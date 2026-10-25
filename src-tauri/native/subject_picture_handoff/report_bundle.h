#pragma once
#include "supervisor.h"
namespace picture_handoff {
inline std::string read_report(HANDLE handle) {
    const auto count=file_bytes(handle);if(count>65536)throw std::runtime_error("REPORT_BUDGET_EXCEEDED");
    LARGE_INTEGER zero{};DWORD read=0;std::string text(size_t(count),'\0');
    if(!SetFilePointerEx(handle,zero,nullptr,FILE_BEGIN)||!ReadFile(handle,text.data(),DWORD(count),&read,nullptr)||read!=count)
        throw std::runtime_error("REPORT_READBACK_FAILED");
    return text;
}
inline void require_empty_marker(HANDLE handle) {
    LARGE_INTEGER size{};if(!GetFileSizeEx(handle,&size)||size.QuadPart!=0)throw std::runtime_error("REPORT_COMMIT_FAILED");
}
inline uint32_t crc32(const std::string& bytes) {
    uint32_t crc=0xffffffffu;
    for(const unsigned char value:bytes) {
        crc^=value;for(unsigned n=0;n<8;++n)crc=(crc>>1)^(0xedb88320u&(0u-(crc&1u)));
    }
    return ~crc;
}
// Tiny stored ZIP: bounded ASCII names and already validated reports only.
// No paths/media/source/environment are read implicitly or included.
inline std::string report_zip(const std::map<std::string,std::string>& entries) {
    if(entries.empty()||entries.size()>16)throw std::runtime_error("REPORT_BUDGET_EXCEEDED");
    std::string local,central;
    auto put=[](std::string& text,uint32_t value,unsigned bytes){for(unsigned n=0;n<bytes;++n)text+=char((value>>(8*n))&255);};
    for(const auto& [name,bytes]:entries) {
        if(name.empty()||name.size()>160||name.find("..")!=std::string::npos||name.front()=='/'
            ||name.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./")!=std::string::npos
            ||bytes.size()>65536||local.size()+central.size()+bytes.size()>60000)
            throw std::runtime_error("REPORT_BUDGET_EXCEEDED");
        const auto offset=uint32_t(local.size()),crc=crc32(bytes),size=uint32_t(bytes.size()),length=uint32_t(name.size());
        put(local,0x04034b50,4);put(local,20,2);put(local,0,2);put(local,0,2);put(local,0,2);put(local,33,2);
        put(local,crc,4);put(local,size,4);put(local,size,4);put(local,length,2);put(local,0,2);local+=name;local+=bytes;
        put(central,0x02014b50,4);put(central,20,2);put(central,20,2);put(central,0,2);put(central,0,2);put(central,0,2);put(central,33,2);
        put(central,crc,4);put(central,size,4);put(central,size,4);put(central,length,2);put(central,0,2);put(central,0,2);
        put(central,0,2);put(central,0,2);put(central,0,4);put(central,offset,4);central+=name;
    }
    const auto offset=uint32_t(local.size()),size=uint32_t(central.size());local+=central;
    put(local,0x06054b50,4);put(local,0,2);put(local,0,2);put(local,uint32_t(entries.size()),2);put(local,uint32_t(entries.size()),2);
    put(local,size,4);put(local,offset,4);put(local,0,2);
    if(local.size()>65536)throw std::runtime_error("REPORT_BUDGET_EXCEEDED");return local;
}
}
