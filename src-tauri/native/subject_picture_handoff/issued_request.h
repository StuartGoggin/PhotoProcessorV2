#pragma once
#include "supervisor.h"
#include <tlhelp32.h>
#include <cstring>

namespace picture_handoff {
// Per-run, inherited read-only kernel capability. Ambient job membership alone
// is not admission. No outer-job handle is inherited (kill-on-close stays owned
// solely by the controller); the inner worker never grants this mapping to FFmpeg.
struct IssuedRequest {
    uint32_t schema=1,bytes=sizeof(IssuedRequest),parentPid=0;
    FILETIME parentCreated{};
    uint64_t expires=0;
    wchar_t output[241]{};
    char sample[12]{},backend[12]{};
};
class IssuedInput {
    OwnedHandle writable,readOnly;
public:
    IssuedInput(const fs::path& output,const std::string& sample,const std::string& backend,unsigned seconds) {
        IssuedRequest value;value.parentPid=GetCurrentProcessId();
        FILETIME exit{},kernel{},user{};
        if(!GetProcessTimes(GetCurrentProcess(),&value.parentCreated,&exit,&kernel,&user)
            ||output.native().size()>240||sample.size()>11||backend.size()>11)
            throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
        value.expires=(std::min)(GetTickCount64()+uint64_t(seconds)*1000,caseDeadlineTick);
        std::copy(output.native().begin(),output.native().end(),value.output);
        std::copy(sample.begin(),sample.end(),value.sample);std::copy(backend.begin(),backend.end(),value.backend);
        writable=OwnedHandle(CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(value),nullptr));
        void* view=MapViewOfFile(writable.get(),FILE_MAP_WRITE,0,0,sizeof(value));
        if(!view)throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
        std::memcpy(view,&value,sizeof(value));UnmapViewOfFile(view);
        HANDLE copy=nullptr;
        if(!DuplicateHandle(GetCurrentProcess(),writable.get(),GetCurrentProcess(),&copy,FILE_MAP_READ,TRUE,0))
            throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
        readOnly=OwnedHandle(copy);
    }
    HANDLE get()const{return readOnly.get();}
};
inline void admit_issued_request(const fs::path& self,const fs::path& output,const std::string& sample,const std::string& backend) {
    const HANDLE raw=GetStdHandle(STD_INPUT_HANDLE);
    if(!raw||raw==INVALID_HANDLE_VALUE)throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
    OwnedHandle inherited(raw);
    const void* view=MapViewOfFile(inherited.get(),FILE_MAP_READ,0,0,sizeof(IssuedRequest));
    if(!view)throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
    IssuedRequest value;std::memcpy(&value,view,sizeof(value));UnmapViewOfFile(view);inherited.close();
    const uint64_t now=GetTickCount64();BOOL owned=FALSE;
    if(value.schema!=1||value.bytes!=sizeof(value)||!value.parentPid||value.output[240]||value.sample[11]||value.backend[11]
        ||value.expires<=now||value.expires-now>90000||fs::path(value.output)!=output||std::string(value.sample)!=sample
        ||std::string(value.backend)!=backend||!IsProcessInJob(GetCurrentProcess(),nullptr,&owned)||!owned)
        throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
    OwnedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0));
    PROCESSENTRY32W entry{};entry.dwSize=sizeof(entry);bool parentMatches=false;
    if(Process32FirstW(snapshot.get(),&entry))for(unsigned count=0;count<4096;++count) {
        if(entry.th32ProcessID==GetCurrentProcessId()){parentMatches=entry.th32ParentProcessID==value.parentPid;break;}
        if(!Process32NextW(snapshot.get(),&entry))break;
    }
    if(!parentMatches)throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
    OwnedHandle parent(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION|SYNCHRONIZE,FALSE,value.parentPid));
    FILETIME created{},exit{},kernel{},user{};std::array<wchar_t,32768> image{};DWORD length=DWORD(image.size());
    if(WaitForSingleObject(parent.get(),0)!=WAIT_TIMEOUT||!GetProcessTimes(parent.get(),&created,&exit,&kernel,&user)
        ||std::memcmp(&created,&value.parentCreated,sizeof(created))||!QueryFullProcessImageNameW(parent.get(),0,image.data(),&length)
        ||CompareStringOrdinal(image.data(),int(length),self.c_str(),int(self.native().size()),TRUE)!=CSTR_EQUAL)
        throw std::runtime_error("INTERNAL_OWNER_REQUIRED");
    caseDeadlineTick=value.expires;cancellation_point();
}
}
