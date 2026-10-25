//! Selection uses a full native-owned base, never an original thumbnail or
//! independently stabilized preview excerpt. Export remains separately gated.
use super::*;
use sha2::Sha256;
mod tracking;
pub use tracking::{studio_subject_track,studio_subject_tracked,studio_subject_tracking_forget,studio_subject_mask_frame,studio_subject_mask_review};
pub use tracking::{studio_subject_finish_frame,studio_subject_finish_cancel,studio_subject_finish_epoch};

// Fail busy before queuing a blocking task. One request per preparation and
// two across the app bound both pending work and live decoders during scrubbing.
struct FrameSlot(String);
fn frame_slots()->&'static Mutex<Vec<String>> {
    static SLOTS:OnceLock<Mutex<Vec<String>>>=OnceLock::new();
    SLOTS.get_or_init(||Mutex::new(Vec::new()))
}
impl FrameSlot {
    fn acquire(id:&str)->Result<Self,String> {
        let mut slots=frame_slots().lock().map_err(|e|e.to_string())?;
        if slots.len()>=2||slots.iter().any(|value|value==id) {
            return Err("Subject frame reader is busy; retain only the latest requested frame and retry after the current read".into());
        }
        slots.push(id.into());Ok(Self(id.into()))
    }
}
impl Drop for FrameSlot {fn drop(&mut self){frame_slots().lock().unwrap_or_else(|e|e.into_inner()).retain(|id|id!=&self.0);}}

#[derive(Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct PreparedBase {
    version:u32,id:String,clip_id:String,identity:String,width:u32,height:u32,fps:u32,frame_count:u32,
    base_policy:BasePolicy,reused:bool,contains_global_sharpening:bool,warnings:Vec<String>,
}
struct Prepared {
    public:PreparedBase,sha256:String,path:PathBuf,ff:PathBuf,key:String,project:Project,clip:Clip,
    folder:PathBuf,_root:cache::OwnedRoot,_tool_root:cache::OwnedRoot,_files:Vec<fs::File>,
}
fn prepared()->&'static Mutex<HashMap<String,Arc<Prepared>>> {
    static STORE:OnceLock<Mutex<HashMap<String,Arc<Prepared>>>>=OnceLock::new();
    STORE.get_or_init(||Mutex::new(HashMap::new()))
}
/// Ephemeral review history is not restart-persisted. Retire only detached,
/// drained terminal metadata; never media, live handles or ordinary render jobs.
/// Caller holds jobs first and must poll quarantine before taking that mutex.
pub(super) fn retire_history(state:&mut HashMap<String,StudioJob>) {
    let mut protected=prepared().lock().unwrap_or_else(|e|e.into_inner()).keys().cloned().collect::<std::collections::HashSet<_>>();
    protected.extend(tracking::protected_ids());
    protected.extend(frame_slots().lock().unwrap_or_else(|e|e.into_inner()).iter().cloned());
    retire_detached_history(state,&protected);
}
fn retire_detached_history(state:&mut HashMap<String,StudioJob>,protected:&std::collections::HashSet<String>) {
    let mut terminal=state.iter().filter(|(id,job)|((job.kind=="subjectBase"&&id.starts_with("subject-base-"))||(job.kind=="subjectMasks"&&id.starts_with("subject-masks-"))||(job.kind=="subjectFrame"&&id.starts_with("subject-frame-")))
        &&["completed","failed","cancelled"].contains(&job.status.as_str())&&!job.recoverable&&!protected.contains(*id)
        &&job.process_id.is_none()&&job.process_ids.is_empty()&&job.active_tasks.is_empty())
        .map(|(id,job)|(chrono::DateTime::parse_from_rfc3339(&job.finished_at).ok().or_else(||chrono::DateTime::parse_from_rfc3339(&job.created_at).ok()),id.clone())).collect::<Vec<_>>();
    terminal.sort();let retiring=terminal.len().saturating_sub(64);
    for (_,id) in terminal.into_iter().take(retiring){state.remove(&id);}
}
fn exact_ffmpeg()->Result<PathBuf,String> {
    #[cfg(test)] if let Some(path)=std::env::var_os("PHOTOGOGO_TEST_FFMPEG") {return PathBuf::from(path).canonicalize().map_err(|e|e.to_string());}
    let path=detect_ffmpeg_capabilities()?.binary;
    if !path.is_absolute()||!path.is_file(){return Err("Subject preparation requires the exact installed/bundled FFmpeg path; no PATH substitute was launched".into());}
    path.canonicalize().map_err(|e|e.to_string())
}
fn source_profile(info:&Value)->Result<(),String> {
    let videos=info["streams"].as_array().ok_or("Missing source streams")?.iter()
        .filter(|s|s["codec_type"]=="video").collect::<Vec<_>>();
    if videos.len()!=1{return Err("Subject finishing requires one known SDR camera video stream".into());}
    let v=videos[0];
    if v["codec_name"]!="h264"||!["yuv420p","yuvj420p","nv12"].contains(&v["pix_fmt"].as_str().unwrap_or(""))
        ||v["field_order"]!="progressive"||!["pc","tv"].contains(&v["color_range"].as_str().unwrap_or(""))
        ||["color_space","color_transfer","color_primaries"].iter().any(|field|v[*field]!="bt709") {
        return Err("Subject finishing v1 requires explicitly declared progressive 8-bit SDR BT.709 H.264 footage. Unknown colour, Log/HDR and higher precision are not silently converted.".into());
    }
    Ok(())
}
fn directory(parent:&cache::OwnedRoot,name:&str)->Result<cache::OwnedRoot,String> {
    // Format names contain Mbps; unlike user paths this name is computed solely
    // from validated integers and the bounded generation key.
    if name.is_empty()||name.len()>128||!name.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'.')||name.contains("..") {
        return Err("Invalid generated preparation directory".into());
    }
    let path=parent.path.join(name);if !path.exists(){fs::create_dir(&path).map_err(|e|e.to_string())?;}
    cache::OwnedRoot::open(&path)
}
fn frame_count(info:&Value)->Result<u32,String> {
    info["streams"].as_array().and_then(|s|s.iter().find(|s|s["codec_type"]=="video"))
        .and_then(|s|s["nb_frames"].as_str()).and_then(|s|s.parse::<u32>().ok())
        .filter(|n|(1..=1_800_000).contains(n)).ok_or("Normalized base has no bounded exact frame count".into())
}
fn effective_policy(p:&Project)->BasePolicy {if clean_base(p){BasePolicy::Clean}else{BasePolicy::Reuse}}
fn schedule_step(info:&Value,fps:u32)->Result<u64,String> {
    let video=info["streams"].as_array().and_then(|s|s.iter().find(|s|s["codec_type"]=="video")).ok_or("Missing base video schedule")?;
    let time_base=video["time_base"].as_str().and_then(|v|v.strip_prefix("1/")).and_then(|v|v.parse::<u64>().ok());
    if video["start_pts"]!=0||video["start_time"].as_str().and_then(|v|v.parse::<f64>().ok())!=Some(0.) {
        return Err("Subject selection requires a zero-origin normalized frame schedule".into());
    }
    time_base.filter(|denom|*denom>0&&fps>0&&*denom%fps as u64==0).map(|denom|denom/fps as u64)
        .ok_or("Subject selection requires an exact integer CFR time base".into())
}
fn packet_schedule(bytes:&[u8],step:u64,count:u32)->Result<(),String> {
    let text=std::str::from_utf8(bytes).map_err(|_|"Invalid base packet schedule")?;
    let mut stamps=Vec::with_capacity(count as usize);
    for line in text.lines() {
        if stamps.len()>=count as usize{return Err("Base contains extra video packets".into());}
        stamps.push(line.trim().parse::<u64>().map_err(|_|"Base has an unknown or negative frame timestamp")?);
    }
    // Packet order may differ from display order when legacy x264 used B frames.
    stamps.sort_unstable();
    if stamps.len()!=count as usize||stamps.iter().enumerate().any(|(i,stamp)|*stamp!=i as u64*step) {
        return Err("Subject base does not have one packet per exact zero-origin CFR frame; no timestamp-based selection was admitted".into());
    }
    Ok(())
}
fn verify_schedule(ff:&Path,path:&Path,info:&Value,fps:u32,count:u32)->Result<(),String> {
    let step=schedule_step(info,fps)?;
    let path=path.to_str().ok_or("Prepared media path is not Unicode")?;
    let output=super::super::super::process::command_output_limited(&ffprobe(ff),
        &["-v","error","-select_streams","v:0","-show_packets","-show_entries","packet=pts","-of","csv=p=0",path],
        64*1024*1024,Duration::from_secs(120))?;
    if !output.status.success(){return Err("Cannot verify the full base frame schedule".into());}
    packet_schedule(&output.stdout,step,count)
}
fn load_base(root:cache::OwnedRoot,recipe:&Value,id:&str,p:&Project,c:&Clip,ff:&Path,folder:&Path,key:&str)->Result<Prepared,String> {
    let mut manifest=cache::lease(&root.child("manifest.json")?,false)?;
    let receipt=cache::bounded_json(&mut manifest)?;
    if receipt["schema"]!=1||receipt["complete"]!=true||receipt["recipe"]!=*recipe {
        return Err("Existing subject base receipt is incomplete or stale. It was preserved, not overwritten.".into());
    }
    let path=root.child("base.mp4")?;let mut file=cache::lease(&path,false)?;
    let (bytes,md5,sha)=cache::hashes(&mut file,Some(id))?;
    if receipt["base"]["bytes"]!=bytes||receipt["base"]["checksum"]!=md5||receipt["base"]["sha256"]!=sha {
        return Err("Subject base failed its full content receipt; it was preserved, not reused".into());
    }
    let info=inspect(ff,&path)?;let count=frame_count(&info)?;
    cache::validate_profile(&info,p,count)?;verify_output(&info,p,count as f64/p.fps as f64)?;
    verify_schedule(ff,&path,&info,p.fps,count)?;
    let policy=effective_policy(p);
    let global=c.stabilization!="off"&&c.stabilization_method=="quality"&&!clean_base(p);
    let warnings=if global {vec!["This reused-policy Quality base already contains whole-frame sharpening. Subject finishing cannot undo it. Choose explicit clean-base regeneration for the best bokeh preservation.".into()]}else{vec![]};
    let tool_root=cache::OwnedRoot::open(ff.parent().ok_or("Missing exact media tool directory")?)?;
    let ff_file=cache::lease(ff,false)?;let probe_file=cache::lease(&tool_root.path.join("ffprobe.exe"),false)?;
    Ok(Prepared{public:PreparedBase{version:1,id:id.into(),clip_id:c.id.clone(),identity:md5,width:p.width,height:p.height,fps:p.fps,
        frame_count:count,base_policy:policy,reused:receipt["reused"]==true,contains_global_sharpening:global,warnings},
        sha256:sha,path,ff:ff.into(),key:key.into(),project:p.clone(),clip:c.clone(),folder:folder.into(),_root:root,_tool_root:tool_root,_files:vec![file,manifest,ff_file,probe_file]})
}
fn prepare(mut p:Project,mut c:Clip,staging:&str,id:&str,allow_generation:bool)->Result<Prepared,String> {
    validate(&p)?;checkpoint(id)?;
    let ff=exact_ffmpeg()?;let tool_root=cache::OwnedRoot::open(ff.parent().ok_or("Missing media tool directory")?)?;
    let mut tool=cache::lease(&ff,false)?;let (_,_,tool_sha)=cache::hashes(&mut tool,Some(id))?;
    let _probe=cache::lease(&tool_root.path.join("ffprobe.exe"),false)?;
    // Preserve the caller's original staging authority until the source and
    // every lexical parent are leased. Never derive new authority from c.path.
    let _staging_root=cache::OwnedRoot::open(Path::new(staging))?;
    let lexical=Path::new(&c.path);
    if !lexical.is_absolute(){return Err("Subject source must retain its admitted absolute path".into());}
    let _lexical_parent=cache::OwnedRoot::open(lexical.parent().ok_or("Missing admitted source parent")?)?;
    let source_path=source(&_staging_root.path,&c.path)?;
    let _source_root=cache::OwnedRoot::open(source_path.parent().ok_or("Missing source directory")?)?;
    let mut source_file=cache::lease(&source_path,false)?;let (_,_,source_sha)=cache::hashes(&mut source_file,Some(id))?;
    let source_info=inspect(&ff,&source_path)?;source_profile(&source_info)?;
    c.path=source_path.to_string_lossy().into_owned();c.duration=duration(&source_info)?;
    let estimated_frames=c.duration*p.fps as f64;
    if !estimated_frames.is_finite()||estimated_frames<1.||estimated_frames.ceil()>1_800_000. {
        return Err("Subject base exceeds the bounded output-frame budget; no generation was started".into());
    }
    p.output_dir=fs::canonicalize(&p.output_dir).map_err(|e|format!("Choose an existing output folder: {e}"))?.to_string_lossy().into_owned();
    let output=cache::OwnedRoot::open(Path::new(&p.output_dir))?;
    let legacy_root=directory(&output,".photogogo-video-studio-cache")?;
    let format_root=directory(&legacy_root,&format_key(&p))?;
    let root=cache::finishing_root(&format_root.path)?;
    let encoder_name=if p.encoder_preference=="cpu"{"libx264"}else{studio_hardware::select_encoder(&detect_ffmpeg_capabilities()?)};
    let source_key=source_signature(&source_path)?;
    let key=stabilization::base_key(&p,&c,&source_key,encoder_name)?;
    let recipe=json!([1,"owned-full-subject-base-sdr709-v1",key,source_sha,tool_sha]);
    let name=format!("base-{}",hex::encode(Sha256::digest(serde_json::to_vec(&recipe).map_err(|e|e.to_string())?)));
    let _lock=cache::lock_owned(&root,&name,id)?;let target=root.child(&name)?;
    if target.exists(){return load_base(cache::OwnedRoot::open(&target)?,&recipe,id,&p,&c,&ff,&format_root.path,&key);}
    if !allow_generation {
        return Err("This exact normalized subject base has not been prepared. Prepare and select it in the clip's Finishing step first; export did not repeat stabilization or regenerate a clean base.".into());
    }
    let required=(c.duration*(effective_bitrate(&p) as f64*1_000_000.+256_000.)/8.*3.) as u64+64*1024*1024;
    if fs2::available_space(&output.path).map_err(|e|e.to_string())?<required {return Err("Not enough output-disk space for a separate full-base preparation; old caches were preserved".into());}
    let _reservation=reserve_disk(&output.path,required)?;
    let stamp=chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name preparation")?;
    let stage=format!("{name}-{stamp}.partial");
    let stage_path=root.child(&stage)?;fs::create_dir(&stage_path).map_err(|e|e.to_string())?;
    let stage_root=cache::OwnedRoot::open(&stage_path)?;
    // Windows subprocess working directories have a tighter length limit than
    // extended-length media paths. Keep the working directory shallow; final
    // publication still uses the separate, digest-addressed partial stage.
    let work=directory(&root,&format!("work-{stamp}"))?;
    let isolated=directory(&work,"motion-cache")?;
    let legacy=format_root.path.join(cache_name("base",&c,&p,&key));
    let mut adopted=None;
    if legacy.is_file() {
        let _legacy_lock=cache::lock_legacy_fragment(&legacy,id)?;
        let legacy_guard=cache::lease(&legacy,false)?;
        let record_guard=cache::lease(&fragment_record_path(&legacy),false)?;
        if cached_video_is_valid(&ff,&legacy,&p,c.duration,&key){adopted=Some((legacy,legacy_guard,record_guard));}
    }
    let reused=adopted.is_some();
    let base=if let Some((path,_,_))=&adopted {
        update(id,|j|j.logs.push("Adopted existing full stabilized base under immutable content leases; no stabilization pass. Original cache preserved.".into()));path.clone()
    }else{
        prepare_stabilized_base(&p,&c,0,&ff,encoder_name,false,None,None,id,&work.path,&isolated.path)?.path
    };
    let base_guard=cache::lease(&base,false)?;
    let info=inspect(&ff,&base)?;let count=frame_count(&info)?;verify_output(&info,&p,count as f64/p.fps as f64)?;
    // The exact legacy recipe admits only normalized limited-range pictures.
    // This stream-copy operation adds missing SDR signalling; it does NOT
    // reinterpret camera Log/HDR pixels, sharpen, rescale or restabilize.
    let normalized=stage_root.child("base.mp4")?;
    run(&ff,&p,vec!["-i".into(),base.to_string_lossy().into_owned(),"-map".into(),"0:v:0".into(),"-map".into(),"0:a:0".into(),
        "-c".into(),"copy".into(),"-bsf:v".into(),"h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1".into(),
        "-color_range".into(),"tv".into(),"-colorspace".into(),"bt709".into(),"-color_primaries".into(),"bt709".into(),"-color_trc".into(),"bt709".into(),
        normalized.to_string_lossy().into_owned()],&work.path,id,"Prepare selection metadata without picture re-encoding",count as f64/p.fps as f64,90.,5.)?;
    let mut file=cache::lease(&normalized,false)?;let expected=cache::hashes(&mut file,Some(id))?;
    cache::validate_profile(&inspect(&ff,&normalized)?,&p,count)?;drop(file);drop(base_guard);drop(adopted);
    // Release only owned stage directory handles for the no-replace move.
    drop(work);drop(isolated);drop(stage_root);
    cache::move_stage(&root,&stage,&name,id)?;let final_root=cache::OwnedRoot::open(&target)?;
    let _final_file=cache::lease_matching(&final_root.child("base.mp4")?,&expected,Some(id))?;
    let receipt=json!({"schema":1,"complete":true,"recipe":recipe,"reused":reused,"frames":count,
        "base":{"bytes":expected.0,"checksum":expected.1,"sha256":expected.2},"subjectQualityAccepted":false});
    let _manifest=cache::commit_marker(&final_root,&receipt,id)?;
    load_base(final_root,&recipe,id,&p,&c,&ff,&format_root.path,&key)
}

#[tauri::command]
pub fn studio_subject_prepare(project:Project,staging_dir:String,clip_id:String)->Result<String,String> {
    launch::poll_cleanup();
    validate(&project)?;
    let clip=project.clips.iter().find(|c|c.id==clip_id).cloned().ok_or("Unknown subject clip")?;
    let mut jobs=jobs().lock().map_err(|e|e.to_string())?;
    retire_history(&mut jobs);
    let pending=jobs.values().filter(|j|j.kind=="subjectBase"&&["queued","running","paused"].contains(&j.status.as_str())).count();
    if pending>=2{return Err("Two subject bases are already being prepared; wait for one to finish before adding another".into());}
    if prepared().lock().map_err(|e|e.to_string())?.len()+pending>=128 {
        return Err("Forget an old subject preparation before opening another; cached video is never deleted".into());
    }
    let id=format!("subject-base-{}-{}",chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name preparation")?,std::process::id());
    jobs.insert(id.clone(),StudioJob{id:id.clone(),name:format!("{} · prepare subject base",clip.chapter),kind:"subjectBase".into(),clip_id:Some(clip_id),status:"queued".into(),
        width:project.width,height:project.height,fps:project.fps,created_at:chrono::Utc::now().to_rfc3339(),..StudioJob::default()});drop(jobs);
    let running=id.clone();
    if let Err(error)=thread::Builder::new().name("subject-base-preparation".into()).spawn(move|| {
        update(&running,|j|{j.status="running".into();j.started_ms=Some(chrono::Utc::now().timestamp_millis());j.started_at=chrono::Utc::now().to_rfc3339();});
        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||prepare(project,clip,&staging_dir,&running,true)))
            .unwrap_or_else(|_|Err("Subject preparation panicked; uncommitted files were preserved".into()));
        finish_preparation(&running,result);
    }) {update(&id,|j|{j.status="failed".into();j.error=Some(format!("Cannot start subject preparation: {error}"));});return Err(error.to_string());}
    Ok(id)
}

/// Export must consume the SAME normalized, leased full base used for prompts.
/// A render request is not permission to silently regenerate a missing base.
pub(in crate::commands::video_studio) struct ExportBase {
    pub path:PathBuf,pub key:String,pub seconds:f64,_prepared:Prepared,
}
pub(in crate::commands::video_studio) fn existing_export_base(p:&Project,c:&Clip,ff:&Path,staging:&Path,id:&str)->Result<ExportBase,String> {
    let selection=c.finishing_selection.as_ref().ok_or("Select the horse and rider on the prepared base before exporting subject finishing")?;
    selection.validate()?;
    let staging=staging.to_str().ok_or("Original source authority is not Unicode")?;
    let base=prepare(p.clone(),c.clone(),staging,id,false)?;
    if base.ff!=ff.canonicalize().map_err(|e|e.to_string())?||selection.base_identity!=base.public.identity
        ||selection.frame_count!=base.public.frame_count {
        return Err("The export base/tool no longer matches this clip's exact selected base. Prepare and review again; no old masks were applied.".into());
    }
    Ok(ExportBase{path:base.path.clone(),key:base.key.clone(),seconds:base.public.frame_count as f64/base.public.fps as f64,_prepared:base})
}
fn finish_preparation(id:&str,result:Result<Prepared,String>) {
    // update holds the cancellation/job mutex. Readers and forget take that
    // same mutex before the registry, so readiness and insertion are atomic.
    update(id,|j|{j.finished_at=chrono::Utc::now().to_rfc3339();match result {
        Ok(base) if !j.cancelled&&j.worker_error.is_none()=>{
            prepared().lock().unwrap_or_else(|e|e.into_inner()).insert(id.into(),Arc::new(base));
            j.status="completed".into();j.phase="Full base ready for horse/rider selection".into();j.progress=100.;
        },
        Ok(_)=>{j.status=if j.cancelled{"cancelled"}else{"failed"}.into();},
        Err(error)=>{j.status=if j.cancelled{"cancelled"}else{"failed"}.into();j.error=Some(error);},
    }});
}
fn ready_preparation(id:&str)->Result<Arc<Prepared>,String> {
    let state=jobs().lock().map_err(|e|e.to_string())?;
    if state.get(id).is_none_or(|j|j.status!="completed"||j.cancelled||j.worker_error.is_some()) {
        return Err("This full-base preparation is not ready or has been forgotten".into());
    }
    prepared().lock().map_err(|e|e.to_string())?.get(id).cloned().ok_or("This full-base preparation has been forgotten".into())
}
#[tauri::command]
pub fn studio_subject_prepared(preparation_id:String)->Result<PreparedBase,String> {
    Ok(ready_preparation(&preparation_id)?.public.clone())
}
#[tauri::command]
pub fn studio_subject_forget(preparation_id:String)->Result<(),String> {
    let mut state=jobs().lock().map_err(|e|e.to_string())?;
    if let Some(job)=state.get_mut(&preparation_id) {
        if job.kind!="subjectBase"{return Err("Only a subject-base preparation can be forgotten here".into());}
        // Also tombstone pending work. Its worker cannot resurrect this ID.
        job.cancelled=true;job.paused=false;
    }
    tracking::forget_for_base(&mut state,&preparation_id);
    prepared().lock().map_err(|e|e.to_string())?.remove(&preparation_id);Ok(())
}
#[tauri::command]
pub async fn studio_subject_frame(preparation_id:String,frame:u32)->Result<Value,String> {
    let base=ready_preparation(&preparation_id)?;
    if frame>=base.public.frame_count{return Err("Subject frame lies outside its exact base".into());}
    let slot=FrameSlot::acquire(&preparation_id)?;
    tauri::async_runtime::spawn_blocking(move|| {
        let _slot=slot;
        let began=std::time::Instant::now();
        let _permit=studio_hardware::acquire_with_threads(base.public.width,base.public.height,"balanced",4,
            ||began.elapsed()>=Duration::from_secs(20)||ready_preparation(&base.public.id).is_err())?;
        if ready_preparation(&base.public.id).is_err(){return Err("Subject preparation was forgotten before its frame read".into());}
        let at=format!("{:.9}",frame as f64/base.public.fps as f64);
        let path=base.path.to_str().ok_or("Prepared media path is not Unicode")?;
        let output=super::super::super::process::command_output_limited(&base.ff,&["-v","error","-nostdin","-filter_threads","1","-threads","2","-ss",&at,"-i",path,
            "-frames:v","1","-an","-vf","scale=960:-2","-threads","2","-f","image2pipe","-c:v","mjpeg","-"],4*1024*1024,Duration::from_secs(20))?;
        if !output.status.success()||output.stdout.is_empty(){return Err("Cannot read the exact prepared frame; no original thumbnail substitute was used".into());}
        Ok(json!({"preparationId":base.public.id,"baseIdentity":base.public.identity,"frame":frame,
            "dataUrl":format!("data:image/jpeg;base64,{}",crate::utils::base64_encode(&output.stdout))}))
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detached_subject_history_is_capped_without_touching_handles_drain_or_regular_renders() {
        let mut state=HashMap::new();
        for index in 0..100 {let id=format!("subject-masks-terminal-{index:03}");state.insert(id.clone(),StudioJob{id,kind:"subjectMasks".into(),status:"failed".into(),created_at:format!("2026-10-10T00:00:{:02}.{:03}Z",index/2,index%2),..StudioJob::default()});}
        for status in ["queued","running","paused"] {state.insert(format!("subject-masks-{status}"),StudioJob{kind:"subjectMasks".into(),status:status.into(),cancelled:true,..StudioJob::default()});}
        state.insert("render".into(),StudioJob{kind:"render".into(),status:"completed".into(),..StudioJob::default()});
        for key in ["process","descendants","tasks"] {let mut job=StudioJob{kind:"subjectMasks".into(),status:"cancelled".into(),..StudioJob::default()};
            match key {"process"=>job.process_id=Some(123),"descendants"=>job.process_ids=vec![456],_=>job.active_tasks=vec![ActiveTask::default()]};state.insert(format!("subject-masks-{key}"),job);}
        let protected=std::collections::HashSet::from(["subject-masks-terminal-000".into()]);
        retire_detached_history(&mut state,&protected);
        assert_eq!(state.len(),72);assert!(state.contains_key("subject-masks-terminal-000"));assert!(!state.contains_key("subject-masks-terminal-001"));
        assert!(!state.contains_key("subject-masks-terminal-035"));assert!(state.contains_key("subject-masks-terminal-036"));
        assert!(state.contains_key("render"));for id in ["queued","running","paused","process","descendants","tasks"] {assert!(state.contains_key(&format!("subject-masks-{id}")));}
        retire_detached_history(&mut state,&protected);assert_eq!(state.len(),72);
        state.get_mut("subject-masks-process").unwrap().process_id=None;
        retire_detached_history(&mut state,&protected);assert_eq!(state.len(),71);assert!(!state.contains_key("subject-masks-process"),"Only proven drain may make detached history eligible");
    }
    #[test]
    fn frame_admission_has_no_unbounded_pending_queue_and_returns_capacity() {
        let first=FrameSlot::acquire("frame-budget-one").unwrap();
        assert!(FrameSlot::acquire("frame-budget-one").is_err());
        let second=FrameSlot::acquire("frame-budget-two").unwrap();
        assert!(FrameSlot::acquire("frame-budget-three").is_err());
        drop(first);let third=FrameSlot::acquire("frame-budget-three").unwrap();drop(second);drop(third);
        assert!(frame_slots().lock().unwrap().is_empty());
    }
    #[test]
    fn timestamp_reader_admits_only_verified_integer_zero_origin_schedules() {
        let good=json!({"streams":[{"codec_type":"video","start_pts":0,"start_time":"0.000000","time_base":"1/90000"}]});
        for fps in [25,30,50,60]{assert_eq!(schedule_step(&good,fps).unwrap(),90_000/fps as u64);}
        let mut bad=good.clone();bad["streams"][0]["start_pts"]=json!(1);assert!(schedule_step(&bad,50).is_err());
        bad=good.clone();bad["streams"][0]["time_base"]=json!("1/1001");assert!(schedule_step(&bad,50).is_err());
        packet_schedule(b"0\n3600\n1800\n",1800,3).unwrap();
        for bytes in [b"0\n1800\n1800\n".as_slice(),b"0\n1801\n3600\n",b"-1\n1800\n3600\n",b"0\n1800\n",b"0\n1800\n3600\n5400\n"] {
            assert!(packet_schedule(bytes,1800,3).is_err());
        }
    }
    #[test]
    fn disabled_clean_request_reports_effective_reuse_and_forget_tombstones_pending_work() {
        let mut p=super::super::super::tests::project(Path::new("."));
        p.finishing=Some(Settings{base_policy:BasePolicy::Clean,..Settings::default()});
        assert!(matches!(effective_policy(&p),BasePolicy::Reuse));
        p.finishing.as_mut().unwrap().enabled=true;assert!(matches!(effective_policy(&p),BasePolicy::Clean));
        let id="subject-pending-forget-test";
        jobs().lock().unwrap().insert(id.into(),StudioJob{id:id.into(),kind:"subjectBase".into(),status:"paused".into(),paused:true,..StudioJob::default()});
        studio_subject_forget(id.into()).unwrap();assert!(checkpoint(id).is_err());assert!(ready_preparation(id).is_err());
        finish_preparation(id,Err("Cancelled".into()));assert_eq!(jobs().lock().unwrap()[id].status,"cancelled");
        assert!(!prepared().lock().unwrap().contains_key(id));jobs().lock().unwrap().remove(id);
    }
    #[test]
    fn source_admission_does_not_reinterpret_unknown_log_hdr_or_precision() {
        let good=json!({"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuvj420p","field_order":"progressive",
            "color_range":"pc","color_space":"bt709","color_primaries":"bt709","color_transfer":"bt709"}]});source_profile(&good).unwrap();
        for (field,value) in [("color_transfer","unknown"),("color_transfer","smpte2084"),("pix_fmt","yuv420p10le"),("color_range","unknown")] {
            let mut bad=good.clone();bad["streams"][0][field]=json!(value);assert!(source_profile(&bad).is_err());
        }
    }
    #[test]
    #[ignore="bounded public full-base/frame/cache qualification; requires exact bundled FFmpeg"]
    fn public_subject_preparation_and_exact_frame_smoke() {
        let ff=exact_ffmpeg().unwrap();
        for fps in [25u32,30,50,60] {
        let root=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-output")
            .join(format!("subject-public-preparation-{fps}-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();let root=root.canonicalize().unwrap();
        let source=root.join("source.mp4");
        let generator=format!("testsrc2=size=1280x720:rate={fps}");
        let generated=command(&ff).args(["-v","error","-nostdin","-n","-f","lavfi","-i",&generator,
            "-f","lavfi","-i","sine=frequency=440:sample_rate=48000","-t","1","-c:v","libx264","-threads","2","-bf","0",
            "-pix_fmt","yuv420p","-color_range","tv","-x264-params","colorprim=bt709:transfer=bt709:colormatrix=bt709",
            "-c:a","aac","-ac","2","-ar","48000"]).arg(&source).output().unwrap();
        assert!(generated.status.success(),"{}",String::from_utf8_lossy(&generated.stderr));
        let original=compute_md5(&source).unwrap();let mut p=super::super::super::tests::project(&root);
        p.fps=fps;p.encoder_preference="cpu".into();p.adaptive_scheduling=false;p.performance="balanced".into();
        p.clips[0].stabilization="off".into();p.clips[0].duration=1.;p.clips[0].replays.clear();
        let folder=root.join(".photogogo-video-studio-cache").join(format_key(&p));fs::create_dir_all(&folder).unwrap();
        let key=stabilization::base_key(&p,&p.clips[0],&source_signature(&source).unwrap(),"libx264").unwrap();
        let legacy=folder.join(cache_name("base",&p.clips[0],&p,&key));
        let copied=command(&ff).args(["-v","error","-nostdin","-n","-i"]).arg(&source)
            .args(["-c","copy","-bsf:v","h264_metadata=colour_primaries=2:transfer_characteristics=2:matrix_coefficients=2"]).arg(&legacy).output().unwrap();
        assert!(copied.status.success());
        let record=FragmentRecord{version:FRAGMENT_CACHE_VERSION.into(),signature:key,bytes:fs::metadata(&legacy).unwrap().len(),duration:1.};
        fs::write(fragment_record_path(&legacy),serde_json::to_vec(&record).unwrap()).unwrap();let legacy_hash=compute_md5(&legacy).unwrap();
        let id=studio_subject_prepare(p.clone(),root.to_string_lossy().into_owned(),"one".into()).unwrap();
        let began=std::time::Instant::now();
        loop {
            let job=studio_list_jobs().into_iter().find(|j|j.id==id).unwrap();
            if !["queued","running","paused"].contains(&job.status.as_str()){assert_eq!(job.status,"completed","{:?}",job.error);break;}
            assert!(began.elapsed()<Duration::from_secs(45),"Public preparation exceeded its synthetic bound");thread::sleep(Duration::from_millis(50));
        }
        let metadata=studio_subject_prepared(id.clone()).unwrap();assert_eq!(metadata.frame_count,fps);assert!(metadata.reused);
        assert_eq!(compute_md5(&legacy).unwrap(),legacy_hash);assert_eq!(compute_md5(&source).unwrap(),original);
        let held=prepared().lock().unwrap().get(&id).unwrap().clone();
        assert!(fs::OpenOptions::new().write(true).open(&held.path).is_err());
        assert!(!jobs().lock().unwrap()[&id].logs.iter().any(|s|s.contains("analyse shake")||s.contains("render full clip")),"Adoption unexpectedly restabilized");
        for frame in [0,1,2,7,fps/2,fps-2,fps-1] {
            let response=tauri::async_runtime::block_on(studio_subject_frame(id.clone(),frame)).unwrap();
            let filter=format!("select=eq(n\\,{frame}),scale=960:-2");
            let oracle=command(&ff).args(["-v","error","-nostdin","-threads","2","-i"]).arg(&held.path)
                .args(["-frames:v","1","-an","-vf",&filter,"-threads","2","-f","image2pipe","-c:v","mjpeg","-"]).output().unwrap();
            assert!(oracle.status.success());assert_eq!(response["dataUrl"],format!("data:image/jpeg;base64,{}",crate::utils::base64_encode(&oracle.stdout)),"Seek returned a different integer frame {frame}");
            assert_eq!(response["preparationId"],id);assert_eq!(response["baseIdentity"],metadata.identity);
        }
        assert!(tauri::async_runtime::block_on(studio_subject_frame(id.clone(),fps)).is_err());
        assert!(tauri::async_runtime::block_on(studio_subject_frame("arbitrary-path".into(),0)).is_err());
        let first_path=held.path.clone();drop(held);studio_subject_forget(id.clone()).unwrap();assert!(studio_subject_prepared(id).is_err());
        assert!(first_path.is_file(),"Forget deleted reusable media");
        let other=format!("subject-reuse-direct-{fps}");jobs().lock().unwrap().insert(other.clone(),StudioJob{id:other.clone(),kind:"subjectBase".into(),status:"running".into(),..StudioJob::default()});
        p.clips[0].title="New title".into();p.finishing=Some(Settings{enabled:true,..Settings::default()});
        let clip=p.clips[0].clone();let same=prepare(p.clone(),clip.clone(),&root.to_string_lossy(),&other,true).unwrap();assert_eq!(same.path,first_path);
        p.clips[0].finishing_selection=Some(serde_json::from_value(json!({"version":1,"baseIdentity":same.public.identity,"frameCount":fps,
            "referenceFrame":0,"anchors":[{"frame":0,"object":"horse","box":[0.2,0.3,0.8,0.9]},
                {"frame":0,"object":"rider","box":[0.4,0.1,0.6,0.5]}]})).unwrap());
        let export=existing_export_base(&p,&p.clips[0],&ff,&root,&other).unwrap();assert_eq!(export.path,first_path);
        assert_eq!(compute_md5(&export.path).unwrap(),p.clips[0].finishing_selection.as_ref().unwrap().base_identity);
        drop(export);
        let narrower=root.join("different-admitted-root");fs::create_dir(&narrower).unwrap();
        assert!(existing_export_base(&p,&p.clips[0],&ff,&narrower,&other).is_err(),"Export must retain the original staging authority, not derive it from source parents");
        let mut changed=p.clone();changed.fps=if fps==25{30}else{25};
        assert!(existing_export_base(&changed,&changed.clips[0],&ff,&root,&other).err().unwrap().contains("has not been prepared"));
        assert!(!jobs().lock().unwrap()[&other].logs.iter().any(|s|s.contains("render full clip")||s.contains("analyse shake")),"Cached export generated new stabilization");
        studio_subject_forget(other.clone()).unwrap();finish_preparation(&other,Ok(same));
        assert!(studio_subject_prepared(other.clone()).is_err(),"Late completion resurrected a forgotten preparation");
        assert_eq!(jobs().lock().unwrap()[&other].status,"cancelled");
        println!("PASS: public full-base preparation, leased no-stabilization adoption, exact integer-frame seek oracle at {fps} fps, opaque IDs, forget-without-delete/late completion and title/grade base reuse. Synthetic only: {}",root.display());
        }
    }
}
