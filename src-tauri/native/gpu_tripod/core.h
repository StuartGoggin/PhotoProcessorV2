#pragma once
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <deque>
#include <stdexcept>
#include <string>
#include <vector>
#include "shaders.h"
#ifdef PHOTOGOGO_EMBED_SHADERS
#include "compiled-shaders.h"
#endif
using Microsoft::WRL::ComPtr;
inline constexpr char kEngine[] = "gpu-tripod-d3d11-v1";
inline void check(HRESULT hr,const char* action) {
    if(FAILED(hr)) throw std::runtime_error(std::string(action)+" failed (HRESULT "+std::to_string(static_cast<unsigned long>(hr))+")");
}
inline std::string utf8(const std::wstring& s) {
    int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),nullptr,0,nullptr,nullptr);
    if(!n && !s.empty()) throw std::runtime_error("Invalid Unicode argument");
    std::string r(n,0); WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,s.data(),static_cast<int>(s.size()),r.data(),n,nullptr,nullptr); return r;
}
inline std::string jsonString(const std::string& s) {
    std::string r="\""; for(unsigned char c:s) {
        if(c=='"'||c=='\\') {r+='\\';r+=c;} else if(c<32) { const char* hex="0123456789abcdef";r+="\\u00";r+=hex[c>>4];r+=hex[c&15]; } else r+=c;
    } return r+'"';
}
struct RawBuffer { ComPtr<ID3D11Buffer> buffer; ComPtr<ID3D11ShaderResourceView> srv; ComPtr<ID3D11UnorderedAccessView> uav; };
struct Motion {
    double x=0,y=0,confidence=0,meanSad=0;
    uint64_t supportMask=0;
    std::array<float,48> residuals{};
};
struct MotionChoice { Motion motion; int candidate=-1; };
inline MotionChoice chooseFullResolutionMotion(const Motion& seeded,const Motion& nearZero) {
    if(seeded.confidence<=0) return nearZero.confidence>0?MotionChoice{nearZero,1}:MotionChoice{};
    if(nearZero.confidence<=0) return {seeded,0};
    if(std::hypot(seeded.x-nearZero.x,seeded.y-nearZero.y)<=1.5) return {seeded,0};
    // Compare the same full-resolution peripheral blocks. Comparing separately
    // selected mean residuals can favour a small, easy foreground subset.
    unsigned count=0;std::array<unsigned,4> quadrants{};double a=0,b=0;
    for(unsigned i=0;i<48;++i)if((seeded.supportMask&nearZero.supportMask)&(uint64_t(1)<<i)) {
        ++count;++quadrants[(i/8>=3?2:0)+(i%8>=4?1:0)];a+=seeded.residuals[i];b+=nearZero.residuals[i];
    }
    if(count<12||std::count_if(quadrants.begin(),quadrants.end(),[](unsigned n){return n>=2;})<3) return {};
    a/=count;b/=count;
    if(b+1<a) return {nearZero,1};
    if(a+1<b) return {seeded,0};
    return {}; // Distinct near-tied basins are ambiguous, not trusted motion.
}
struct Correction { double x=0,y=0; };
struct PathFrame { uint64_t index; double x,y,confidence; uint64_t segment; std::vector<uint8_t> bytes; };
// Fit a local line as well as its intercept. Unlike endpoint-padded averages,
// this preserves a deliberate constant-speed pan at the start/end of a clip.
inline Correction smoothCorrection(const std::deque<PathFrame>& frames,size_t centre,unsigned radius,double strength) {
    const auto& f=frames.at(centre);
    double s0=0,s1=0,s2=0,x0=0,x1=0,y0=0,y1=0;
    for(const auto& p:frames) if(p.segment==f.segment && std::abs(double(p.index)-double(f.index))<=radius) {
        double t=double(p.index)-double(f.index),w=std::exp(-t*t/(2*std::max(1.,double(radius)*radius/4)));
        s0+=w;s1+=w*t;s2+=w*t*t;x0+=w*p.x;x1+=w*t*p.x;y0+=w*p.y;y1+=w*t*p.y;
    }
    double determinant=s0*s2-s1*s1;
    if(determinant<1e-6 || f.confidence<=0) return {};
    return {(f.x-(x0*s2-x1*s1)/determinant)*strength*f.confidence,
            (f.y-(y0*s2-y1*s1)/determinant)*strength*f.confidence};
}
class Gpu {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11ComputeShader> downsample,matchShader,refineShader,warpShader;
    ComPtr<ID3D11Buffer> constants;
    ComPtr<ID3D11Query> complete;
    RawBuffer input,previousFull,output,currentAnalysis,previousAnalysis,matches;
    ComPtr<ID3D11Buffer> pixelReadback,motionReadback;
    uint32_t width,height,size;
    static constexpr uint32_t aw=320,ah=180;
    RawBuffer buffer(uint32_t bytes) {
        RawBuffer result; D3D11_BUFFER_DESC d{};d.ByteWidth=bytes;d.Usage=D3D11_USAGE_DEFAULT;
        d.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_UNORDERED_ACCESS;d.MiscFlags=D3D11_RESOURCE_MISC_BUFFER_ALLOW_RAW_VIEWS;
        check(device->CreateBuffer(&d,nullptr,&result.buffer),"Create GPU buffer");
        D3D11_SHADER_RESOURCE_VIEW_DESC s{};s.Format=DXGI_FORMAT_R32_TYPELESS;s.ViewDimension=D3D11_SRV_DIMENSION_BUFFEREX;
        s.BufferEx.NumElements=bytes/4;s.BufferEx.Flags=D3D11_BUFFEREX_SRV_FLAG_RAW;
        check(device->CreateShaderResourceView(result.buffer.Get(),&s,&result.srv),"Create raw input view");
        D3D11_UNORDERED_ACCESS_VIEW_DESC u{};u.Format=DXGI_FORMAT_R32_TYPELESS;u.ViewDimension=D3D11_UAV_DIMENSION_BUFFER;
        u.Buffer.NumElements=bytes/4;u.Buffer.Flags=D3D11_BUFFER_UAV_FLAG_RAW;
        check(device->CreateUnorderedAccessView(result.buffer.Get(),&u,&result.uav),"Create raw output view");return result;
    }
    ComPtr<ID3D11Buffer> staging(uint32_t bytes) {
        D3D11_BUFFER_DESC d{};d.ByteWidth=bytes;d.Usage=D3D11_USAGE_STAGING;d.CPUAccessFlags=D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Buffer> b;check(device->CreateBuffer(&d,nullptr,&b),"Create readback buffer");return b;
    }
    ComPtr<ID3D11ComputeShader> compile(const char* entry) {
#ifdef PHOTOGOGO_EMBED_SHADERS
        const void* bytes=nullptr;size_t count=0;
        if(std::strcmp(entry,"Downsample")==0) {bytes=shaderDownsample;count=sizeof(shaderDownsample);}
        else if(std::strcmp(entry,"Match")==0) {bytes=shaderMatch;count=sizeof(shaderMatch);}
        else if(std::strcmp(entry,"Refine")==0) {bytes=shaderRefine;count=sizeof(shaderRefine);}
        else if(std::strcmp(entry,"Warp")==0) {bytes=shaderWarp;count=sizeof(shaderWarp);}
        else throw std::runtime_error("Unknown built-in shader");
        ComPtr<ID3D11ComputeShader> result;check(device->CreateComputeShader(bytes,count,nullptr,&result),"Create built-in compute shader");return result;
#else
        ComPtr<ID3DBlob> code,errors;
        HRESULT hr=D3DCompile(kShaders,sizeof(kShaders)-1,"PhotoGoGo original shaders",nullptr,nullptr,entry,"cs_5_0",D3DCOMPILE_OPTIMIZATION_LEVEL3|D3DCOMPILE_ENABLE_STRICTNESS,0,&code,&errors);
        if(FAILED(hr)) throw std::runtime_error(std::string("Compile ")+entry+": "+(errors ? std::string(static_cast<char*>(errors->GetBufferPointer()),errors->GetBufferSize()) : "failed"));
        ComPtr<ID3D11ComputeShader> result;check(device->CreateComputeShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,&result),"Create compute shader");return result;
#endif
    }
    void dispatch(ID3D11ComputeShader* shader,RawBuffer& a,RawBuffer* b,RawBuffer& out,uint32_t groups,Correction correction={},double crop=0) {
        struct Params { uint32_t w,h,aw,ah;float x,y,crop,unused; } p{width,height,aw,ah,float(correction.x),float(correction.y),float(crop),0};
        context->UpdateSubresource(constants.Get(),0,nullptr,&p,0,0);
        ID3D11Buffer* cb=constants.Get();context->CSSetConstantBuffers(0,1,&cb);
        ID3D11ShaderResourceView* srvs[]={a.srv.Get(),b ? b->srv.Get() : nullptr};context->CSSetShaderResources(0,2,srvs);
        ID3D11UnorderedAccessView* u=out.uav.Get();context->CSSetUnorderedAccessViews(0,1,&u,nullptr);
        context->CSSetShader(shader,nullptr,0);context->Dispatch(groups,1,1);
        ID3D11ShaderResourceView* empty[]={nullptr,nullptr};ID3D11UnorderedAccessView* no=nullptr;
        context->CSSetShaderResources(0,2,empty);context->CSSetUnorderedAccessViews(0,1,&no,nullptr);
    }
    void wait() {
        context->End(complete.Get());context->Flush();auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
        for(;;) {
            HRESULT hr=context->GetData(complete.Get(),nullptr,0,D3D11_ASYNC_GETDATA_DONOTFLUSH);
            if(hr==S_OK) return;check(hr,"GPU completion");
            if(std::chrono::steady_clock::now()>deadline) throw std::runtime_error("GPU completion timed out; no CPU fallback. Device status: "+std::to_string(device->GetDeviceRemovedReason()));
            Sleep(0);
        }
    }
public:
    std::string adapter;
    uint32_t vendor=0,deviceId=0;
    uint64_t uploads=0,readbacks=0;
    double motionMilliseconds=0,warpMilliseconds=0;
    double maxCoarseSeedPixels=0,maxAcceptedMotionPixels=0;
    uint64_t alternateRefinements=0,nearZeroWins=0,ambiguousPairs=0;
    Gpu(uint32_t w,uint32_t h):width(w),height(h) {
        if(w<640||h<360||w>4096||h>4096||w%8||h%2) throw std::runtime_error("GPU Tripod requires 640x360..4096x4096 dimensions with even height and width divisible by 8");
        uint64_t count=uint64_t(w)*h*3/2;if(count>32*1024*1024) throw std::runtime_error("Frame allocation exceeds bounded GPU worker budget");size=uint32_t(count);
        ComPtr<IDXGIFactory1> factory;check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)),"Enumerate hardware adapters");
        uint64_t best=0;
        for(UINT i=0;;++i) {
            ComPtr<IDXGIAdapter1> a;if(factory->EnumAdapters1(i,&a)==DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 description{};check(a->GetDesc1(&description),"Read adapter capability");
            if(description.Flags&DXGI_ADAPTER_FLAG_SOFTWARE) continue;
            ComPtr<ID3D11Device> candidate;ComPtr<ID3D11DeviceContext> candidateContext;D3D_FEATURE_LEVEL actual{};
            D3D_FEATURE_LEVEL level=D3D_FEATURE_LEVEL_11_0;
            HRESULT hr=D3D11CreateDevice(a.Get(),D3D_DRIVER_TYPE_UNKNOWN,nullptr,0,&level,1,D3D11_SDK_VERSION,&candidate,&actual,&candidateContext);
            if(FAILED(hr)||actual<D3D_FEATURE_LEVEL_11_0) continue;
            uint64_t rank=description.DedicatedVideoMemory;
            if(!device||rank>best) {device=candidate;context=candidateContext;adapter=utf8(description.Description);vendor=description.VendorId;deviceId=description.DeviceId;best=rank;}
        }
        if(!device) throw std::runtime_error("No hardware D3D11 compute adapter is available. Choose existing Quality or Fast; software/WARP is not used.");
        downsample=compile("Downsample");matchShader=compile("Match");refineShader=compile("Refine");warpShader=compile("Warp");
        input=buffer(size);previousFull=buffer(size);output=buffer(size);currentAnalysis=buffer(aw*ah);previousAnalysis=buffer(aw*ah);matches=buffer(48*16);
        pixelReadback=staging(size);motionReadback=staging(48*16);
        D3D11_BUFFER_DESC cd{};cd.ByteWidth=32;cd.Usage=D3D11_USAGE_DEFAULT;cd.BindFlags=D3D11_BIND_CONSTANT_BUFFER;
        check(device->CreateBuffer(&cd,nullptr,&constants),"Create parameters");
        D3D11_QUERY_DESC q{D3D11_QUERY_EVENT,0};check(device->CreateQuery(&q,&complete),"Create completion query");
    }
    uint32_t frameSize() const {return size;}
    void upload(const std::vector<uint8_t>& bytes) {
        if(bytes.size()!=size) throw std::runtime_error("Incomplete raw frame");context->UpdateSubresource(input.buffer.Get(),0,nullptr,bytes.data(),0,0);uploads+=size;
    }
    Motion consensus(bool sourceResolution) {
        context->CopyResource(motionReadback.Get(),matches.buffer.Get());wait();
        D3D11_MAPPED_SUBRESOURCE map{};check(context->Map(motionReadback.Get(),0,D3D11_MAP_READ,0,&map),"Read motion metadata");
        std::array<std::array<float,4>,48> blocks{};std::memcpy(blocks.data(),map.pData,48*16);context->Unmap(motionReadback.Get(),0);readbacks+=48*16;
        std::vector<float> xs,ys;for(const auto& b:blocks) if(b[3]>0) {xs.push_back(b[0]);ys.push_back(b[1]);}
        if(xs.size()<12) return {};
        auto median=[](std::vector<float> v){std::sort(v.begin(),v.end());return v[v.size()/2];};float x=median(xs),y=median(ys);
        unsigned agree=0;std::array<unsigned,4> quadrants{};double sumx=0,sumy=0,sumSad=0;uint64_t support=0;
        for(size_t i=0;i<blocks.size();++i) {const auto& b=blocks[i];if(b[3]>0&&std::hypot(b[0]-x,b[1]-y)<=1.5) {++agree;++quadrants[(i/8>=3?2:0)+(i%8>=4?1:0)];sumx+=b[0];sumy+=b[1];sumSad+=b[2];support|=uint64_t(1)<<i;}}
        auto covered=std::count_if(quadrants.begin(),quadrants.end(),[](unsigned n){return n>=2;});
        if(covered<3||agree<12||agree<xs.size()*0.7) return {};
        Motion result;result.x=sumx/agree*(sourceResolution?1.:double(width)/aw);result.y=sumy/agree*(sourceResolution?1.:double(height)/ah);
        result.confidence=std::min(1.,double(agree)/24);result.meanSad=sumSad/agree;result.supportMask=support;
        for(size_t i=0;i<blocks.size();++i)result.residuals[i]=blocks[i][2];return result;
    }
    Motion analyse(const std::vector<uint8_t>& bytes,bool first) {
        auto started=std::chrono::steady_clock::now();upload(bytes);
        dispatch(downsample.Get(),input,nullptr,currentAnalysis,(aw*ah/4+63)/64);
        Motion result;
        if(!first) {
            dispatch(matchShader.Get(),currentAnalysis,&previousAnalysis,matches,48);
            result=consensus(false);
            maxCoarseSeedPixels=std::max(maxCoarseSeedPixels,std::max(std::abs(result.x),std::abs(result.y)));
            bool displacedSeed=std::round(result.x)!=0||std::round(result.y)!=0;
            // A sub-grid shake may not survive the coarse texture/uniqueness
            // gate. Still attempt a bounded +/-8 SOURCE-pixel search around zero;
            // only full-resolution agreement may authorize a correction.
            dispatch(refineShader.Get(),input,&previousFull,matches,48,{result.x,result.y});
            result=consensus(true);
            if(displacedSeed) {
                // Sparse coarse sampling can alias repeating 4K texture into a
                // wrong distant basin. Verify an independent near-zero basin at
                // SOURCE resolution without losing legitimate fast-pan motion.
                dispatch(refineShader.Get(),input,&previousFull,matches,48);
                auto alternative=consensus(true);++alternateRefinements;
                auto choice=chooseFullResolutionMotion(result,alternative);
                if(choice.candidate==1)++nearZeroWins;
                if(choice.candidate<0&&result.confidence>0&&alternative.confidence>0)++ambiguousPairs;
                result=choice.motion;
            }
            if(result.confidence>0)maxAcceptedMotionPixels=std::max(maxAcceptedMotionPixels,std::max(std::abs(result.x),std::abs(result.y)));
        } else { wait(); }
        context->CopyResource(previousAnalysis.buffer.Get(),currentAnalysis.buffer.Get());
        context->CopyResource(previousFull.buffer.Get(),input.buffer.Get());
        motionMilliseconds+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();return result;
    }
    std::vector<uint8_t> warp(const std::vector<uint8_t>& bytes,Correction shift,double crop) {
        auto started=std::chrono::steady_clock::now();
        if(crop<0||crop>0.1||!std::isfinite(shift.x)||!std::isfinite(shift.y)) throw std::runtime_error("Invalid warp policy");
        // Leave four LUMA pixels for the cubic footprint of both Y and half-size
        // chroma. A two-luma-pixel guard is insufficient for 4:2:0 cubic sampling.
        // Identity is used only
        // by tests; production always has a fixed crop margin.
        if(crop>0) {shift.x=std::clamp(shift.x,-std::max(0.,crop*width-4),std::max(0.,crop*width-4));shift.y=std::clamp(shift.y,-std::max(0.,crop*height-4),std::max(0.,crop*height-4));}
        upload(bytes);dispatch(warpShader.Get(),input,nullptr,output,(size/4+63)/64,shift,crop);
        context->CopyResource(pixelReadback.Get(),output.buffer.Get());wait();
        D3D11_MAPPED_SUBRESOURCE map{};check(context->Map(pixelReadback.Get(),0,D3D11_MAP_READ,0,&map),"Read transformed pixels");
        std::vector<uint8_t> result(size);std::copy_n(static_cast<uint8_t*>(map.pData),size,result.data());context->Unmap(pixelReadback.Get(),0);readbacks+=size;
        warpMilliseconds+=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count();return result;
    }
};
