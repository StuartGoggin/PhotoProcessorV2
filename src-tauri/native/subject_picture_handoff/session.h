#pragma once
#include "report_bundle.h"
#include <functional>
namespace picture_handoff {
using SessionProgress=std::function<void(unsigned,const std::wstring&)>;
inline std::string regex_literal(const std::string& text) {
    std::string result;for(const char c:text){if(std::string("\\.^$|()[]{}*+?").find(c)!=std::string::npos)result+='\\';result+=c;}return result;
}
inline void checked_case_inventory(FileSet& files,const fs::path& folder,const std::wstring& video,
        const std::wstring& marker,bool nvidia) {
    const std::set<std::wstring> expected{L"picture-report.json",marker,video};
    std::set<std::wstring> inventory;
    for(const auto& entry:fs::directory_iterator(folder)) {
        const auto name=entry.path().filename().wstring();
        if(nvidia&&name==L"NVIDIA Corporation") {
            // Observed driver-created empty directories are not evidence. Lease
            // each ordinary directory before examining children; never read or
            // include incidental contents in the report-only return bundle.
            const auto driver=folder/L"NVIDIA Corporation";files.directory(driver);
            for(const auto& child:fs::directory_iterator(driver)) {
                if(child.path().filename()!=fs::path(L"umdlogs"))throw std::runtime_error("REPORT_COMMIT_FAILED");
                const auto logs=driver/L"umdlogs";files.directory(logs);
                if(fs::directory_iterator(logs)!=fs::directory_iterator{})throw std::runtime_error("REPORT_COMMIT_FAILED");
            }
        } else {
            if(!expected.count(name))throw std::runtime_error("REPORT_COMMIT_FAILED");
            inventory.insert(name);
        }
    }
    if(inventory!=expected)throw std::runtime_error("REPORT_COMMIT_FAILED");
}
inline std::string checked_case_report(FileSet& files,const fs::path& folder,const fs::path& root,
        const std::string& runnerSha,const std::string& sample,const std::string& backend,std::string& hash) {
    const HANDLE handle=files.file(folder/L"picture-report.json");const auto text=read_report(handle);hash=sha256(handle);
    const std::string marker="picture-report."+hash+".committed";
    require_empty_marker(files.file(folder/fs::path(marker)));
    const auto sampleRoot=root/L"samples"/fs::path(sample);
    const auto output=files.file(folder/fs::path(sample+"-"+backend+".mp4"));
    std::ostringstream head;head<<"{\"schema\":1,\"kind\":\"photogogo-cached-picture-benchmark\",\"sample\":\""<<sample
        <<"\",\"backend\":\""<<backend<<"\",\"runnerSha256\":\""<<runnerSha<<"\",\"buildProfile\":\"cached-picture-fixed35-sdr709-rgbq4-v1\""
        <<",\"completionProtocol\":\"zero-byte-report-sha256-marker-v1\",\"baseSha256\":\""<<sha256(files.file(sampleRoot/L"base.mp4"))
        <<"\",\"maskSha256\":\""<<sha256(files.file(sampleRoot/L"masks.pgmask"))<<"\",\"maskManifestSha256\":\""<<sha256(files.file(sampleRoot/L"manifest.json"))
        <<"\",\"mediaManifestSha256\":\""<<sha256(files.file(root/L"media"/L"build-manifest.json"))<<"\"";
    const std::string numeric="([0-9]+(?:\\.[0-9]+)?(?:e\\+?[0-9]+)?)";
    std::string middle=",\"actualVendorId\":([0-9]+),\"actualDeviceId\":([0-9]+),\"cpuPictureParallelism\":([0-9]+)";
    for(const char* key:{"filterAndTransferMs","decodeFilterEncodeSeconds","renderWallSeconds","wallSeconds","ownedPeakBytes"})
        middle+=",\""+std::string(key)+"\":"+numeric;
    std::ostringstream tail;tail<<",\"ownedPeakScope\":\"render-job-committed-bytes\",\"ownedActiveProcesses\":0,\"decodedVideoFrames\":100,\"videoPackets\":100,\"audioPacketsCopiedExactly\":95"
        <<",\"outputFile\":\""<<sample<<"-"<<backend<<".mp4\",\"outputBytes\":"<<file_bytes(output)<<",\"outputSha256\":\""<<sha256(output)
        <<"\",\"encoder\":\"libx264\",\"profile\":\"limited-sdr709-yuv420p8\",\"cudaInferenceReady\":false,\"inferenceRuntimeBundled\":false"
        <<",\"pixelParityChecked\":false,\"continuousPlaybackReviewed\":false,\"subjectQualityAccepted\":false,\"productionExportQualified\":false"
        <<",\"hostChanges\":{\"dependenciesInstalled\":false,\"driverChanged\":false,\"executionPolicyChanged\":false}}";
    std::smatch fields;
    if(!std::regex_match(text,fields,std::regex(regex_literal(head.str())+middle+regex_literal(tail.str())+"\\r?\\n?")))
        throw std::runtime_error("REPORT_READBACK_FAILED");
    const auto vendor=std::stoul(fields[1].str()),device=std::stoul(fields[2].str()),workers=std::stoul(fields[3].str());
    if(vendor>65535||device>65535||workers!=(backend=="cpu"?4u:0u)||(backend=="cpu"&&(vendor||device))
        ||(backend!="cpu"&&!vendor)||(backend=="nvidia"&&vendor!=0x10de))throw std::runtime_error("REPORT_READBACK_FAILED");
    const std::array<double,5> caps{180000,90,95,180,double(uint64_t(4)*1024*1024*1024)};
    for(size_t n=0;n<caps.size();++n){const auto value=number(fields[n+4].str());if(value<=0||value>caps[n])throw std::runtime_error("REPORT_READBACK_FAILED");}
    checked_case_inventory(files,folder,fs::path(sample+"-"+backend+".mp4").wstring(),fs::path(marker).wstring(),
        backend!="cpu"&&vendor==0x10de);
    return text;
}
inline std::string failed_case_code(const Capture& capture) {
    std::smatch match;const std::regex pattern(R"case(\{"event":"cachedPictureFailed","code":"([A-Z_]+)"\}\r?\n?)case");
    if(std::regex_match(capture.err,match,pattern))return public_failure(match[1].str().c_str());return "CHILD_FAILED";
}
inline bool run_comparison(const fs::path& target,const std::string& gpuBackend,const SessionProgress& progress={}) {
    if(gpuBackend!="nvidia"&&gpuBackend!="default-gpu")throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
    caseDeadlineTick=GetTickCount64()+760000;FileSet files;
    if(target.native().size()+110>240)throw std::runtime_error("ORDINARY_LOCAL_PATH_REQUIRED");
    const fs::path self(module_path()),root=self.parent_path().parent_path();const auto runnerSha=sha256(files.file(self));
    pin_payload(files,root);files.ancestry(target);ULARGE_INTEGER space{};
    if(!GetDiskFreeSpaceExW(target.parent_path().c_str(),&space,nullptr,nullptr)||space.QuadPart<uint64_t(512)*1024*1024)
        throw std::runtime_error("SCRATCH_BUDGET_UNAVAILABLE");
    if(!CreateDirectoryW(target.c_str(),nullptr))throw std::runtime_error("NEW_OUTPUT_FOLDER_REQUIRED");files.directory(target);
    const std::array<std::pair<std::string,std::string>,4> cases{{{"black-horse","cpu"},{"black-horse",gpuBackend},{"white-horse",gpuBackend},{"white-horse","cpu"}}};
    std::map<std::string,std::string> returned;std::ostringstream results;bool complete=true;
    for(size_t n=0;n<cases.size();++n) {
        cancellation_point();const auto& [sample,backend]=cases[n];const auto folder=target/fs::path("case-"+std::to_string(n+1));
        if(progress)progress(unsigned(n+1),fs::path(sample+" / "+backend+" - validating and rendering").wstring());
        std::cout<<"{\"event\":\"comparisonCaseStarted\",\"case\":"<<n+1<<",\"sample\":\""<<sample<<"\",\"backend\":\""<<backend<<"\"}\n"<<std::flush;
        const auto capture=supervised(self,{L"--run-case",folder.wstring(),L"--sample",fs::path(sample).wstring(),L"--backend",fs::path(backend).wstring(),L"--confirm-idle"},target,185,{},nullptr,true);
        if(n)results<<',';
        results<<"{\"sample\":\""<<sample<<"\",\"backend\":\""<<backend<<"\",\"status\":\""<<(capture.exitCode?"failed":"passed")<<"\"";
        if(capture.exitCode) {
            const auto code=failed_case_code(capture);complete=false;results<<",\"code\":\""<<code<<"\"";
            if(code=="OWNED_STOP_UNCONFIRMED")throw std::runtime_error("OWNED_STOP_UNCONFIRMED");
        } else {
            std::string hash;const auto text=checked_case_report(files,folder,root,runnerSha,sample,backend,hash);
            results<<",\"reportSha256\":\""<<hash<<"\",\"report\":"<<text;
            const auto prefix="case-"+std::to_string(n+1)+"/";returned.emplace(prefix+"picture-report.json",text);
            returned.emplace(prefix+"picture-report."+hash+".committed","");
        }
        results<<'}';
    }
    cancellation_point();pin_payload(files,root);
    // Directory leases prevent replacement, not arbitrary new descendants.
    // Recheck successful cases before publishing; late incidental files refuse.
    for(size_t n=0;n<cases.size();++n) {
        const auto prefix="case-"+std::to_string(n+1)+"/";
        const auto retained=returned.find(prefix+"picture-report.json");
        if(retained==returned.end())continue;
        const auto& [sample,backend]=cases[n];std::string hash;
        if(checked_case_report(files,target/fs::path("case-"+std::to_string(n+1)),root,runnerSha,sample,backend,hash)!=retained->second)
            throw std::runtime_error("REPORT_READBACK_FAILED");
    }
    const std::string text="{\"schema\":1,\"kind\":\"photogogo-cached-picture-comparison\",\"runnerSha256\":\""+runnerSha
        +"\",\"status\":\""+(complete?"complete":"partial")+"\",\"observationsPerCase\":1,\"cases\":["+results.str()
        +"],\"cudaInferenceReady\":false,\"subjectQualityAccepted\":false,\"productionExportQualified\":false}\n";
    publish(target/L"comparison-report.json",text,false);
    const auto comparisonHash=sha256(files.file(target/L"comparison-report.json"));
    returned.emplace("comparison-report.json",text);returned.emplace("comparison-report."+comparisonHash+".committed","");
    if(progress)progress(4,L"Preparing the small return-report ZIP (no videos)");
    publish(target/L"PhotoGoGo-Return-Reports.zip",report_zip(returned));
    std::cout<<"{\"event\":\"comparisonReportSaved\",\"status\":\""<<(complete?"complete":"partial")<<"\",\"file\":\"PhotoGoGo-Return-Reports.zip\",\"productionExportQualified\":false}\n";
    return complete;
}
}
