// Test translation unit only: intercept the two startup API failure boundaries.
// Not compiled into the runner and not included in a user package.
#include <Windows.h>
#include <iostream>
#include <string>
inline bool rejectAssignment=false;
inline HANDLE observedChild=nullptr;
inline BOOL fixture_assign(HANDLE group,HANDLE process) {
    if(!DuplicateHandle(GetCurrentProcess(),process,GetCurrentProcess(),&observedChild,
        SYNCHRONIZE|PROCESS_TERMINATE,FALSE,0))return FALSE;
    if(rejectAssignment){SetLastError(ERROR_ACCESS_DENIED);return FALSE;}
    return AssignProcessToJobObject(group,process);
}
inline DWORD fixture_resume(HANDLE) {SetLastError(ERROR_ACCESS_DENIED);return DWORD(-1);}
#define AssignProcessToJobObject fixture_assign
#define ResumeThread fixture_resume
#include "../subject_finishing/process_owner.h"
#undef AssignProcessToJobObject
#undef ResumeThread
int wmain(int argc,wchar_t** argv) {
    using namespace subject_finishing;
    if(argc==2&&std::wstring(argv[1])==L"--sleep"){Sleep(30000);return 0;}
    if(argc!=2)return 2;
    rejectAssignment=std::wstring(argv[1])==L"assignment";
    std::array<wchar_t,32768> self{};GetModuleFileNameW(nullptr,self.data(),DWORD(self.size()));
    ChildGroup group;SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    OwnedHandle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedPipe output(false),error(false);bool refused=false;
    const auto start=std::chrono::steady_clock::now();
    try{OwnedChild child(self.data(),{L"--sleep"},input.get(),output.write.get(),group.get(),L"",L"",error.write.get());}
    catch(const std::exception&){refused=true;}
    const bool stopped=observedChild&&WaitForSingleObject(observedChild,0)==WAIT_OBJECT_0;
    const auto elapsed=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count();
    // A red test must still clean up only its exact intercepted child.
    if(observedChild){if(!stopped){TerminateProcess(observedChild,1);WaitForSingleObject(observedChild,2500);}CloseHandle(observedChild);}
    std::cout<<"{\"event\":\"startupFailureFixture\",\"boundary\":\""<<(rejectAssignment?"assignment":"resume")
        <<"\",\"refused\":"<<(refused?"true":"false")<<",\"stoppedBeforeConstructorReturned\":"<<(stopped?"true":"false")
        <<",\"milliseconds\":"<<elapsed<<"}\n";
    return refused&&stopped&&elapsed<=3000?0:1;
}
