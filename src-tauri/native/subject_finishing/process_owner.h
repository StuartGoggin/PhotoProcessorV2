#pragma once
#include <Windows.h>
#include <array>
#include <string>
#include <vector>
#include <stdexcept>
#include <chrono>

namespace subject_finishing {
// Per-pipeline lifetime ownership; structured arguments, no shell. The app's
// global Job Object alone cannot isolate cancellation of one render's children.
class OwnedHandle {
    HANDLE value=nullptr;
public:
    OwnedHandle()=default;
    explicit OwnedHandle(HANDLE handle):value(handle) {
        if(!value||value==INVALID_HANDLE_VALUE)throw std::runtime_error("Cannot create owned Windows handle");
    }
    ~OwnedHandle(){close();}
    OwnedHandle(const OwnedHandle&)=delete;OwnedHandle& operator=(const OwnedHandle&)=delete;
    OwnedHandle(OwnedHandle&& other) noexcept:value(other.value){other.value=nullptr;}
    OwnedHandle& operator=(OwnedHandle&& other) noexcept {
        if(this!=&other){close();value=other.value;other.value=nullptr;}return *this;
    }
    HANDLE get()const{return value;}
    void close(){if(value){CloseHandle(value);value=nullptr;}}
};
inline void checked(BOOL ok,const char* what) {
    if(!ok)throw std::runtime_error(std::string(what)+" (Windows "+std::to_string(GetLastError())+")");
}
struct OwnedPipe {
    OwnedHandle read,write;
    explicit OwnedPipe(bool childReads) {
        SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};HANDLE r=nullptr,w=nullptr;
        checked(CreatePipe(&r,&w,&security,1024*1024),"Cannot create bounded picture pipe");
        read=OwnedHandle(r);write=OwnedHandle(w);
        checked(SetHandleInformation(childReads?write.get():read.get(),HANDLE_FLAG_INHERIT,0),"Cannot restrict picture pipe inheritance");
    }
};
inline std::wstring quote_argument(const std::wstring& value) {
    std::wstring result=L"\"";size_t slashes=0;
    for(wchar_t c:value) {
        if(c==L'\\'){++slashes;continue;}
        result.append(slashes*(c==L'"'?2:1),L'\\');slashes=0;
        if(c==L'"')result+=L'\\';result+=c;
    }
    result.append(slashes*2,L'\\');return result+L'"';
}
class ChildGroup {
    OwnedHandle job;
public:
    ChildGroup():job(CreateJobObjectW(nullptr,nullptr)) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.JobMemoryLimit=SIZE_T(4)*1024*1024*1024;
        checked(SetInformationJobObject(job.get(),JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"Cannot configure bounded child ownership");
    }
    HANDLE get()const{return job.get();}
};
class OwnedChild {
    OwnedHandle process;
    void stop_failed_start() {
        if(WaitForSingleObject(process.get(),0)==WAIT_OBJECT_0)return;
        const BOOL requested=TerminateProcess(process.get(),1);
        // Retain the process handle until exit is established, including the
        // assignment-failed child which is not protected by the new job yet.
        if((!requested&&WaitForSingleObject(process.get(),0)!=WAIT_OBJECT_0)
            ||WaitForSingleObject(process.get(),2500)!=WAIT_OBJECT_0)
            throw std::runtime_error("OWNED_STOP_UNCONFIRMED");
    }
public:
    OwnedChild(const std::wstring& binary,const std::vector<std::wstring>& args,HANDLE input,HANDLE output,HANDLE group,
            const std::wstring& environment=L"",const std::wstring& directory=L"",HANDLE diagnostics=nullptr) {
        HANDLE copy=nullptr;
        checked(DuplicateHandle(GetCurrentProcess(),diagnostics?diagnostics:GetStdHandle(STD_ERROR_HANDLE),GetCurrentProcess(),&copy,0,TRUE,DUPLICATE_SAME_ACCESS),"Cannot duplicate child diagnostics");
        OwnedHandle error(copy);
        SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&bytes);std::vector<uint8_t> storage(bytes);
        auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        checked(InitializeProcThreadAttributeList(attributes,1,0,&bytes),"Cannot initialize child handle list");
        struct Guard{LPPROC_THREAD_ATTRIBUTE_LIST value;~Guard(){DeleteProcThreadAttributeList(value);}} guard{attributes};
        std::array<HANDLE,3> handles{input,output,error.get()};
        checked(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles.data(),sizeof(handles),nullptr,nullptr),"Cannot restrict child handle list");
        STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput=input;startup.StartupInfo.hStdOutput=output;startup.StartupInfo.hStdError=error.get();startup.lpAttributeList=attributes;
        std::wstring line=quote_argument(binary);for(const auto& value:args)line+=L" "+quote_argument(value);
        if(line.size()>32760)throw std::runtime_error("Finishing child argument list is too long");
        PROCESS_INFORMATION info{};
        checked(CreateProcessW(binary.c_str(),line.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,
            environment.empty()?nullptr:const_cast<wchar_t*>(environment.data()),directory.empty()?nullptr:directory.c_str(),
            &startup.StartupInfo,&info),"Cannot launch owned finishing child");
        process=OwnedHandle(info.hProcess);OwnedHandle thread(info.hThread);
        if(!AssignProcessToJobObject(group,process.get())) {
            stop_failed_start();throw std::runtime_error("Cannot isolate finishing child lifetime; refused before execution");
        }
        if(ResumeThread(thread.get())==DWORD(-1)) {
            stop_failed_start();throw std::runtime_error("Cannot resume supervised finishing child");
        }
    }
    void finish(DWORD remainingMilliseconds=30000) {
        if(WaitForSingleObject(process.get(),remainingMilliseconds)!=WAIT_OBJECT_0)throw std::runtime_error("Finishing child missed the EOF deadline");
        DWORD code=1;checked(GetExitCodeProcess(process.get(),&code),"Cannot read finishing child result");
        if(code)throw std::runtime_error("Finishing child failed with exit code "+std::to_string(code));
    }
    bool exited() const {return WaitForSingleObject(process.get(),0)==WAIT_OBJECT_0;}
    DWORD result() const {
        if(!exited())throw std::runtime_error("Finishing child result requested before exit");
        DWORD code=1;checked(GetExitCodeProcess(process.get(),&code),"Cannot read finishing child result");return code;
    }
    DWORD id() const {return GetProcessId(process.get());}
};
// Probe metadata is small and untrusted. Drain without an unbounded capture or
// blocking pipe read, enforce a wall deadline, and kill owned children on error.
inline std::string capture_bounded(const std::wstring& binary,const std::vector<std::wstring>& args,
        size_t limit=16384,std::chrono::seconds deadline=std::chrono::seconds(30)) {
    ChildGroup group;SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    OwnedHandle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedPipe output(false);OwnedChild child(binary,args,input.get(),output.write.get(),group.get());output.write.close();
    std::string result;const auto start=std::chrono::steady_clock::now();
    for(;;) {
        if(std::chrono::steady_clock::now()-start>deadline)throw std::runtime_error("Finishing metadata probe exceeded its deadline");
        DWORD available=0;
        if(!PeekNamedPipe(output.read.get(),nullptr,0,nullptr,&available,nullptr)) {
            if(GetLastError()==ERROR_BROKEN_PIPE)break;
            throw std::runtime_error("Finishing metadata probe pipe failed");
        }
        if(available) {
            std::array<char,4096> buffer{};DWORD read=0;
            checked(ReadFile(output.read.get(),buffer.data(),DWORD((std::min)(size_t(available),buffer.size())),&read,nullptr),"Cannot read finishing metadata");
            if(result.size()+read>limit)throw std::runtime_error("Finishing metadata exceeded its bounded output budget");
            result.append(buffer.data(),read);
        } else if(child.exited())break;
        else Sleep(10);
    }
    const auto remaining=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-(std::chrono::steady_clock::now()-start)).count();
    child.finish(DWORD((std::max)(int64_t(0),remaining)));return result;
}
inline bool read_exact_frame(HANDLE pipe,void* data,size_t bytes) {
    size_t offset=0;
    while(offset<bytes) {
        DWORD count=0;const BOOL ok=ReadFile(pipe,static_cast<uint8_t*>(data)+offset,DWORD(bytes-offset),&count,nullptr);
        if(!ok&&GetLastError()!=ERROR_BROKEN_PIPE)throw std::runtime_error("Finishing decoder pipe failed");
        if(!ok||!count){if(offset)throw std::runtime_error("Finishing decoder ended with a partial picture");return false;}
        offset+=count;
    }
    return true;
}
inline void write_exact_frame(HANDLE pipe,const void* data,size_t bytes) {
    size_t offset=0;
    while(offset<bytes) {
        DWORD count=0;checked(WriteFile(pipe,static_cast<const uint8_t*>(data)+offset,DWORD(bytes-offset),&count,nullptr),"Finishing encoder pipe failed");
        if(!count)throw std::runtime_error("Finishing encoder pipe made no progress");offset+=count;
    }
}
}
