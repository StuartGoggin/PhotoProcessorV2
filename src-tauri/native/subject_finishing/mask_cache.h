#pragma once
#include "core.h"
#include <filesystem>
#include <fstream>

namespace subject_finishing {
// The application verifies the manifest/base/file checksums before launch.
// This reader independently enforces geometry, inflation, ownership and EOF.
class MaskCache {
    std::ifstream input;
    uint32_t width=0,height=0,count=0,readCount=0;
    uint32_t number() {
        uint8_t value[4]{};input.read(reinterpret_cast<char*>(value),4);
        if(!input)throw std::runtime_error("Truncated subject-mask record");
        return uint32_t(value[0])|(uint32_t(value[1])<<8)|(uint32_t(value[2])<<16)|(uint32_t(value[3])<<24);
    }
public:
    explicit MaskCache(const std::filesystem::path& path,uint32_t expected):input(path,std::ios::binary) {
        if(!input||std::filesystem::file_size(path)>uint64_t(2)*1024*1024*1024)throw std::runtime_error("Subject mask cache is unavailable or over budget");
        char magic[8]{};input.read(magic,8);
        if(!input||std::memcmp(magic,"PGMSK001",8))throw std::runtime_error("Unsupported subject-mask format");
        width=number();height=number();count=number();
        if(!width||width>1024||!height||height>1024||!count||count!=expected)throw std::runtime_error("Subject-mask geometry or frame count differs from request");
    }
    std::vector<uint8_t> next(uint32_t outWidth,uint32_t outHeight) {
        if(readCount>=count)throw std::runtime_error("Too many subject-mask reads");
        const uint32_t pixels=width*height,size=number();
        if(size<5||size>pixels*5||size%5)throw std::runtime_error("Invalid bounded subject-mask RLE size");
        std::vector<uint8_t> compactMask(pixels);uint32_t filled=0;
        for(uint32_t offset=0;offset<size;offset+=5) {
            const uint32_t run=number();char value=0;input.read(&value,1);
            if(!input||!run||run>pixels-filled)throw std::runtime_error("Invalid inflating subject-mask run");
            std::fill(compactMask.begin()+filled,compactMask.begin()+filled+run,uint8_t(value));filled+=run;
        }
        if(filled!=pixels)throw std::runtime_error("Subject-mask runs omit picture pixels");
        std::vector<uint8_t> result(size_t(outWidth)*outHeight);
        for(uint32_t y=0;y<outHeight;++y)for(uint32_t x=0;x<outWidth;++x) {
            result[size_t(y)*outWidth+x]=compactMask[size_t(uint64_t(y)*height/outHeight)*width+uint32_t(uint64_t(x)*width/outWidth)];
        }
        ++readCount;return result;
    }
    void finish() {
        if(readCount!=count||input.peek()!=std::char_traits<char>::eof())throw std::runtime_error("Subject-mask cache has missing or trailing frames");
    }
};
}
