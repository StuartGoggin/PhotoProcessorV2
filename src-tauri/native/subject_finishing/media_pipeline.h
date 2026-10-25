#pragma once
#include "gpu.h"
#include "mask_cache.h"
#include "process_owner.h"
#include "media_contract.h"
#include <memory>
#include <iostream>
#include <chrono>

namespace subject_finishing {
struct MediaRequest {
    std::filesystem::path ffmpeg,source,output,masks;
    uint32_t width,height,count,fps,threads,bitrate;
    Finishing settings;
    std::string backend,encoder;
    uint32_t requiredVendor=0;
};
inline void render_media(const MediaRequest& p) {
    if(!p.width||p.width>4096||!p.height||p.height>4096||uint64_t(p.width)*p.height>16777216
        ||!p.count||p.count>1800000||!p.fps||p.fps>60||!p.threads||p.threads>64||!p.bitrate||p.bitrate>200)
        throw std::invalid_argument("Invalid bounded finishing media request");
    if(p.backend!="auto"&&p.backend!="cpu"&&p.backend!="gpu")throw std::invalid_argument("Invalid finishing backend");
    if(p.requiredVendor&&p.backend!="gpu")throw std::invalid_argument("A required GPU vendor needs explicit GPU processing");
    if(p.encoder!="libx264"&&p.encoder!="h264_nvenc"&&p.encoder!="h264_qsv")throw std::invalid_argument("Invalid finishing encoder");
    for(const auto& path:{p.ffmpeg,p.source,p.masks}) {
        if(!path.is_absolute()||!std::filesystem::is_regular_file(path))throw std::runtime_error("Finishing requires exact local input files");
    }
    if(!p.output.is_absolute()||std::filesystem::exists(p.output)||!std::filesystem::is_directory(p.output.parent_path()))
        throw std::runtime_error("Finishing requires a new owned staging output; existing files are never overwritten");
    // Native workers reopen the base for probe, decode and audio. Prevent a
    // concurrent writer/rename between those owners, not merely a stale hash.
    OwnedHandle sourceLease(CreateFileW(p.source.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedHandle maskLease(CreateFileW(p.masks.c_str(),GENERIC_READ,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    const auto probe=p.ffmpeg.parent_path()/L"ffprobe.exe";
    if(!std::filesystem::is_regular_file(probe))throw std::runtime_error("Finishing requires its exact local FFprobe sibling");
    const auto metadata=capture_bounded(probe.wstring(),{L"-v",L"error",L"-select_streams",L"v",L"-show_entries",
        L"stream=codec_type,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,field_order,nb_frames,r_frame_rate,avg_frame_rate,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation,displaymatrix",
        L"-of",L"default",p.source.wstring()});
    validate_media_metadata(metadata,p.width,p.height,p.fps,p.count);
    Frame source{p.width,p.height,std::vector<Rgba>(size_t(p.width)*p.height)};
    std::vector<uint8_t> mask(source.pixels.size());
    validate(source,mask,p.settings.sharpness);validate_colour(p.settings.subject);validate_colour(p.settings.wholeFrame);
    MaskCache cache(p.masks,p.count);
    std::unique_ptr<GpuSharpener> gpu;
    if(p.backend!="cpu") {
        try{gpu=std::make_unique<GpuSharpener>(p.requiredVendor);}
        catch(const std::exception& error) {
            if(p.backend=="gpu")throw;
            std::cerr<<"{\"event\":\"cpuFallback\",\"reason\":\"Hardware initialization failed; CPU reference selected before the first frame\"}\n";
            (void)error;
        }
    }
    // This group owns both FFmpeg children. It is non-inheritable and excluded
    // from their handle lists. Forced app/worker termination closes it and kills
    // all descendants; no cancelled decoder can continue reading the source.
    ChildGroup group;
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    OwnedHandle nullFile(CreateFileW(L"NUL",GENERIC_READ|GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&security,
        OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
    OwnedPipe decoded(false),encoded(true);
    auto text=[](auto number){return std::to_wstring(number);};
    const std::wstring size=text(p.width)+L"x"+text(p.height),rate=text(p.bitrate)+L"M";
    const std::wstring duration=text(double(p.count)/p.fps);
    const std::wstring encoderName(p.encoder.begin(),p.encoder.end());
    std::vector<std::wstring> decode={L"-hide_banner",L"-v",L"error",L"-nostdin",L"-threads",text(p.threads),
        L"-noautorotate",L"-i",p.source.wstring(),L"-map",L"0:v:0",L"-an",L"-fps_mode",L"passthrough",L"-filter_threads",L"1",
        L"-vf",L"scale=iw:ih:in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709,format=rgba",
        L"-threads",L"1",L"-f",L"rawvideo",L"-pix_fmt",L"rgba",L"pipe:1"};
    std::vector<std::wstring> encode={L"-hide_banner",L"-v",L"error",L"-nostdin",L"-n",L"-threads",L"1",
        L"-f",L"rawvideo",L"-pix_fmt",L"rgba",L"-video_size",size,L"-framerate",text(p.fps),L"-i",L"pipe:0",
        L"-i",p.source.wstring(),L"-map",L"0:v:0",L"-map",L"1:a:0",L"-filter_threads",L"1",
        L"-vf",L"scale=iw:ih:in_range=pc:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,format=yuv420p,setsar=1,setparams=range=limited:color_primaries=bt709:color_trc=bt709:colorspace=bt709",
        L"-c:v",encoderName,L"-bf",L"0",L"-profile:v",L"high",L"-preset",
        p.encoder=="h264_nvenc"?L"p4":p.encoder=="h264_qsv"?L"fast":L"veryfast",
        L"-b:v",rate,L"-maxrate",rate,L"-bufsize",L"64M",L"-pix_fmt",L"yuv420p",L"-color_range",L"tv",
        L"-color_primaries",L"bt709",L"-color_trc",L"bt709",L"-colorspace",L"bt709",
        L"-c:a",L"copy",L"-t",duration,L"-video_track_timescale",L"90000",L"-threads",text(p.threads)};
    if(p.encoder=="libx264")encode.insert(encode.end(),{L"-x264-params",L"colorprim=bt709:transfer=bt709:colormatrix=bt709"});
    encode.push_back(p.output.wstring());
    const auto start=std::chrono::steady_clock::now();double filterMilliseconds=0;
    const uint32_t cpuPictureParallelism=gpu?0:(std::min)({uint32_t(8),p.threads,p.height});
    OwnedChild decoder(p.ffmpeg.wstring(),decode,nullFile.get(),decoded.write.get(),group.get());decoded.write.close();
    OwnedChild encoder(p.ffmpeg.wstring(),encode,encoded.read.get(),nullFile.get(),group.get());encoded.read.close();
    std::cerr<<"{\"schema\":1,\"event\":\"pipelineStarted\",\"children\":["<<decoder.id()<<","<<encoder.id()<<"]}\n"<<std::flush;
    uint32_t written=0;
    while(read_exact_frame(decoded.read.get(),source.pixels.data(),source.pixels.size()*sizeof(Rgba))) {
        if(written>=p.count)throw std::runtime_error("Finishing decoder exceeded its exact frame count");
        mask=cache.next(p.width,p.height);
        const auto filterStart=std::chrono::steady_clock::now();
        const Frame finished=gpu?gpu->filter(source,mask,p.settings):finish(source,mask,p.settings,cpuPictureParallelism);
        filterMilliseconds+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-filterStart).count();
        write_exact_frame(encoded.write.get(),finished.pixels.data(),finished.pixels.size()*sizeof(Rgba));++written;
        std::cout<<"frame="<<written<<"\nout_time_us="<<uint64_t(double(written)/p.fps*1e6)<<"\nprogress=continue\n"<<std::flush;
    }
    // Valid output prefix is insufficient: every owner and EOF must succeed.
    decoder.finish();cache.finish();
    if(written!=p.count)throw std::runtime_error("Finishing decoder omitted picture frames");
    encoded.write.close();encoder.finish();
    const double seconds=std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count();
    std::cerr<<"{\"schema\":1,\"event\":\"mediaFinished\",\"engine\":\"subject-rgb709-q4-v2\",\"frames\":"<<written
        <<",\"backend\":\""<<(gpu?"d3d11":"cpu")<<"\",\"filterAndTransferMs\":"<<filterMilliseconds
        <<",\"cpuPictureParallelism\":"<<cpuPictureParallelism
        <<",\"actualVendorId\":"<<(gpu?gpu->adapterDescription.VendorId:0)
        <<",\"actualDeviceId\":"<<(gpu?gpu->adapterDescription.DeviceId:0)
        <<",\"decodeFilterEncodeSeconds\":"<<seconds<<",\"profile\":\"limited-sdr709-yuv420p8\",\"audio\":\"base-stream-copy\"}\n";
    std::cout<<"progress=end\n"<<std::flush;
}
}
