//! Exact-frame user assertions, not model acceptance or whole-clip approval.
//! Immutable sidecars never modify the base, mask or generator manifests.
use super::*;
use sha2::Sha256;

const MAX_EVENTS:usize=256;
const MAX_RECEIPT:u64=8*1024;
#[derive(Clone,Debug,Deserialize,Serialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub struct ReviewRequest {pub decision:Decision,pub coverage:Coverage,pub frames:Vec<u32>}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub enum Decision {Approve,Reject}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq)]
#[serde(rename_all="camelCase")]
pub enum Coverage {SampledFrames}
impl ReviewRequest {
    fn validate(&self,count:u32)->Result<(),String> {
        if self.frames.is_empty()||self.frames.len()>128||self.frames.iter().any(|f|*f>=count)
            ||self.frames.windows(2).any(|pair|pair[0]>=pair[1]) {
            return Err("Review requires 1–128 sorted, unique frame indices within this exact clip".into());
        }
        Ok(())
    }
}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Binding {
    base_checksum:String,base_sha256:String,width:u32,height:u32,fps:u32,frames:u32,
    mask_identity:String,mask_sha256:String,canonical_recipe_sha256:String,
    generation_profile:Value,runtime_profile:String,runtime_seal:String,
}
impl Binding {
    fn from_record(record:&Tracking)->Result<Self,String> {
        let masks=&record.ready.as_ref().ok_or("Mask review requires verified tracking")?.masks;
        let required=|key:&str|masks.receipt[key].as_str().map(str::to_owned).ok_or_else(||format!("Missing verified mask {key}"));
        Ok(Self{base_checksum:record.base.public.identity.clone(),base_sha256:record.base.sha256.clone(),
            width:record.base.public.width,height:record.base.public.height,fps:record.base.public.fps,frames:record.base.public.frame_count,
            mask_identity:masks.identity.clone(),mask_sha256:masks.sha256.clone(),canonical_recipe_sha256:hex::encode(Sha256::digest(required("canonicalRecipe")?.as_bytes())),
            generation_profile:masks.receipt["generationProfile"].clone(),runtime_profile:required("runtimeProfile")?,runtime_seal:required("runtimeSeal")?})
    }
}
#[derive(Clone,Debug,Deserialize,Serialize,PartialEq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Receipt {
    schema:u32,sequence:usize,previous_identity:Option<String>,receipt_identity:String,
    assertion_kind:String,timestamp:String,decision:Decision,coverage:Coverage,frames:Vec<u32>,binding:Binding,
}
impl Receipt {
    fn identity(&self)->Result<String,String> {
        let mut content=self.clone();content.receipt_identity.clear();
        Ok(hex::encode(Sha256::digest(serde_json::to_vec(&content).map_err(|e|e.to_string())?)))
    }
    fn validate(&self,binding:&Binding,sequence:usize,previous:Option<&str>)->Result<(),String> {
        ReviewRequest{decision:self.decision.clone(),coverage:self.coverage.clone(),frames:self.frames.clone()}.validate(binding.frames)?;
        if self.schema!=1||self.sequence!=sequence||self.sequence>MAX_EVENTS||self.assertion_kind!="user-asserted"
            ||self.binding!=*binding||self.previous_identity.as_deref()!=previous
            ||chrono::DateTime::parse_from_rfc3339(&self.timestamp).is_err()||self.receipt_identity!=self.identity()? {
            return Err("Subject review is incomplete, changed or belongs to different base/prompts/masks/runtime. It was preserved, not adopted.".into());
        }
        Ok(())
    }
}
fn serial()->&'static Mutex<()> {static LOCK:OnceLock<Mutex<()>>=OnceLock::new();LOCK.get_or_init(||Mutex::new(()))}
fn review_root(record:&Tracking,create:bool)->Result<Option<cache::OwnedRoot>,String> {
    let folder=record.ready.as_ref().ok_or("Mask review requires verified tracking")?.masks.path.parent().ok_or("Missing owned mask directory")?;
    let parent=cache::OwnedRoot::open(folder)?;let path=parent.child("reviews")?;
    if !path.exists(){if !create{return Ok(None);}fs::create_dir(&path).map_err(|e|e.to_string())?;}
    Ok(Some(cache::OwnedRoot::open(&path)?))
}
/// Hold every opened receipt through recovery/publication. A bounded chain
/// refuses interior gaps. This local ledger is not rollback-resistant: removal
/// of the entire newest suffix while leases are closed cannot be detected.
fn history(root:&cache::OwnedRoot,binding:&Binding)->Result<(Option<Receipt>,Vec<fs::File>),String> {
    let mut entries=Vec::new();let mut seen=0;let mut held=Vec::new();
    for entry in fs::read_dir(&root.path).map_err(|e|e.to_string())? {
        seen+=1;if seen>MAX_EVENTS*2{return Err("Subject review history exceeds its bounded budget; no approval was inferred".into());}
        let entry=entry.map_err(|e|e.to_string())?;
        let name=entry.file_name().into_string().map_err(|_|"Unexpected subject review entry")?;
        // A failed/cancelled stage is evidence, not a committed assertion.
        if name.starts_with("review-stage-")&&name.ends_with(".pending")&&name.len()<=96 {
            held.push(cache::lease(&root.child(&name)?,false)?);continue;
        }
        let seq=name.strip_prefix("review-").and_then(|v|v.strip_suffix(".json"))
            .filter(|v|v.len()==4&&v.bytes().all(|b|b.is_ascii_digit())).and_then(|v|v.parse::<usize>().ok())
            .filter(|n|(1..=MAX_EVENTS).contains(n)).ok_or("Unexpected subject review entry; no approval was inferred")?;
        entries.push((seq,name));
    }
    entries.sort();let mut last:Option<Receipt>=None;
    for (index,(sequence,name)) in entries.into_iter().enumerate() {
        let mut file=cache::lease(&root.child(&name)?,false)?;
        if file.metadata().map_err(|e|e.to_string())?.len()>MAX_RECEIPT{return Err("Subject review receipt exceeds its bounded budget".into());}
        let receipt:Receipt=serde_json::from_value(cache::bounded_json(&mut file)?).map_err(|e|format!("Invalid subject review: {e}"))?;
        receipt.validate(binding,index+1,last.as_ref().map(|r|r.receipt_identity.as_str()))?;
        if sequence!=receipt.sequence{return Err("Subject review sequence does not match its owned name".into());}
        last=Some(receipt);held.push(file);
    }
    Ok((last,held))
}
pub(super) fn latest(record:&Tracking)->Result<Option<Value>,String> {
    let _guard=serial().lock().map_err(|e|e.to_string())?;
    let Some(root)=review_root(record,false)? else{return Ok(None)};
    let (last,_leases)=history(&root,&Binding::from_record(record)?)?;
    last.map(|receipt|serde_json::to_value(receipt).map_err(|e|e.to_string())).transpose()
}
fn publish(root:&cache::OwnedRoot,receipt:&Receipt,id:&str,record:&Arc<Tracking>,before_commit:impl FnOnce())->Result<(),String> {
    let bytes=serde_json::to_vec(receipt).map_err(|e|e.to_string())?;
    if bytes.len()as u64>MAX_RECEIPT{return Err("Subject review receipt exceeds its bounded budget".into());}
    let pending=root.child(&format!("review-stage-{}-{}.pending",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name review stage")?))?;
    let target=root.child(&format!("review-{:04}.json",receipt.sequence))?;
    let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&pending).map_err(|e|e.to_string())?;
    file.write_all(&bytes).and_then(|_|file.sync_all()).map_err(|e|e.to_string())?;drop(file);
    before_commit();
    let mut state=jobs().lock().map_err(|e|e.to_string())?;
    let records=tracks().lock().map_err(|e|e.to_string())?;
    if !still_ready(&state,id)||!still_ready(&state,&record.base.public.id)
        ||records.get(id).is_none_or(|current|!Arc::ptr_eq(current,record)) {
        return Err("Subject review was released or cancelled before its receipt commit".into());
    }
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let from:Vec<u16>=pending.as_os_str().encode_wide().chain(Some(0)).collect();let to:Vec<u16>=target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe{MoveFileExW(from.as_ptr(),to.as_ptr(),8)}==0{return Err(format!("Cannot commit review without overwrite: {}",std::io::Error::last_os_error()));}
    }
    #[cfg(not(windows))] return Err("Subject review publication is not qualified on this platform".into());
    let mut verified=cache::lease(&target,false)?;
    if cache::bounded_json(&mut verified)?!=serde_json::to_value(receipt).map_err(|e|e.to_string())? {
        return Err("Subject review changed during publication; no approval was returned".into());
    }
    if let Some(job)=state.get_mut(id){job.logs.push(format!("User {} assertion recorded for {} exact frames; whole-clip/export qualification unchanged",if receipt.decision==Decision::Approve{"acknowledgment"}else{"flag"},receipt.frames.len()));}
    Ok(())
}
#[tauri::command]
pub fn studio_subject_mask_review(tracking_id:String,request:ReviewRequest)->Result<Value,String> {
    record_review(tracking_id,request,||{})
}
fn record_review(tracking_id:String,request:ReviewRequest,before_commit:impl FnOnce())->Result<Value,String> {
    let record=ready_track(&tracking_id)?;request.validate(record.base.public.frame_count)?;
    let _guard=serial().lock().map_err(|e|e.to_string())?;
    let root=review_root(&record,true)?.ok_or("Cannot create owned review directory")?;
    let binding=Binding::from_record(&record)?;let (last,_leases)=history(&root,&binding)?;
    if _leases.len()>=MAX_EVENTS*2{return Err("Subject review staging history is full; existing evidence was preserved. No new decision was recorded.".into());}
    let sequence=last.as_ref().map_or(1,|r|r.sequence+1);
    if sequence>MAX_EVENTS{return Err("Subject review history is full; existing decisions were preserved. No new approval was recorded.".into());}
    let mut receipt=Receipt{schema:1,sequence,previous_identity:last.map(|r|r.receipt_identity),receipt_identity:String::new(),
        assertion_kind:"user-asserted".into(),timestamp:chrono::Utc::now().to_rfc3339(),decision:request.decision,coverage:request.coverage,frames:request.frames,binding};
    receipt.receipt_identity=receipt.identity()?;
    publish(&root,&receipt,&tracking_id,&record,before_commit)?;
    Ok(json!({"trackingId":tracking_id,"preparationId":record.base.public.id,"baseIdentity":record.base.public.identity,
        "maskIdentity":receipt.binding.mask_identity,"maskSha256":receipt.binding.mask_sha256,
        "review":receipt,"reviewed":false,"exportQualified":false,"subjectQualityAccepted":false}))
}
#[cfg(test)]
pub(super) fn cancel_before_commit(id:String,request:ReviewRequest)->Result<Value,String> {
    let base=ready_track(&id)?.base.public.id.clone();
    record_review(id,request,||{studio_subject_forget(base).unwrap();})
}
#[cfg(test)] mod tests {
    use super::*;
    fn binding()->Binding {Binding{base_checksum:"a".repeat(32),base_sha256:"b".repeat(64),width:320,height:180,fps:25,frames:5,
        mask_identity:"c".repeat(64),mask_sha256:"d".repeat(64),canonical_recipe_sha256:"c".repeat(64),
        generation_profile:json!([1,"fixture"]),runtime_profile:"fixture".into(),runtime_seal:"e".repeat(64)}}
    fn receipt(binding:Binding,sequence:usize,previous_identity:Option<String>,decision:Decision)->Receipt {
        let mut r=Receipt{schema:1,sequence,previous_identity,receipt_identity:String::new(),assertion_kind:"user-asserted".into(),
            timestamp:chrono::Utc::now().to_rfc3339(),decision,coverage:Coverage::SampledFrames,frames:vec![0,3],binding};r.receipt_identity=r.identity().unwrap();r
    }
    #[test] fn exact_review_requests_refuse_inflated_coverage_unknown_authority_and_bad_frames() {
        let request=ReviewRequest{decision:Decision::Approve,coverage:Coverage::SampledFrames,frames:vec![0,3]};request.validate(5).unwrap();
        for frames in [vec![],vec![3,0],vec![0,0],(0..129).collect()] {assert!(ReviewRequest{frames,..request.clone()}.validate(200).is_err());}
        assert!(ReviewRequest{frames:vec![5],..request.clone()}.validate(5).is_err());
        for extra in [json!({"coverage":"entireClip"}),json!({"path":"other.mp4"}),json!({"exportQualified":true})] {
            let mut data=serde_json::to_value(&request).unwrap();for (key,value)in extra.as_object().unwrap(){data[key]=value.clone();}
            assert!(serde_json::from_value::<ReviewRequest>(data).is_err());
        }
    }
    #[test] fn immutable_review_chain_recovers_rejects_stale_binding_gaps_and_budget_overflow() {
        let path=std::env::temp_dir().join(format!("subject-review-chain-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));fs::create_dir(&path).unwrap();
        let root=cache::OwnedRoot::open(&path).unwrap();let binding=binding();
        let first=receipt(binding.clone(),1,None,Decision::Approve);
        fs::write(root.child("review-0001.json").unwrap(),serde_json::to_vec(&first).unwrap()).unwrap();
        let (last,held)=history(&root,&binding).unwrap();assert_eq!(last,Some(first.clone()));
        assert!(fs::OpenOptions::new().write(true).open(root.child("review-0001.json").unwrap()).is_err());drop(held);
        for field in ["baseSha256","baseChecksum","maskSha256","maskIdentity","runtimeSeal","canonicalRecipeSha256","generationProfile","width"] {
            let mut changed=serde_json::to_value(&binding).unwrap();changed[field]=if field=="width"{json!(321)}else{json!("mismatched")};
            let stale=serde_json::from_value::<Binding>(changed).unwrap();assert!(history(&root,&stale).is_err());
        }
        let second=receipt(binding.clone(),2,Some(first.receipt_identity.clone()),Decision::Reject);
        fs::write(root.child("review-0002.json").unwrap(),serde_json::to_vec(&second).unwrap()).unwrap();
        let (last,held)=history(&root,&binding).unwrap();assert_eq!(last.unwrap().decision,Decision::Reject);drop(held);
        // Document the local-ledger trust limit rather than claim a protected
        // expected head or an authorization/security boundary we do not have.
        fs::rename(root.child("review-0002.json").unwrap(),root.child("review-stage-suffix.pending").unwrap()).unwrap();
        let (last,held)=history(&root,&binding).unwrap();assert_eq!(last,Some(first.clone()));drop(held);
        fs::rename(root.child("review-stage-suffix.pending").unwrap(),root.child("review-0002.json").unwrap()).unwrap();
        fs::rename(root.child("review-0001.json").unwrap(),root.child("review-stage-missing.pending").unwrap()).unwrap();assert!(history(&root,&binding).is_err());
        fs::rename(root.child("review-stage-missing.pending").unwrap(),root.child("review-0001.json").unwrap()).unwrap();
        let oversized=root.child("review-0003.json").unwrap();fs::write(&oversized,vec![b' ';MAX_RECEIPT as usize+1]).unwrap();assert!(history(&root,&binding).is_err());
        drop(root);fs::remove_dir_all(path).unwrap();
    }
    #[test] fn maximum_supported_prompt_set_fits_a_digest_bound_one_frame_review() {
        let anchors=(0..128).map(|i|json!({"frame":i/2,"object":if i%2==0{"horse"}else{"rider"},"box":[0.123456789123,0.234567891234,0.876543219876,0.987654321987],
            "points":(0..4).map(|_|json!({"x":0.456789123456,"y":0.567891234567,"include":true})).collect::<Vec<_>>() })).collect::<Vec<_>>();
        let selection:Selection=serde_json::from_value(json!({"version":1,"baseIdentity":"a".repeat(32),"frameCount":100,"referenceFrame":0,"anchors":anchors})).unwrap();selection.validate().unwrap();
        let p=super::super::super::super::super::tests::project(Path::new("."));
        let canonical=serde_json::to_string(&cache::mask_recipe(&selection,&p).unwrap()).unwrap();
        assert!(canonical.len()>MAX_RECEIPT as usize,"Fixture must exercise the supported input previously refused by review metadata");
        let mut binding=binding();binding.frames=100;binding.canonical_recipe_sha256=hex::encode(Sha256::digest(canonical.as_bytes()));binding.mask_identity=binding.canonical_recipe_sha256.clone();
        let mut review=receipt(binding,1,None,Decision::Approve);review.frames=vec![63];review.receipt_identity=review.identity().unwrap();
        assert!(serde_json::to_vec(&review).unwrap().len()<MAX_RECEIPT as usize);review.validate(&review.binding,1,None).unwrap();
    }
}
