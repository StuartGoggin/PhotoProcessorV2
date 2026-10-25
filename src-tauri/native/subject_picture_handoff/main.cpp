// Validation-only cached-picture controller. Never admits the app's export gate.
#include "payload.h"
#include "supervisor.h"
#include "issued_request.h"
#include "../subject_finishing/media_pipeline.h"
#include <regex>
#include <cstring>
#include <set>

namespace picture_handoff {
inline const char* public_failure(const char* text) {
    constexpr const char* codes[]={"CANCELLED","RUNNER_IDENTITY_UNAVAILABLE","ORDINARY_LOCAL_PATH_REQUIRED",
        "LOCAL_VOLUME_REQUIRED","DIRECTORY_LEASE_REFUSED","REDIRECTION_REFUSED","INPUT_LEASE_REFUSED",
        "FILE_BUDGET_EXCEEDED","HASH_UNAVAILABLE","INPUT_READ_FAILED","HASH_FAILED","REPORT_BUDGET_EXCEEDED",
        "REPORT_WRITE_FAILED","REPORT_READBACK_FAILED","REPORT_COMMIT_FAILED","OWNERSHIP_QUERY_FAILED","SYSTEM_DIRECTORY_UNAVAILABLE",
        "CHILD_CAPTURE_FAILED","CHILD_CAPTURE_LIMIT","CHILD_TIMEOUT","CHILD_SUPERVISION_FAILED","OUTPUT_BUDGET_EXCEEDED","OWNED_STOP_UNCONFIRMED",
        "CHILD_FAILED","PAYLOAD_IDENTITY_MISMATCH","MEDIA_BIN_INVENTORY_MISMATCH","NEW_OUTPUT_FOLDER_REQUIRED",
        "SCRATCH_BUDGET_UNAVAILABLE","RENDER_PROTOCOL_INVALID","MEDIA_VERIFICATION_FAILED","OVERALL_DEADLINE",
        "CONFIRM_IDLE_AND_SELECT_FIXED_CASE","INTERNAL_OWNER_REQUIRED","UNRECOGNIZED_FIXED_SAMPLE",
        "INTERFACE_UNAVAILABLE","FOLDER_PICKER_UNAVAILABLE","REPORT_IDENTIFIER_UNAVAILABLE"};
    for(const char* code:codes)if(std::strcmp(code,text)==0)return code;return "PICTURE_TEST_FAILED";
}
inline void pin_payload(FileSet& files,const fs::path& root) {
    for(const auto& pin:payload) {
        const HANDLE file=files.file(root/fs::path(pin.path));
        if(file_bytes(file)!=pin.bytes||sha256(file)!=pin.sha256)throw std::runtime_error("PAYLOAD_IDENTITY_MISMATCH");
    }
    // A pinned executable does not pin an adjacent, injected DLL. Refuse extras.
    const std::set<std::wstring> expected={L"ffmpeg.exe",L"ffprobe.exe",L"msvcp140.dll",L"vcomp140.dll",L"vcruntime140_1.dll",L"vcruntime140.dll"};
    std::set<std::wstring> actual;
    for(const auto& entry:fs::directory_iterator(root/L"media"/L"bin"))actual.insert(entry.path().filename().wstring());
    if(actual!=expected)throw std::runtime_error("MEDIA_BIN_INVENTORY_MISMATCH");
}
inline std::string ascii(const std::wstring& text) {
    std::string result;for(const wchar_t c:text){if(c<32||c>126)throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");result+=char(c);}return result;
}
inline MediaRequest request(const fs::path& root,const fs::path& output,const std::string& sample,const std::string& backend) {
    if(sample!="black-horse"&&sample!="white-horse")throw std::runtime_error("UNRECOGNIZED_FIXED_SAMPLE");
    MediaRequest value;value.ffmpeg=root/L"media"/L"bin"/L"ffmpeg.exe";
    const fs::path directory=root/L"samples"/fs::path(sample);
    value.source=directory/L"base.mp4";value.masks=directory/L"masks.pgmask";value.output=output;
    value.width=3840;value.height=2160;value.count=100;value.fps=50;value.threads=4;value.bitrate=40;
    value.backend=backend=="cpu"?"cpu":"gpu";value.encoder="libx264";
    value.requiredVendor=backend=="nvidia"?0x10de:0;
    value.settings.sharpness={26,32};
    value.settings.subject=sample=="black-horse"?Colour{0.25f,1.03f,1.04f,0.02f}:Colour{-0.20f,1.02f,0.98f,-0.015f};
    value.settings.wholeFrameEnabled=false;return value;
}
inline std::vector<std::string> lines(const std::string& text) {
    std::istringstream input(text);std::string line;std::vector<std::string> result;
    while(std::getline(input,line)){if(!line.empty()&&line.back()=='\r')line.pop_back();if(!line.empty())result.push_back(line);}return result;
}
inline std::vector<std::map<std::string,std::string>> records(const std::string& text,const std::string& type) {
    std::vector<std::map<std::string,std::string>> result;std::map<std::string,std::string> record;bool open=false;
    for(const auto& line:lines(text)) {
        if(line=="["+type+"]"){if(open)throw std::runtime_error("MEDIA_VERIFICATION_FAILED");open=true;record.clear();continue;}
        if(line=="[/"+type+"]"){if(!open)throw std::runtime_error("MEDIA_VERIFICATION_FAILED");result.push_back(record);open=false;continue;}
        const auto equal=line.find('=');
        if(!open||equal==std::string::npos||!record.emplace(line.substr(0,equal),line.substr(equal+1)).second)
            throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    }
    if(open||result.empty())throw std::runtime_error("MEDIA_VERIFICATION_FAILED");return result;
}
inline double number(const std::string& value) {
    size_t used=0;const double result=std::stod(value,&used);
    if(used!=value.size()||!std::isfinite(result))throw std::runtime_error("MEDIA_VERIFICATION_FAILED");return result;
}
struct MediaEvidence {std::string audio;uint32_t packets=0;};
inline MediaEvidence inspect(const fs::path& probe,const fs::path& file,const fs::path& scratch,
        std::chrono::steady_clock::time_point started) {
    auto run=[&](std::vector<std::wstring> args) {
        if(std::chrono::steady_clock::now()-started>std::chrono::seconds(180))throw std::runtime_error("OVERALL_DEADLINE");
        args.insert(args.begin(),{L"-v",L"error"});args.push_back(file.wstring());
        const auto capture=supervised(probe,args,scratch);
        if(!capture.err.empty())throw std::runtime_error("MEDIA_VERIFICATION_FAILED");return capture.out;
    };
    validate_media_metadata(run({L"-select_streams",L"v",L"-show_entries",
        L"stream=codec_type,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,field_order,nb_frames,r_frame_rate,avg_frame_rate,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation,displaymatrix",
        L"-of",L"default"}),3840,2160,50,100);
    const auto decoded=records(run({L"-select_streams",L"v",L"-count_frames",L"-show_entries",L"stream=nb_read_frames,duration",L"-of",L"default"}),"STREAM");
    if(decoded.size()!=1||decoded[0]!=std::map<std::string,std::string>{{"nb_read_frames","100"},{"duration","2.000000"}})
        throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    const auto audioProfile=records(run({L"-select_streams",L"a",L"-show_entries",
        L"stream=codec_type,codec_name,sample_rate,channels,duration",L"-of",L"default"}),"STREAM");
    if(audioProfile.size()!=1||audioProfile[0]!=std::map<std::string,std::string>{{"codec_type","audio"},{"codec_name","aac"},
        {"sample_rate","48000"},{"channels","2"},{"duration","2.000000"}})throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    const auto packets=records(run({L"-select_streams",L"v",L"-show_packets",L"-show_entries",L"packet=pts_time,duration_time",L"-of",L"default"}),"PACKET");
    if(packets.size()!=100)throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    std::vector<double> times;
    for(const auto& packet:packets) {
        if(packet.size()!=2||!packet.count("pts_time")||!packet.count("duration_time")||std::abs(number(packet.at("duration_time"))-0.02)>0.000001)
            throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
        times.push_back(number(packet.at("pts_time")));
    }
    std::sort(times.begin(),times.end());
    for(size_t n=0;n<times.size();++n)if(std::abs(times[n]-double(n)/50)>0.000001)throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    MediaEvidence evidence;
    evidence.audio=run({L"-select_streams",L"a",L"-show_packets",L"-show_data_hash",L"sha256",L"-show_entries",
        L"packet=pts_time,dts_time,duration_time,size,data_hash:packet_side_data",L"-of",L"default"});
    const auto audioLines=lines(evidence.audio);
    evidence.packets=uint32_t(std::count(audioLines.begin(),audioLines.end(),"[PACKET]"));
    if(evidence.packets!=95||std::count(audioLines.begin(),audioLines.end(),"[/PACKET]")!=95
        ||std::count_if(audioLines.begin(),audioLines.end(),[](const std::string& line){return line.rfind("data_hash=SHA256:",0)==0;})!=95)
        throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    return evidence;
}
struct Completion {double filterMs=0,pipelineSeconds=0;uint32_t cpuWorkers=0,vendor=0,device=0;};
inline Completion completed(const Capture& capture,const std::string& backend) {
    const auto progress=lines(capture.out);if(progress.size()!=301)throw std::runtime_error("RENDER_PROTOCOL_INVALID");
    for(size_t n=0;n<100;++n) {
        if(progress[n*3]!="frame="+std::to_string(n+1)||progress[n*3+1]!="out_time_us="+std::to_string((n+1)*20000)
            ||progress[n*3+2]!="progress=continue")throw std::runtime_error("RENDER_PROTOCOL_INVALID");
    }
    if(progress.back()!="progress=end")throw std::runtime_error("RENDER_PROTOCOL_INVALID");
    const auto events=lines(capture.err);std::smatch fields;
    const std::regex started(R"(\{"schema":1,"event":"pipelineStarted","children":\[[0-9]+,[0-9]+\]\})");
    const std::string numeric="([0-9]+(?:\\.[0-9]+)?(?:e\\+?[0-9]+)?)";
    const std::regex finished("\\{\"schema\":1,\"event\":\"mediaFinished\",\"engine\":\"subject-rgb709-q4-v2\",\"frames\":100,\"backend\":\""
        +std::string(backend=="cpu"?"cpu":"d3d11")+"\",\"filterAndTransferMs\":"+numeric+",\"cpuPictureParallelism\":([0-9]+),\"actualVendorId\":([0-9]+),\"actualDeviceId\":([0-9]+),\"decodeFilterEncodeSeconds\":"
        +numeric+",\"profile\":\"limited-sdr709-yuv420p8\",\"audio\":\"base-stream-copy\"\\}");
    if(events.size()!=2||!std::regex_match(events[0],started)||!std::regex_match(events[1],fields,finished))
        throw std::runtime_error("RENDER_PROTOCOL_INVALID");
    Completion result{number(fields[1].str()),number(fields[5].str()),uint32_t(std::stoul(fields[2].str())),
        uint32_t(std::stoul(fields[3].str())),uint32_t(std::stoul(fields[4].str()))};
    if(result.filterMs<=0||result.filterMs>180000||result.pipelineSeconds<=0||result.pipelineSeconds>90
        ||result.vendor>65535||result.device>65535||result.cpuWorkers!=(backend=="cpu"?4u:0u)
        ||(backend=="cpu"&&(result.vendor||result.device))||(backend=="nvidia"&&result.vendor!=0x10de))
        throw std::runtime_error("RENDER_PROTOCOL_INVALID");
    return result;
}
inline void run_case(const fs::path& target,const std::string& sample,const std::string& backend,unsigned renderSeconds) {
    caseDeadlineTick=GetTickCount64()+180000;
    const auto start=std::chrono::steady_clock::now();FileSet files;
    // Reserve the full hash-bearing marker name before any report/media write.
    if(target.native().size()+1+std::string("picture-report.").size()+64+std::string(".committed").size()>240)
        throw std::runtime_error("ORDINARY_LOCAL_PATH_REQUIRED");
    const fs::path self(module_path()),root=self.parent_path().parent_path();
    const auto runnerSha=sha256(files.file(self));pin_payload(files,root);files.ancestry(target);
    ULARGE_INTEGER space{};
    if(!GetDiskFreeSpaceExW(target.parent_path().c_str(),&space,nullptr,nullptr)||space.QuadPart<384*1024*1024)
        throw std::runtime_error("SCRATCH_BUDGET_UNAVAILABLE");
    if(!CreateDirectoryW(target.c_str(),nullptr))throw std::runtime_error("NEW_OUTPUT_FOLDER_REQUIRED");
    files.directory(target);
    const auto output=target/fs::path(sample+"-"+backend+".mp4");
    const auto media=request(root,output,sample,backend);const auto probe=media.ffmpeg.parent_path()/L"ffprobe.exe";
    std::cout<<"{\"event\":\"cachedPictureStarted\",\"sample\":\""<<sample<<"\",\"backend\":\""<<backend<<"\"}\n"<<std::flush;
    const auto original=inspect(probe,media.source,target,start);
    IssuedInput issued(output,sample,backend,renderSeconds);
    const auto capture=supervised(self,{L"--owned-render",output.wstring(),fs::path(sample).wstring(),fs::path(backend).wstring()},target,renderSeconds,output,issued.get());
    const auto done=completed(capture,backend);const auto rendered=inspect(probe,output,target,start);
    if(original.audio!=rendered.audio)throw std::runtime_error("MEDIA_VERIFICATION_FAILED");
    const HANDLE result=files.file(output);const auto outputSha=sha256(result);const auto bytes=file_bytes(result);
    pin_payload(files,root);cancellation_point();
    const double wall=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    if(wall>180)throw std::runtime_error("OVERALL_DEADLINE");
    std::ostringstream report;report<<std::setprecision(12)
        <<"{\"schema\":1,\"kind\":\"photogogo-cached-picture-benchmark\",\"sample\":\""<<sample<<"\",\"backend\":\""<<backend
        <<"\",\"runnerSha256\":\""<<runnerSha<<"\",\"buildProfile\":\"cached-picture-fixed35-sdr709-rgbq4-v1\""
        <<",\"completionProtocol\":\"zero-byte-report-sha256-marker-v1\""
        <<",\"baseSha256\":\""<<sha256(files.file(media.source))<<"\",\"maskSha256\":\""<<sha256(files.file(media.masks))
        <<"\",\"maskManifestSha256\":\""<<sha256(files.file(media.source.parent_path()/L"manifest.json"))
        <<"\",\"mediaManifestSha256\":\""<<sha256(files.file(root/L"media"/L"build-manifest.json"))<<"\""
        <<",\"actualVendorId\":"<<done.vendor<<",\"actualDeviceId\":"<<done.device
        <<",\"cpuPictureParallelism\":"<<done.cpuWorkers<<",\"filterAndTransferMs\":"<<done.filterMs
        <<",\"decodeFilterEncodeSeconds\":"<<done.pipelineSeconds<<",\"renderWallSeconds\":"<<capture.seconds<<",\"wallSeconds\":"<<wall
        <<",\"ownedPeakBytes\":"<<capture.peakBytes<<",\"ownedPeakScope\":\"render-job-committed-bytes\",\"ownedActiveProcesses\":0,\"decodedVideoFrames\":100,\"videoPackets\":100,\"audioPacketsCopiedExactly\":95"
        <<",\"outputFile\":\""<<sample<<"-"<<backend<<".mp4\",\"outputBytes\":"<<bytes<<",\"outputSha256\":\""<<outputSha
        <<"\",\"encoder\":\"libx264\",\"profile\":\"limited-sdr709-yuv420p8\",\"cudaInferenceReady\":false,\"inferenceRuntimeBundled\":false"
        <<",\"pixelParityChecked\":false,\"continuousPlaybackReviewed\":false,\"subjectQualityAccepted\":false,\"productionExportQualified\":false"
        <<",\"hostChanges\":{\"dependenciesInstalled\":false,\"driverChanged\":false,\"executionPolicyChanged\":false}}\n";
    publish(target/L"picture-report.json",report.str());
    std::cout<<"{\"event\":\"cachedPictureReportSaved\",\"file\":\"picture-report.json\",\"productionExportQualified\":false}\n";
}
}
#include "gui.h"
int wmain(int argc,wchar_t** argv) {
    using namespace picture_handoff;
    SetConsoleCtrlHandler(console_control,TRUE);
    try {
        if(argc==1)return gui_run();
        if(argc==2&&std::wstring(argv[1])==L"--help") {
            std::cout<<"PhotoGoGo cached-picture test (validation only, installs nothing).\n"
                <<"--run-case NEW_LOCAL_FOLDER --sample black-horse|white-horse --backend cpu|nvidia|default-gpu --confirm-idle\n"
                <<"Fixed 100-frame/2-second UHD sample; 4 GiB owned-job cap; 90-second render cap; 180-second case cap.\n"
                <<"Optional --render-deadline-seconds 1..90. 384 MiB free output space required.\n"
                <<"Ctrl+C cancels only this owned test tree; bounded stop/drain allowance is 2.5 seconds.\n"
                <<"Case deadline covers probes/render/hash checkpoints; synchronous local IO can delay a checkpoint.\n"
                <<"Prepared masks only: no inference, stabilization, NVIDIA encoder or production export qualification.\n";return 0;
        }
        if((argc==4||argc==6)&&std::wstring(argv[1])==L"--run-comparison"&&std::wstring(argv[3])==L"--confirm-idle") {
            std::string backend="nvidia";
            if(argc==6) {
                if(std::wstring(argv[4])!=L"--gpu-backend")throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
                backend=ascii(argv[5]);
            }
            // A partial comparison is a completed diagnostic run, not a success
            // for its failed cases. Status and return bundle preserve that split.
            run_comparison(fs::path(argv[2]),backend);return 0;
        }
        if(argc==5&&std::wstring(argv[1])==L"--owned-render") {
            const auto sample=ascii(argv[3]),backend=ascii(argv[4]);
            const fs::path self(module_path()),output(argv[2]),root=self.parent_path().parent_path();
            admit_issued_request(self,output,sample,backend);
            FileSet files;files.file(self);pin_payload(files,root);
            if(backend!="cpu"&&backend!="nvidia"&&backend!="default-gpu")throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
            files.ancestry(output);files.directory(output.parent_path());
            if(fs::exists(output)||output.filename()!=fs::path(sample+"-"+backend+".mp4"))throw std::runtime_error("NEW_OUTPUT_FOLDER_REQUIRED");
            render_media(request(root,output,sample,backend));return 0;
        }
        if((argc!=8&&argc!=10)||std::wstring(argv[1])!=L"--run-case"||std::wstring(argv[3])!=L"--sample"
            ||std::wstring(argv[5])!=L"--backend"||std::wstring(argv[7])!=L"--confirm-idle")
            throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
        const auto sample=ascii(argv[4]),backend=ascii(argv[6]);
        unsigned renderSeconds=90;
        if(argc==10) {
            const auto digits=ascii(argv[9]);renderSeconds=0;
            if(std::wstring(argv[8])!=L"--render-deadline-seconds"||digits.empty()||digits.size()>2)
                throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
            for(const char digit:digits) {
                if(digit<'0'||digit>'9')throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
                renderSeconds=renderSeconds*10+unsigned(digit-'0');
            }
            if(!renderSeconds||renderSeconds>90)throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
        }
        if((sample!="black-horse"&&sample!="white-horse")||(backend!="cpu"&&backend!="nvidia"&&backend!="default-gpu"))
            throw std::runtime_error("CONFIRM_IDLE_AND_SELECT_FIXED_CASE");
        run_case(fs::path(argv[2]),sample,backend,renderSeconds);return 0;
    } catch(const std::exception& error) {
        if(argc==1)MessageBoxW(nullptr,L"The test interface could not open. No test or installation was started.\nPlease report this message here in Codex.",L"PhotoGoGo test",MB_OK|MB_ICONERROR);
        std::cerr<<"{\"event\":\"cachedPictureFailed\",\"code\":\""<<public_failure(error.what())<<"\"}\n";return 1;
    }
}
