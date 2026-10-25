#pragma once
#include <map>
#include <sstream>
#include <string>
#include <stdexcept>

namespace subject_finishing {
// ffprobe's bounded default writer has exactly one video STREAM. Unknown,
// duplicate, oriented or non-square records cannot be silently reinterpreted.
inline void validate_media_metadata(const std::string& metadata,uint32_t width,uint32_t height,uint32_t fps,uint32_t count) {
    std::map<std::string,std::string> fields;std::istringstream lines(metadata);std::string line;
    bool inside=false;uint32_t streams=0;
    while(std::getline(lines,line)) {
        if(!line.empty()&&line.back()=='\r')line.pop_back();
        if(line.empty())continue;
        if(line=="[STREAM]") {if(inside||++streams!=1)throw std::runtime_error("Finishing requires one normalized picture stream");inside=true;continue;}
        if(line=="[/STREAM]") {if(!inside)throw std::runtime_error("Invalid finishing picture probe");inside=false;continue;}
        const auto equal=line.find('=');
        if(!inside||equal==std::string::npos)throw std::runtime_error("Finishing rejects orientation/display-matrix or unsupported metadata");
        const auto key=line.substr(0,equal),value=line.substr(equal+1);
        if(!fields.emplace(key,value).second)throw std::runtime_error("Finishing rejects ambiguous duplicate picture metadata");
    }
    if(inside||streams!=1)throw std::runtime_error("Incomplete normalized picture metadata");
    const std::map<std::string,std::string> expected={
        {"codec_type","video"},{"width",std::to_string(width)},{"height",std::to_string(height)},
        {"sample_aspect_ratio","1:1"},{"pix_fmt","yuv420p"},{"color_range","tv"},
        {"color_space","bt709"},{"color_transfer","bt709"},{"color_primaries","bt709"},
        {"field_order","progressive"},{"r_frame_rate",std::to_string(fps)+"/1"},
        {"avg_frame_rate",std::to_string(fps)+"/1"},{"nb_frames",std::to_string(count)}};
    if(fields!=expected)throw std::runtime_error("Finishing requires exact geometry, square pixels, identity orientation, complete CFR count and explicit limited SDR7098 profile");
}
}
