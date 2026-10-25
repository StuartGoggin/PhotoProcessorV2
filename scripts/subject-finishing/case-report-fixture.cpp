// Regression harness for the actual controller read-back seam. No rendering.
#define wmain retained_picture_runner_entry
#include "../../src-tauri/native/subject_picture_handoff/main.cpp"
#undef wmain

int wmain(int argc,wchar_t** argv) {
    using namespace picture_handoff;
    try {
        const bool lateCheck=argc==7&&std::wstring(argv[6])==L"--lease-and-late-check";
        const bool returnZip=argc==8&&std::wstring(argv[6])==L"--report-only-zip";
        if(argc!=6&&!lateCheck&&!returnZip)throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
        const fs::path folder(argv[1]),root(argv[2]);
        FileSet files;std::string reportHash;
        const auto text=checked_case_report(files,folder,root,ascii(argv[5]),ascii(argv[3]),ascii(argv[4]),reportHash);
        if(lateCheck) {
            const auto driver=folder/L"NVIDIA Corporation";
            if(MoveFileW(driver.c_str(),(folder/L"moved-driver").c_str()))throw std::runtime_error("DIRECTORY_LEASE_REFUSED");
            const auto logs=driver/L"umdlogs";
            if(MoveFileW(logs.c_str(),(driver/L"moved-logs").c_str()))throw std::runtime_error("DIRECTORY_LEASE_REFUSED");
            OwnedHandle late(CreateFileW((logs/L"late.log").c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
            late.close();bool refused=false;
            try {checked_case_report(files,folder,root,ascii(argv[5]),ascii(argv[3]),ascii(argv[4]),reportHash);}
            catch(const std::runtime_error& error){refused=std::strcmp(error.what(),"REPORT_COMMIT_FAILED")==0;}
            if(!refused)throw std::runtime_error("REPORT_READBACK_FAILED");
        }
        if(returnZip) {
            std::map<std::string,std::string> retained;
            retained.emplace("case-2/picture-report.json",text);
            retained.emplace("case-2/picture-report."+reportHash+".committed","");
            publish(fs::path(argv[7]),report_zip(retained));
        }
        std::cout<<"{\"event\":\"checkedCaseAccepted\",\"reportSha256\":\""<<reportHash
            <<"\",\"reportBytes\":"<<text.size()<<"}\n";
        return 0;
    } catch(const std::exception& error) {
        std::cerr<<"{\"event\":\"checkedCaseRefused\",\"code\":\""<<public_failure(error.what())<<"\"}\n";
        return 1;
    }
}
