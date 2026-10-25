#pragma once
namespace subject_finishing {
// Integer reference, independently versioned from AMD CAS/RCAS and YUV filters.
constexpr const char* sharpenShader = R"hlsl(
cbuffer Recipe : register(b0) { uint width; uint height; int gain256; int threshold16; };
StructuredBuffer<uint> picture : register(t0);
StructuredBuffer<uint> subject : register(t1);
RWStructuredBuffer<uint> finished : register(u0);
int3 rgb(uint p) { return int3(p & 255, (p >> 8) & 255, (p >> 16) & 255); }
int level(uint p) { int3 v = rgb(p); return (54*v.r + 183*v.g + 19*v.b + 128) / 256; }
int roundDiv(int v, int d) { return v < 0 ? -((-v + d/2) / d) : (v + d/2) / d; }
[numthreads(16, 16, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    if (id.x >= width || id.y >= height) return;
    uint index = id.y * width + id.x;
    uint original = picture[index];
    finished[index] = original;
    if (gain256 == 0 || id.x == 0 || id.y == 0 || id.x+1 == width || id.y+1 == height || subject[index] <= 240) return;
    int minAlpha = 255, opaqueAlpha = 255, minimum = 255, maximum = 0, weighted = 0;
    [unroll] for (int dy = -1; dy <= 1; ++dy) {
        [unroll] for (int dx = -1; dx <= 1; ++dx) {
            uint neighbour = (int(id.y)+dy)*width + int(id.x)+dx;
            int v = level(picture[neighbour]);
            minimum = min(minimum, v); maximum = max(maximum, v);
            minAlpha = min(minAlpha, int(subject[neighbour]));
            opaqueAlpha = min(opaqueAlpha, int(picture[neighbour] >> 24));
            weighted += (dy == 0 ? 2 : 1) * (dx == 0 ? 2 : 1) * v;
        }
    }
    if (minAlpha <= 240 || opaqueAlpha != 255 || maximum-minimum <= 4) return;
    int centre = level(original), residual = 16*centre-weighted;
    int magnitude = max(0, abs(residual)-threshold16);
    int d = clamp(roundDiv((residual < 0 ? -magnitude : magnitude)*gain256, 256), -48, 48);
    d = roundDiv(d*clamp((maximum-minimum-4)*32, 0, 256), 256);
    d = roundDiv(d*((minAlpha-240)*256/15), 256);
    int3 pixel = rgb(original);
    int lower = max(minimum-centre, -min(pixel.r, min(pixel.g, pixel.b)));
    int upper = min(maximum-centre, 255-max(pixel.r, max(pixel.g, pixel.b)));
    int delta = clamp(roundDiv(d, 16), lower, upper);
    pixel += delta;
    finished[index] = (original & 0xff000000) | uint(pixel.r) | (uint(pixel.g)<<8) | (uint(pixel.b)<<16);
}
)hlsl";
constexpr const char* colourShader = R"hlsl(
cbuffer ColourRecipe : register(b0) {
    uint width; uint height; uint wholeFrameEnabled; uint reserved;
    float4 subjectGrade; float4 wholeFrameGrade;
};
StructuredBuffer<uint> picture : register(t0);
StructuredBuffer<uint> subject : register(t1);
RWStructuredBuffer<uint> finished : register(u0);
float decode709(float v) { return v < 0.081 ? v/4.5 : pow((v+0.099)/1.099, 1.0/0.45); }
float encode709(float v) { return v < 0.018 ? v*4.5 : 1.099*pow(v, 0.45)-0.099; }
float3 gradeRgb(float3 display, float4 grade) {
    if (all(grade == float4(0, 1, 1, 0))) return display;
    float3 radiance = float3(decode709(display.r), decode709(display.g), decode709(display.b));
    float gain = exp2(grade.x), peak = max(radiance.r, max(radiance.g, radiance.b));
    radiance *= gain/(1+(gain-1)*peak);
    float before = dot(radiance, float3(0.2126, 0.7152, 0.0722));
    radiance.r *= exp2(grade.w); radiance.b *= exp2(-grade.w);
    float after = dot(radiance, float3(0.2126, 0.7152, 0.0722));
    float balance = after > 0 ? before/after : 1.0;
    float gamut = max(1.0, max(radiance.r, max(radiance.g, radiance.b))*balance);
    radiance = max(0.0, radiance*balance/gamut);
    display = saturate(float3(encode709(radiance.r), encode709(radiance.g), encode709(radiance.b)));
    if (grade.y != 1) {
        [unroll] for (int channel = 0; channel < 3; ++channel) {
            float value = display[channel];
            display[channel] = value <= 0.5 ? 0.5*pow(2*value, grade.y) : 1-0.5*pow(2*(1-value), grade.y);
        }
    }
    float grey = dot(display, float3(0.2126, 0.7152, 0.0722));
    float saturation = grade.z;
    [unroll] for (int channel = 0; channel < 3; ++channel) {
        float chroma = display[channel]-grey;
        if (chroma > 0) saturation = min(saturation, (1-grey)/chroma);
        else if (chroma < 0) saturation = min(saturation, -grey/chroma);
    }
    return saturate(grey+(display-grey)*saturation);
}
[numthreads(16, 16, 1)]
void main(uint3 id : SV_DispatchThreadID) {
    if (id.x >= width || id.y >= height) return;
    uint index = id.y*width+id.x, original = picture[index];
    uint weight = subject[index];
    if ((original >> 24) != 255 ||
        ((!wholeFrameEnabled || all(wholeFrameGrade == float4(0, 1, 1, 0))) &&
            (weight == 0 || all(subjectGrade == float4(0, 1, 1, 0))))) {
        finished[index] = original; return;
    }
    float3 display = float3(original & 255, (original >> 8) & 255, (original >> 16) & 255)/255.0;
    if (wholeFrameEnabled) display = gradeRgb(display, wholeFrameGrade);
    if (weight != 0 && !all(subjectGrade == float4(0, 1, 1, 0))) {
        float3 candidate = gradeRgb(display, subjectGrade);
        display += (candidate-display)*(float(weight)/255.0);
    }
    uint3 value = uint3(floor(saturate(display)*255.0+0.5));
    finished[index] = (original & 0xff000000) | value.r | (value.g<<8) | (value.b<<16);
}
)hlsl";
} // namespace subject_finishing
