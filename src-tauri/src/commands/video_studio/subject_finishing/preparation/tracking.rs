//! Opaque, bounded child operations for exact-base mask review. No media or
//! runtime path can be supplied through these public commands.
use super::*;
use super::super::{cache::VerifiedMasks,mask_preparation};
use std::io::{Seek,SeekFrom};
mod preview;
mod review;
pub use review::studio_subject_mask_review;
pub use preview::{studio_subject_finish_frame,studio_subject_finish_cancel,studio_subject_finish_epoch};

struct MaskReady {masks:VerifiedMasks,index:MaskIndex}
struct Tracking {base:Arc<Prepared>,selection:Selection,ready:Option<Arc<MaskReady>>,preview_epoch:Arc<std::sync::atomic::AtomicU32>}
fn tracks()->&'static Mutex<HashMap<String,Arc<Tracking>>> {
    static STORE:OnceLock<Mutex<HashMap<String,Arc<Tracking>>>>=OnceLock::new();
    STORE.get_or_init(||Mutex::new(HashMap::new()))
}
pub(super) fn protected_ids()->Vec<String> {
    let records=tracks().lock().unwrap_or_else(|e|e.into_inner());
    records.iter().flat_map(|(id,record)|[id.clone(),record.base.public.id.clone()]).collect()
}
/// Called while the job mutex is held, then the registry mutex. A late success
/// must relinquish its lease and handle when cancellation/forget wins.
fn publish_tracking_result<T>(job:&mut StudioJob,id:&str,entries:&mut HashMap<String,T>,result:Result<T,String>) {
    job.finished_at=chrono::Utc::now().to_rfc3339();
    match result {
        Ok(record) if !job.cancelled&&job.worker_error.is_none()&&entries.contains_key(id)=> {
            entries.insert(id.into(),record);
            job.status="completed".into();job.phase="Tracking ready; review its exact mask before approval".into();job.progress=100.;
        },
        Ok(_)=>{entries.remove(id);job.status=if job.cancelled{"cancelled"}else{"failed"}.into();},
        Err(error)=>{entries.remove(id);job.status=if job.cancelled{"cancelled"}else{"failed"}.into();job.error=Some(error);},
    }
}
fn still_ready(state:&HashMap<String,StudioJob>,id:&str)->bool {
    state.get(id).is_some_and(|j|j.status=="completed"&&!j.cancelled&&j.worker_error.is_none())
}
fn ready_track(id:&str)->Result<Arc<Tracking>,String> {
    let state=jobs().lock().map_err(|e|e.to_string())?;
    let records=tracks().lock().map_err(|e|e.to_string())?;
    let record=records.get(id).filter(|r|still_ready(&state,id)&&still_ready(&state,&r.base.public.id)&&r.ready.is_some())
        .ok_or("This exact subject tracking is not ready or has been forgotten")?;
    Ok(record.clone())
}
pub(super) fn forget_for_base(state:&mut HashMap<String,StudioJob>,base_id:&str) {
    let mut records=tracks().lock().unwrap_or_else(|e|e.into_inner());
    records.retain(|id,record|{
        if record.base.public.id!=base_id{return true;}
        if let Some(job)=state.get_mut(id){job.cancelled=true;job.paused=false;}
        preview::cancel_for_track(state,id);
        false
    });
}

#[tauri::command]
pub fn studio_subject_track(preparation_id:String,selection:Selection)->Result<String,String> {
    launch::poll_cleanup();
    selection.validate()?;let base=ready_preparation(&preparation_id)?;
    if selection.base_identity!=base.public.identity||selection.frame_count!=base.public.frame_count {
        return Err("Subject prompts do not match this exact full prepared base".into());
    }
    let mut state=jobs().lock().map_err(|e|e.to_string())?;
    retire_history(&mut state);
    if !still_ready(&state,&preparation_id){return Err("Subject base was forgotten before tracking admission".into());}
    let pending=state.values().filter(|j|j.kind=="subjectMasks"&&["queued","running","paused"].contains(&j.status.as_str())).count();
    let mut records=tracks().lock().map_err(|e|e.to_string())?;
    if pending>=2||records.len()>=8{return Err("Subject tracking is busy; release an old review or wait for an active track to finish. Cached media is preserved.".into());}
    let id=format!("subject-masks-{}-{}",chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name subject tracking")?,std::process::id());
    let record=Arc::new(Tracking{base,selection,ready:None,preview_epoch:Arc::new(std::sync::atomic::AtomicU32::new(0))});records.insert(id.clone(),record.clone());
    state.insert(id.clone(),StudioJob{id:id.clone(),name:format!("{} · track horse and rider",record.base.clip.chapter),
        kind:"subjectMasks".into(),clip_id:Some(record.base.public.clip_id.clone()),status:"queued".into(),
        width:record.base.public.width,height:record.base.public.height,fps:record.base.public.fps,
        created_at:chrono::Utc::now().to_rfc3339(),..StudioJob::default()});drop(records);drop(state);
    let running=id.clone();
    if let Err(error)=thread::Builder::new().name("subject-mask-preparation".into()).spawn(move|| {
        update(&running,|j|{if !j.cancelled {j.status="running".into();j.started_ms=Some(chrono::Utc::now().timestamp_millis());j.started_at=chrono::Utc::now().to_rfc3339();}});
        let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            checkpoint(&running)?;
            let mut p=record.base.project.clone();let mut clip=record.base.clip.clone();
            p.finishing.get_or_insert_with(Settings::default).enabled=true;clip.finishing_selection=Some(record.selection.clone());
            let masks=mask_preparation::prepare_masks(&record.base.ff,&p,&clip,&record.base.path,&record.base.folder,&record.base.folder,&running)?;
            let index=MaskIndex::new(&masks.path,record.base.public.frame_count,Some(&running))?;
            Ok::<_,String>(Arc::new(MaskReady{masks,index}))
        })).unwrap_or_else(|_|Err("Subject tracking panicked; uncommitted artifacts were preserved".into()));
        update(&running,|j| {
            let mut entries=tracks().lock().unwrap_or_else(|e|e.into_inner());
            publish_tracking_result(j,&running,&mut entries,result.map(|ready|Arc::new(Tracking{base:record.base.clone(),selection:record.selection.clone(),ready:Some(ready),preview_epoch:record.preview_epoch.clone()})));
        });
    }) {studio_subject_tracking_forget(id.clone())?;update(&id,|j|{j.status="failed".into();j.error=Some(error.to_string());});return Err(error.to_string());}
    Ok(id)
}
#[tauri::command]
pub fn studio_subject_tracking_forget(tracking_id:String)->Result<(),String> {
    let mut state=jobs().lock().map_err(|e|e.to_string())?;
    if let Some(job)=state.get_mut(&tracking_id){if job.kind!="subjectMasks" {return Err("Only subject-mask tracking can be released here".into());}job.cancelled=true;job.paused=false;}
    preview::cancel_for_track(&mut state,&tracking_id);
    tracks().lock().map_err(|e|e.to_string())?.remove(&tracking_id);Ok(())
}
#[tauri::command]
pub fn studio_subject_tracked(tracking_id:String)->Result<Value,String> {
    let record=ready_track(&tracking_id)?;let ready=record.ready.as_ref().unwrap();
    let review=review::latest(&record)?;
    ready_track(&tracking_id)?;
    Ok(json!({"version":1,"id":tracking_id,"preparationId":record.base.public.id,"baseIdentity":record.base.public.identity,
        "maskIdentity":ready.masks.identity,"maskSha256":ready.masks.sha256,"frames":record.base.public.frame_count,
        "device":ready.masks.receipt["device"],"secondsIncludingLoad":ready.masks.receipt["secondsIncludingLoad"],
        "minimumSeamIoU":ready.masks.receipt["minimumSeamIoU"],"selection":record.selection,
        "review":review,"reviewed":false,"exportQualified":false}))
}
#[tauri::command]
pub async fn studio_subject_mask_frame(tracking_id:String,frame:u32)->Result<Value,String> {
    let record=ready_track(&tracking_id)?;
    if frame>=record.base.public.frame_count{return Err("Mask frame lies outside its exact prepared base".into());}
    let slot=FrameSlot::acquire(&tracking_id)?;
    tauri::async_runtime::spawn_blocking(move||{
        let _slot=slot;let ready=record.ready.as_ref().unwrap();
        let alpha=ready.index.read(&ready.masks.path,frame)?;
        let rgba=alpha.into_iter().flat_map(|a|[250u8,204,21,a/2]).collect::<Vec<_>>();
        let image=image::RgbaImage::from_raw(ready.index.width,ready.index.height,rgba).ok_or("Invalid mask image dimensions")?;
        let mut png=std::io::Cursor::new(Vec::new());image.write_to(&mut png,image::ImageFormat::Png).map_err(|e|e.to_string())?;
        if png.get_ref().len()>8*1024*1024{return Err("Mask preview exceeds its bounded image budget".into());}
        ready_track(&tracking_id)?;
        Ok(json!({"trackingId":tracking_id,"preparationId":record.base.public.id,"baseIdentity":record.base.public.identity,
            "maskIdentity":ready.masks.identity,"frame":frame,"dataUrl":format!("data:image/png;base64,{}",crate::utils::base64_encode(png.get_ref()))}))
    }).await.map_err(|e|e.to_string())?
}

/// Sparse immutable index: at most 7,032 offsets for 1.8M frames. Seeking
/// expands only the requested alpha and skips at most 255 verified payloads.
struct MaskIndex {width:u32,height:u32,count:u32,offsets:Vec<u64>}
fn word(file:&mut fs::File)->Result<u32,String>{let mut b=[0;4];file.read_exact(&mut b).map_err(|_|"Truncated mask preview")?;Ok(u32::from_le_bytes(b))}
impl MaskIndex {
    fn new(path:&Path,count:u32,id:Option<&str>)->Result<Self,String>{
        let mut file=cache::lease(path,false)?;let mut magic=[0;8];file.read_exact(&mut magic).map_err(|e|e.to_string())?;
        let (width,height,observed)=(word(&mut file)?,word(&mut file)?,word(&mut file)?);
        if magic!=*b"PGMSK001"||count!=observed||!(1..=1_800_000).contains(&count)||width==0||height==0||width>1024||height>1024{return Err("Invalid bounded mask preview header".into());}
        let length=file.metadata().map_err(|e|e.to_string())?.len();let mut offsets=Vec::new();
        for frame in 0..count {
            if frame%256==0 {if let Some(id)=id{checkpoint(id)?;}}
            let at=file.stream_position().map_err(|e|e.to_string())?;if frame%256==0{offsets.push(at);}
            let bytes=word(&mut file)?;if bytes==0||bytes%5!=0||bytes as u64>width as u64*height as u64*5||at+4+bytes as u64>length{return Err("Invalid bounded mask preview payload".into());}
            file.seek(SeekFrom::Current(bytes as i64)).map_err(|e|e.to_string())?;
        }
        if file.stream_position().map_err(|e|e.to_string())?!=length{return Err("Trailing mask preview data".into());}
        Ok(Self{width,height,count,offsets})
    }
    fn read(&self,path:&Path,frame:u32)->Result<Vec<u8>,String>{
        if frame>=self.count{return Err("Mask preview frame is out of bounds".into());}
        let mut file=cache::lease(path,false)?;file.seek(SeekFrom::Start(self.offsets[(frame/256)as usize])).map_err(|e|e.to_string())?;
        for _ in 0..frame%256{let bytes=word(&mut file)?;file.seek(SeekFrom::Current(bytes as i64)).map_err(|e|e.to_string())?;}
        let bytes=word(&mut file)?;let mut alpha=Vec::with_capacity((self.width*self.height)as usize);
        for _ in 0..bytes/5{let run=word(&mut file)?;let mut value=[0];file.read_exact(&mut value).map_err(|e|e.to_string())?;
            if run==0||alpha.len()+run as usize>(self.width*self.height)as usize{return Err("Mask preview run overflows frame".into());}
            alpha.resize(alpha.len()+run as usize,value[0]);}
        if alpha.len()!=(self.width*self.height)as usize{return Err("Mask preview does not cover the full frame".into());}Ok(alpha)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn successful_tracking_losing_to_cancellation_releases_its_registry_lease() {
        for (cancelled,worker_error) in [(true,None),(false,Some("owned worker cleanup failed".into()))] {
            let retained=Arc::new(());let observer=Arc::downgrade(&retained);
            let mut entries=HashMap::from([("track".into(),retained)]);
            let mut job=StudioJob{kind:"subjectMasks".into(),status:"running".into(),cancelled,worker_error,..StudioJob::default()};
            publish_tracking_result(&mut job,"track",&mut entries,Ok(Arc::new(())));
            assert!(entries.is_empty(),"Rejected success must not consume a review slot");
            assert!(observer.upgrade().is_none(),"Rejected success must drop the registry lease");
            assert_eq!(job.status,if cancelled{"cancelled"}else{"failed"});assert!(!job.finished_at.is_empty());
        }
    }
    #[test] fn tracking_publication_cannot_resurrect_a_forgotten_id() {
        let mut entries=HashMap::<String,u8>::new();let mut job=StudioJob::default();
        publish_tracking_result(&mut job,"forgotten",&mut entries,Ok(1));assert!(entries.is_empty());assert_eq!(job.status,"failed");
        entries.insert("ready".into(),0);publish_tracking_result(&mut job,"ready",&mut entries,Ok(2));
        assert_eq!(entries.get("ready"),Some(&2));assert_eq!(job.status,"completed");
        publish_tracking_result(&mut job,"ready",&mut entries,Err("verification failed".into()));
        assert!(entries.is_empty());assert_eq!(job.status,"failed");assert_eq!(job.error.as_deref(),Some("verification failed"));
    }
    #[test] fn forgetting_a_base_tombstones_child_tracking_but_worker_leases_survive_until_drop() {
        let root=std::env::temp_dir().join(format!("subject-parent-forget-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();let path=root.join("base.mp4");fs::write(&path,b"immutable fixture").unwrap();
        let project=super::super::super::super::tests::project(&root);let clip=project.clips[0].clone();
        let base_id=format!("subject-base-parent-{}",root.file_name().unwrap().to_string_lossy());let id=format!("subject-masks-child-{base_id}");
        let identity="a".repeat(32);
        let base=Arc::new(Prepared{public:PreparedBase{version:1,id:base_id.clone(),clip_id:clip.id.clone(),identity:identity.clone(),width:320,height:180,fps:25,frame_count:10,
            base_policy:BasePolicy::Reuse,reused:true,contains_global_sharpening:false,warnings:vec![]},path:path.clone(),ff:root.join("ffmpeg.exe"),key:"fixture".into(),
            sha256:hex::encode(Sha256::digest(b"immutable fixture")),project,clip,folder:root.clone(),_root:cache::OwnedRoot::open(&root).unwrap(),_tool_root:cache::OwnedRoot::open(&root).unwrap(),_files:vec![cache::lease(&path,false).unwrap()]});
        let selection:Selection=serde_json::from_value(json!({"version":1,"baseIdentity":identity,"frameCount":10,"referenceFrame":0,
            "anchors":[{"frame":0,"object":"horse","box":[0.2,0.3,0.8,0.9]},{"frame":0,"object":"rider","box":[0.4,0.1,0.6,0.5]}]})).unwrap();
        let worker=Arc::new(Tracking{base:base.clone(),selection,ready:None,preview_epoch:Arc::new(std::sync::atomic::AtomicU32::new(0))});
        {let mut state=jobs().lock().unwrap();state.insert(base_id.clone(),StudioJob{kind:"subjectBase".into(),status:"completed".into(),..StudioJob::default()});
            state.insert(id.clone(),StudioJob{kind:"subjectMasks".into(),status:"running".into(),..StudioJob::default()});
            prepared().lock().unwrap().insert(base_id.clone(),base.clone());tracks().lock().unwrap().insert(id.clone(),worker.clone());}
        studio_subject_forget(base_id.clone()).unwrap();assert!(checkpoint(&id).is_err());assert!(studio_subject_tracked(id.clone()).is_err());
        assert!(!tracks().lock().unwrap().contains_key(&id));assert!(!prepared().lock().unwrap().contains_key(&base_id));
        assert!(fs::OpenOptions::new().write(true).open(&path).is_err(),"Cancellation is not permission to mutate a worker-owned base");
        drop(worker);drop(base);assert!(fs::OpenOptions::new().write(true).open(&path).is_ok());
        let mut state=jobs().lock().unwrap();state.remove(&id);state.remove(&base_id);drop(state);fs::remove_dir_all(root).unwrap();
    }
    #[test] fn sparse_mask_reader_is_exact_bounded_and_rejects_trailing_data(){
        let root=std::env::temp_dir().join(format!("subject-mask-index-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));fs::create_dir(&root).unwrap();
        let path=root.join("masks.pgmask");let mut bytes=b"PGMSK001".to_vec();for n in [2u32,1,513]{bytes.extend(n.to_le_bytes());}
        for frame in 0..513{bytes.extend(5u32.to_le_bytes());bytes.extend(2u32.to_le_bytes());bytes.push((frame%256)as u8);}fs::write(&path,&bytes).unwrap();
        let index=MaskIndex::new(&path,513,None).unwrap();assert_eq!(index.offsets.len(),3);
        for frame in [0,1,255,256,257,511,512]{assert_eq!(index.read(&path,frame).unwrap(),vec![(frame%256)as u8;2]);}
        assert!(index.read(&path,513).is_err());assert!(MaskIndex::new(&path,512,None).is_err());
        bytes.push(0);fs::write(&path,bytes).unwrap();assert!(MaskIndex::new(&path,513,None).is_err());fs::remove_dir_all(root).unwrap();
    }
}
