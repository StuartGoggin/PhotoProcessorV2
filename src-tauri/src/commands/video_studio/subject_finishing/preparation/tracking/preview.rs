//! Full-resolution before/after frames through the identical picture kernel.
//! No stabilization, model inference, media overwrite or thumbnail sharpening.
use super::*;
use super::super::super::pipeline;
use sha2::{Digest,Sha256};

pub(super) fn cancel_for_track(state:&mut HashMap<String,StudioJob>,id:&str) {
    for job in state.values_mut().filter(|j|j.kind=="subjectFrame"&&j.preview_key==id) {job.cancelled=true;job.paused=false;}
}
#[tauri::command]
pub fn studio_subject_finish_cancel(tracking_id:String)->Result<(),String> {
    let mut state=jobs().lock().map_err(|e|e.to_string())?;
    let records=tracks().lock().map_err(|e|e.to_string())?;
    if let Some(record)=records.get(&tracking_id){record.preview_epoch.fetch_update(Ordering::Relaxed,Ordering::Relaxed,|value|value.checked_add(1))
        .map_err(|_|"Finishing preview generation exhausted; release this tracking review")?;}
    cancel_for_track(&mut state,&tracking_id);Ok(())
}
#[tauri::command]
pub fn studio_subject_finish_epoch(tracking_id:String)->Result<u32,String>{Ok(ready_track(&tracking_id)?.preview_epoch.load(Ordering::Relaxed))}
fn arguments(width:u32,height:u32,settings:&Settings)->Vec<String> {
    let mut args=vec!["--finish".into(),width.to_string(),height.to_string(),
        (settings.sharpening.amount*128.).round().to_string(),(settings.sharpening.noise_threshold*255.*16.).round().to_string(),"1".into(),"auto".into()];
    args.extend([settings.colour.light_ev,settings.colour.contrast,settings.colour.saturation,settings.colour.warmth].map(|v|v.to_string()));
    args.push(u8::from(settings.whole_frame.enabled).to_string());
    args.extend([settings.whole_frame.colour.light_ev,settings.whole_frame.colour.contrast,settings.whole_frame.colour.saturation,settings.whole_frame.colour.warmth].map(|v|v.to_string()));args
}
struct Scratch(cache::OwnedRoot);
impl Drop for Scratch {
    fn drop(&mut self) {
        // Only these newly created temporary files, while the opened parent
        // cannot be renamed. Never recursively remove a computed directory.
        for name in ["decoded.rgba","input.rgba","filtered.rgba"] {
            if let Ok(path)=self.0.child(name) {if let Err(e)=fs::remove_file(&path){if e.kind()!=std::io::ErrorKind::NotFound {eprintln!("Subject preview scratch retained: {e}");}}}
        }
        // The empty stage directory is retained; no path-redirection gap is
        // introduced by releasing its lease to delete it.
    }
}
struct Inputs {_record:Arc<Tracking>,_files:Vec<fs::File>,_tool_roots:Vec<cache::OwnedRoot>,_scratch:Scratch}
struct BoundedPng {bytes:Vec<u8>,limit:usize}
impl Write for BoundedPng {
    fn write(&mut self,bytes:&[u8])->std::io::Result<usize> {
        if self.bytes.len().checked_add(bytes.len()).is_none_or(|length|length>self.limit){return Err(std::io::Error::other("Full-resolution preview exceeds its PNG byte budget"));}
        self.bytes.extend_from_slice(bytes);Ok(bytes.len())
    }
    fn flush(&mut self)->std::io::Result<()>{Ok(())}
}
fn png(width:u32,height:u32,bytes:Vec<u8>)->Result<String,String> {
    let buffer=encode_png(width,height,&bytes,32*1024*1024)?;
    Ok(format!("data:image/png;base64,{}",crate::utils::base64_encode(&buffer)))
}
fn encode_png(width:u32,height:u32,bytes:&[u8],limit:usize)->Result<Vec<u8>,String> {
    use image::ImageEncoder;
    if width as u64*height as u64*4!=bytes.len()as u64{return Err("Invalid full preview dimensions".into());}
    let mut buffer=BoundedPng{bytes:Vec::new(),limit};image::codecs::png::PngEncoder::new(&mut buffer)
        .write_image(bytes,width,height,image::ExtendedColorType::Rgba8).map_err(|e|e.to_string())?;
    Ok(buffer.bytes)
}
fn publish_frame_result(state:&mut HashMap<String,StudioJob>,id:&str,tracking:&str,base:&str,result:Result<Value,String>)->Result<Value,String> {
    let parents_ready=still_ready(state,tracking)&&still_ready(state,base);
    let job=state.get_mut(id).ok_or("Finishing preview was forgotten before terminal publication")?;
    let accepted=if job.cancelled{Err("Cancelled before finishing preview publication".into())}
        else if let Some(error)=&job.worker_error{Err(error.clone())}
        else if !parents_ready{Err("Tracking or stabilized base was released before preview publication".into())}else{result};
    job.finished_at=chrono::Utc::now().to_rfc3339();job.status=if job.cancelled{"cancelled"}else if accepted.is_ok(){"completed"}else{"failed"}.into();
    if let Err(error)=&accepted{job.error=Some(error.clone());}accepted
}
fn frame(record:Arc<Tracking>,tracking_id:&str,index:u32,settings:&Settings,id:&str)->Result<Value,String> {
    let base=&record.base;if record.ready.is_none(){return Err("Masks are not ready".into());}
    let (width,height)=(base.public.width,base.public.height);let pixels=width as u64*height as u64;
    if pixels==0||pixels>16_777_216{return Err("Finishing preview exceeds its full-resolution frame budget".into());}
    let worker=pipeline::worker()?;let mut held=cache::lease(&worker,false)?;
    if cache::hashes(&mut held,Some(id))?.2!="db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d" {
        return Err("The finishing preview worker does not match the evaluated export kernel".into());
    }
    let finishing=cache::finishing_root(&base.folder)?;
    let stage=finishing.child(&format!("frame-preview-{}.partial",chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name preview")?))?;
    fs::create_dir(&stage).map_err(|e|e.to_string())?;let scratch=Scratch(cache::OwnedRoot::open(&stage)?);
    let raw=scratch.0.child("decoded.rgba")?;let input_path=scratch.0.child("input.rgba")?;let output_path=scratch.0.child("filtered.rgba")?;
    let ff=base.ff.clone();let original=base.path.clone();
    let tool_roots=vec![cache::OwnedRoot::open(ff.parent().ok_or("Missing media tool root")?)?,cache::OwnedRoot::open(worker.parent().ok_or("Missing picture tool root")?)?];
    let files=vec![held,cache::lease(&ff,false)?];
    let inputs=Inputs{_record:record,_files:files,_tool_roots:tool_roots,_scratch:scratch};
    let admission_began=std::time::Instant::now();
    let permit=studio_hardware::acquire_finishing(width,height,"balanced",false,
        ||{launch::poll_cleanup();admission_began.elapsed()>=Duration::from_secs(20)||stopped_or_paused(id)},|_|{})
        .map_err(|error|if admission_began.elapsed()>=Duration::from_secs(20){"Finishing frame preview waited too long for host processing capacity".into()}else{error})?;
    let began=std::time::Instant::now();let gpu=loop {
        checkpoint(id)?;if began.elapsed()>Duration::from_secs(20){return Err("Finishing preview waited too long for its image slot".into());}
        if let Some(slot)=image_admission::ImageSlot::try_acquire()?{break slot;}thread::sleep(Duration::from_millis(50));
    };
    let decode=vec!["-v".into(),"error".into(),"-nostdin".into(),"-n".into(),"-filter_threads".into(),"1".into(),"-threads".into(),"2".into(),
        "-ss".into(),format!("{:.9}",index as f64/inputs._record.base.public.fps as f64),"-noautorotate".into(),"-i".into(),original.to_string_lossy().into_owned(),
        "-map".into(),"0:v:0".into(),"-frames:v".into(),"1".into(),"-an".into(),"-vf".into(),"scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba".into(),"-threads".into(),"1".into(),
        "-f".into(),"rawvideo".into(),raw.to_string_lossy().into_owned()];
    let (retention,result)=launch::run(&ff,&decode,&stage,id,"Decode exact full-resolution finishing frame",Duration::from_secs(20),(inputs,permit,gpu))?;result?;
    let (mut inputs,permit,gpu)=retention;checkpoint(id)?;
    let mut decoded=cache::lease(&raw,false)?;if decoded.metadata().map_err(|e|e.to_string())?.len()!=pixels*4{return Err("Exact frame decoder returned an unexpected byte count".into());}
    let mut before=Vec::with_capacity((pixels*4)as usize);decoded.read_to_end(&mut before).map_err(|e|e.to_string())?;
    let ready=inputs._record.ready.as_ref().unwrap();let alpha=ready.index.read(&ready.masks.path,index)?;
    let mut input=fs::OpenOptions::new().write(true).create_new(true).open(&input_path).map_err(|e|e.to_string())?;
    input.write_all(&before).map_err(|e|e.to_string())?;
    let mut row=vec![0u8;width as usize];for y in 0..height {checkpoint(id)?;for x in 0..width {
        row[x as usize]=alpha[((y as u64*ready.index.height as u64/height as u64)*ready.index.width as u64+x as u64*ready.index.width as u64/width as u64)as usize];}
        input.write_all(&row).map_err(|e|e.to_string())?;}input.sync_all().map_err(|e|e.to_string())?;drop(input);
    let input=cache::lease(&input_path,false)?;
    let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
    #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);}
    let output=options.open(&output_path).map_err(|e|e.to_string())?;
    inputs._files.push(decoded);let io=input.try_clone().map_err(|e|e.to_string())?;let out=output.try_clone().map_err(|e|e.to_string())?;
    inputs._files.extend([input,output]);
    let (retention,result)=launch::run_io(&worker,&arguments(width,height,settings),&stage,id,"Full-resolution subject preview through export kernel",
        Duration::from_secs(20),(inputs,permit,gpu),io,out)?;result?;
    let (mut inputs,permit,gpu)=retention;drop(gpu);checkpoint(id)?;ready_track(tracking_id)?;
    // The output was deny-write guarded through drain. Release its writer
    // before acquiring the immutable read lease under Windows sharing rules.
    drop(inputs._files.pop());
    let mut filtered=cache::lease(&output_path,false)?;if filtered.metadata().map_err(|e|e.to_string())?.len()!=pixels*4{return Err("Finishing kernel returned an unexpected byte count".into());}
    let mut after=Vec::with_capacity(before.len());filtered.read_to_end(&mut after).map_err(|e|e.to_string())?;drop(filtered);
    let ready=inputs._record.ready.as_ref().unwrap();let settings_id=hex::encode(Sha256::digest(serde_json::to_vec(settings).map_err(|e|e.to_string())?));
    let result=json!({"trackingId":tracking_id,"preparationId":inputs._record.base.public.id,"baseIdentity":inputs._record.base.public.identity,
        "maskIdentity":ready.masks.identity,"settings":settings,"settingsIdentity":settings_id,"frame":index,"width":width,"height":height,
        "beforeDataUrl":png(width,height,before)?,"dataUrl":png(width,height,after)?,"engine":"subject-rgb709-q4-v2",
        "exportQualified":false,"note":"Full-resolution picture kernel before final H.264 encoding and graphics. No stabilization or mask inference was rerun."});
    checkpoint(id)?;ready_track(tracking_id)?;drop(inputs);drop(permit);Ok(result)
}
#[tauri::command]
pub async fn studio_subject_finish_frame(tracking_id:String,frame_index:u32,settings:Settings,preview_epoch:u32)->Result<Value,String> {
    let record=ready_track(&tracking_id)?;let mut project=record.base.project.clone();project.finishing=Some(settings.clone());validate(&project)?;
    if !settings.enabled{return Err("Enable finishing before requesting its rendered picture preview".into());}
    if !matches!((&settings.base_policy,&record.base.public.base_policy),(BasePolicy::Clean,BasePolicy::Clean)|(BasePolicy::Reuse,BasePolicy::Reuse)) {
        return Err("Finishing preview base policy changed. Prepare and select that exact base first; no implicit regeneration occurred.".into());
    }
    if frame_index>=record.base.public.frame_count{return Err("Finishing preview frame lies outside its exact base".into());}
    let slot=FrameSlot::acquire(&tracking_id)?;
    let id=format!("subject-frame-{}",chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name finishing preview")?);
    launch::poll_cleanup();
    {let mut state=jobs().lock().map_err(|e|e.to_string())?;retire_history(&mut state);
        if !still_ready(&state,&tracking_id)||!still_ready(&state,&record.base.public.id){return Err("Tracking was released before preview admission".into());}
        if record.preview_epoch.load(Ordering::Relaxed)!=preview_epoch{return Err("Finishing preview was cancelled before admission; request a new generation".into());}
        state.insert(id.clone(),StudioJob{id:id.clone(),name:format!("{} · finishing frame {frame_index}",record.base.clip.chapter),kind:"subjectFrame".into(),preview_key:tracking_id.clone(),status:"running".into(),
            width:record.base.public.width,height:record.base.public.height,fps:record.base.public.fps,created_at:chrono::Utc::now().to_rfc3339(),..StudioJob::default()});}
    tauri::async_runtime::spawn_blocking(move||{
        let _slot=slot;let base=record.base.public.id.clone();let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||frame(record,&tracking_id,frame_index,&settings,&id)))
            .unwrap_or_else(|_|Err("Finishing preview panicked; no media output was published".into()));
        let mut state=jobs().lock().map_err(|e|e.to_string())?;publish_frame_result(&mut state,&id,&tracking_id,&base,result)
    }).await.map_err(|e|e.to_string())?
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn preview_png_budget_is_enforced_during_encoding_not_after_allocation() {
        let mut writer=BoundedPng{bytes:Vec::new(),limit:4};writer.write_all(&[1,2,3]).unwrap();assert!(writer.write_all(&[4,5]).is_err());assert_eq!(writer.bytes,[1,2,3]);
        let bytes=(0..64*64*4).map(|index|((index*73+index/256)%256)as u8).collect::<Vec<_>>();
        assert!(encode_png(64,64,&bytes,128).is_err());let png=encode_png(64,64,&bytes,64*1024).unwrap();
        assert_eq!(image::load_from_memory(&png).unwrap().into_rgba8().into_raw(),bytes);
    }
    #[test] fn cancelled_or_released_preview_cannot_publish_success_at_terminal_boundary() {
        for reason in ["cancelled","released","worker-error","forgotten-job"] {
            let mut state=HashMap::from([("track".into(),StudioJob{status:"completed".into(),..StudioJob::default()}),
                ("base".into(),StudioJob{status:"completed".into(),..StudioJob::default()}),
                ("frame".into(),StudioJob{kind:"subjectFrame".into(),status:"running".into(),..StudioJob::default()})]);
            match reason {"cancelled"=>state.get_mut("frame").unwrap().cancelled=true,"released"=>state.get_mut("track").unwrap().cancelled=true,
                "worker-error"=>state.get_mut("frame").unwrap().worker_error=Some("failed drain".into()),_=>{state.remove("frame");}}
            assert!(publish_frame_result(&mut state,"frame","track","base",Ok(json!({"image":"late success"}))).is_err(),"Accepted stale success after {reason}");
            assert!(!state.get("frame").is_some_and(|job|job.status=="completed"));
        }
    }
    #[test]
    #[ignore="bounded public finishing-frame/media qualification; requires exact FFmpeg and picture worker"]
    fn public_finishing_frame_matches_full_kernel_and_protects_unselected_pixels() {
        use md5::Md5;
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-output")
            .join(format!("subject-full-preview-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();let ff=exact_ffmpeg().unwrap();
        let source=root.join("source.mp4");let result=command(&ff).args(["-v","error","-nostdin","-n","-f","lavfi","-i","testsrc2=size=320x180:rate=25",
            "-t","0.2","-c:v","libx264","-threads","2","-bf","0","-pix_fmt","yuv420p","-color_range","tv",
            "-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709","-video_track_timescale","90000"]).arg(&source).output().unwrap();
        assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));let original=compute_md5(&source).unwrap();
        let mut p=super::super::super::super::super::tests::project(&root);p.width=320;p.height=180;p.fps=25;
        p.clips[0].duration=0.2;p.clips[0].replays.clear();let clip=p.clips[0].clone();
        let base_id=format!("subject-base-preview-{}",root.file_name().unwrap().to_string_lossy());
        let id=format!("subject-masks-preview-{}",root.file_name().unwrap().to_string_lossy());
        let selection:Selection=serde_json::from_value(json!({"version":1,"baseIdentity":original,"frameCount":5,"referenceFrame":0,
            "anchors":[{"frame":0,"object":"horse","box":[0.5,0.3,0.9,0.9]},{"frame":0,"object":"rider","box":[0.6,0.1,0.8,0.5]}]})).unwrap();
        let mask_folder=root.join("fixture-masks");fs::create_dir(&mask_folder).unwrap();
        let mut bytes=b"PGMSK001".to_vec();for n in [320u32,180,5]{bytes.extend(n.to_le_bytes());}
        for _ in 0..5 {bytes.extend((180u32*10).to_le_bytes());for _ in 0..180 {for value in [0u8,255]{bytes.extend(160u32.to_le_bytes());bytes.push(value);}}}
        fs::write(mask_folder.join("masks.pgmask"),&bytes).unwrap();
        let canonical=serde_json::to_string(&cache::mask_recipe(&selection,&p).unwrap()).unwrap();
        let receipt=json!({"schema":1,"complete":true,"engine":"sam2.1-tiny-two-object-window-v1","baseChecksum":original,
            "maskIdentity":hex::encode(Sha256::digest(canonical.as_bytes())),"canonicalRecipe":canonical,
            "selection":selection,"width":320,"height":180,"fps":25,"frames":5,"profile":"limited-sdr709-yuv420p8",
            "generationProfile":cache::generation(),"subjectQualityAccepted":false,"appCommitted":true,
            "runtimeProfile":"manual-video-cpu-v1","runtimeSeal":super::super::super::super::runtime::seal_identity(),
            "mask":{"schema":1,"format":"PGMSK001","width":320,"height":180,"frames":5,"bytes":bytes.len(),
                "checksum":hex::encode(Md5::digest(&bytes)),"sha256":hex::encode(Sha256::digest(&bytes))}});
        fs::write(mask_folder.join("manifest.json"),serde_json::to_vec(&receipt).unwrap()).unwrap();
        let masks=cache::verified_masks(&mask_folder,&selection,&p,None).unwrap();let index=MaskIndex::new(&masks.path,5,None).unwrap();
        let base=Arc::new(Prepared{public:PreparedBase{version:1,id:base_id.clone(),clip_id:clip.id.clone(),identity:original.clone(),width:320,height:180,fps:25,frame_count:5,
            base_policy:BasePolicy::Reuse,reused:true,contains_global_sharpening:false,warnings:vec![]},path:source.clone(),ff:ff.clone(),key:"synthetic-verified-base".into(),
            sha256:cache::hashes(&mut cache::lease(&source,false).unwrap(),None).unwrap().2,project:p,clip,folder:root.clone(),_root:cache::OwnedRoot::open(&root).unwrap(),_tool_root:cache::OwnedRoot::open(ff.parent().unwrap()).unwrap(),
            _files:vec![cache::lease(&source,false).unwrap()]});
        {let mut state=jobs().lock().unwrap();for (key,kind) in [(&base_id,"subjectBase"),(&id,"subjectMasks")]{state.insert(key.clone(),StudioJob{kind:kind.into(),status:"completed".into(),..StudioJob::default()});}
            prepared().lock().unwrap().insert(base_id.clone(),base.clone());tracks().lock().unwrap().insert(id.clone(),Arc::new(Tracking{base:base.clone(),selection,ready:Some(Arc::new(MaskReady{masks,index})),preview_epoch:Arc::new(std::sync::atomic::AtomicU32::new(0))}));}
        let mut settings=Settings{enabled:true,..Settings::default()};settings.colour.light_ev=0.3;
        let epoch=studio_subject_finish_epoch(id.clone()).unwrap();studio_subject_finish_cancel(id.clone()).unwrap();
        assert!(tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),3,settings.clone(),epoch)).is_err(),"Cancellation before admission was lost");
        let epoch=studio_subject_finish_epoch(id.clone()).unwrap();
        // Occupy the real host scheduler without allocating video buffers or
        // launching background media work. Its full CPU reservation prevents
        // preview admission, exercising the public timeout and FrameSlot drop.
        let held=studio_hardware::acquire_with_threads(320,180,"max",crate::utils::num_cpus(),||false).unwrap();
        let started=std::time::Instant::now();
        let timeout=tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),3,settings.clone(),epoch)).unwrap_err();
        assert!(timeout.contains("waited too long for host processing capacity"),"{timeout}");
        assert!(started.elapsed()>=Duration::from_secs(20));assert!(started.elapsed()<Duration::from_secs(30),"Public preview did not bound host admission");
        drop(held);
        // The same tracking/frame must become usable again. A leaked FrameSlot
        // or input lease would fail this public retry or scratch cleanup below.
        let response=tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),3,settings.clone(),epoch)).unwrap();
        assert_eq!(response["width"],320);assert_eq!(response["height"],180);assert_eq!(response["frame"],3);assert_eq!(response["exportQualified"],false);
        let decoded=command(&ff).args(["-v","error","-nostdin","-threads","2","-i"]).arg(&source)
            .args(["-frames:v","1","-an","-vf","select=eq(n\\,3),scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba","-threads","1","-f","rawvideo","-"]).output().unwrap();
        assert!(decoded.status.success());let before=decoded.stdout;
        assert_eq!(response["beforeDataUrl"],png(320,180,before.clone()).unwrap(),"Timestamp preview selected the wrong integer frame");
        let input=root.join("oracle.rgba");let mut data=before.clone();for _ in 0..180{data.extend(vec![0;160]);data.extend(vec![255;160]);}fs::write(&input,data).unwrap();
        let mut args=arguments(320,180,&settings);args[6]="cpu".into();
        let oracle=command(&pipeline::worker().unwrap()).args(args).stdin(std::process::Stdio::from(fs::File::open(input).unwrap())).output().unwrap();
        assert!(oracle.status.success(),"{}",String::from_utf8_lossy(&oracle.stderr));let after=oracle.stdout;
        assert_eq!(response["dataUrl"],png(320,180,after.clone()).unwrap(),"Public full-resolution preview differs from the CPU export kernel");
        // Manual review is its own native-owned evidence, not clip approval,
        // model acceptance, finishing settings or a mutable generator receipt.
        let metadata=studio_subject_tracked(id.clone()).unwrap();assert_eq!(metadata["reviewed"],false);
        let generated=fs::read(mask_folder.join("manifest.json")).unwrap();let masks_before=fs::read(mask_folder.join("masks.pgmask")).unwrap();
        let sampled=super::super::review::ReviewRequest{decision:super::super::review::Decision::Approve,
            coverage:super::super::review::Coverage::SampledFrames,frames:vec![0,3]};
        let accepted=studio_subject_mask_review(id.clone(),sampled.clone()).unwrap();
        assert_eq!(accepted["reviewed"],false,"Reviewing two frames is not entire-clip approval");assert_eq!(accepted["exportQualified"],false);
        assert_eq!(accepted["review"]["coverage"],"sampledFrames");assert_eq!(accepted["review"]["frames"],json!([0,3]));
        assert_eq!(accepted["review"]["assertionKind"],"user-asserted");
        assert_eq!(studio_subject_tracked(id.clone()).unwrap()["review"],accepted["review"],"Manual receipt was not read back through the tracking interface");
        let old=tracks().lock().unwrap().get(&id).unwrap().clone();
        let recovered=format!("{id}-recovered");
        jobs().lock().unwrap().insert(recovered.clone(),StudioJob{kind:"subjectMasks".into(),status:"completed".into(),..StudioJob::default()});
        tracks().lock().unwrap().insert(recovered.clone(),old.clone());
        assert_eq!(studio_subject_tracked(recovered.clone()).unwrap()["review"],accepted["review"],"Durable review must not depend on an old session handle");
        studio_subject_tracking_forget(recovered.clone()).unwrap();jobs().lock().unwrap().remove(&recovered);
        assert!(serde_json::from_value::<super::super::review::ReviewRequest>(json!({"decision":"approve","coverage":"entireClip","frames":[0,3]})).is_err(),"Sampled review must not inflate to whole-clip approval");
        let rejected=super::super::review::ReviewRequest{decision:super::super::review::Decision::Reject,..sampled.clone()};
        let flagged=studio_subject_mask_review(id.clone(),rejected).unwrap();
        assert_eq!(flagged["reviewed"],false);assert_eq!(flagged["review"]["decision"],"reject");
        assert_eq!(studio_subject_tracked(id.clone()).unwrap()["review"]["decision"],"reject","A later rejection must supersede sampled approval");
        let invalid=super::super::review::ReviewRequest{frames:vec![5],..sampled.clone()};assert!(studio_subject_mask_review(id.clone(),invalid).is_err());
        let invalid=super::super::review::ReviewRequest{frames:vec![3,0],..sampled.clone()};assert!(studio_subject_mask_review(id.clone(),invalid).is_err());
        assert_eq!(fs::read(mask_folder.join("manifest.json")).unwrap(),generated);assert_eq!(fs::read(mask_folder.join("masks.pgmask")).unwrap(),masks_before);
        let mut changed=0;for y in 0..180 {for x in 0..320 {let at=(y*320+x)*4;if x<160{assert_eq!(&before[at..at+4],&after[at..at+4],"Unselected background changed");}
            else if before[at..at+4]!=after[at..at+4]{changed+=1;}}}assert!(changed>0,"The selected subject must actually be filtered");
        assert_eq!(compute_md5(&source).unwrap(),original);assert!(fs::OpenOptions::new().write(true).open(&source).is_err());
        for directory in fs::read_dir(cache::finishing_root(&root).unwrap().path).unwrap(){assert_eq!(fs::read_dir(directory.unwrap().path()).unwrap().count(),0,"Preview scratch bytes survived proven drain");}
        assert!(tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),5,settings.clone(),epoch)).is_err());
        settings.base_policy=BasePolicy::Clean;assert!(tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),0,settings,epoch)).is_err());
        let cancelled=super::super::review::cancel_before_commit(id.clone(),sampled.clone()).unwrap_err();
        assert!(cancelled.contains("released or cancelled"));assert!(!mask_folder.join("reviews/review-0003.json").exists(),"Cancellation must prevent a committed review");
        assert_eq!(fs::read(mask_folder.join("manifest.json")).unwrap(),generated);assert_eq!(fs::read(mask_folder.join("masks.pgmask")).unwrap(),masks_before);
        studio_subject_forget(base_id.clone()).unwrap();assert!(tauri::async_runtime::block_on(studio_subject_finish_frame(id.clone(),0,Settings{enabled:true,..Settings::default()},epoch)).is_err());
        assert!(studio_subject_mask_review(id.clone(),sampled).is_err(),"Released tracking must not record a review");
        assert!(source.is_file());drop(base);let mut state=jobs().lock().unwrap();state.remove(&base_id);state.remove(&id);
        println!("Public full-resolution preview exact frame/kernel/background/cancellation checks passed; synthetic fixture only: {}",root.display());
    }
    #[test] fn preview_arguments_and_cancel_are_bounded_to_the_same_kernel_and_tracking_owner() {
        let settings=Settings{enabled:true,..Settings::default()};let args=arguments(3840,2160,&settings);
        assert_eq!(args.len(),16);assert_eq!(&args[..7],["--finish","3840","2160","26","32","1","auto"]);
        let mut state=HashMap::from([("frame".into(),StudioJob{kind:"subjectFrame".into(),preview_key:"owner".into(),..StudioJob::default()}),
            ("other".into(),StudioJob{kind:"subjectFrame".into(),preview_key:"different".into(),..StudioJob::default()}),
            ("render".into(),StudioJob{kind:"render".into(),preview_key:"owner".into(),..StudioJob::default()})]);
        cancel_for_track(&mut state,"owner");assert!(state["frame"].cancelled);assert!(!state["other"].cancelled);assert!(!state["render"].cancelled);
    }
}
