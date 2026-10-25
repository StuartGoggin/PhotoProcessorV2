//! The narrow stabilized-picture seam. Never use legacy weak fragment receipts
//! for finishing or release the input leases before final assembly consumes it.
use super::*;
use cache::{OwnedRoot,VerifiedMasks};
use sha2::Sha256;

pub(in crate::commands::video_studio) struct Picture {
    pub path:PathBuf,pub key:String,
    _files:Vec<fs::File>,_root:Option<OwnedRoot>,_masks:Option<VerifiedMasks>,
}
pub(in crate::commands::video_studio) struct PreparedSegments {
    pub segments:Vec<(PathBuf,String)>,pub picture:Picture,
}
struct PictureInputs {
    base:fs::File,masks:VerifiedMasks,_files:Vec<fs::File>,_roots:Vec<OwnedRoot>,
}
pub(super) fn worker()->Result<PathBuf,String> {
    let relative=Path::new("tools/subject-finishing/photogogo-subject-finishing.exe");
    if let Some(folder)=std::env::current_exe().ok().and_then(|p|p.parent().map(Path::to_path_buf)) {
        let path=folder.join(relative);if path.is_file(){return Ok(path);}
    }
    if cfg!(test)||cfg!(debug_assertions) {
        let path=Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);if path.is_file(){return Ok(path);}
    }
    Err("Subject-finishing worker is missing from this installation. No PATH substitute was launched.".into())
}
fn enabled(p:&Project)->bool {p.finishing.as_ref().is_some_and(|s|s.enabled)}
fn picture_recipe(p:&Project,c:&Clip,base_key:&str,base_md5:&str,masks:&VerifiedMasks,encoder:&str)->Value {
    json!([1,"subject-finished-picture-v1",base_key,base_md5,clip_recipe(p,c),
        masks.identity,masks.sha256,format_key(p),encoder,"limited-sdr709-yuv420p8"])
}
fn cache_root(folder:&Path)->Result<OwnedRoot,String> {
    cache::finishing_root(folder)
}
fn verified_picture(ff:&Path,p:&Project,folder:&Path,recipe:&Value,key:&str,count:u32,id:&str,
    base:fs::File,masks:VerifiedMasks)->Result<Picture,String> {
    let root=OwnedRoot::open(folder)?;let mut manifest=cache::lease(&root.child("manifest.json")?,false)?;
    let receipt=cache::bounded_json(&mut manifest)?;
    if receipt["schema"]!=1 || receipt["complete"]!=true || receipt["recipe"]!=*recipe
        || receipt["pictureKey"]!=key || receipt["frames"]!=count {
        return Err("Finished picture receipt is stale; the existing artifact was preserved".into());
    }
    let path=root.child("picture.mp4")?;let mut file=cache::lease(&path,false)?;
    let (bytes,md5,sha)=cache::hashes(&mut file,Some(id))?;
    if receipt["picture"]["bytes"]!=bytes || receipt["picture"]["checksum"]!=md5
        || receipt["picture"]["sha256"]!=sha {
        return Err("Finished picture does not match its full checksum receipt; it was not reused".into());
    }
    let info=inspect(ff,&path)?;cache::validate_profile(&info,p,count)?;
    verify_output(&info,p,count as f64/p.fps as f64)?;
    Ok(Picture{path,key:key.into(),_files:vec![base,file,manifest],_root:Some(root),_masks:Some(masks)})
}

#[allow(clippy::too_many_arguments)]
pub(in crate::commands::video_studio) fn prepare_picture(ff:&Path,p:&Project,c:&Clip,base_path:&Path,base_key:&str,
    encoder:&str,preview:bool,folder:&Path,work:&Path,id:&str)->Result<Picture,String> {
    if !enabled(p) {return Ok(Picture{path:base_path.into(),key:base_key.into(),
        _files:vec![],_root:None,_masks:None});}
    validate(p)?;
    if !ff.is_absolute()||!ff.is_file() {return Err("Subject finishing requires the exact installed or bundled FFmpeg path; a PATH name is not admitted".into());}
    if preview {return Err("Subject finishing previews must use the full verified stabilized base, not a separately stabilized low-resolution excerpt".into());}
    let selection=c.finishing_selection.as_ref().ok_or("Select and review the horse and rider on the stabilized base before finishing this clip")?;
    let mut base=cache::lease(base_path,false)?;
    let (_,base_md5,_)=cache::hashes(&mut base,Some(id))?;
    if selection.base_identity!=base_md5 {return Err("The stabilized picture changed. Select the horse and rider on this exact base again; no old masks were applied.".into());}
    let info=inspect(ff,base_path)?;cache::validate_profile(&info,p,selection.frame_count)?;
    let root=cache_root(folder)?;
    let mask_folder=root.child(&cache::mask_folder_name(selection,p)?)?;
    if !mask_folder.is_dir(){return Err("Subject masks have not been prepared for this exact base and selection. Prepare and review them first; no whole-frame substitute was applied.".into());}
    let masks=cache::verified_masks(&mask_folder,selection,p,Some(id))?;
    let recipe=picture_recipe(p,c,base_key,&base_md5,&masks,encoder);
    let key=hex::encode(Sha256::digest(serde_json::to_vec(&recipe).map_err(|e|e.to_string())?));
    let destination=format!("picture-{key}");let target=root.child(&destination)?;
    let _guard=cache::lock_owned(&root,&destination,id)?;
    if target.exists() {
        let result=verified_picture(ff,p,&target,&recipe,&key,selection.frame_count,id,base,masks)?;
        note_fragment(id,"Reused subject-finished picture",&result.path);return Ok(result);
    }
    let binary=worker()?;let binary_guard=cache::lease(&binary,false)?;
    let tool_root=OwnedRoot::open(ff.parent().ok_or("Missing exact media-tools directory")?)?;
    let ff_guard=cache::lease(ff,false)?;let probe_guard=cache::lease(&tool_root.path.join("ffprobe.exe"),false)?;
    let binary_root=OwnedRoot::open(binary.parent().ok_or("Missing picture worker directory")?)?;
    let base_root=OwnedRoot::open(base_path.parent().ok_or("Missing exact base directory")?)?;
    let settings=p.finishing.as_ref().unwrap();
    let stage=format!("picture-{key}-{}.partial",chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default());
    let stage_path=root.child(&stage)?;fs::create_dir(&stage_path).map_err(|e|e.to_string())?;
    let stage_root=OwnedRoot::open(&stage_path)?;
    let output=stage_path.join("picture.mp4");let phase=format!("{}: subject finishing",c.chapter);
    let mut inputs=PictureInputs{base,masks,_files:vec![binary_guard,ff_guard,probe_guard],
        _roots:vec![tool_root,binary_root,base_root,stage_root]};
    loop {
        checkpoint(id)?;
        let permit=match studio_hardware::acquire_finishing(p.width,p.height,&p.performance,false,
            ||{launch::poll_cleanup();stopped_or_paused(id)},|note|update(id,|j|record_memory_wait(j,&work.to_string_lossy(),note))) {
            Ok(value)=>value,
            Err(error)=> {if jobs().lock().ok().and_then(|s|s.get(id).map(|j|j.paused&&!j.cancelled&&j.worker_error.is_none())).unwrap_or(false){continue;}return Err(error);}
        };
        if stopped_or_paused(id){drop(permit);continue;}
        let Some(gpu)=image_admission::ImageSlot::try_acquire()? else {drop(permit);thread::sleep(Duration::from_millis(100));continue;};
        let threads=(permit.threads()/2).clamp(1,64);
        let mut args=vec!["--render".into(),ff.to_string_lossy().into_owned(),base_path.to_string_lossy().into_owned(),
            output.to_string_lossy().into_owned(),inputs.masks.path.to_string_lossy().into_owned(),p.width.to_string(),p.height.to_string(),
            (settings.sharpening.amount*128.).round().to_string(),(settings.sharpening.noise_threshold*255.*16.).round().to_string(),
            selection.frame_count.to_string(),"auto".into()];
        args.extend([settings.colour.light_ev,settings.colour.contrast,settings.colour.saturation,settings.colour.warmth].map(|n|n.to_string()));
        args.push(u8::from(settings.whole_frame.enabled).to_string());
        args.extend([settings.whole_frame.colour.light_ev,settings.whole_frame.colour.contrast,
            settings.whole_frame.colour.saturation,settings.whole_frame.colour.warmth].map(|n|n.to_string()));
        args.extend([p.fps.to_string(),threads.to_string(),effective_bitrate(p).to_string(),encoder.into()]);
        update(id,|j|j.logs.push(format!("Subject finishing: cached two-object masks; {threads} threads per decoder/encoder; three process slots. GPU image kernels or explicit initialization-only CPU fallback; no GPU segmentation throughput claim.")));
        let (retention,result)=launch::run(&binary,&args,work,id,&phase,Duration::from_secs(24*60*60),(inputs,permit,gpu))?;
        let (restored,permit,gpu)=retention;inputs=restored;drop(gpu);drop(permit);
        match result {Err(error) if error==diagnostics::RETRY_ADMISSION=>continue,result=>result?,}break;
    }
    // Failed drain retains this entire pack in the launcher quarantine. Only a
    // verified complete drain returns it for output inspection/publication.
    let PictureInputs{base,masks,_files,_roots:mut roots}=inputs;
    // Stage is the last root. Release its no-rename lease only after drain;
    // retain the independent source/tool roots throughout verification.
    drop(roots.pop());
    let mut generated=cache::lease(&output,false)?;
    let expected=cache::hashes(&mut generated,Some(id))?;
    let generated_info=inspect(ff,&output)?;cache::validate_profile(&generated_info,p,selection.frame_count)?;
    verify_output(&generated_info,p,selection.frame_count as f64/p.fps as f64)?;
    drop(generated);
    // No picture lease is held during the Windows directory move. Completion is
    // still absent. Reopen at its final path and compare to the PRE-MOVE identity,
    // never calculate-and-bless changed bytes in the move's short sharing gap.
    cache::move_stage(&root,&stage,&destination,id)?;
    let destination_root=OwnedRoot::open(&target)?;let path=destination_root.child("picture.mp4")?;
    let file=cache::lease_matching(&path,&expected,Some(id))?;let output_info=inspect(ff,&path)?;
    cache::validate_profile(&output_info,p,selection.frame_count)?;
    verify_output(&output_info,p,selection.frame_count as f64/p.fps as f64)?;
    let (bytes,md5,sha)=expected;
    let receipt=json!({"schema":1,"complete":true,"recipe":recipe,"pictureKey":key,"frames":selection.frame_count,
        "picture":{"bytes":bytes,"checksum":md5,"sha256":sha},"subjectQualityAccepted":false});
    let manifest=cache::commit_marker(&destination_root,&receipt,id)?;
    note_fragment(id,"Rendered subject-finished picture",&path);
    Ok(Picture{path,key,_files:vec![base,file,manifest],_root:Some(destination_root),_masks:Some(masks)})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_finishing_is_an_exact_no_io_passthrough() {
        let p=super::super::super::tests::project(Path::new("."));
        let picture=prepare_picture(Path::new("missing-ffmpeg"),&p,&p.clips[0],Path::new("missing-base"),
            "legacy-key","libx264",true,Path::new("missing-cache"),Path::new("missing-work"),"missing-job").unwrap();
        assert_eq!(picture.path,Path::new("missing-base"));assert_eq!(picture.key,"legacy-key");
        assert!(picture._files.is_empty());
    }
    #[test]
    #[ignore="bounded native finishing/cache/lease smoke; requires bundled worker and FFmpeg"]
    fn subject_finishing_adapter_smoke() {
        let ff=std::env::var_os("PHOTOGOGO_TEST_FFMPEG").map(PathBuf::from)
            .unwrap_or_else(||detect_ffmpeg_capabilities().unwrap().binary);
        assert!(ff.is_absolute(),"Set PHOTOGOGO_TEST_FFMPEG to the exact local bundled executable for this smoke test");
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-output")
            .join(format!("studio-subject-adapter-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();let source=root.join("normalized-base.mp4");
        let result=command(&ff).args(["-v","error","-nostdin","-n","-f","lavfi","-i","testsrc2=size=320x180:rate=25",
            "-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","0.4","-c:v","libx264","-bf","0",
            "-threads","1","-pix_fmt","yuv420p","-color_range","tv","-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709","-c:a","aac","-ac","2"]).arg(&source).output().unwrap();
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
        let original=compute_md5(&source).unwrap();let mut p=super::super::super::tests::project(&root);
        p.width=320;p.height=180;p.fps=25;p.bitrate_mbps=4;p.performance="balanced".into();
        let mut settings=Settings::default();settings.enabled=true;p.finishing=Some(settings);
        let selection:Selection=serde_json::from_value(json!({"version":1,"baseIdentity":original,"frameCount":10,
            "referenceFrame":0,"anchors":[{"frame":0,"object":"horse","box":[0.2,0.3,0.8,0.9]},
                {"frame":0,"object":"rider","box":[0.4,0.1,0.6,0.5]}]})).unwrap();
        p.clips[0].finishing_selection=Some(selection.clone());
        let cache_root=cache_root(&root).unwrap();let recipe=cache::mask_recipe(&selection,&p).unwrap();
        let mask_key=hex::encode(Sha256::digest(serde_json::to_vec(&recipe).unwrap()));
        let mask_folder=cache_root.child(&format!("masks-{mask_key}")).unwrap();fs::create_dir(&mask_folder).unwrap();
        let mut bytes=b"PGMSK001".to_vec();for n in [320u32,180,10]{bytes.extend(n.to_le_bytes());}
        for _ in 0..10 {bytes.extend(5u32.to_le_bytes());bytes.extend((320u32*180).to_le_bytes());bytes.push(255);}
        fs::write(mask_folder.join("masks.pgmask"),&bytes).unwrap();let canonical=serde_json::to_string(&recipe).unwrap();
        let manifest=json!({"schema":1,"complete":true,"engine":"sam2.1-tiny-two-object-window-v1",
            "baseChecksum":original,"maskIdentity":hex::encode(Sha256::digest(canonical.as_bytes())),"canonicalRecipe":canonical,
            "selection":selection,"width":320,"height":180,"fps":25,"frames":10,"profile":"limited-sdr709-yuv420p8",
            "generationProfile":cache::generation(),"subjectQualityAccepted":false,"appCommitted":true,
            "runtimeProfile":"manual-video-cpu-v1","runtimeSeal":super::super::runtime::seal_identity(),
            "mask":{"schema":1,"format":"PGMSK001","width":320,"height":180,"frames":10,"bytes":bytes.len(),
                "checksum":hex::encode(Md5::digest(&bytes)),"sha256":hex::encode(Sha256::digest(&bytes))}});
        fs::write(mask_folder.join("manifest.json"),serde_json::to_vec(&manifest).unwrap()).unwrap();
        let id=format!("subject-adapter-smoke-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap());
        jobs().lock().unwrap().insert(id.clone(),StudioJob{id:id.clone(),status:"running".into(),..StudioJob::default()});
        let call=|p:&Project|prepare_picture(&ff,p,&p.clips[0],&source,"fixed-normalized-base","libx264",false,&root,&root,&id);
        let first=call(&p).unwrap();let key=first.key.clone();let path=first.path.clone();
        let checksum=compute_md5(&path).unwrap();let timestamp=fs::metadata(&path).unwrap().modified().unwrap();
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err(),"Output became mutable before downstream consumption");
        assert!(fs::OpenOptions::new().write(true).open(&source).is_err(),"Base became mutable during finishing");
        drop(first);let reused=call(&p).unwrap();assert_eq!(reused.key,key);
        assert_eq!(compute_md5(&reused.path).unwrap(),checksum);assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(),timestamp);
        drop(reused);p.finishing.as_mut().unwrap().sharpening.amount=0.;let changed=call(&p).unwrap();
        assert_ne!(changed.key,key,"Filter edits must produce a distinct finished-picture identity");drop(changed);
        assert_eq!(compute_md5(&source).unwrap(),original,"Filter edits must not touch the stabilized base");
        p.finishing.as_mut().unwrap().sharpening.amount=0.2;
        fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(b"corrupt-cache-fixture").unwrap();
        let preserved=compute_md5(&path).unwrap();assert!(call(&p).err().unwrap().contains("checksum"));
        assert_eq!(compute_md5(&path).unwrap(),preserved,"Corrupt existing cache must be preserved, not silently replaced");
        assert_eq!(compute_md5(&source).unwrap(),original);
        jobs().lock().unwrap().remove(&id);
        println!("PASS: native finishing, marker-last publication, exact reuse, filter-only invalidation and held leases. Synthetic fixtures retained: {}",root.display());
    }
}
