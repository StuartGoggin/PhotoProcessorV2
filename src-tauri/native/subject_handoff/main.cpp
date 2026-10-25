// Native control package: readiness only. No runtime acquisition or export admission.
#include "../subject_finishing/gpu.h"
#include "../subject_finishing/process_owner.h"
#include <dxgi1_2.h>
#include <shobjidl.h>
#include <filesystem>
#include <iostream>
#include <sstream>
#include <cstring>

namespace {
using namespace subject_finishing;
namespace fs=std::filesystem;

std::string utf8(const std::wstring& value) {
    if(value.empty())return {};
    const int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),int(value.size()),nullptr,0,nullptr,nullptr);
    if(!count)throw std::runtime_error("INVALID_TEXT");
    std::string result(size_t(count),'\0');
    if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),int(value.size()),result.data(),count,nullptr,nullptr))
        throw std::runtime_error("INVALID_TEXT");
    return result;
}
std::string quoted(const std::string& value) {
    constexpr char digits[]="0123456789abcdef";
    std::string result="\"";
    for(const unsigned char c:value) {
        if(c=='"'||c=='\\'){result+='\\';result+=char(c);}
        else if(c<32){result+="\\u00";result+=digits[c>>4];result+=digits[c&15];}
        else result+=char(c);
    }
    return result+'"';
}
const char* public_failure(const char* value) {
    constexpr const char* codes[]={"INVALID_TEXT","SELECT_NEW_LOCAL_REPORT_FOLDER","REPORT_VOLUME_NOT_LOCAL",
        "REPORT_PARENT_UNAVAILABLE","REPORT_REDIRECTION_REFUSED","HOST_MEMORY_UNAVAILABLE","HOST_CPU_UNAVAILABLE",
        "INSPECTOR_IDENTITY_UNAVAILABLE","INSPECTOR_MEMORY_LIMIT_UNAVAILABLE","INSPECTOR_STOP_UNCONFIRMED",
        "HARDWARE_INSPECTION_TIMEOUT","HARDWARE_INSPECTION_PIPE_FAILED","HARDWARE_INSPECTION_OUTPUT_LIMIT",
        "HARDWARE_INSPECTION_FAILED","HARDWARE_INSPECTION_REPORT_INVALID","REPORT_LIMIT_EXCEEDED",
        "REPORT_OUTPUT_ALREADY_EXISTS","REPORT_FOLDER_CREATION_FAILED","REPORT_FOLDER_LEASE_FAILED",
        "REPORT_PUBLICATION_FAILED","REPORT_WRITE_FAILED","REPORT_READBACK_FAILED","FOLDER_PICKER_UNAVAILABLE",
        "REPORT_IDENTIFIER_UNAVAILABLE","INVALID_READINESS_DEADLINE","USE_PREFLIGHT_WITH_NEW_REPORT_FOLDER"};
    for(const char* code:codes)if(std::strcmp(value,code)==0)return code;
    return "READINESS_FAILED";
}

// Hold ordinary ancestor directories without write/delete sharing until report read-back.
// Caller-selected paths are used only for local IO, never copied into shared diagnostics.
std::vector<OwnedHandle> lease_ancestors(const fs::path& target) {
    const auto native=target.native();
    if(native.size()<4||native.size()>240||native[1]!=L':'||native[2]!=L'\\'
        ||!((native[0]>=L'A'&&native[0]<=L'Z')||(native[0]>=L'a'&&native[0]<=L'z'))
        ||target!=target.lexically_normal()||target==target.root_path())
        throw std::runtime_error("SELECT_NEW_LOCAL_REPORT_FOLDER");
    for(const auto& part:target.relative_path()) {
        const auto text=part.native();
        if(text.empty()||text.back()==L'.'||text.back()==L' '||text.find_first_of(L":*?\"<>|")!=std::wstring::npos)
            throw std::runtime_error("SELECT_NEW_LOCAL_REPORT_FOLDER");
    }
    const UINT drive=GetDriveTypeW(target.root_path().c_str());
    if(drive!=DRIVE_FIXED&&drive!=DRIVE_REMOVABLE)throw std::runtime_error("REPORT_VOLUME_NOT_LOCAL");
    std::vector<fs::path> paths;
    for(auto path=target.parent_path();!path.empty();) {
        paths.push_back(path);const auto next=path.parent_path();if(next==path)break;path=next;
    }
    std::vector<OwnedHandle> handles;
    for(auto iterator=paths.rbegin();iterator!=paths.rend();++iterator) {
        // Attribute-only access does not participate in Windows read/write sharing checks.
        const HANDLE raw=CreateFileW(iterator->c_str(),GENERIC_READ,FILE_SHARE_READ,
            nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
        if(raw==INVALID_HANDLE_VALUE)throw std::runtime_error("REPORT_PARENT_UNAVAILABLE");
        OwnedHandle handle(raw);BY_HANDLE_FILE_INFORMATION info{};
        if(!GetFileInformationByHandle(handle.get(),&info)||!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)
            ||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))throw std::runtime_error("REPORT_REDIRECTION_REFUSED");
        handles.push_back(std::move(handle));
    }
    return handles;
}

std::string readiness() {
    MEMORYSTATUSEX memory{};memory.dwLength=sizeof(memory);
    if(!GlobalMemoryStatusEx(&memory)||!memory.ullAvailPhys)throw std::runtime_error("HOST_MEMORY_UNAVAILABLE");
    const DWORD processors=GetActiveProcessorCount(ALL_PROCESSOR_GROUPS);
    if(!processors||processors==DWORD(-1))throw std::runtime_error("HOST_CPU_UNAVAILABLE");
    std::ostringstream adapters;bool first=true,nvidia=false,enumerationReady=false;
    ComPtr<IDXGIFactory1> factory;
    if(SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        enumerationReady=true;
        for(UINT index=0;index<16;++index) {
            ComPtr<IDXGIAdapter1> adapter;
            const HRESULT status=factory->EnumAdapters1(index,&adapter);
            if(status==DXGI_ERROR_NOT_FOUND)break;
            if(FAILED(status)){enumerationReady=false;break;}
            DXGI_ADAPTER_DESC1 info{};
            if(FAILED(adapter->GetDesc1(&info))){enumerationReady=false;break;}
            const bool software=(info.Flags&DXGI_ADAPTER_FLAG_SOFTWARE)!=0;
            nvidia|=info.VendorId==0x10de&&!software;
            if(!first)adapters<<',';first=false;
            const size_t length=wcsnlen_s(info.Description,128);
            adapters<<"{\"description\":"<<quoted(utf8(std::wstring(info.Description,length)))
                <<",\"vendorId\":"<<info.VendorId<<",\"dedicatedBytes\":"<<info.DedicatedVideoMemory
                <<",\"software\":"<<(software?"true":"false")<<'}';
        }
    }
    bool shaderReady=false;UINT selectedVendor=0;
    try{GpuSharpener graphics;shaderReady=true;selectedVendor=graphics.adapterDescription.VendorId;}
    catch(const std::exception&){/* Distinguish unavailable picture shader from CUDA inference. */}
    std::ostringstream report;
    report<<"{\"schema\":1,\"kind\":\"photogogo-subject-finishing-readiness\",\"mode\":\"preflight-only\","
        <<"\"host\":{\"logicalProcessors\":"<<processors<<",\"availablePhysicalBytes\":"<<memory.ullAvailPhys
        <<",\"adapters\":["<<adapters.str()<<"]},\"adapterEnumerationReady\":"<<(enumerationReady?"true":"false")
        <<",\"nvidiaAdapterPresent\":"<<(nvidia?"true":"false")<<",\"d3d11ShaderReady\":"<<(shaderReady?"true":"false")
        <<",\"d3d11DefaultVendorId\":"<<selectedVendor
        <<",\"cudaInferenceReady\":false,\"mediaTestReady\":false,\"inferenceRuntimeBundled\":false,"
        <<"\"mediaFramesProcessed\":0,\"subjectQualityAccepted\":false,\"productionExportQualified\":false,"
        <<"\"hostChanges\":{\"dependenciesInstalled\":false,\"driverChanged\":false,\"executionPolicyChanged\":false},"
        <<"\"nextRequirement\":\"A separately admitted video-test package and inference profile are required. This hardware report is not a video test or export approval.\"}\n";
    return report.str();
}

std::string inspect_hardware(unsigned seconds) {
    std::array<wchar_t,32768> module{};
    const DWORD length=GetModuleFileNameW(nullptr,module.data(),DWORD(module.size()));
    if(!length||length>=module.size())throw std::runtime_error("INSPECTOR_IDENTITY_UNAVAILABLE");
    auto executableAncestors=lease_ancestors(fs::path(module.data()));
    const HANDLE executableRaw=CreateFileW(module.data(),GENERIC_READ,FILE_SHARE_READ,nullptr,
        OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(executableRaw==INVALID_HANDLE_VALUE)throw std::runtime_error("INSPECTOR_IDENTITY_UNAVAILABLE");
    OwnedHandle executable(executableRaw);
    BY_HANDLE_FILE_INFORMATION executableInfo{};
    if(!GetFileInformationByHandle(executable.get(),&executableInfo)||GetFileType(executable.get())!=FILE_TYPE_DISK
        ||(executableInfo.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)))
        throw std::runtime_error("INSPECTOR_IDENTITY_UNAVAILABLE");
    ChildGroup group;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_JOB_MEMORY;
    limits.JobMemoryLimit=SIZE_T(512)*1024*1024;
    if(!SetInformationJobObject(group.get(),JobObjectExtendedLimitInformation,&limits,sizeof(limits)))
        throw std::runtime_error("INSPECTOR_MEMORY_LIMIT_UNAVAILABLE");
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    OwnedHandle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,
        OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedPipe output(false);
    OwnedChild inspector(module.data(),{L"--inspect-hardware"},input.get(),output.write.get(),group.get());
    output.write.close();
    const auto start=std::chrono::steady_clock::now();
    const auto stop=[&](const char* reason) {
        if(!TerminateJobObject(group.get(),1))throw std::runtime_error("INSPECTOR_STOP_UNCONFIRMED");
        const auto drain=std::chrono::steady_clock::now();
        while(!inspector.exited()) {
            if(std::chrono::steady_clock::now()-drain>std::chrono::milliseconds(2500))
                throw std::runtime_error("INSPECTOR_STOP_UNCONFIRMED");
            Sleep(10);
        }
        throw std::runtime_error(reason);
    };
    std::string result;
    for(;;) {
        if(std::chrono::steady_clock::now()-start>std::chrono::seconds(seconds))stop("HARDWARE_INSPECTION_TIMEOUT");
        DWORD available=0;
        if(!PeekNamedPipe(output.read.get(),nullptr,0,nullptr,&available,nullptr)) {
            if(GetLastError()==ERROR_BROKEN_PIPE)break;
            stop("HARDWARE_INSPECTION_PIPE_FAILED");
        }
        if(available) {
            std::array<char,4096> bytes{};DWORD count=0;
            if(!ReadFile(output.read.get(),bytes.data(),DWORD((std::min)(size_t(available),bytes.size())),&count,nullptr))
                stop("HARDWARE_INSPECTION_PIPE_FAILED");
            if(result.size()+count>65536)stop("HARDWARE_INSPECTION_OUTPUT_LIMIT");
            result.append(bytes.data(),count);
        } else if(inspector.exited())break;
        else Sleep(10);
    }
    // Closing stdout and process exit are not atomic. Allow ordinary CRT cleanup,
    // while retaining the same owned deadline instead of reporting a false failure.
    while(!inspector.exited()) {
        if(std::chrono::steady_clock::now()-start>std::chrono::seconds(seconds))stop("HARDWARE_INSPECTION_TIMEOUT");
        Sleep(10);
    }
    try{inspector.finish(0);}catch(const std::exception&){throw std::runtime_error("HARDWARE_INSPECTION_FAILED");}
    // This is the same leased executable's fixed typed serializer, not a caller-provided probe.
    if(result.rfind("{\"schema\":1,\"kind\":\"photogogo-subject-finishing-readiness\",",0)!=0
        ||result.size()<3||result.substr(result.size()-2)!="}\n")throw std::runtime_error("HARDWARE_INSPECTION_REPORT_INVALID");
    return result;
}

void publish_readiness(const fs::path& target,unsigned seconds) {
    auto ancestors=lease_ancestors(target);
    const std::string report=inspect_hardware(seconds);
    if(report.size()>65536)throw std::runtime_error("REPORT_LIMIT_EXCEEDED");
    // Create the directory only after readiness succeeds. Never reuse caller data.
    if(!CreateDirectoryW(target.c_str(),nullptr)) {
        if(GetLastError()==ERROR_ALREADY_EXISTS)throw std::runtime_error("REPORT_OUTPUT_ALREADY_EXISTS");
        throw std::runtime_error("REPORT_FOLDER_CREATION_FAILED");
    }
    const HANDLE rootRaw=CreateFileW(target.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,
        OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(rootRaw==INVALID_HANDLE_VALUE)throw std::runtime_error("REPORT_FOLDER_LEASE_FAILED");
    OwnedHandle root(rootRaw);BY_HANDLE_FILE_INFORMATION info{};
    if(!GetFileInformationByHandle(root.get(),&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT))
        throw std::runtime_error("REPORT_REDIRECTION_REFUSED");
    const auto file=target/L"readiness-report.json";
    const HANDLE raw=CreateFileW(file.c_str(),GENERIC_WRITE|GENERIC_READ,FILE_SHARE_READ,nullptr,
        CREATE_NEW,FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OPEN_REPARSE_POINT,nullptr);
    if(raw==INVALID_HANDLE_VALUE)throw std::runtime_error("REPORT_PUBLICATION_FAILED");
    OwnedHandle output(raw);DWORD written=0;
    if(!WriteFile(output.get(),report.data(),DWORD(report.size()),&written,nullptr)||written!=report.size()
        ||!FlushFileBuffers(output.get()))throw std::runtime_error("REPORT_WRITE_FAILED");
    LARGE_INTEGER origin{};
    if(!SetFilePointerEx(output.get(),origin,nullptr,FILE_BEGIN))throw std::runtime_error("REPORT_READBACK_FAILED");
    std::string readback(report.size(),'\0');DWORD bytes=0;
    if(!ReadFile(output.get(),readback.data(),DWORD(readback.size()),&bytes,nullptr)||bytes!=report.size()||readback!=report)
        throw std::runtime_error("REPORT_READBACK_FAILED");
    std::cout<<"{\"event\":\"readinessReportSaved\",\"file\":\"readiness-report.json\",\"mediaTestReady\":false}\n";
}

fs::path choose_report_folder() {
    const HRESULT initialized=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED|COINIT_DISABLE_OLE1DDE);
    if(FAILED(initialized))throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    struct ComGuard{~ComGuard(){CoUninitialize();}} guard;
    ComPtr<IFileOpenDialog> picker;
    if(FAILED(CoCreateInstance(CLSID_FileOpenDialog,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&picker))))
        throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    DWORD options=0;picker->GetOptions(&options);
    if(FAILED(picker->SetOptions(options|FOS_PICKFOLDERS|FOS_FORCEFILESYSTEM))
        ||FAILED(picker->SetTitle(L"Choose where to save the PhotoGoGo readiness report")))
        throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    const HRESULT shown=picker->Show(nullptr);
    if(shown==HRESULT_FROM_WIN32(ERROR_CANCELLED))return {};
    if(FAILED(shown))throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    ComPtr<IShellItem> item;
    if(FAILED(picker->GetResult(&item)))throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    PWSTR path=nullptr;
    if(FAILED(item->GetDisplayName(SIGDN_FILESYSPATH,&path)))throw std::runtime_error("FOLDER_PICKER_UNAVAILABLE");
    const fs::path parent(path);CoTaskMemFree(path);
    GUID id{};if(FAILED(CoCreateGuid(&id)))throw std::runtime_error("REPORT_IDENTIFIER_UNAVAILABLE");
    wchar_t text[40]{};if(!StringFromGUID2(id,text,40))throw std::runtime_error("REPORT_IDENTIFIER_UNAVAILABLE");
    return parent/(std::wstring(L"PhotoGoGo-Finishing-Report-")+text);
}
}

int wmain(int argc,wchar_t** argv) {
    const bool interactive=argc==1;
    try {
        if(argc==2&&std::wstring(argv[1])==L"--inspect-hardware") {
#ifdef PHOTOGOGO_HANDOFF_TEST_FAULTS
            wchar_t marker[2]{};
            if(GetEnvironmentVariableW(L"PHOTOGOGO_TEST_READINESS_STALL",marker,2)==1&&marker[0]==L'1')Sleep(60000);
#endif
            // Emit exact UTF-8 bytes; CRT text output otherwise converts LF to CRLF.
            try {
                const auto report=readiness();DWORD written=0;
                if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),report.data(),DWORD(report.size()),&written,nullptr)
                    ||written!=report.size())return 1;
                return 0;
            } catch(const std::exception&){return 1;}
        }
        if(argc==2&&std::wstring(argv[1])==L"--help") {
            std::cout<<"PhotoGoGo Finishing Test: --preflight NEW_ABSOLUTE_REPORT_FOLDER\n"
                <<"Optional --deadline-seconds 1..30 (default 30); owned inspector memory cap 512 MiB.\n"
                <<"Readiness only: installs nothing; processes no media; does not qualify CUDA or export.\n";return 0;
        }
        fs::path target;unsigned seconds=30;
        if(interactive){target=choose_report_folder();if(target.empty())return 2;}
        else if((argc==3||argc==5)&&std::wstring(argv[1])==L"--preflight") {
            target=fs::path(argv[2]);
            if(argc==5) {
                const std::wstring value(argv[4]);seconds=0;
                if(std::wstring(argv[3])!=L"--deadline-seconds"||value.empty()||value.size()>2)
                    throw std::runtime_error("INVALID_READINESS_DEADLINE");
                for(const wchar_t digit:value) {
                    if(digit<L'0'||digit>L'9')throw std::runtime_error("INVALID_READINESS_DEADLINE");
                    seconds=seconds*10+unsigned(digit-L'0');
                }
                if(!seconds||seconds>30)throw std::runtime_error("INVALID_READINESS_DEADLINE");
            }
        }
        else throw std::runtime_error("USE_PREFLIGHT_WITH_NEW_REPORT_FOLDER");
#ifdef PHOTOGOGO_HANDOFF_TEST_FAULTS
        wchar_t failure[2]{};
        if(GetEnvironmentVariableW(L"PHOTOGOGO_TEST_UNKNOWN_FAILURE",failure,2)==1&&failure[0]==L'1')
            throw std::runtime_error("private-user-and-media-path: unclassified test-only failure");
#endif
        publish_readiness(target,seconds);
        if(interactive)MessageBoxW(nullptr,L"Readiness report saved in a new PhotoGoGo-Finishing-Report folder.\n\n"
            L"This version does not run the video test. No software or drivers were installed.\n"
            L"Attach readiness-report.json in the Codex conversation.",L"PhotoGoGo readiness report",MB_OK|MB_ICONINFORMATION);
        return 0;
    } catch(const std::exception& error) {
        // Fixed error codes, never raw filesystem/driver exception text or paths.
        std::cerr<<"{\"event\":\"readinessFailed\",\"code\":"<<quoted(public_failure(error.what()))<<"}\n";
        if(interactive)MessageBoxW(nullptr,L"The readiness report could not be saved. Choose a new ordinary local folder.\n"
            L"No video processing, installation or driver change occurred.",L"PhotoGoGo readiness check",MB_OK|MB_ICONERROR);
        return 1;
    }
}
