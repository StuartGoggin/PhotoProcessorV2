//! Independently versioned finishing settings. Camera-motion identity is unchanged.
use super::*;
mod cache;
mod pipeline;
mod runtime;
mod mask_preparation;
mod launch;
mod image_admission;
pub(super) mod preparation;
pub(super) use pipeline::{prepare_picture,PreparedSegments};
pub(super) use preparation::existing_export_base;
pub(super) fn poll_cleanup(){launch::poll_cleanup();}
pub(super) fn retire_history(state:&mut HashMap<String,StudioJob>){preparation::retire_history(state);}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Subject { #[default] HorseRider }
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColourScope { #[default] Subject }
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BasePolicy { #[default] Reuse, Clean }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Colour {
    /// Bounded midtone trim; not camera exposure or recovery of clipped pixels.
    pub light_ev: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub warmth: f64,
}
impl Default for Colour {
    fn default() -> Self { Self { light_ev: 0., contrast: 1., saturation: 1., warmth: 0. } }
}
impl Colour {
    fn validate(&self) -> Result<(), String> {
        for (value, minimum, maximum) in [(self.light_ev, -1.5, 1.5), (self.contrast, 0.75, 1.25),
            (self.saturation, 0., 1.4), (self.warmth, -0.25, 0.25)] {
            if !value.is_finite() || !(minimum..=maximum).contains(&value) {
                return Err("Invalid bounded subject-finishing colour setting".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Sharpness { pub amount: f64, pub noise_threshold: f64 }
impl Default for Sharpness {
    fn default() -> Self { Self { amount: 0.2, noise_threshold: 2. / 255. } }
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WholeFrame { pub enabled: bool, pub colour: Colour }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub enabled: bool,
    pub subject: Subject,
    pub colour_scope: ColourScope,
    pub base_policy: BasePolicy,
    pub sharpening: Sharpness,
    pub colour: Colour,
    pub whole_frame: WholeFrame,
}
impl Default for Settings {
    fn default() -> Self {
        Self { version: 1, enabled: false, subject: Subject::default(), colour_scope: ColourScope::default(),
            base_policy: BasePolicy::default(), sharpening: Sharpness::default(), colour: Colour::default(),
            whole_frame: WholeFrame::default() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackedObject { Horse, Rider }
impl TrackedObject {
    fn name(&self) -> &'static str {match self {Self::Horse=>"horse",Self::Rider=>"rider"}}
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PointPrompt {pub x:f64,pub y:f64,pub include:bool}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub frame:u32,pub object:TrackedObject,
    #[serde(default,rename="box",skip_serializing_if="Option::is_none")]
    pub rect:Option<[f64;4]>,
    #[serde(default)]
    pub points:Vec<PointPrompt>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct Selection {
    pub version:u32,pub base_identity:String,pub frame_count:u32,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub reference_frame:Option<u32>,
    pub anchors:Vec<Anchor>,
}
impl Selection {
    fn reference(&self) -> Result<u32,String> {
        let shared=|frame:u32| ["horse","rider"].iter().all(|name|
            self.anchors.iter().any(|anchor|anchor.frame==frame && anchor.object.name()==*name));
        self.reference_frame.or_else(||self.anchors.iter().filter(|anchor|shared(anchor.frame))
            .map(|anchor|anchor.frame).min()).filter(|frame|shared(*frame))
            .ok_or_else(||"Horse and rider need anchors at the subject-finishing reference frame".into())
    }
    fn validate(&self)->Result<(),String> {
        if self.version!=1 || !(1..=1_800_000).contains(&self.frame_count)
            || ![32,64].contains(&self.base_identity.len())
            || !self.base_identity.bytes().all(|value|value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
            || !(2..=128).contains(&self.anchors.len()) {
            return Err("Invalid exact subject-finishing base identity or anchor budget".into());
        }
        let unit=|value:f64|value.is_finite() && (0.0..=1.0).contains(&value);
        let mut identities=std::collections::HashSet::new();let mut count=0;
        for anchor in &self.anchors {
            if anchor.frame>=self.frame_count || !identities.insert((anchor.frame,anchor.object.name()))
                || anchor.points.len()>32 {return Err("Invalid subject-finishing frame, duplicate object or correction budget".into());}
            if let Some(rect)=anchor.rect {
                if !rect.into_iter().all(unit) || rect[0]>=rect[2] || rect[1]>=rect[3] {
                    return Err("Subject-finishing box requires normalized positive area".into());
                }
            }
            count+=anchor.points.len();
            if count>512 || anchor.points.iter().any(|point|!unit(point.x)||!unit(point.y))
                || (anchor.rect.is_none() && !anchor.points.iter().any(|point|point.include)) {
                return Err("Subject-finishing anchor requires valid box or positive points within its budget".into());
            }
        }
        self.reference()?;Ok(())
    }
    fn recipe(&self)->Value {
        let mut anchors:Vec<_>=self.anchors.iter().collect();
        anchors.sort_by_key(|anchor|(anchor.frame,anchor.object.name()));
        json!([1,self.base_identity,self.frame_count,self.reference().ok(),anchors.iter().map(|anchor|
            json!([anchor.frame,anchor.object.name(),anchor.rect,anchor.points.iter()
                .map(|point|json!([point.x,point.y,point.include])).collect::<Vec<_>>()])).collect::<Vec<_>>()])
    }
}

fn colour_recipe(value:&Colour)->Value {json!([value.light_ev,value.contrast,value.saturation,value.warmth])}
pub(super) fn clip_recipe(p:&Project,c:&Clip)->Value {
    let Some(settings)=p.finishing.as_ref().filter(|value|value.enabled) else{return Value::Null;};
    json!([1,[1,"subject-rgb709-q4-v2","horseRider",settings.base_policy,
        settings.sharpening.amount,settings.sharpening.noise_threshold,colour_recipe(&settings.colour),
        if settings.whole_frame.enabled {colour_recipe(&settings.whole_frame.colour)} else {Value::Null}],
        [1,"sam2.1-tiny-two-object-window-v1","7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69",
            "proxy-max1024-jpeg-q2-v1","fp32-cpu-offload-v1",16,4,"fixed-two-id-object-reacquisition-seam-v3",0.6,0.25,
            "inward-erode5-blur1-nearest-v1"],c.finishing_selection.as_ref().map(Selection::recipe)])
}

pub(super) fn validate(p: &Project) -> Result<(), String> {
    for clip in &p.clips {if let Some(selection)=&clip.finishing_selection {selection.validate()?;}}
    if let Some(settings) = &p.finishing {
        if settings.version != 1 || !settings.sharpening.amount.is_finite()
            || !(0.0..=1.0).contains(&settings.sharpening.amount)
            || !settings.sharpening.noise_threshold.is_finite()
            || !(2. / 255. ..=8. / 255.).contains(&settings.sharpening.noise_threshold) {
            return Err("Invalid bounded subject-finishing version or sharpening setting".into());
        }
        settings.colour.validate()?;
        settings.whole_frame.colour.validate()?;
    }
    Ok(())
}

/// A distinct, explicitly selected normalized base. Disabled/reuse settings
/// retain byte-for-byte legacy cache identities and the original filter chain.
pub(super) fn clean_base(p: &Project) -> bool {
    p.finishing.as_ref().is_some_and(|settings|
        settings.enabled && matches!(settings.base_policy, BasePolicy::Clean))
}

pub(super) fn preflight(p: &Project) -> Result<(), String> {
    validate(p)?;
    if p.finishing.as_ref().is_some_and(|settings| settings.enabled) {
        // The settings/cache/worker slice must not masquerade as a completed
        // export pipeline. Replace this fail-closed gate only after that public
        // integration and its staged-publication tests actually pass.
        return Err("Subject finishing is not export-ready in this development checkpoint. No render was started; disable finishing to use the existing workflow.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn saved_selection() -> Value {
        json!({"version":1,"baseIdentity":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","frameCount":100,"referenceFrame":10,
            "anchors":[{"frame":10,"object":"horse","box":[0.2,0.3,0.8,0.9]},
                {"frame":10,"object":"rider","box":[0.4,0.1,0.6,0.5]},
                {"frame":2,"object":"horse","points":[{"x":0.5,"y":0.6,"include":true}]}]})
    }
    #[test]
    fn finishing_identity_stales_complete_clip_and_sequence_but_preserves_legacy_base() {
        let mut raw = serde_json::to_value(super::super::tests::project(Path::new("."))).unwrap();
        let old: Project = serde_json::from_value(raw.clone()).unwrap();
        let base = stabilization::base_key(&old,&old.clips[0],"source","libx264").unwrap();
        let key = recovery::clip_signature_for_source(&old,&old.clips[0],"source".into()).unwrap();
        raw["finishing"] = json!({"enabled":true});raw["clips"][0]["finishingSelection"] = saved_selection();
        let enabled: Project = serde_json::from_value(raw.clone()).unwrap();validate(&enabled).unwrap();
        assert_eq!(stabilization::base_key(&enabled,&enabled.clips[0],"source","libx264").unwrap(),base);
        assert_ne!(recovery::clip_signature_for_source(&enabled,&enabled.clips[0],"source".into()).unwrap(),key);
        assert_eq!(sequence::recipe(&enabled)[0],json!(6));assert_eq!(sequence::recipe(&enabled).as_array().unwrap().len(),10);
        raw["clips"][0]["finishingSelection"]["anchors"][0]["box"][0]=json!(0.1);
        let edited: Project=serde_json::from_value(raw.clone()).unwrap();
        assert_ne!(recovery::clip_signature_for_source(&edited,&edited.clips[0],"source".into()).unwrap(),
            recovery::clip_signature_for_source(&enabled,&enabled.clips[0],"source".into()).unwrap());
        raw["finishing"]["enabled"]=json!(false);
        let disabled: Project=serde_json::from_value(raw).unwrap();validate(&disabled).unwrap();
        assert_eq!(recovery::clip_signature_for_source(&disabled,&disabled.clips[0],"source".into()).unwrap(),key);
        assert_eq!(sequence::recipe(&disabled),sequence::recipe(&old));
    }
    #[test]
    fn malformed_selection_is_rejected_even_when_the_effect_is_disabled() {
        let raw = serde_json::to_value(super::super::tests::project(Path::new("."))).unwrap();
        for bad in [json!({"extra":"ignored"}), {
            let mut value=saved_selection();value["referenceFrame"]=json!(2);value
        }, {
            let mut value=saved_selection();value["anchors"][0]["extra"]=json!(true);value
        }, {
            let mut value=saved_selection();value["anchors"][0]["box"]=json!([0.8,0.3,0.2,0.9]);value
        }] {
            let mut changed=raw.clone();changed["clips"][0]["finishingSelection"]=bad;
            assert!(serde_json::from_value::<Project>(changed).map(|p|validate(&p).is_err()).unwrap_or(true));
        }
    }
    #[test]
    fn explicit_clean_base_separates_quality_cache_and_removes_only_global_sharpening() {
        let mut p = super::super::tests::project(Path::new("."));
        p.clips[0].stabilization_method = "quality".into();
        let old = stabilization::base_key(&p, &p.clips[0], "source", "libx264").unwrap();
        let old_filter = stabilization::quality_filter(&p, &p.clips[0], "motion.trf", 30, "format=yuv420p");
        let mut settings = Settings::default();settings.enabled = true;p.finishing = Some(settings);
        assert_eq!(stabilization::base_key(&p, &p.clips[0], "source", "libx264").unwrap(), old);
        assert_eq!(stabilization::quality_filter(&p, &p.clips[0], "motion.trf", 30, "format=yuv420p"), old_filter);
        p.finishing.as_mut().unwrap().base_policy = BasePolicy::Clean;
        assert_ne!(stabilization::base_key(&p, &p.clips[0], "source", "libx264").unwrap(), old);
        let clean = stabilization::quality_filter(&p, &p.clips[0], "motion.trf", 30, "format=yuv420p");
        assert_eq!(clean, old_filter.replace(",unsharp=5:5:0.6:3:3:0.0", ""));
        p.finishing.as_mut().unwrap().enabled = false;
        assert_eq!(stabilization::base_key(&p, &p.clips[0], "source", "libx264").unwrap(), old);
        assert_eq!(stabilization::quality_filter(&p, &p.clips[0], "motion.trf", 30, "format=yuv420p"), old_filter);
    }
    #[test]
    fn legacy_defaults_remain_disabled_and_enabled_development_requests_fail_closed() {
        let mut p = super::super::tests::project(Path::new("."));
        assert!(preflight(&p).is_ok());
        p.finishing = Some(Settings::default());
        assert!(preflight(&p).is_ok());
        p.finishing.as_mut().unwrap().enabled = true;
        let error = studio_start_render(p, "must-not-create".into(), false, None, None,
            Some("project".into()), None, Some(false)).unwrap_err();
        assert!(error.contains("No render was started"));
    }
}
