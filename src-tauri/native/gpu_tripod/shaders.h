#pragma once
// Original, translation-only kernels. Raw YUV never shares a UAV word between
// threads: each invocation produces one aligned four-byte output word.
inline constexpr char kShaders[] = R"hlsl(
cbuffer Parameters : register(b0) {
    uint width, height, analysisWidth, analysisHeight;
    float shiftX, shiftY, crop, unused;
};
ByteAddressBuffer source : register(t0);
ByteAddressBuffer previous : register(t1);
RWByteAddressBuffer target : register(u0);
uint byteAt(ByteAddressBuffer b, uint address) {
    return (b.Load(address & ~3u) >> ((address & 3u) * 8u)) & 255u;
}
[numthreads(64,1,1)]
void Downsample(uint3 id : SV_DispatchThreadID) {
    uint first = id.x * 4;
    if (first >= analysisWidth * analysisHeight) return;
    uint packed = 0;
    [unroll] for (uint lane = 0; lane < 4; ++lane) {
        uint n = first + lane, x = n % analysisWidth, y = n / analysisWidth;
        float2 step = float2(width, height) / float2(analysisWidth, analysisHeight);
        float sum = 0;
        [unroll] for (uint sy=0;sy<4;++sy) [unroll] for (uint sx=0;sx<4;++sx) {
            uint2 p = min(uint2((float2(x,y) + (float2(sx,sy)+0.5)/4) * step), uint2(width-1,height-1));
            sum += byteAt(source, p.y*width+p.x);
        }
        packed |= uint(sum / 16 + 0.5) << (lane*8);
    }
    target.Store(first, packed);
}
groupshared float costs[289];
void blockMatch(uint groupIndex, uint thread, bool high) {
    uint bx = groupIndex % 8, by = groupIndex / 8;
    uint mw=high?width:analysisWidth, mh=high?height:analysisHeight;
    int2 centre = int2((bx+0.5)*mw/8, (by+0.5)*mh/6);
    int2 initial=high ? int2(round(float2(shiftX,shiftY))) : int2(0,0);
    // Do not use the central subject as a camera reference. This is a spatial
    // confidence heuristic, not semantic horse/person recognition.
    bool central = bx>=2 && bx<=5 && by>=1 && by<=4;
    for (uint candidate=thread;candidate<289;candidate+=64) {
        int2 delta = int2(candidate%17, candidate/17)-8+initial;
        float cost = 0;
        [loop] for (int y=-6;y<6;++y) [loop] for (int x=-6;x<6;++x) {
            int2 p=centre+int2(x,y), q=p+delta;
            // Reject samples outside the luma plane rather than accidentally
            // wrapping into another row/chroma plane during an extreme search.
            if(any(p<0)||any(q<0)||p.x>=int(mw)||q.x>=int(mw)||p.y>=int(mh)||q.y>=int(mh)) cost+=10000;
            else cost += abs(float(byteAt(previous,p.y*mw+p.x))-float(byteAt(source,q.y*mw+q.x)));
        }
        costs[candidate]=cost/144;
    }
    GroupMemoryBarrierWithGroupSync();
    if (thread==0) {
        uint best=0;
        [loop] for(uint c=1;c<289;++c) if(costs[c]<costs[best]) best=c;
        int2 delta=int2(best%17,best/17)-8;
        float second=1000, mean=0, variance=0;
        [loop] for(uint c=0;c<289;++c) {
            int2 d=int2(c%17,c/17)-8;
            if(max(abs(d.x-delta.x),abs(d.y-delta.y))>1) second=min(second,costs[c]);
        }
        [loop] for(int y=-6;y<6;++y) [loop] for(int x=-6;x<6;++x) {
            int2 p=centre+int2(x,y);
            float v=byteAt(previous,p.y*mw+p.x); mean+=v; variance+=v*v;
        }
        variance=max(0,variance/144-(mean/144)*(mean/144));
        float unique=(second-costs[best])/(second+1);
        bool valid=!central && variance>=36 && costs[best]<15 && unique>0.12 && max(abs(delta.x),abs(delta.y))<8;
        float2 subpixel=0;
        if(valid) {
            float denominatorX=costs[best-1]-2*costs[best]+costs[best+1];
            float denominatorY=costs[best-17]-2*costs[best]+costs[best+17];
            if(denominatorX>0.1) subpixel.x=clamp(0.5*(costs[best-1]-costs[best+1])/denominatorX,-0.5,0.5);
            if(denominatorY>0.1) subpixel.y=clamp(0.5*(costs[best-17]-costs[best+17])/denominatorY,-0.5,0.5);
        }
        target.Store4(groupIndex*16,asuint(float4(float2(delta+initial)+subpixel, costs[best], valid ? 1 : 0)));
    }
}
[numthreads(64,1,1)]
void Match(uint3 group : SV_GroupID, uint thread : SV_GroupIndex) { blockMatch(group.x,thread,false); }
[numthreads(64,1,1)]
void Refine(uint3 group : SV_GroupID, uint thread : SV_GroupIndex) { blockMatch(group.x,thread,true); }
float cubic(float x) {
    x=abs(x);
    if(x<1) return 1.5*x*x*x-2.5*x*x+1;
    if(x<2) return -0.5*x*x*x+2.5*x*x-4*x+2;
    return 0;
}
uint samplePlane(uint offset,uint w,uint h,float2 p) {
    int2 base=int2(floor(p)); float sum=0;
    [unroll] for(int y=-1;y<=2;++y) [unroll] for(int x=-1;x<=2;++x) {
        int2 q=clamp(base+int2(x,y),int2(0,0),int2(w-1,h-1));
        sum+=byteAt(source,offset+q.y*w+q.x)*cubic(p.x-base.x-x)*cubic(p.y-base.y-y);
    }
    return uint(clamp(floor(sum+0.5),0,255));
}
[numthreads(64,1,1)]
void Warp(uint3 id : SV_DispatchThreadID) {
    uint first=id.x*4, size=width*height, chroma=size/4;
    if(first>=size+chroma*2) return;
    uint packed=0;
    [unroll] for(uint lane=0;lane<4;++lane) {
        uint n=first+lane, offset=0, w=width,h=height; bool colour=n>=size;
        if(colour) { offset=n<size+chroma ? size : size+chroma; w/=2;h/=2; }
        uint local=n-offset; float2 p=float2(local%w,local/w);
        float2 centre=float2(width-1,height-1)/2;
        if(colour) p=p*2+0.5;
        p=(p-centre)*(1-2*crop)+centre+float2(shiftX,shiftY);
        if(colour) p=(p-0.5)/2;
        packed|=samplePlane(offset,w,h,p)<<(lane*8);
    }
    target.Store(first,packed);
}
)hlsl";
