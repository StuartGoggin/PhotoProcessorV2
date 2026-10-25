//! Per-launch ownership, distinct from the app-wide job containing other work.
//! Spawn suspended, attach before execution, then await the entire job's drain.
use super::*;

fn quoted(value:&str)->Result<String,String> {
    if value.contains('\0'){return Err("Invalid native argument".into());}
    let mut result=String::from("\"");let mut slashes=0;
    for ch in value.chars() {
        if ch=='\\'{slashes+=1;continue;}
        result.push_str(&"\\".repeat(if ch=='"'{slashes*2+1}else{slashes}));slashes=0;result.push(ch);
    }
    result.push_str(&"\\".repeat(slashes*2));result.push('"');Ok(result)
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::os::windows::{ffi::OsStrExt,io::AsRawHandle};
    use windows_sys::Win32::{Foundation::*,System::{JobObjects::*,Threading::*}};
    struct Handle(HANDLE);
    // SAFETY: each handle is uniquely owned; Win32 job/process APIs synchronize
    // queries/termination. A handle is never shared with another running task.
    unsafe impl Send for Handle {}
    impl Drop for Handle {fn drop(&mut self){unsafe{CloseHandle(self.0);}}}
    fn handle(value:HANDLE)->Result<Handle,String> {
        if value.is_null()||value==INVALID_HANDLE_VALUE {Err(std::io::Error::last_os_error().to_string())}else{Ok(Handle(value))}
    }
    fn wide(value:&std::ffi::OsStr)->Vec<u16>{value.encode_wide().chain(Some(0)).collect()}
    struct Owner {job:Handle,process:Handle,pid:u32,children:Mutex<Vec<(u32,Handle)>>}
    // Field order is intentional: close stream handles before caller scratch
    // cleanup, including failed spawn and quarantine destruction.
    struct StreamRetention<T>{input:fs::File,output:fs::File,retention:T}
    struct PendingRetention<T>{io:Option<(fs::File,fs::File)>,retention:T}
    impl Owner {
        fn start<T:Send+'static>(binary:&Path,args:&[String],dir:&Path,stderr:&fs::File,
            id:&str,retention:StreamRetention<T>)->Result<Run<StreamRetention<T>>,String> {
            let binary_text=binary.to_str().ok_or("Native executable path is not Unicode")?;
            let mut line=quoted(binary_text)?;
            for argument in args {line.push(' ');line.push_str(&quoted(argument)?);}
            if line.encode_utf16().count()>32760 {return Err("Native argument list exceeds its bound".into());}
            let job=handle(unsafe{CreateJobObjectW(std::ptr::null(),std::ptr::null())})?;
            let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=unsafe{std::mem::zeroed()};
            limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            limits.BasicLimitInformation.ActiveProcessLimit=8;
            limits.JobMemoryLimit=4*1024*1024*1024;
            if unsafe{SetInformationJobObject(job.0,JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),std::mem::size_of_val(&limits) as u32)}==0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut copies=Vec::new();
            for source in [retention.input.as_raw_handle(),retention.output.as_raw_handle(),stderr.as_raw_handle()] {
                let mut copy=std::ptr::null_mut();
                if unsafe{DuplicateHandle(GetCurrentProcess(),source,GetCurrentProcess(),&mut copy,0,1,DUPLICATE_SAME_ACCESS)}==0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                copies.push(handle(copy)?);
            }
            let mut bytes=0;
            unsafe{InitializeProcThreadAttributeList(std::ptr::null_mut(),1,0,&mut bytes);}
            let mut storage=vec![0usize;bytes.div_ceil(std::mem::size_of::<usize>())];
            let attributes=storage.as_mut_ptr().cast();
            if unsafe{InitializeProcThreadAttributeList(attributes,1,0,&mut bytes)}==0 {return Err(std::io::Error::last_os_error().to_string());}
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {fn drop(&mut self){unsafe{DeleteProcThreadAttributeList(self.0);}}}
            let attributes=Attributes(attributes);
            let handles=[copies[0].0,copies[1].0,copies[2].0];
            if unsafe{UpdateProcThreadAttribute(attributes.0,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr().cast(),std::mem::size_of_val(&handles),std::ptr::null_mut(),std::ptr::null())}==0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut startup:STARTUPINFOEXW=unsafe{std::mem::zeroed()};
            startup.StartupInfo.cb=std::mem::size_of_val(&startup) as u32;startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput=handles[0];startup.StartupInfo.hStdOutput=handles[1];startup.StartupInfo.hStdError=handles[2];
            startup.lpAttributeList=attributes.0;
            let mut info:PROCESS_INFORMATION=unsafe{std::mem::zeroed()};
            let mut line:Vec<u16>=line.encode_utf16().chain(Some(0)).collect();
            let application=wide(binary.as_os_str());let directory=wide(dir.as_os_str());
            if unsafe{CreateProcessW(application.as_ptr(),line.as_mut_ptr(),std::ptr::null(),std::ptr::null(),1,
                CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,
                std::ptr::null(),directory.as_ptr(),&startup.StartupInfo,&mut info)}==0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            // The child now owns its inherited copies. Close the parent copies
            // before fallible assignment/resume can unwind caller scratch.
            drop(copies);
            // Successful CreateProcessW owns valid process/thread handles. Put
            // retention under RAII before any fallible assignment/resume step.
            let process=Handle(info.hProcess);let primary=Handle(info.hThread);
            let run=Run{owner:Some(Self{job,process,pid:info.dwProcessId,children:Mutex::new(Vec::new())}),retention:Some(retention),id:id.into()};
            let owner=run.owner.as_ref().unwrap();
            if unsafe{AssignProcessToJobObject(owner.job.0,owner.process.0)}==0 {
                let error=std::io::Error::last_os_error();
                return Err(format!("Cannot isolate native worker before execution: {error}"));
            }
            if unsafe{ResumeThread(primary.0)}==u32::MAX {return Err("Cannot resume the isolated native worker".into());}
            Ok(run)
        }
        fn status(&self)->Result<Option<u32>,String> {
            match unsafe{WaitForSingleObject(self.process.0,0)} {
                WAIT_TIMEOUT=>Ok(None),WAIT_OBJECT_0=> {
                    let mut code=1;
                    if unsafe{GetExitCodeProcess(self.process.0,&mut code)}==0{return Err(std::io::Error::last_os_error().to_string());}
                    Ok(Some(code))
                },_=>Err(std::io::Error::last_os_error().to_string()),
            }
        }
        fn active(&self)->Result<u32,String> {
            let mut accounting:JOBOBJECT_BASIC_ACCOUNTING_INFORMATION=unsafe{std::mem::zeroed()};
            if unsafe{QueryInformationJobObject(self.job.0,JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut())}==0 {return Err(std::io::Error::last_os_error().to_string());}
            Ok(accounting.ActiveProcesses)
        }
        fn observe_children(&self)->Result<(),String> {
            // Independent exit evidence for observed exact-job members: retain
            // real handles before termination, not post-exit PIDs that can later
            // be recycled. This snapshot is not universal child registration.
            #[repr(C)] struct Pids {assigned:u32,in_list:u32,ids:[usize;128]}
            let mut list=Pids{assigned:0,in_list:0,ids:[0;128]};
            if unsafe{QueryInformationJobObject(self.job.0,JobObjectBasicProcessIdList,
                (&mut list as *mut Pids).cast(),std::mem::size_of_val(&list) as u32,std::ptr::null_mut())}==0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            if list.in_list>128||list.assigned>128{return Err("Owned process inventory exceeds its cleanup bound".into());}
            let mut children=self.children.lock().unwrap_or_else(|e|e.into_inner());
            for &pid in &list.ids[..list.in_list as usize] {
                let pid=u32::try_from(pid).map_err(|_|"Invalid owned process ID")?;
                if pid==self.pid||children.iter().any(|(known,_)|*known==pid){continue;}
                let raw=unsafe{OpenProcess(SYNCHRONIZATION_SYNCHRONIZE|PROCESS_QUERY_LIMITED_INFORMATION,0,pid)};
                if raw.is_null() {
                    let error=std::io::Error::last_os_error();
                    if error.raw_os_error()==Some(87){continue;} // process already ceased to exist
                    return Err(format!("Cannot retain owned process for exit verification: {error}"));
                }
                let child=Handle(raw);let mut in_job=0;
                if unsafe{IsProcessInJob(child.0,self.job.0,&mut in_job)}==0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                // If the snapshot PID was recycled, never retain, signal or
                // wait on an unrelated process outside this exact private job.
                if in_job!=0{children.push((pid,child));}
            }
            Ok(())
        }
        fn drained(&self)->bool {
            self.active()==Ok(0)&&matches!(self.status(),Ok(Some(_)))
                &&self.children.lock().unwrap_or_else(|e|e.into_inner()).iter()
                    .all(|(_,child)|unsafe{WaitForSingleObject(child.0,0)}==WAIT_OBJECT_0)
        }
        fn stop(&self){unsafe{TerminateJobObject(self.job.0,1);TerminateProcess(self.process.0,1);}}
        fn drain(&self,limit:Duration)->bool {
            if self.observe_children().is_err(){self.stop();return false;}
            self.stop();let started=std::time::Instant::now();
            loop {
                if self.drained(){return true;}
                if started.elapsed()>=limit{return false;}
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
    impl Drop for Owner {fn drop(&mut self){self.stop();}}
    struct Quarantined {owner:Owner,_retention:Box<dyn Send>,id:String}
    fn items()->&'static Mutex<Vec<Quarantined>> {
        static ITEMS:OnceLock<Mutex<Vec<Quarantined>>>=OnceLock::new();ITEMS.get_or_init(||Mutex::new(Vec::new()))
    }
    pub(super) fn poll_cleanup() {
        items().lock().unwrap_or_else(|e|e.into_inner()).retain(|item| {
            item.owner.stop();
            if item.owner.drained(){update(&item.id,|j|{
                j.process_ids.retain(|pid|*pid!=item.owner.pid);j.process_id=j.process_ids.last().copied();
                j.logs.push("Owned finishing tree drained; quarantined leases/reservations released".into());
            });false}else{true}
        });
    }
    fn quarantine(owner:Owner,retention:Box<dyn Send>,id:&str) {
        static WORKER:Mutex<bool>=Mutex::new(false);
        // Poisoning is not permission to release live resources: keep ownership
        // even after an unrelated panic. Thread-start failure also leaves it here.
        items().lock().unwrap_or_else(|e|e.into_inner()).push(Quarantined{owner,_retention:retention,id:id.into()});
        let mut running=WORKER.lock().unwrap_or_else(|e|e.into_inner());
        if !*running {
            match thread::Builder::new().name("subject-tree-cleanup".into()).spawn(move ||loop {
                // Preserve the independent status/admission cleanup paths even
                // if one poll panics; the registry owns all undrained resources.
                if std::panic::catch_unwind(poll_cleanup).is_err() {
                    eprintln!("Subject finishing cleanup poll panicked; ownership retained and polling will retry");
                }
                thread::sleep(Duration::from_secs(1));
            }) {
                Ok(_)=>*running=true,
                Err(error)=>update(id,|j|j.logs.push(format!("Cleanup thread could not start: {error}. Ownership retained; Studio status/admission polling will also drain it, and a later quarantine can retry worker startup."))),
            }
        }
    }
    struct Run<T:Send+'static>{owner:Option<Owner>,retention:Option<T>,id:String}
    impl<T:Send+'static> Drop for Run<T> {
        fn drop(&mut self) {
            if let (Some(owner),Some(retention))=(self.owner.take(),self.retention.take()) {
                if !owner.drain(Duration::from_secs(30)) {
                    update(&self.id,|j|j.logs.push("Finishing cleanup is pending: runtime leases and resource admission remain quarantined".into()));
                    quarantine(owner,Box::new(retention),&self.id);
                }
            }
        }
    }
    impl<T:Send+'static> Run<T> {
        fn quarantine(&mut self) {
            if let (Some(owner),Some(retention))=(self.owner.take(),self.retention.take()) {
                quarantine(owner,Box::new(retention),&self.id);
            }
        }
    }
    pub(super) fn run<T:Send+'static>(binary:&Path,args:&[String],dir:&Path,id:&str,phase:&str,
        timeout:Duration,retention:T,io:Option<(fs::File,fs::File)>)->Result<(T,Result<(),String>),String> {
        let mut pending=PendingRetention{io,retention};
        if stopped_or_paused(id){drop(pending.io.take());return Ok((pending.retention,Err(diagnostics::RETRY_ADMISSION.into())));}
        let log_path=diagnostics::create_log(id)?;let log_root=Path::new(&log_path).parent().ok_or("Missing diagnostic directory")?;
        let stamp=chrono::Utc::now().timestamp_nanos_opt().ok_or("Cannot name worker diagnostics")?;
        let stdout_path=log_root.join(format!("{stamp}-subject-stdout.txt"));
        let stderr_path=log_root.join(format!("{stamp}-subject-stderr.txt"));
        let stdout=fs::OpenOptions::new().write(true).create_new(true).open(&stdout_path).map_err(|e|e.to_string())?;
        let stderr=fs::OpenOptions::new().write(true).create_new(true).open(&stderr_path).map_err(|e|e.to_string())?;
        let (input,output)=match pending.io.take(){Some(io)=>io,None=>(fs::File::open("NUL").map_err(|e|e.to_string())?,stdout)};
        let stream=StreamRetention{input,output,retention:pending.retention};
        let mut run=Owner::start(binary,args,dir,&stderr,id,stream)?;let pid=run.owner.as_ref().unwrap().pid;
        update(id,|j|{j.log_path=log_path;j.phase=phase.into();j.process_id=Some(pid);j.process_ids.push(pid);
            j.process_name=binary.file_name().unwrap_or_default().to_string_lossy().into_owned();
            j.logs.push(format!("{phase}: isolated PID {pid}, assigned while suspended; {stdout_path:?}; {stderr_path:?}"));});
        let started=std::time::Instant::now();let mut heartbeat=std::time::Instant::now();
        let result=loop {
            if let Err(error)=run.owner.as_ref().unwrap().observe_children(){break Err(error);}
            let cancelled=jobs().lock().map(|s|s.get(id).is_none_or(|j|j.cancelled||j.worker_error.is_some())).unwrap_or(true);
            if cancelled{break Err("Cancelled".into());}
            if started.elapsed()>=timeout{break Err("Subject worker timed out".into());}
            match run.owner.as_ref().unwrap().status() {
                Ok(Some(0))=>break Ok(()),Ok(Some(code))=>break Err(format!("Subject worker failed with exit code {code}; diagnostics: {}",stderr_path.display())),
                Err(error)=>break Err(error),Ok(None)=>{},
            }
            if heartbeat.elapsed()>=Duration::from_secs(5){update(id,|j|j.heartbeat_at=chrono::Utc::now().to_rfc3339());heartbeat=std::time::Instant::now();}
            thread::sleep(Duration::from_millis(100));
        };
        let drained=run.owner.as_ref().unwrap().drain(Duration::from_secs(30));
        let observed=run.owner.as_ref().unwrap().children.lock().unwrap_or_else(|e|e.into_inner())
            .iter().map(|(pid,_)|*pid).collect::<Vec<_>>();
        update(id,|j|{if drained{j.process_ids.retain(|p|*p!=pid);j.process_id=j.process_ids.last().copied();}
            j.logs.push(format!("{phase}: {:.2}s; complete isolated job drain={drained}; exact-job observed children={observed:?}",started.elapsed().as_secs_f64()));});
        if !drained{run.quarantine();return Err("Finishing tree cleanup remains pending; leases and memory/process reservations are retained, no artifact was committed".into());}
        run.owner.take();let StreamRetention{input,output,retention}=run.retention.take().unwrap();drop(input);drop(output);Ok((retention,result))
    }
}
pub(super) fn run<T:Send+'static>(binary:&Path,args:&[String],dir:&Path,id:&str,phase:&str,
    timeout:Duration,retention:T)->Result<(T,Result<(),String>),String> {
    #[cfg(windows)] {windows::run(binary,args,dir,id,phase,timeout,retention,None)}
    #[cfg(not(windows))] {let _=(binary,args,dir,id,phase,timeout,retention);Err("Owned finishing launch is not qualified on this platform".into())}
}
/// One bounded frame stream through the identical export kernel. No pipes,
/// reader-thread queue or PATH/shell substitution; owned file IO drains with
/// the same process job and retention contract as the full video worker.
pub(super) fn run_io<T:Send+'static>(binary:&Path,args:&[String],dir:&Path,id:&str,phase:&str,
    timeout:Duration,retention:T,input:fs::File,output:fs::File)->Result<(T,Result<(),String>),String> {
    #[cfg(windows)] {windows::run(binary,args,dir,id,phase,timeout,retention,Some((input,output)))}
    #[cfg(not(windows))] {let _=(binary,args,dir,id,phase,timeout,retention,input,output);Err("Owned finishing frame stream is not qualified on this platform".into())}
}
pub(super) fn poll_cleanup(){#[cfg(windows)] windows::poll_cleanup();}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[cfg(windows)]
    fn frame_stream_error_startup_and_cancellation_close_io_before_scratch_cleanup() {
        struct Cleanup {input:PathBuf,output:PathBuf,closed:Arc<std::sync::atomic::AtomicBool>}
        impl Drop for Cleanup {fn drop(&mut self){let done=fs::remove_file(&self.input).is_ok()&&fs::remove_file(&self.output).is_ok();self.closed.store(done,Ordering::Relaxed);}}
        for mode in ["worker-error","startup-error","cancelled"] {
            let root=std::env::temp_dir().join(format!("subject-io-cleanup-{mode}-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));fs::create_dir(&root).unwrap();
            let input_path=root.join("input.rgba");let output_path=root.join("output.rgba");fs::write(&input_path,b"bounded bytes").unwrap();
            let input=cache::lease(&input_path,false).unwrap();
            let mut options=fs::OpenOptions::new();options.write(true).create_new(true);
            use std::os::windows::fs::OpenOptionsExt;options.share_mode(1);let output=options.open(&output_path).unwrap();
            let id=format!("subject-frame-{mode}-{}",root.file_name().unwrap().to_string_lossy());jobs().lock().unwrap().insert(id.clone(),StudioJob::default());
            let closed=Arc::new(std::sync::atomic::AtomicBool::new(false));let cleanup=Cleanup{input:input_path,output:output_path,closed:closed.clone()};
            let shell=if mode=="startup-error"{root.join("missing-worker.exe")}else{PathBuf::from("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe")};
            let args=vec!["-NoProfile".into(),"-Command".into(),if mode=="cancelled"{"Start-Sleep -Seconds 15".into()}else{"exit 7".into()}];
            let stopper=if mode=="cancelled" {let id=id.clone();Some(thread::spawn(move||{let began=std::time::Instant::now();loop {
                let mut state=jobs().lock().unwrap();let job=state.get_mut(&id).unwrap();if job.process_id.is_some(){job.cancelled=true;break;}
                drop(state);assert!(began.elapsed()<Duration::from_secs(10));thread::sleep(Duration::from_millis(20));}}))}else{None};
            match run_io(&shell,&args,&root,&id,"Cleanup qualification",Duration::from_secs(10),cleanup,input,output) {
                Ok((retained,result))=>{assert!(result.is_err());assert!(!closed.load(Ordering::Relaxed));drop(retained);},
                Err(_)=>assert_eq!(mode,"startup-error"),
            }
            if let Some(stopper)=stopper{stopper.join().unwrap();}assert!(closed.load(Ordering::Relaxed),"IO was still held when scratch cleanup ran for {mode}");
            jobs().lock().unwrap().remove(&id);fs::remove_dir(root).unwrap();
        }
    }
    #[test]
    #[cfg(windows)]
    fn bounded_frame_stream_returns_exact_bytes_and_retains_actual_io_until_drain() {
        let root=std::env::temp_dir().join(format!("subject-frame-stream-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));fs::create_dir(&root).unwrap();
        let (input_path,output_path)=(root.join("input.rgba"),root.join("output.rgba"));let bytes=(0..=255u8).collect::<Vec<_>>();fs::write(&input_path,&bytes).unwrap();
        let input=cache::lease(&input_path,false).unwrap();let output=fs::OpenOptions::new().write(true).create_new(true).open(&output_path).unwrap();
        let id=format!("subject-frame-test-{}",root.file_name().unwrap().to_string_lossy());jobs().lock().unwrap().insert(id.clone(),StudioJob::default());
        let shell=Path::new("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
        let args=vec!["-NoProfile".into(),"-Command".into(),"[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())".into()];
        let (retained,result)=run_io(shell,&args,&root,&id,"Exact frame stream",Duration::from_secs(10),input.try_clone().unwrap(),input.try_clone().unwrap(),output.try_clone().unwrap()).unwrap();
        result.unwrap();assert_eq!(fs::read(&output_path).unwrap(),bytes);assert!(fs::OpenOptions::new().write(true).open(&input_path).is_err());
        drop(retained);drop(input);drop(output);jobs().lock().unwrap().remove(&id);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_arguments_preserve_spaces_quotes_and_trailing_slashes_without_shell_expansion() {
        assert_eq!(quoted("a b").unwrap(),"\"a b\"");assert_eq!(quoted("a\"b").unwrap(),"\"a\\\"b\"");
        assert_eq!(quoted("C:\\folder\\").unwrap(),"\"C:\\folder\\\\\"");
        assert_eq!(quoted("$env:SECRET & x").unwrap(),"\"$env:SECRET & x\"");assert!(quoted("bad\0arg").is_err());
    }
    #[cfg(windows)]
    fn owned_tree(cancel:bool) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle,System::Threading::{OpenProcess,WaitForSingleObject,PROCESS_QUERY_LIMITED_INFORMATION,SYNCHRONIZATION_SYNCHRONIZE}};
        let root=std::env::temp_dir().join(format!("subject-owned-tree-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();let input=root.join("retained-input.bin");fs::write(&input,b"fixture").unwrap();
        let held=cache::lease(&input,false).unwrap();let child_id=root.join("child-id.txt");
        let powershell=Path::new("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
        let literal=|path:&Path|format!("'{}'",path.to_string_lossy().replace('\'',"''"));
        // Start-Process can use ShellExecute and delegate creation to a shell
        // broker outside this job. The production worker uses CreateProcess;
        // exercise that actual inheritance contract without a shell broker.
        let retained_marker=root.join("child-retained.txt");
        let script=format!("$ownedTestInfo=New-Object System.Diagnostics.ProcessStartInfo; $ownedTestInfo.FileName={}; $ownedTestInfo.Arguments='-NoProfile -Command \"Start-Sleep -Seconds 60\"'; $ownedTestInfo.UseShellExecute=$false; $ownedTestInfo.CreateNoWindow=$true; $ownedTestChild=[System.Diagnostics.Process]::Start($ownedTestInfo); [IO.File]::WriteAllText({},[string]$ownedTestChild.Id); $ownedTestWait=[Diagnostics.Stopwatch]::StartNew(); while(-not [IO.File]::Exists({}) -and $ownedTestWait.Elapsed.TotalSeconds -lt 20){{Start-Sleep -Milliseconds 50}}; {}",
            literal(powershell),literal(&child_id),literal(&retained_marker),if cancel{"Start-Sleep -Seconds 60"}else{"exit 0"});
        let id=format!("subject-tree-test-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap());
        jobs().lock().unwrap().insert(id.clone(),StudioJob{id:id.clone(),..StudioJob::default()});
        let stopper={
            let id=id.clone();let marker=child_id.clone();thread::spawn(move || {
                let started=std::time::Instant::now();
                let pid=loop {
                    if let Some(pid)=fs::read_to_string(&marker).ok().and_then(|s|s.parse::<u32>().ok()){break pid;}
                    assert!(started.elapsed()<Duration::from_secs(20),"Child never published its PID");
                    thread::sleep(Duration::from_millis(50));
                };
                let child=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZATION_SYNCHRONIZE,0,pid)};
                assert!(!child.is_null(),"Cannot retain the live qualification child");
                assert_eq!(unsafe{WaitForSingleObject(child,0)},258,"Fixture child was not alive before drain");
                fs::write(retained_marker,b"retained").unwrap();
                // Ensure the launcher also samples this admitted live member.
                thread::sleep(Duration::from_millis(200));
                if cancel{jobs().lock().unwrap().get_mut(&id).unwrap().cancelled=true;}
                (pid,child as usize)
            })
        };
        let (retention,status)=run(powershell,&["-NoProfile".into(),"-Command".into(),script],&root,&id,
            "Owned tree contract",Duration::from_secs(25),held).unwrap();
        let (pid,child)=stopper.join().unwrap();let child=child as *mut std::ffi::c_void;
        assert_eq!(status.is_err(),cancel);if cancel{assert!(status.unwrap_err().contains("Cancelled"));}
        assert_eq!(unsafe{WaitForSingleObject(child,0)},0,"Descendant outlived the returned retention");unsafe{CloseHandle(child);}
        assert!(fs::OpenOptions::new().write(true).open(&input).is_err(),"Input lease was released before returned retention");
        assert!(!retention.as_raw_handle().is_null());drop(retention);
        assert!(fs::OpenOptions::new().write(true).open(&input).is_ok());
        assert!(jobs().lock().unwrap().get(&id).unwrap().logs.iter().any(|line|line.contains("complete isolated job drain=true")));
        assert!(jobs().lock().unwrap().get(&id).unwrap().logs.iter().any(|line|line.contains("exact-job observed children=")&&line.contains(&pid.to_string())),"Qualification child was not observed as a member of this exact job");
        jobs().lock().unwrap().remove(&id);fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[cfg(windows)]
    fn normal_owner_exit_drains_inherited_descendants_before_returning_retention(){owned_tree(false);}
    #[test]
    #[cfg(windows)]
    fn cancellation_drains_inherited_descendants_before_returning_retention(){owned_tree(true);}
}
