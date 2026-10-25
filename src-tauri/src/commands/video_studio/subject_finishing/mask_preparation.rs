//! App-owned mask preparation. Requests carry media/prompts, never executable
//! paths, model hashes or authority. Runtime leases span the owned launch.
use super::*;
use cache::{OwnedRoot,VerifiedMasks};

struct Inputs {
    runtime:runtime::ManualRuntime,
    _files:Vec<fs::File>,
    _roots:Vec<OwnedRoot>,
}

fn request(p:&Project,selection:&Selection,base:&Path,destination:&Path)->Result<Value,String> {
    selection.validate()?;
    Ok(json!({"version":1,"sourcePath":base,"baseChecksum":selection.base_identity,
        "width":p.width,"height":p.height,"fps":p.fps,"frameCount":selection.frame_count,
        "windowFrames":16,"overlapFrames":4,"destinationPath":destination,"selection":selection}))
}

pub(super) fn prepare_masks(ff:&Path,p:&Project,c:&Clip,
    base_path:&Path,folder:&Path,work:&Path,id:&str)->Result<VerifiedMasks,String> {
    validate(p)?;
    if !p.finishing.as_ref().is_some_and(|s|s.enabled) {
        return Err("Enable subject finishing before preparing its masks".into());
    }
    if !ff.is_absolute()||!ff.is_file()||!ff.file_name().is_some_and(|s|s.to_string_lossy().eq_ignore_ascii_case("ffmpeg.exe")) {
        return Err("Mask preparation requires the exact installed or bundled FFmpeg path; a PATH name is not admitted".into());
    }
    let media_root=OwnedRoot::open(ff.parent().ok_or("Missing media-tools directory")?)?;
    let probe=media_root.path.join("ffprobe.exe");
    let media_files=vec![cache::lease(ff,false)?,cache::lease(&probe,false)?];
    let selection=c.finishing_selection.as_ref().ok_or("Select both horse and rider on this exact full stabilized base first")?;
    let base_root=OwnedRoot::open(base_path.parent().ok_or("Missing stabilized-base directory")?)?;
    let mut base=cache::lease(base_path,false)?;
    let (_,checksum,_)=cache::hashes(&mut base,Some(id))?;
    if checksum!=selection.base_identity {
        return Err("The stabilized base changed; old subject prompts/masks were not applied. Prepare and select this base again.".into());
    }
    let info=inspect(ff,base_path)?;cache::validate_profile(&info,p,selection.frame_count)?;
    let root=cache::finishing_root(folder)?;
    let destination=cache::mask_folder_name(selection,p)?;
    let target=root.child(&destination)?;let _lock=cache::lock_owned(&root,&destination,id)?;
    if target.exists() {
        let result=cache::verified_masks(&target,selection,p,Some(id))?;
        note_fragment(id,"Reused exact subject masks (not visual approval)",&result.path);return Ok(result);
    }
    // Verify once, before reserving inference capacity. The private pack and
    // actual owner binary remain immutable through every launch/error path.
    let runtime=runtime::resolve(id)?;
    let stamp=chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name a new owned mask stage")?;
    let stage=format!("{destination}-{stamp}.partial");let stage_path=root.child(&stage)?;
    let request_folder=root.child(&format!("mask-request-{stamp}"))?;
    fs::create_dir(&request_folder).map_err(|e|e.to_string())?;
    let request_root=OwnedRoot::open(&request_folder)?;
    let request_path=request_root.child("request.json")?;
    let payload=serde_json::to_vec(&request(p,selection,base_path,&stage_path)?).map_err(|e|e.to_string())?;
    if payload.len()>128*1024 {return Err("Subject-mask request exceeds its metadata bound".into());}
    let mut request_file=fs::OpenOptions::new().write(true).create_new(true).open(&request_path).map_err(|e|e.to_string())?;
    request_file.write_all(&payload).and_then(|_|request_file.sync_all()).map_err(|e|e.to_string())?;drop(request_file);
    let mut request_file=cache::lease(&request_path,false)?;
    if cache::bounded_json(&mut request_file)?!=request(p,selection,base_path,&stage_path)? {
        return Err("Subject-mask request changed before launch".into());
    }
    let phase=format!("{}: preparing horse and rider masks",c.chapter);
    let request_directory=request_root.path.clone();
    let mut files=media_files;files.extend([base,request_file]);
    let mut inputs=Inputs{runtime,_files:files,_roots:vec![base_root,media_root,request_root]};
    loop {
        checkpoint(id)?;
        let permit=match studio_hardware::acquire_finishing(p.width,p.height,&p.performance,true,
            ||{launch::poll_cleanup();stopped_or_paused(id)},|note|update(id,|j|record_memory_wait(j,&work.to_string_lossy(),note))) {
            Ok(value)=>value,
            Err(error)=> {
                if jobs().lock().ok().and_then(|s|s.get(id).map(|j|j.paused&&!j.cancelled&&j.worker_error.is_none())).unwrap_or(false){continue;}
                return Err(error);
            }
        };
        if stopped_or_paused(id){drop(permit);continue;}
        // Decoder owns at most two threads concurrently with the CPU model.
        // This qualified CPU profile does not reserve the shared GPU image slot.
        let threads=permit.threads().saturating_sub(2).clamp(1,8);
        inputs.runtime.check_namespace()?;
        let binary=inputs.runtime.worker.clone();
        let args=vec!["--mask-job".into(),inputs.runtime.python.to_string_lossy().into_owned(),
            inputs.runtime.script.to_string_lossy().into_owned(),request_path.to_string_lossy().into_owned(),
            inputs.runtime.root.to_string_lossy().into_owned(),ff.to_string_lossy().into_owned(),"86400".into(),threads.to_string()];
        update(id,|j|j.logs.push(format!("Mask preparation: admitted sealed manual-video-cpu-v1; two objects; 16-frame windows/4-frame overlap; {threads} model threads; 4 GiB/three-process ceiling. CPU cost is not NVIDIA throughput qualification.")));
        // Launch retention includes all executable/media/request handles AND
        // the reservation. An undrained cancellation quarantines them together.
        let (retained,result)=launch::run(&binary,&args,&request_directory,id,&phase,
            Duration::from_secs(24*60*60),(inputs,permit))?;
        let (restored,permit)=retained;inputs=restored;
        drop(permit);
        match result {Err(error) if error==diagnostics::RETRY_ADMISSION=>continue,result=>result?,}break;
    }
    // No app receipt exists until complete finite masks and their original
    // worker receipt survive final-path verification. Preserve failed stages.
    let result=cache::publish_mask_stage(&root,&stage,&destination,selection,p,id)?;
    drop(inputs);
    note_fragment(id,"Prepared subject masks; exact-artifact review still required",&result.path);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mask_request_is_fixed_bounded_policy_without_runtime_authority() {
        let p=super::super::super::tests::project(Path::new("."));
        let selection:Selection=serde_json::from_value(json!({"version":1,"baseIdentity":"a".repeat(32),
            "frameCount":30,"referenceFrame":12,"anchors":[{"frame":12,"object":"horse","box":[0.1,0.2,0.7,0.9]},
                {"frame":12,"object":"rider","box":[0.4,0.1,0.6,0.5]}]})).unwrap();
        let value=request(&p,&selection,Path::new("C:/owned/base.mp4"),Path::new("C:/owned/masks.partial")).unwrap();
        assert_eq!(value.as_object().unwrap().len(),11);assert_eq!(value["windowFrames"],16);assert_eq!(value["overlapFrames"],4);
        assert_eq!(value["selection"]["referenceFrame"],12);
        for field in ["python","worker","runtimeRoot","model","expectedSha256"] {assert!(value.get(field).is_none());}
        assert!(serde_json::to_vec(&value).unwrap().len()<128*1024);
    }
}
