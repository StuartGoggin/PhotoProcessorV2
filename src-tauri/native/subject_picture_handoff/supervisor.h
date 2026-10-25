#pragma once
#include "../subject_finishing/process_owner.h"
#include <bcrypt.h>
#include <filesystem>
#include <map>
#include <atomic>
#include <sstream>
#include <iomanip>
#include <mutex>
#include <regex>
#include <iostream>

namespace picture_handoff {
using namespace subject_finishing;
namespace fs=std::filesystem;
inline std::atomic<bool> cancelled{false};
inline std::mutex commitMutex;
inline bool committed=false;
inline uint64_t caseDeadlineTick=0;
inline BOOL WINAPI console_control(DWORD event) {
    if(event==CTRL_C_EVENT||event==CTRL_BREAK_EVENT) {
        std::lock_guard<std::mutex> guard(commitMutex);if(!committed)cancelled=true;return TRUE;
    }
    return FALSE;
}
inline void cancellation_point(){
    if(cancelled)throw std::runtime_error("CANCELLED");
    if(caseDeadlineTick&&GetTickCount64()>=caseDeadlineTick)throw std::runtime_error("OVERALL_DEADLINE");
}
inline std::wstring module_path() {
    std::array<wchar_t,32768> buffer{};const DWORD length=GetModuleFileNameW(nullptr,buffer.data(),DWORD(buffer.size()));
    if(!length||length>=buffer.size())throw std::runtime_error("RUNNER_IDENTITY_UNAVAILABLE");
    return std::wstring(buffer.data(),length);
}

// Directory leases participate in sharing checks and pin each non-reparse ancestor.
class FileSet {
    std::map<std::wstring,OwnedHandle> directories;
    std::map<std::wstring,OwnedHandle> files;
public:
    void ancestry(const fs::path& target) {
        const auto native=target.native();
        if(native.size()<4||native.size()>240||native[1]!=L':'||native[2]!=L'\\'
            ||!((native[0]>=L'A'&&native[0]<=L'Z')||(native[0]>=L'a'&&native[0]<=L'z'))
            ||target!=target.lexically_normal()||target==target.root_path())throw std::runtime_error("ORDINARY_LOCAL_PATH_REQUIRED");
        for(const auto& component:target.relative_path()) {
            const auto text=component.native();
            if(text.empty()||text.back()==L'.'||text.back()==L' '||text.find_first_of(L":*?\"<>|")!=std::wstring::npos)
                throw std::runtime_error("ORDINARY_LOCAL_PATH_REQUIRED");
        }
        const UINT drive=GetDriveTypeW(target.root_path().c_str());
        if(drive!=DRIVE_FIXED&&drive!=DRIVE_REMOVABLE)throw std::runtime_error("LOCAL_VOLUME_REQUIRED");
        std::vector<fs::path> parents;
        for(auto parent=target.parent_path();!parent.empty();) {
            parents.push_back(parent);const auto next=parent.parent_path();if(next==parent)break;parent=next;
        }
        for(auto i=parents.rbegin();i!=parents.rend();++i)directory(*i);
    }
    void directory(const fs::path& path) {
        if(directories.count(path.native()))return;
        const HANDLE raw=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        if(raw==INVALID_HANDLE_VALUE)throw std::runtime_error("DIRECTORY_LEASE_REFUSED");
        OwnedHandle handle(raw);BY_HANDLE_FILE_INFORMATION info{};
        if(!GetFileInformationByHandle(handle.get(),&info)||!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)
            ||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))throw std::runtime_error("REDIRECTION_REFUSED");
        directories.emplace(path.native(),std::move(handle));
    }
    HANDLE file(const fs::path& path) {
        const auto found=files.find(path.native());if(found!=files.end())return found->second.get();
        ancestry(path);
        const HANDLE raw=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        if(raw==INVALID_HANDLE_VALUE)throw std::runtime_error("INPUT_LEASE_REFUSED");
        OwnedHandle handle(raw);BY_HANDLE_FILE_INFORMATION info{};
        if(!GetFileInformationByHandle(handle.get(),&info)||GetFileType(handle.get())!=FILE_TYPE_DISK
            ||(info.dwFileAttributes&(FILE_ATTRIBUTE_DIRECTORY|FILE_ATTRIBUTE_REPARSE_POINT)))
            throw std::runtime_error("REDIRECTION_REFUSED");
        const auto inserted=files.emplace(path.native(),std::move(handle));return inserted.first->second.get();
    }
};
inline uint64_t file_bytes(HANDLE handle) {
    LARGE_INTEGER size{};if(!GetFileSizeEx(handle,&size)||size.QuadPart<=0||size.QuadPart>64*1024*1024)
        throw std::runtime_error("FILE_BUDGET_EXCEEDED");
    return uint64_t(size.QuadPart);
}
inline std::string sha256(HANDLE handle) {
    cancellation_point();const uint64_t expected=file_bytes(handle);
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)
        throw std::runtime_error("HASH_UNAVAILABLE");
    struct Guard{BCRYPT_ALG_HANDLE* a;BCRYPT_HASH_HANDLE* h;~Guard(){if(*h)BCryptDestroyHash(*h);if(*a)BCryptCloseAlgorithmProvider(*a,0);}} guard{&algorithm,&hash};
    ULONG size=0,count=0;
    if(BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&size),sizeof(size),&count,0)<0||!size||size>65536)
        throw std::runtime_error("HASH_UNAVAILABLE");
    std::vector<uint8_t> object(size);
    if(BCryptCreateHash(algorithm,&hash,object.data(),size,nullptr,0,0)<0)throw std::runtime_error("HASH_UNAVAILABLE");
    LARGE_INTEGER origin{};if(!SetFilePointerEx(handle,origin,nullptr,FILE_BEGIN))throw std::runtime_error("INPUT_READ_FAILED");
    std::array<uint8_t,65536> bytes{};uint64_t total=0;
    for(;;) {
        cancellation_point();DWORD read=0;
        if(!ReadFile(handle,bytes.data(),DWORD(bytes.size()),&read,nullptr))throw std::runtime_error("INPUT_READ_FAILED");
        if(!read)break;total+=read;
        if(total>expected||BCryptHashData(hash,bytes.data(),read,0)<0)throw std::runtime_error("HASH_FAILED");
    }
    if(total!=expected)throw std::runtime_error("INPUT_READ_FAILED");
    std::array<uint8_t,32> digest{};
    if(BCryptFinishHash(hash,digest.data(),ULONG(digest.size()),0)<0)throw std::runtime_error("HASH_FAILED");
    constexpr char hex[]="0123456789abcdef";std::string result;
    for(const auto byte:digest){result+=hex[byte>>4];result+=hex[byte&15];}return result;
}
inline void publish(const fs::path& file,const std::string& text,bool finalCommit=true) {
    cancellation_point();if(text.size()>65536)throw std::runtime_error("REPORT_BUDGET_EXCEEDED");
    OwnedHandle handle(CreateFileW(file.c_str(),GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    DWORD count=0;
    if(!WriteFile(handle.get(),text.data(),DWORD(text.size()),&count,nullptr)||count!=text.size()||!FlushFileBuffers(handle.get()))
        throw std::runtime_error("REPORT_WRITE_FAILED");
    LARGE_INTEGER origin{};std::string readback(text.size(),'\0');
    if(!SetFilePointerEx(handle.get(),origin,nullptr,FILE_BEGIN)||!ReadFile(handle.get(),readback.data(),DWORD(readback.size()),&count,nullptr)
        ||count!=text.size()||readback!=text)throw std::runtime_error("REPORT_READBACK_FAILED");
    // The JSON alone is incomplete. A new zero-byte, hash-bearing marker is the
    // atomic completion boundary; no rename, replacement or directory-lease gap.
    const auto hash=sha256(handle.get());
    const auto marker=file.parent_path()/fs::path(file.stem().string()+"."+hash+".committed");
    std::lock_guard<std::mutex> guard(commitMutex);cancellation_point();
    const HANDLE raw=CreateFileW(marker.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(raw==INVALID_HANDLE_VALUE)throw std::runtime_error("REPORT_COMMIT_FAILED");
    OwnedHandle committedMarker(raw);
    if(finalCommit)committed=true;
}
struct Capture {std::string out,err;double seconds=0;uint64_t peakBytes=0;DWORD exitCode=0;};
inline ULONG active_processes(HANDLE job) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION value{};
    if(!QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&value,sizeof(value),nullptr))
        throw std::runtime_error("OWNERSHIP_QUERY_FAILED");
    return value.ActiveProcesses;
}
inline std::wstring minimal_environment(const fs::path& scratch) {
    std::array<wchar_t,32768> system{};const UINT count=GetWindowsDirectoryW(system.data(),UINT(system.size()));
    if(!count||count>=system.size())throw std::runtime_error("SYSTEM_DIRECTORY_UNAVAILABLE");
    const fs::path windows(std::wstring(system.data(),count));
    std::wstring result;
    for(const auto& pair:std::vector<std::pair<std::wstring,std::wstring>>{
        {L"PATH",(windows/L"System32").wstring()},{L"SystemRoot",windows.wstring()},
        {L"TEMP",scratch.wstring()},{L"TMP",scratch.wstring()},{L"WINDIR",windows.wstring()}}) {
        result+=pair.first+L"="+pair.second;result+=L'\0';
    }
    result+=L'\0';return result;
}
inline Capture supervised(const fs::path& binary,const std::vector<std::wstring>& args,const fs::path& scratch,
        unsigned seconds=30,const fs::path& growingOutput={},HANDLE suppliedInput=nullptr,bool allowFailedChild=false) {
    cancellation_point();ChildGroup group;
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    OwnedHandle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedPipe output(false),error(false);
    const auto start=std::chrono::steady_clock::now();Capture result;
    OwnedChild child(binary.wstring(),args,suppliedInput?suppliedInput:input.get(),output.write.get(),group.get(),minimal_environment(scratch),scratch.wstring(),error.write.get());
    output.write.close();error.write.close();
    bool stdoutClosed=false,stderrClosed=false;const char* failure=nullptr;
    bool mediaAnnounced=false;
    const std::regex mediaIds(R"(\{"schema":1,"event":"pipelineStarted","children":\[([0-9]{1,10}),([0-9]{1,10})\]\})");
    auto drain=[&](HANDLE pipe,std::string& text,bool& closed,bool retain) {
        if(closed)return;DWORD available=0;
        if(!PeekNamedPipe(pipe,nullptr,0,nullptr,&available,nullptr)) {
            if(GetLastError()==ERROR_BROKEN_PIPE){closed=true;return;}
            failure="CHILD_CAPTURE_FAILED";closed=true;return;
        }
        if(!available)return;
        std::array<char,4096> bytes{};DWORD count=0;
        if(!ReadFile(pipe,bytes.data(),DWORD((std::min)(size_t(available),bytes.size())),&count,nullptr)) {
            failure="CHILD_CAPTURE_FAILED";closed=true;return;
        }
        if(retain) {
            if(text.size()+count>65536){failure="CHILD_CAPTURE_LIMIT";return;}
            text.append(bytes.data(),count);
        }
    };
    try {for(;;) {
        drain(output.read.get(),result.out,stdoutClosed,true);drain(error.read.get(),result.err,stderrClosed,true);
        if(!growingOutput.empty()&&!mediaAnnounced) {
            std::smatch ids;
            if(std::regex_search(result.err,ids,mediaIds)) {
                std::cout<<"{\"event\":\"ownedMediaStarted\",\"children\":["<<ids[1].str()<<','<<ids[2].str()<<"]}\n"<<std::flush;
                mediaAnnounced=true;
            }
        }
        if(cancelled)failure="CANCELLED";
        if(caseDeadlineTick&&GetTickCount64()>=caseDeadlineTick)failure="OVERALL_DEADLINE";
        if(std::chrono::steady_clock::now()-start>std::chrono::seconds(seconds))failure="CHILD_TIMEOUT";
        if(!growingOutput.empty()) {
            WIN32_FILE_ATTRIBUTE_DATA info{};
            if(GetFileAttributesExW(growingOutput.c_str(),GetFileExInfoStandard,&info)
                &&(info.nFileSizeHigh||info.nFileSizeLow>64*1024*1024))failure="OUTPUT_BUDGET_EXCEEDED";
        }
        if(failure)break;
        if(child.exited()&&stdoutClosed&&stderrClosed&&active_processes(group.get())==0)break;
        Sleep(5);
    }} catch(const std::exception&){failure="CHILD_SUPERVISION_FAILED";}
    if(failure) {
        const char* reason=failure;
        if(!TerminateJobObject(group.get(),1))throw std::runtime_error("OWNED_STOP_UNCONFIRMED");
        const auto stop=std::chrono::steady_clock::now();
        while(!child.exited()||!stdoutClosed||!stderrClosed||active_processes(group.get())) {
            drain(output.read.get(),result.out,stdoutClosed,false);drain(error.read.get(),result.err,stderrClosed,false);
            if(std::chrono::steady_clock::now()-stop>std::chrono::milliseconds(2500))throw std::runtime_error("OWNED_STOP_UNCONFIRMED");
            Sleep(5);
        }
        if(!growingOutput.empty())std::cout<<"{\"event\":\"ownedTestStopped\",\"activeProcesses\":0}\n"<<std::flush;
        throw std::runtime_error(reason);
    }
    result.exitCode=child.result();
    if(!allowFailedChild&&result.exitCode)throw std::runtime_error("CHILD_FAILED");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION memory{};
    if(!QueryInformationJobObject(group.get(),JobObjectExtendedLimitInformation,&memory,sizeof(memory),nullptr))
        throw std::runtime_error("OWNERSHIP_QUERY_FAILED");
    result.peakBytes=memory.PeakJobMemoryUsed;
    result.seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    cancellation_point();return result;
}
}
