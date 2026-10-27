//! Versioned UI recipe. All adjustments stay in RawTherapee's high precision
//! pipeline; an embedded camera JPEG is never an export intermediate.
use super::super::photo_process::BwParams;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct RawRecipe {
    pub schema_version: u32,
    pub preset: String,
    pub white_balance: String,
    pub temperature: f64,
    pub tint: f64,
    pub exposure: f64,
    pub auto_exposure: bool,
    pub highlights: f64,
    pub shadows: f64,
    pub black_point: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub curve_strength: f64,
    pub sharpening: f64,
    pub luminance_noise: f64,
    pub chroma_noise: f64,
    pub output: String,
    pub colour: bool,
    pub bw: bool,
    pub keep_gps: bool,
    pub bw_params: BwParams,
}
impl Default for RawRecipe {
    fn default() -> Self {
        Self {
            schema_version: 1,
            preset: "natural".into(),
            white_balance: "asShot".into(),
            temperature: 6500.,
            tint: 1.,
            exposure: 0.,
            auto_exposure: false,
            highlights: 20.,
            shadows: 0.,
            black_point: 0.,
            contrast: 0.,
            saturation: 0.,
            curve_strength: 0.15,
            sharpening: 20.,
            luminance_noise: 0.,
            chroma_noise: 15.,
            output: "jpeg".into(),
            colour: true,
            bw: false,
            keep_gps: true,
            bw_params: BwParams::default(),
        }
    }
}
impl RawRecipe {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !["natural", "neutral", "highIso", "custom"].contains(&self.preset.as_str())
            || !["asShot", "auto", "custom"].contains(&self.white_balance.as_str())
            || !["jpeg", "tiff16"].contains(&self.output.as_str())
        {
            return Err(
                "Unsupported RAW recipe version, preset, white balance or output format".into(),
            );
        }
        if !self.colour && !self.bw {
            return Err("Select at least one RAW output".into());
        }
        for (name, v, min, max) in [
            ("temperature", self.temperature, 2000., 12000.),
            ("tint", self.tint, 0.5, 2.),
            ("exposure", self.exposure, -3., 3.),
            ("highlights", self.highlights, 0., 100.),
            ("shadows", self.shadows, 0., 100.),
            ("black point", self.black_point, -100., 100.),
            ("contrast", self.contrast, -100., 100.),
            ("saturation", self.saturation, -100., 100.),
            ("curve", self.curve_strength, 0., 1.),
            ("sharpening", self.sharpening, 0., 100.),
            ("luminance noise", self.luminance_noise, 0., 100.),
            ("chroma noise", self.chroma_noise, 0., 100.),
        ] {
            if !v.is_finite() || !(min..=max).contains(&v) {
                return Err(format!("RAW {name} must be between {min} and {max}"));
            }
        }
        self.bw_params.validate()
    }
    pub fn pp3(&self, bw: bool, preview: bool) -> Result<String, String> {
        self.validate()?;
        let auto = self.auto_exposure;
        let setting = match self.white_balance.as_str() {
            "asShot" => "Camera",
            "auto" => "autitcgreen",
            _ => "Custom",
        };
        let sharp = if bw {
            f64::from(self.bw_params.sharpness) * 100.
        } else {
            self.sharpening
        };
        let sharp = sharp.round() as i32;
        let bw_curve = if bw {
            let b = self.bw_params;
            let mid = f64::from(b.midpoint);
            format!(
                "1;0;0;{};{};{mid};{mid};{};{};1;1;",
                mid / 2.,
                (mid / 2. - f64::from(b.shadow_depth * b.curve_strength)).max(0.),
                (1. + mid) / 2.,
                ((1. + mid) / 2. + f64::from(b.highlight_lift * b.curve_strength)).min(1.)
            )
        } else {
            let s = self.curve_strength * 0.10;
            format!("1;0;0;0.25;{};0.5;0.5;0.75;{};1;1;", 0.25 - s, 0.75 + s)
        };
        let s = self.curve_strength * 0.06;
        let curve = format!("1;0;0;0.25;{};0.5;0.5;0.75;{};1;1;", 0.25 - s, 0.75 + s);
        let local = if bw {
            f64::from(self.bw_params.local_contrast) * 0.15
        } else {
            0.
        };
        // No user defaults, source sidecars, auto exposure, fast-export, lens
        // guessing or resize on final export. Recipe v1 uses an edge-limited
        // unsharp mask, not a claimed semantic subject mask.
        Ok(format!("[Version]\nAppVersion=5.13\nVersion=353\n[Exposure]\nAuto={auto}\nCompensation={}\nBrightness=0\nBlack={}\nContrast={}\nSaturation={}\nHighlightCompr={}\nHighlightComprThreshold=50\nShadowCompr=0\nHistogramMatching=false\nCurveFromHistogramMatching=false\nCurveMode=Luminance\nCurve={curve}\nCurve2=0;\n[White Balance]\nEnabled=true\nSetting={setting}\nTemperature={}\nGreen={}\n[Shadows & Highlights]\nEnabled={}\nShadows={}\nHighlights=0\nShadowTonalWidth=30\nHighlightTonalWidth=70\nRadius=40\nLab=false\n[Sharpening]\nEnabled={}\nMethod=usm\nRadius=0.5\nContrast=20\nAmount={sharp}\nThreshold=20;80;2000;1200;\nOnlyEdges=true\nEdgedetectionRadius=1.9\nEdgeTolerance=1800\nHalocontrolEnabled=true\nHalocontrolAmount=75\n[Directional Pyramid Denoising]\nEnabled={}\nLuma={}\nChroma={}\nLdetail=0\nCMethod=MAN\nC2Method=MANU\nLMethod=SLI\nMethod=Lab\nRedchro=0\nBluechro=0\nAutoGain=true\nGamma=1.7\nMedian=false\nEnhance=false\nPasses=1\n[Black & White]\nEnabled={bw}\nMethod=ChannelMixer\nAuto=false\nSetting=RGB-Rel\nFilter=None\nComplementaryColors=false\nMixerRed=21\nMixerGreen=72\nMixerBlue=7\nGammaRed=0\nGammaGreen=0\nGammaBlue=0\nBeforeCurve=0;\nAfterCurveMode=Standard\nAfterCurve={bw_curve}\n[Color Management]\nInputProfile=(cameraICC)\nToneCurve=false\nApplyLookTable=false\nApplyHueSatMap=true\nApplyBaselineExposureOffset=true\nWorkingProfile=Rec2020\nOutputProfile=RTv4_sRGB\nOutputProfileIntent=Relative\nOutputBPC=true\n[Coarse Transformation]\nRotate=0\nHorizontalFlip=false\nVerticalFlip=false\n[Crop]\nEnabled=false\n[Resize]\nEnabled={preview}\nDataSpecified=3\nLongEdge=1600\nAllowUpscaling=false\nMethod=Lanczos\nAppliesTo=Cropped area\n[Local Contrast]\nEnabled={}\nRadius=80\nAmount={local}\nDarkness=1\nLightness=1\n[Metadata]\nMode=0\n",
            self.exposure,(self.black_point*100.).round() as i32,self.contrast.round() as i32,self.saturation.round() as i32,self.highlights.round() as i32,self.temperature.round() as i32,self.tint,self.shadows>0.,self.shadows.round() as i32,
            sharp>0,self.luminance_noise>0.||self.chroma_noise>0.,self.luminance_noise,self.chroma_noise,local>0.))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recipe_bounds_and_precision_contract() {
        let mut r = RawRecipe::default();
        assert!(r.validate().is_ok());
        r.exposure = f64::NAN;
        assert!(r.validate().is_err());
        r = RawRecipe::default();
        r.colour = false;
        assert!(r.validate().is_err());
        let p = RawRecipe::default().pp3(false, false).unwrap();
        assert!(p.contains("Auto=false"));
        assert!(p.contains("Enabled=false\nDataSpecified"));
        assert!(p.contains("WorkingProfile=Rec2020"));
        assert!(!p.contains("FastExport"));
    }
    #[test]
    fn bw_branch_does_not_depend_on_colour_output() {
        let mut r = RawRecipe::default();
        r.colour = false;
        r.bw = true;
        assert!(r
            .pp3(true, false)
            .unwrap()
            .contains("Enabled=true\nMethod=ChannelMixer"));
    }
}
