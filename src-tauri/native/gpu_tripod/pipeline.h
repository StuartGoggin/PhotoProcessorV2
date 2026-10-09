#pragma once
#include "core.h"
#include <iostream>
#include <map>
#include <memory>
class Handle {
    HANDLE value=nullptr;
public:
    Handle()=default;explicit Handle(HANDLE h):value(h) {if(!h||h==INVALID_HANDLE_VALUE) throw std::runtime_error("Windows handle creation failed");}
    ~Handle(){if(value) CloseHandle(value);}Handle(const Handle&)=delete;Handle& operator=(const Handle&)=delete;
    Handle(Handle&& other) noexcept:value(other.value){other.value=nullptr;}
    Handle& operator=(Handle&& other) noexcept {if(this!=&other){if(value)CloseHandle(value);value=other.value;other.value=nullptr;}return *this;}
    HANDLE get()const{return value;}void close(){if(value){CloseHandle(value);value=nullptr;}}
};
inline void winCheck(BOOL ok,const char* action) {if(!ok) throw std::runtime_error(std::string(action)+" failed (Windows "+std::to_string(GetLastError())+")");}
struct Pipe {
    Handle read,write;
    explicit Pipe(bool childReads) {
        SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};HANDLE r=nullptr,w=nullptr;
        winCheck(CreatePipe(&r,&w,&security,1024*1024),"Create bounded raw pipe");read=Handle(r);write=Handle(w);
        winCheck(SetHandleInformation(childReads?write.get():read.get(),HANDLE_FLAG_INHERIT,0),"Restrict raw pipe inheritance");
    }
};
inline std::wstring quote(const std::wstring& value) {
    std::wstring result=L"\"";size_t slashes=0;
    for(wchar_t c:value) {
        if(c==L'\\') {++slashes;continue;}
        result.append(slashes*(c==L'"'?2:1),L'\\');slashes=0;
        if(c==L'"') result+=L'\\';result+=c;
    }
    result.append(slashes*2,L'\\');return result+L'"';
}
class Child {
    Handle process;
public:
    Child(const std::wstring& binary,const std::vector<std::wstring>& args,HANDLE input,HANDLE output,HANDLE job) {
        HANDLE copy=nullptr;winCheck(DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_ERROR_HANDLE),GetCurrentProcess(),&copy,0,TRUE,DUPLICATE_SAME_ACCESS),"Duplicate diagnostic stderr");Handle error(copy);
        SIZE_T bytes=0;InitializeProcThreadAttributeList(nullptr,1,0,&bytes);std::vector<uint8_t> storage(bytes);
        auto attributes=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        winCheck(InitializeProcThreadAttributeList(attributes,1,0,&bytes),"Initialize child handle boundary");
        struct AttributeGuard {LPPROC_THREAD_ATTRIBUTE_LIST value;~AttributeGuard(){DeleteProcThreadAttributeList(value);}} guard{attributes};
        std::array<HANDLE,3> handles{input,output,error.get()};
        winCheck(UpdateProcThreadAttribute(attributes,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles.data(),sizeof(handles),nullptr,nullptr),"Restrict inherited child handles");
        STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput=input;startup.StartupInfo.hStdOutput=output;startup.StartupInfo.hStdError=error.get();startup.lpAttributeList=attributes;
        std::wstring command=quote(binary);for(const auto& arg:args)command+=L" "+quote(arg);
        if(command.size()>32760)throw std::runtime_error("Child command is too long");
        PROCESS_INFORMATION info{};
        winCheck(CreateProcessW(binary.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&info),"Start owned FFmpeg child");
        process=Handle(info.hProcess);Handle thread(info.hThread);
        if(!AssignProcessToJobObject(job,process.get())) {TerminateProcess(process.get(),1);throw std::runtime_error("Cannot supervise FFmpeg descendants; render refused");}
        if(ResumeThread(thread.get())==DWORD(-1)) {TerminateProcess(process.get(),1);throw std::runtime_error("Cannot resume owned FFmpeg child");}
    }
    void finish() {
        DWORD waited=WaitForSingleObject(process.get(),30000);if(waited!=WAIT_OBJECT_0)throw std::runtime_error("FFmpeg child did not finish within EOF deadline");
        DWORD exitCode=1;winCheck(GetExitCodeProcess(process.get(),&exitCode),"Read child result");if(exitCode)throw std::runtime_error("FFmpeg child failed with exit code "+std::to_string(exitCode));
    }
};
struct RenderOptions {
    std::wstring ffmpeg,source,output,encoder;uint32_t width,height,fps,threads,bitrate;
    double seconds,offset,crop,strength;unsigned radius;bool audio;
};
inline RenderOptions parseOptions(int argc,wchar_t** argv) {
    if(argc>34||(argc-2)%2)throw std::runtime_error("Invalid render arguments");
    std::map<std::wstring,std::wstring> values;
    const std::vector<std::wstring> names={L"--ffmpeg",L"--source",L"--output",L"--encoder",L"--width",L"--height",L"--fps",L"--threads",L"--bitrate",L"--seconds",L"--offset",L"--crop",L"--preset",L"--audio"};
    for(int i=2;i<argc;i+=2) {
        std::wstring key=argv[i];if(std::find(names.begin(),names.end(),key)==names.end()||values.count(key))throw std::runtime_error("Unknown or repeated render option");values[key]=argv[i+1];
    }
    if(values.size()!=names.size())throw std::runtime_error("Missing render option");
    auto number=[&](const wchar_t* name){size_t used=0;auto n=std::stod(values.at(name),&used);if(used!=values.at(name).size()||!std::isfinite(n))throw std::runtime_error("Invalid finite numeric option");return n;};
    auto integer=[&](const wchar_t* name,uint32_t lo,uint32_t hi){double n=number(name);if(n<lo||n>hi||n!=std::floor(n))throw std::runtime_error("Integer option outside bounds");return uint32_t(n);};
    RenderOptions p{values[L"--ffmpeg"],values[L"--source"],values[L"--output"],values[L"--encoder"],integer(L"--width",640,4096),integer(L"--height",360,4096),integer(L"--fps",1,60),integer(L"--threads",1,64),integer(L"--bitrate",1,200),number(L"--seconds"),number(L"--offset"),number(L"--crop"),1,8,values[L"--audio"]==L"yes"};
    if(p.seconds<=0||p.seconds>24*60*60||p.offset<0||p.offset>24*60*60||(p.crop!=0.04&&p.crop!=0.06))throw std::runtime_error("Render range or fixed crop outside bounds");
    if(p.encoder!=L"libx264"&&p.encoder!=L"h264_nvenc"&&p.encoder!=L"h264_qsv")throw std::runtime_error("Unsupported encoder");
    if(values[L"--audio"]!=L"yes"&&values[L"--audio"]!=L"no")throw std::runtime_error("Invalid audio policy");
    if(values[L"--preset"]==L"gentle") {p.radius=4;p.strength=0.6;}
    else if(values[L"--preset"]==L"balanced") {p.radius=6;p.strength=0.85;}
    else if(values[L"--preset"]!=L"strong")throw std::runtime_error("Unsupported strength");
    for(const auto& path:{p.ffmpeg,p.source}) {auto attributes=GetFileAttributesW(path.c_str());if(attributes==INVALID_FILE_ATTRIBUTES||attributes&FILE_ATTRIBUTE_DIRECTORY)throw std::runtime_error("Required local file is unavailable");}
    if(GetFileAttributesW(p.output.c_str())!=INVALID_FILE_ATTRIBUTES)throw std::runtime_error("Output already exists; overwriting is forbidden");
    return p;
}
inline bool readFrame(HANDLE pipe,std::vector<uint8_t>& data) {
    size_t offset=0;while(offset<data.size()) {
        DWORD count=0;BOOL ok=ReadFile(pipe,data.data()+offset,DWORD(data.size()-offset),&count,nullptr);
        if(!ok&&GetLastError()!=ERROR_BROKEN_PIPE)throw std::runtime_error("Raw decoder pipe failed");
        if(!ok||count==0) {if(offset)throw std::runtime_error("Decoder ended with a partial raw frame");return false;}offset+=count;
    }return true;
}
inline void writeFrame(HANDLE pipe,const std::vector<uint8_t>& data) {
    size_t offset=0;while(offset<data.size()) {DWORD count=0;winCheck(WriteFile(pipe,data.data()+offset,DWORD(data.size()-offset),&count,nullptr),"Write transformed frame");if(!count)throw std::runtime_error("Encoder pipe made no progress");offset+=count;}
}
struct CorrectionLimiter {
    Correction applied{};
    Correction next(Correction target,double limit) {
        applied.x+=std::clamp(target.x-applied.x,-limit,limit);applied.y+=std::clamp(target.y-applied.y,-limit,limit);return applied;
    }
};
inline double correctionStepLimit(uint32_t width,double confidence) {
    // A one-pixel cap at 720p was suppressing legitimate +/-4-pixel jitter.
    // Distributed high-confidence evidence permits a bounded faster response;
    // lost evidence retains the original gentle decay, never a snap to centre.
    double slow=std::max(0.5,double(width)/1280);
    return slow*(1+2*std::clamp(confidence,0.,1.));
}
inline void render(const RenderOptions& p) {
    auto started=std::chrono::steady_clock::now();Gpu gpu(p.width,p.height);
    // Job handle is non-inheritable and excluded from every child's handle list.
    // A forced worker termination therefore closes the last handle and kills
    // both children. Assignment is checked before either child can execute.
    Handle job(CreateJobObjectW(nullptr,nullptr));JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    winCheck(SetInformationJobObject(job.get(),JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"Configure child lifetime ownership");
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};Handle nullFile(CreateFileW(L"NUL",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    Pipe decoded(false),encoded(true);auto text=[](auto value){return std::to_wstring(value);};
    const std::wstring size=text(p.width)+L"x"+text(p.height),rate=text(p.bitrate)+L"M";
    std::wstring filter=L"scale="+text(p.width)+L":"+text(p.height)+L":force_original_aspect_ratio=decrease:out_range=tv,format=yuv420p,setparams=range=limited,pad="+text(p.width)+L":"+text(p.height)+L":(ow-iw)/2:(oh-ih)/2,setsar=1,fps="+text(p.fps);
    std::vector<std::wstring> decode={L"-hide_banner",L"-nostdin",L"-v",L"error",L"-threads",text(p.threads),L"-filter_threads",L"1",L"-ss",text(p.offset),L"-i",p.source,L"-t",text(p.seconds),L"-map",L"0:v:0",L"-vf",filter,L"-an",L"-threads",L"1",L"-f",L"rawvideo",L"-pix_fmt",L"yuv420p",L"pipe:1"};
    std::vector<std::wstring> encode={L"-hide_banner",L"-nostdin",L"-v",L"error",L"-n",L"-threads",L"1",L"-f",L"rawvideo",L"-pix_fmt",L"yuv420p",L"-video_size",size,L"-framerate",text(p.fps),L"-i",L"pipe:0"};
    if(p.audio) {encode.insert(encode.end(),{L"-ss",text(p.offset),L"-i",p.source});}
    else {encode.insert(encode.end(),{L"-f",L"lavfi",L"-i",L"anullsrc=r=48000:cl=stereo"});}
    encode.insert(encode.end(),{L"-map",L"0:v:0",L"-map",L"1:a:0",L"-t",text(p.seconds),L"-af",L"apad,asetpts=PTS-STARTPTS",L"-c:v",p.encoder,L"-bf",L"0",L"-profile:v",L"high",L"-preset",p.encoder==L"h264_nvenc"?L"p4":p.encoder==L"h264_qsv"?L"fast":L"veryfast",L"-b:v",rate,L"-maxrate",rate,L"-bufsize",L"64M",L"-pix_fmt",L"yuv420p",L"-color_range",L"tv",L"-c:a",L"aac",L"-b:a",L"192k",L"-ar",L"48000",L"-ac",L"2",L"-video_track_timescale",L"90000",L"-threads",text(p.threads),p.output});
    Child decoder(p.ffmpeg,decode,nullFile.get(),decoded.write.get(),job.get());decoded.write.close();
    Child encoder(p.ffmpeg,encode,encoded.read.get(),nullFile.get(),job.get());encoded.read.close();
    std::deque<PathFrame> window;uint64_t received=0,written=0,segment=0,accepted=0,rejected=0;double pathX=0,pathY=0;bool priorValid=false;
    CorrectionLimiter limiter;size_t maxWindow=0;
    auto emit=[&] {
        auto position=std::find_if(window.begin(),window.end(),[&](const auto& frame){return frame.index==written;});
        if(position==window.end())throw std::runtime_error("Lookahead lost a frame");
        auto target=smoothCorrection(window,size_t(position-window.begin()),p.radius,p.strength);
        target.x=std::clamp(target.x,-std::max(0.,p.crop*p.width-4),std::max(0.,p.crop*p.width-4));
        target.y=std::clamp(target.y,-std::max(0.,p.crop*p.height-4),std::max(0.,p.crop*p.height-4));
        auto correction=limiter.next(target,correctionStepLimit(p.width,position->confidence));
        auto bytes=gpu.warp(position->bytes,correction,p.crop);writeFrame(encoded.write.get(),bytes);++written;
        if(written%10==0) {double wall=std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();std::cout<<"frame="<<written<<"\nfps="<<written/wall<<"\nout_time_us="<<uint64_t(double(written)/p.fps*1e6)<<"\nprogress=continue\n"<<std::flush;}
        while(!window.empty()&&window.front().index+p.radius<written)window.pop_front();
    };
    for(;;) {
        std::vector<uint8_t> bytes(gpu.frameSize());if(!readFrame(decoded.read.get(),bytes))break;
        if(received>uint64_t(std::ceil(p.seconds*p.fps))+1)throw std::runtime_error("Decoder exceeded bounded requested frame count");
        auto motion=gpu.analyse(bytes,received==0);bool valid=motion.confidence>0;
        if(received&&valid!=priorValid){++segment;pathX=pathY=0;}
        if(valid){pathX+=motion.x;pathY+=motion.y;++accepted;}else{++rejected;}
        window.push_back({received,pathX,pathY,motion.confidence,segment,std::move(bytes)});++received;priorValid=valid;maxWindow=std::max(maxWindow,window.size());
        if(received>written+p.radius)emit();
    }
    decoder.finish();while(written<received)emit();encoded.write.close();encoder.finish();
    if(!received||written!=received||std::abs(double(received)-p.seconds*p.fps)>1.1)throw std::runtime_error("Frame count differs from requested CFR duration");
    double wall=std::chrono::duration<double>(std::chrono::steady_clock::now()-started).count();
    std::cerr<<"GPU_TRIPOD_RECEIPT {\"engine\":"<<jsonString(kEngine)<<",\"adapter\":"<<jsonString(gpu.adapter)
        <<",\"frames\":"<<written<<",\"acceptedPairs\":"<<accepted<<",\"rejectedPairs\":"<<rejected
        <<",\"lookaheadFrames\":"<<p.radius<<",\"maxBufferedFrames\":"<<maxWindow
        <<",\"maxCoarseSeedPixels\":"<<gpu.maxCoarseSeedPixels<<",\"maxAcceptedMotionPixels\":"<<gpu.maxAcceptedMotionPixels
        <<",\"alternateRefinements\":"<<gpu.alternateRefinements<<",\"nearZeroWins\":"<<gpu.nearZeroWins<<",\"ambiguousPairs\":"<<gpu.ambiguousPairs
        <<",\"uploadBytes\":"<<gpu.uploads<<",\"readbackBytes\":"<<gpu.readbacks
        <<",\"motionWallMs\":"<<gpu.motionMilliseconds<<",\"warpWallMs\":"<<gpu.warpMilliseconds
        <<",\"endToEndSeconds\":"<<wall<<",\"fps\":"<<written/wall
        <<",\"rotation\":0,\"perEdgeCrop\":"<<p.crop<<",\"pixelFormat\":\"limited-yuv420p8\",\"decode\":\"CPU\",\"motionModel\":\"global-translation\"}\n";
    std::cout<<"frame="<<written<<"\nout_time_us="<<uint64_t(double(written)/p.fps*1e6)<<"\nprogress=end\n"<<std::flush;
}
