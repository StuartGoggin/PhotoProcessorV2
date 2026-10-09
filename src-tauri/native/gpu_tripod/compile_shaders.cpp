#include <windows.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <fstream>
#include <iostream>
#include <string>
#include "shaders.h"
int wmain(int argc,wchar_t** argv) {
    if(argc!=2) return 2;
    std::ofstream output(argv[1],std::ios::trunc);
    if(!output) return 2;
    output<<"#pragma once\n";
    for(const char* entry:{"Downsample","Match","Refine","Warp"}) {
        Microsoft::WRL::ComPtr<ID3DBlob> code,errors;
        auto result=D3DCompile(kShaders,sizeof(kShaders)-1,"PhotoGoGo original shaders",nullptr,nullptr,entry,"cs_5_0",D3DCOMPILE_OPTIMIZATION_LEVEL3|D3DCOMPILE_ENABLE_STRICTNESS,0,&code,&errors);
        if(FAILED(result)) { if(errors) std::cerr.write(static_cast<char*>(errors->GetBufferPointer()),errors->GetBufferSize());return 1; }
        output<<"inline constexpr unsigned char shader"<<entry<<"[] = {";
        auto bytes=static_cast<const unsigned char*>(code->GetBufferPointer());
        for(size_t i=0;i<code->GetBufferSize();++i) output<<unsigned(bytes[i])<<',';
        output<<"};\n";
    }
    return output ? 0 : 1;
}
