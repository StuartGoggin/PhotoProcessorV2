//! Pre-launch integrity of the app-selected private pack, NOT a same-user sandbox.
//! No request may supply executable paths, profile authority or expected hashes.
use super::*;
use cache::OwnedRoot;
use std::collections::{BTreeMap,HashSet};

const MANUAL_CPU_SEAL:&str="3305693bb725b3d003c25381d3c02e381646fec5ee7dbad483f21e36448b2c78";
pub(super) fn seal_identity()->&'static str {MANUAL_CPU_SEAL}
const SEAL_MAX_BYTES:u64=8*1024*1024;
const SEAL_MAX_FILES:usize=40_000;

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Seal {schema:u32,profile:String,no_site:bool,qualification_candidate:bool,files:Vec<Entry>}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {path:String,bytes:u64,sha256:String,origin:String}

pub(super) struct ManualRuntime {
    pub root:PathBuf,pub python:PathBuf,pub script:PathBuf,pub worker:PathBuf,
    runner:PathBuf,names:HashSet<String>,directories:HashSet<String>,
    _files:Vec<fs::File>,_roots:Vec<OwnedRoot>,_directories:Vec<fs::File>,
}
fn safe_relative(value:&str)->bool {
    !value.is_empty() && value.len()<=1024 && !value.bytes().any(|b|b<32||b==b'\\'||b==b':')
        && value.split('/').all(|part| !part.is_empty()&&part!="."&&part!=".."&&!part.ends_with(['.',' ']))
}
fn enumerate(folder:&Path,prefix:&str,files:&mut BTreeMap<String,PathBuf>,dirs:&mut Vec<fs::File>,names:&mut HashSet<String>)->Result<(),String> {
    if dirs.len()>40_000||prefix.matches('/').count()>32 {return Err("Private inference tree exceeds its directory/depth bound".into());}
    dirs.push(cache::lease(folder,true)?);
    names.insert(prefix.into());
    for entry in fs::read_dir(folder).map_err(|e|e.to_string())? {
        let entry=entry.map_err(|e|e.to_string())?;let name=entry.file_name().into_string().map_err(|_|"Non-UTF8 inference path")?;
        let relative=format!("{prefix}/{name}");
        if !safe_relative(&relative) {return Err("Invalid inference tree path".into());}
        let path=entry.path();let info=fs::symlink_metadata(&path).map_err(|e|e.to_string())?;
        // The eventual opened-object check is authoritative. Refuse redirection
        // before deciding whether to recurse, so a directory link is not followed.
        #[cfg(windows)] {use std::os::windows::fs::MetadataExt;
            if info.file_attributes()&0x400!=0 {return Err("Redirected private inference descendant".into());}}
        if info.file_type().is_symlink(){return Err("Redirected private inference descendant".into());}
        if info.is_dir(){enumerate(&path,&relative,files,dirs,names)?;}
        else if info.is_file() {
            if files.len()>=SEAL_MAX_FILES || files.insert(relative,path).is_some(){return Err("Inference inventory exceeds its bound or collides".into());}
        } else {return Err("Unexpected private inference file type".into());}
    }
    Ok(())
}
fn inventory(root:&Path,runner:&Path)->Result<(BTreeMap<String,PathBuf>,Vec<fs::File>,HashSet<String>),String> {
    let mut files=BTreeMap::new();let mut dirs=Vec::new();let mut names=HashSet::from(["worker".into()]);
    for name in ["runtime","vendor","models"]{enumerate(&root.join(name),name,&mut files,&mut dirs,&mut names)?;}
    enumerate(runner,"runner",&mut files,&mut dirs,&mut names)?;
    files.insert("worker/photogogo-subject-finishing.exe".into(),runner.parent().ok_or("Missing worker folder")?.join("photogogo-subject-finishing.exe"));
    let archive="sam2-2b90b9f5ceec907a1c18123530e92e794ad901a4.zip";
    files.insert(archive.into(),root.join(archive));
    Ok((files,dirs,names))
}
impl ManualRuntime {
    fn verify(root:&Path,runner:&Path,expected:&str,id:Option<&str>,allow_candidate:bool)->Result<Self,String> {
        let root_guard=OwnedRoot::open(root)?;let runner_guard=OwnedRoot::open(runner)?;
        let mut manifest=cache::lease(&root_guard.path.join("runtime-manifest.json"),false)?;
        if manifest.metadata().map_err(|e|e.to_string())?.len()>SEAL_MAX_BYTES {return Err("Private inference manifest exceeds its size bound".into());}
        let (bytes,_,sha)=cache::hashes(&mut manifest,id)?;
        if bytes>SEAL_MAX_BYTES || sha!=expected {return Err("Private inference manifest is missing, changed or not admitted by this application build".into());}
        let mut payload=Vec::new();(&mut manifest).take(SEAL_MAX_BYTES+1).read_to_end(&mut payload).map_err(|e|e.to_string())?;
        let seal:Seal=serde_json::from_slice(&payload).map_err(|e|e.to_string())?;
        if seal.schema!=1||seal.profile!="manual-video-cpu-v1"||!seal.no_site||seal.files.is_empty()
            ||seal.files.len()>SEAL_MAX_FILES||(!allow_candidate&&seal.qualification_candidate) {
            return Err("Private inference profile is not release-qualified for this application build".into());
        }
        let mut names=HashSet::new();let mut lower=HashSet::new();
        for entry in &seal.files {
            if !safe_relative(&entry.path)||entry.path.ends_with(".pyc")||entry.bytes>4*1024*1024*1024
                ||entry.sha256.len()!=64||!entry.sha256.bytes().all(|b|b.is_ascii_hexdigit()&&!b.is_ascii_uppercase())
                ||entry.origin.is_empty()||entry.origin.len()>128||!lower.insert(entry.path.to_lowercase())||!names.insert(entry.path.clone()) {
                return Err("Malformed private inference file inventory".into());
            }
        }
        let mut directories=HashSet::new();for name in &names {
            let parts:Vec<_>=name.split('/').collect();for index in 1..parts.len(){directories.insert(parts[..index].join("/"));}
        }
        let (actual,dirs,actual_dirs)=inventory(&root_guard.path,&runner_guard.path)?;
        if actual.keys().cloned().collect::<HashSet<_>>()!=names {return Err("Missing or unexpected file in the admitted private inference trees".into());}
        if actual_dirs!=directories {return Err("Missing or unexpected directory shape in private inference trees".into());}
        let mut files=vec![manifest];
        for entry in seal.files {
            let mut held=cache::lease(&actual[&entry.path],false)?;
            if held.metadata().map_err(|e|e.to_string())?.len()!=entry.bytes {return Err(format!("Private inference payload size changed: {}",entry.path));}
            let (bytes,_,sha)=cache::hashes(&mut held,id)?;
            if bytes!=entry.bytes||sha!=entry.sha256 {return Err(format!("Private inference payload changed: {}",entry.path));}
            files.push(held);
        }
        let result=Self{root:root_guard.path.clone(),runner:runner_guard.path.clone(),
            python:root_guard.path.join("runtime/python.exe"),script:runner_guard.path.join("subject_mask_worker.py"),
            worker:runner_guard.path.parent().unwrap().join("photogogo-subject-finishing.exe"),
            names,directories,_files:files,_roots:vec![root_guard,runner_guard],_directories:dirs};
        result.check_namespace()?;Ok(result)
    }
    /// A second inventory catches additions before launch, not hostile additions
    /// after launch. Retained handles deny mutation of existing admitted files.
    pub fn check_namespace(&self)->Result<(),String> {
        let (files,_dirs,dirs)=inventory(&self.root,&self.runner)?;
        if files.keys().cloned().collect::<HashSet<_>>()!=self.names||dirs!=self.directories {return Err("Private inference namespace changed before launch".into());}
        Ok(())
    }
}
pub(super) fn resolve(id:&str)->Result<ManualRuntime,String> {
    let folder=std::env::current_exe().map_err(|e|e.to_string())?.parent().ok_or("Missing application directory")?.join("tools/subject-finishing");
    let installed=folder.join("inference/manual-cpu-v1");
    if installed.is_dir() {
        return ManualRuntime::verify(&installed,&folder.join("runner"),MANUAL_CPU_SEAL,Some(id),false);
    }
    if cfg!(test)||cfg!(debug_assertions) {
        let project=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        return ManualRuntime::verify(&project.join(".build-cache/subject-finishing-manual-cpu-v1"),
            &project.join("src-tauri/tools/subject-finishing/runner"),MANUAL_CPU_SEAL,Some(id),true);
    }
    Err("The qualified private subject-mask runtime is not installed. No global Python or PATH substitute was launched.".into())
}

#[cfg(test)]
mod tests {
    use super::*;use sha2::Sha256;
    fn fixture()->(PathBuf,PathBuf,String) {
        let root=std::env::temp_dir().join(format!("subject-runtime-seal-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let runner=root.join("app-runner");
        for folder in ["runtime","vendor","models","app-runner"]{fs::create_dir_all(root.join(folder)).unwrap();}
        let items=["runtime/python.exe","runtime/python313._pth","vendor/subject.py","models/weights.pt",
            "runner/subject_mask_worker.py","worker/photogogo-subject-finishing.exe","sam2-2b90b9f5ceec907a1c18123530e92e794ad901a4.zip"];
        let files:Vec<_>=items.iter().map(|name| {
            let path=if let Some(name)=name.strip_prefix("runner/"){runner.join(name)}
                else if let Some(name)=name.strip_prefix("worker/"){root.join(name)}else{root.join(name)};
            fs::write(&path,name.as_bytes()).unwrap();
            json!({"path":name,"bytes":name.len(),"sha256":hex::encode(Sha256::digest(name.as_bytes())),"origin":"fixture"})
        }).collect();
        let payload=serde_json::to_vec(&json!({"schema":1,"profile":"manual-video-cpu-v1","noSite":true,"qualificationCandidate":true,"files":files})).unwrap();
        let sha=hex::encode(Sha256::digest(&payload));fs::write(root.join("runtime-manifest.json"),payload).unwrap();(root,runner,sha)
    }
    #[test]
    fn private_profile_requires_build_authority_and_exact_payload_inventory() {
        let (root,runner,sha)=fixture();
        assert!(ManualRuntime::verify(&root,&runner,&"0".repeat(64),None,true).is_err());
        assert!(ManualRuntime::verify(&root,&runner,&sha,None,false).is_err(),"A development candidate was treated as a release pack");
        let runtime=ManualRuntime::verify(&root,&runner,&sha,None,true).unwrap();
        #[cfg(windows)] assert!(fs::OpenOptions::new().write(true).open(&runtime.python).is_err());
        // Deliberately prove the limited threat model: directory leases do NOT
        // prevent new files. The prelaunch inventory must detect an addition.
        fs::write(root.join("runtime/unexpected.py"),b"not admitted").unwrap();
        assert!(runtime.check_namespace().is_err());drop(runtime);
        assert!(ManualRuntime::verify(&root,&runner,&sha,None,true).is_err());
        fs::remove_file(root.join("runtime/unexpected.py")).unwrap();
        fs::create_dir(root.join("runtime/unexpected-empty")).unwrap();
        assert!(ManualRuntime::verify(&root,&runner,&sha,None,true).is_err(),"An unexpected empty directory changed the native search shape");
        fs::remove_dir(root.join("runtime/unexpected-empty")).unwrap();
        fs::write(root.join("vendor/subject.py"),b"changed").unwrap();
        assert!(ManualRuntime::verify(&root,&runner,&sha,None,true).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn seal_paths_refuse_escape_streams_and_ambiguous_components() {
        for name in ["/escape","../escape","runtime/../escape","runtime/a:b","runtime\\evil.py","runtime/name.","runtime//evil"] {
            assert!(!safe_relative(name),"Accepted {name}");
        }
    }
    #[test]
    #[ignore="full 21-package development pack integrity qualification; no inference"]
    fn actual_manual_runtime_seal_smoke() {
        let id=format!("manual-runtime-seal-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap());
        jobs().lock().unwrap().insert(id.clone(),StudioJob{id:id.clone(),..StudioJob::default()});
        let started=std::time::Instant::now();let runtime=resolve(&id).unwrap();
        println!("PASS: {} admitted payload handles, exact no-site CPU pack and runner; {:.3}s. Not footage/licence/installer acceptance.",runtime._files.len(),started.elapsed().as_secs_f64());
        assert!(fs::OpenOptions::new().write(true).open(&runtime.python).is_err());
        drop(runtime);jobs().lock().unwrap().remove(&id);
    }
}
