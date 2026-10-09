#include "core.h"
#include "pipeline.h"
#include <iostream>
#include <random>
std::vector<uint8_t> fixture(uint32_t w,uint32_t h,int dx=0,int dy=0,bool flat=false,bool subject=false) {
    std::vector<uint8_t> data(size_t(w)*h*3/2,128);
    // Texture cells align with the analysis grid for a deterministic motion
    // oracle. The moving central subject negative control has flat periphery.
    for(uint32_t y=0;y<h;++y) for(uint32_t x=0;x<w;++x) {
        int sx=int(x)-dx,sy=int(y)-dy;bool centre=x>w/4&&x<3*w/4&&y>h/4&&y<3*h/4;
        uint32_t value=uint32_t(sx/4)*73856093u^uint32_t(sy/4)*19349663u;
        value^=value>>13;value*=1274126177u;value^=value>>16;
        data[size_t(y)*w+x]=(flat||subject&&!centre)?100:uint8_t(32+value%192);
    }
    if(!flat&&!subject) for(uint32_t y=0;y<h/2;++y)for(uint32_t x=0;x<w/2;++x) {
        uint32_t value=uint32_t(int(x)-dx/2)*73856093u^uint32_t(int(y)-dy/2)*19349663u;
        data[size_t(w)*h+size_t(y)*w/2+x]=uint8_t(32+value%192);
        data[size_t(w)*h*5/4+size_t(y)*w/2+x]=uint8_t(32+(value>>8)%192);
    }
    return data;
}
void require(bool condition,const char* message) {if(!condition) throw std::runtime_error(message);}
uint8_t referenceSample(const std::vector<uint8_t>& bytes,uint32_t offset,uint32_t w,uint32_t h,float px,float py) {
    auto weight=[](float a){a=std::abs(a);if(a<1)return 1.5f*a*a*a-2.5f*a*a+1;if(a<2)return -0.5f*a*a*a+2.5f*a*a-4*a+2;return 0.f;};
    int bx=int(std::floor(px)),by=int(std::floor(py));float sum=0;
    for(int y=-1;y<=2;++y)for(int x=-1;x<=2;++x)sum+=bytes[offset+std::clamp(by+y,0,int(h)-1)*w+std::clamp(bx+x,0,int(w)-1)]*weight(px-bx-x)*weight(py-by-y);
    return uint8_t(std::clamp(std::floor(sum+0.5f),0.f,255.f));
}
void selfTest() {
    Gpu gpu(640,360);auto original=fixture(640,360);
    require(gpu.warp(original,{},0)==original,"Identity pixels differ");
    gpu.analyse(original,true);Motion moved=gpu.analyse(fixture(640,360,6,-4),false);
    require(moved.confidence>0 && std::abs(moved.x-6)<0.15 && std::abs(moved.y+4)<0.15,"Known global translation was not recovered");
    auto corrected=gpu.warp(fixture(640,360,6,-4),{6,-4},0);
    for(uint32_t y=8;y<352;++y)for(uint32_t x=8;x<632;++x)require(corrected[y*640+x]==original[y*640+x],"Nonzero warp has wrong translation sign or units");
    for(uint32_t plane=0;plane<2;++plane)for(uint32_t y=4;y<176;++y)for(uint32_t x=4;x<316;++x) {
        size_t index=640*360+plane*320*180+y*320+x;require(corrected[index]==original[index],"Chroma does not follow half-luma translation");
    }
    for(int displacement:{-4,-1,1,4}) {
        gpu.analyse(original,true);auto fineMotion=gpu.analyse(fixture(640,360,displacement,-displacement),false);
        std::cerr<<"Small-shake control "<<displacement<<": x="<<fineMotion.x<<", y="<<fineMotion.y<<", confidence="<<fineMotion.confidence<<"\n";
        require(fineMotion.confidence>0&&std::abs(fineMotion.x-displacement)<0.25&&std::abs(fineMotion.y+displacement)<0.25,"Small-shake sign or full-resolution refinement failed");
    }
    auto flat=fixture(640,360,0,0,true);gpu.analyse(flat,true);
    require(gpu.analyse(flat,false).confidence==0,"Flat background must not produce a confident camera estimate");
    gpu.analyse(fixture(640,360,0,0,false,true),true);
    require(gpu.analyse(fixture(640,360,6,-4,false,true),false).confidence==0,"Moving subject with flat periphery must be rejected");
    auto constant=std::vector<uint8_t>(gpu.frameSize(),100);
    auto borders=gpu.warp(constant,{1000,-1000},0.04);
    require(std::all_of(borders.begin(),borders.end(),[](uint8_t v){return v==100;}),"Crop border guard introduced invalid pixels");
    for(double edgeCrop:{0.04,0.06})for(double sign:{-1.,1.}) {
        Correction limit{sign*(edgeCrop*640-4),sign*(edgeCrop*360-4)};
        auto transformed=gpu.warp(original,limit,edgeCrop);
        for(uint32_t plane=0;plane<3;++plane) {
            uint32_t w=plane?320:640,h=plane?180:360,offset=plane?640*360+(plane-1)*320*180:0;
            for(uint32_t y:{0u,1u,h/2,h-2,h-1})for(uint32_t x:{0u,1u,w/2,w-2,w-1}) {
                float px=float(x),py=float(y);if(plane){px=px*2+0.5f;py=py*2+0.5f;}
                px=(px-319.5f)*float(1-2*edgeCrop)+319.5f+float(limit.x);
                py=(py-179.5f)*float(1-2*edgeCrop)+179.5f+float(limit.y);
                if(plane){px=(px-0.5f)/2;py=(py-0.5f)/2;}
                require(std::floor(px)>=1&&std::floor(py)>=1&&std::floor(px)+2<float(w)&&std::floor(py)+2<float(h),"Crop cubic footprint touches an invalid plane edge");
                auto expected=referenceSample(original,offset,w,h,px,py);
                require(std::abs(int(transformed[offset+y*w+x])-int(expected))<=1,"Colored crop edge disagrees with cubic reference");
            }
        }
    }
    auto fractional=gpu.warp(original,{1,-1},0);
    for(uint32_t plane=1;plane<3;++plane)for(uint32_t y=8;y<172;y+=17)for(uint32_t x=8;x<312;x+=19) {
        uint32_t offset=640*360+(plane-1)*320*180;
        require(std::abs(int(fractional[offset+y*320+x])-int(referenceSample(original,offset,320,180,float(x)+0.5f,float(y)-0.5f)))<=1,"Odd-luma displacement misaligns fractional chroma");
    }
    std::deque<PathFrame> shortFrames;
    for(uint64_t i=0;i<3;++i) shortFrames.push_back({i,double(i)*4,double(i)*-3,1,0,{}});
    for(size_t i=0;i<shortFrames.size();++i) {auto c=smoothCorrection(shortFrames,i,8,1);require(std::abs(c.x)<1e-6&&std::abs(c.y)<1e-6,"Short-window tail changed a deliberate linear pan");}
    std::deque<PathFrame> cuts;
    for(uint64_t i=0;i<20;++i)cuts.push_back({i,i<10?double(i)*3:double(i-10)*-5,0,1,i<10?0u:1u,{}});
    for(size_t i=0;i<cuts.size();++i)require(std::abs(smoothCorrection(cuts,i,8,1).x)<1e-6,"Smoothing bridged a discontinuous segment/cut");
    CorrectionLimiter transition;transition.applied={12,-9};auto decayed=transition.next({},2);
    require(decayed.x==10&&decayed.y==-7,"Uncertain motion snapped the correction instead of bounded decay");
    require(correctionStepLimit(1280,0)==1&&correctionStepLimit(1280,0.5)==2&&correctionStepLimit(1280,1)==3,"Confidence-dependent correction limits differ");
    CorrectionLimiter tracking;auto fast=tracking.next({4,-4},correctionStepLimit(1280,1));
    require(fast.x==3&&fast.y==-3,"Trusted shake is clipped by the uncertain-motion limit");
    auto loss=tracking.next({},correctionStepLimit(1280,0));
    require(loss.x==2&&loss.y==-2,"Confidence loss must retain slow bounded decay");
    auto recovered=tracking.next({-8,8},correctionStepLimit(1280,1));
    require(recovered.x==-1&&recovered.y==1,"Confidence recovery exceeded the bounded trusted-motion step");
    auto candidate=[](double x,float residual){Motion m;m.x=x;m.confidence=1;m.meanSad=residual;m.residuals.fill(residual);
        for(unsigned i=0;i<48;++i)if(!(i%8>=2&&i%8<=5&&i/8>=1&&i/8<=4))m.supportMask|=uint64_t(1)<<i;return m;};
    require(chooseFullResolutionMotion(candidate(24,12),candidate(3,1)).candidate==1,"Near-zero lower source-resolution residual did not win");
    require(chooseFullResolutionMotion(candidate(24,1),candidate(3,12)).candidate==0,"Fast-pan lower source-resolution residual did not win");
    require(chooseFullResolutionMotion(candidate(24,3),candidate(0,3.5f)).motion.confidence==0,"Near-tied repeating-texture basins must be ambiguous");
    require(chooseFullResolutionMotion({},{}).motion.confidence==0,"Neither valid candidate must remain uncertain");
    auto sparse=candidate(0,0);sparse.supportMask=3;
    require(chooseFullResolutionMotion(candidate(24,12),sparse).motion.confidence==0,"Small easy subset bypassed comparable-support gate");
    Gpu uhd(3840,2160);auto large=fixture(3840,2160);uhd.analyse(large,true);
    auto tiny=uhd.analyse(fixture(3840,2160,1,-1),false);
    require(tiny.confidence>0&&std::abs(tiny.x-1)<0.25&&std::abs(tiny.y+1)<0.25,"UHD small-shake refinement failed");
    for(int displacement:{-24,-12,12,24}) {
        uhd.analyse(large,true);auto pan=uhd.analyse(fixture(3840,2160,displacement,-displacement/2),false);
        require(pan.confidence>0&&std::abs(pan.x-displacement)<0.25&&std::abs(pan.y+displacement/2.)<0.25,"UHD fast translation was lost to near-zero verification");
    }
    std::cout<<"{\"engine\":"<<jsonString(kEngine)<<",\"adapter\":"<<jsonString(gpu.adapter)<<",\"identityPixels\":true,\"knownTranslation\":true,\"flatBackground\":true,\"foregroundNegativeControl\":true,\"fixedCropBorders\":true,\"chromaAlignment\":true,\"coloredCropOracle\":true,\"segmentIsolation\":true,\"shortWindowTail\":true}\n";
}
int wmain(int argc,wchar_t** argv) {
    try {
        if(argc==2&&std::wstring(argv[1])==L"--probe") {
            Gpu gpu(640,360);auto bytes=fixture(640,360);require(gpu.warp(bytes,{},0)==bytes,"Hardware pixel probe failed");
            std::cout<<"{\"engine\":"<<jsonString(kEngine)<<",\"hardware\":true,\"adapter\":"<<jsonString(gpu.adapter)<<",\"vendorId\":"<<gpu.vendor<<",\"deviceId\":"<<gpu.deviceId<<",\"featureLevel\":\"11_0\",\"pixelFormat\":\"yuv420p8\"}\n";return 0;
        }
        if(argc==2&&std::wstring(argv[1])==L"--self-test") {selfTest();return 0;}
        if(argc>=2&&std::wstring(argv[1])==L"--render") {render(parseOptions(argc,argv));return 0;}
        throw std::runtime_error("Usage: photogogo-gpu-tripod --probe | --self-test | --render [bounded options]");
    } catch(const std::exception& e) {std::cerr<<"GPU Tripod: "<<e.what()<<"\n";return 1;}
}
