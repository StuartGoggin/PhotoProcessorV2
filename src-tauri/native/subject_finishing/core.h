#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cmath>
#include <future>
#include <stdexcept>
#include <vector>

namespace subject_finishing {
struct Rgba {
    uint8_t r, g, b, a;
    bool operator==(const Rgba& other) const {
        return r == other.r && g == other.g && b == other.b && a == other.a;
    }
};
static_assert(sizeof(Rgba) == 4, "Packed RGBA frame contract");
struct Frame {
    uint32_t width, height;
    std::vector<Rgba> pixels;
};
struct Sharpness {
    int gain256 = 26;
    int threshold16 = 32;
};

// Rec.709 encoded RGB, full-range bytes. This is not a Log/PQ processing profile.
inline int luma(Rgba pixel) {
    return (54 * int(pixel.r) + 183 * int(pixel.g) + 19 * int(pixel.b) + 128) / 256;
}
inline int round_div(int value, int divisor) {
    return value < 0 ? -((-value + divisor / 2) / divisor) : (value + divisor / 2) / divisor;
}

inline void validate(const Frame& source, const std::vector<uint8_t>& mask, Sharpness settings) {
    if (source.width == 0 || source.height == 0 || source.width > 8192 || source.height > 8192 ||
        uint64_t(source.width) * source.height > 33554432 ||
        uint64_t(source.width) * source.height != source.pixels.size() || mask.size() != source.pixels.size()) {
        throw std::invalid_argument("Invalid bounded finishing frame or mask dimensions");
    }
    if (settings.gain256 < 0 || settings.gain256 > 128 || settings.threshold16 < 32 || settings.threshold16 > 128) {
        throw std::invalid_argument("Invalid bounded finishing sharpening parameters");
    }
}

// The caller owns the budget. No detached work, hardware-wide pool or per-thread frame copies.
template<class Function>
inline void picture_rows(uint32_t height, uint32_t workers, Function work) {
    if (!workers || workers > 8) throw std::invalid_argument("Invalid bounded CPU picture budget");
    workers = std::min(workers, height);
    if (workers <= 1) { work(0, height); return; }
    std::vector<std::future<void>> pending;
    pending.reserve(workers - 1);
    for (uint32_t part = 1; part < workers; ++part) {
        const auto first = uint32_t(uint64_t(height) * part / workers);
        const auto last = uint32_t(uint64_t(height) * (part + 1) / workers);
        pending.push_back(std::async(std::launch::async, [&, first, last] { work(first, last); }));
    }
    // Future destruction joins outstanding work even if launch/work/get throws.
    work(0, height / workers);
    for (auto& task : pending) task.get();
}

inline Frame sharpen(const Frame& source, const std::vector<uint8_t>& mask, Sharpness settings, uint32_t workers = 1) {
    validate(source, mask, settings);
    if (!workers || workers > 8) throw std::invalid_argument("Invalid bounded CPU picture budget");
    Frame result = source;
    if (settings.gain256 == 0 || source.width < 3 || source.height < 3) return result;
    constexpr int gaussian[3] = {1, 2, 1};
    picture_rows(source.height, workers, [&](uint32_t first, uint32_t last) {
    for (uint32_t y = std::max(uint32_t(1), first); y < std::min(last, source.height - 1); ++y) {
        for (uint32_t x = 1; x + 1 < source.width; ++x) {
            const size_t index = size_t(y) * source.width + x;
            if (mask[index] <= 240) continue;
            int minAlpha = 255, opaqueAlpha = 255, minimum = 255, maximum = 0, weighted = 0;
            for (int dy = -1; dy <= 1; ++dy) {
                for (int dx = -1; dx <= 1; ++dx) {
                    const size_t neighbour = size_t(int(y) + dy) * source.width + (int(x) + dx);
                    const int level = luma(source.pixels[neighbour]);
                    minimum = std::min(minimum, level);
                    maximum = std::max(maximum, level);
                    minAlpha = std::min(minAlpha, int(mask[neighbour]));
                    opaqueAlpha = std::min(opaqueAlpha, int(source.pixels[neighbour].a));
                    weighted += gaussian[dy + 1] * gaussian[dx + 1] * level;
                }
            }
            // Never read across the uncertain silhouette for an active sharpener.
            if (minAlpha <= 240 || opaqueAlpha != 255 || maximum - minimum <= 4) continue;
            const Rgba pixel = source.pixels[index];
            const int centre = luma(pixel);
            const int residual = 16 * centre - weighted;
            const int magnitude = std::max(0, std::abs(residual) - settings.threshold16);
            const int thresholded = residual < 0 ? -magnitude : magnitude;
            int detail16 = std::clamp(round_div(thresholded * settings.gain256, 256), -48, 48);
            detail16 = round_div(detail16 * std::clamp((maximum - minimum - 4) * 32, 0, 256), 256);
            detail16 = round_div(detail16 * ((minAlpha - 240) * 256 / 15), 256);
            const int lower = std::max(minimum - centre, -std::min({int(pixel.r), int(pixel.g), int(pixel.b)}));
            const int upper = std::min(maximum - centre, 255 - std::max({int(pixel.r), int(pixel.g), int(pixel.b)}));
            const int delta = std::clamp(round_div(detail16, 16), lower, upper);
            result.pixels[index] = Rgba{
                uint8_t(int(pixel.r) + delta), uint8_t(int(pixel.g) + delta),
                uint8_t(int(pixel.b) + delta), pixel.a,
            };
        }
    }
    });
    return result;
}

struct Colour {
    float lightEv = 0;
    float contrast = 1;
    float saturation = 1;
    float warmth = 0;
    bool neutral() const {
        return lightEv == 0 && contrast == 1 && saturation == 1 && warmth == 0;
    }
};
struct Finishing {
    Sharpness sharpness;
    Colour subject, wholeFrame;
    bool wholeFrameEnabled = false;
};

inline void validate_colour(Colour colour) {
    if (!std::isfinite(colour.lightEv) || colour.lightEv < -1.5f || colour.lightEv > 1.5f ||
        !std::isfinite(colour.contrast) || colour.contrast < 0.75f || colour.contrast > 1.25f ||
        !std::isfinite(colour.saturation) || colour.saturation < 0 || colour.saturation > 1.4f ||
        !std::isfinite(colour.warmth) || colour.warmth < -0.25f || colour.warmth > 0.25f) {
        throw std::invalid_argument("Invalid bounded finishing colour parameters");
    }
}
inline float decode709(float value) {
    return value < 0.081f ? value/4.5f : std::pow((value+0.099f)/1.099f, 1.0f/0.45f);
}
inline float encode709(float value) {
    return value < 0.018f ? value*4.5f : 1.099f*std::pow(value, 0.45f)-0.099f;
}
using WorkingRgb = std::array<float, 3>;
inline WorkingRgb grade_rgb(WorkingRgb display, Colour colour) {
    if (colour.neutral()) return display;
    WorkingRgb radiance = {decode709(display[0]), decode709(display[1]), decode709(display[2])};
    const float gain = std::exp2(colour.lightEv);
    // Endpoint-preserving, invertible midtone light trim. This is NOT a
    // scene-referred camera EV adjustment or recovery of clipped source data.
    const float peak = std::max({radiance[0], radiance[1], radiance[2]});
    const float light = gain / (1 + (gain - 1) * peak);
    for (float& channel : radiance) channel *= light;
    const float before = 0.2126f*radiance[0]+0.7152f*radiance[1]+0.0722f*radiance[2];
    radiance[0] *= std::exp2(colour.warmth);
    radiance[2] *= std::exp2(-colour.warmth);
    const float after = 0.2126f*radiance[0]+0.7152f*radiance[1]+0.0722f*radiance[2];
    const float balance = after > 0 ? before/after : 1;
    const float gamut = std::max(1.0f, std::max({radiance[0], radiance[1], radiance[2]}) * balance);
    for (int channel = 0; channel < 3; ++channel) {
        float value = std::clamp(encode709(std::max(0.0f, radiance[channel]*balance/gamut)), 0.0f, 1.0f);
        if (colour.contrast != 1) {
            value = value <= 0.5f ? 0.5f*std::pow(2*value, colour.contrast)
                : 1-0.5f*std::pow(2*(1-value), colour.contrast);
        }
        display[channel] = value;
    }
    const float grey = 0.2126f*display[0]+0.7152f*display[1]+0.0722f*display[2];
    float saturation = colour.saturation;
    for (int channel = 0; channel < 3; ++channel) {
        const float chroma = display[channel]-grey;
        if (chroma > 0) saturation = std::min(saturation, (1-grey)/chroma);
        else if (chroma < 0) saturation = std::min(saturation, -grey/chroma);
    }
    for (float& channel : display) channel = std::clamp(grey+(channel-grey)*saturation, 0.0f, 1.0f);
    return display;
}
inline Rgba pack_rgb(WorkingRgb pixel, uint8_t alpha) {
    return Rgba{
        uint8_t(std::floor(std::clamp(pixel[0], 0.0f, 1.0f)*255+0.5f)),
        uint8_t(std::floor(std::clamp(pixel[1], 0.0f, 1.0f)*255+0.5f)),
        uint8_t(std::floor(std::clamp(pixel[2], 0.0f, 1.0f)*255+0.5f)), alpha,
    };
}
inline Frame finish(const Frame& source, const std::vector<uint8_t>& mask, Finishing settings, uint32_t workers = 1) {
    validate(source, mask, settings.sharpness);
    validate_colour(settings.subject);
    validate_colour(settings.wholeFrame);
    Frame graded = source;
    picture_rows(source.height, workers, [&](uint32_t first, uint32_t last) {
    for (size_t index = size_t(first) * source.width; index < size_t(last) * source.width; ++index) {
        const Rgba original = source.pixels[index];
        if (original.a != 255 ||
            ((!settings.wholeFrameEnabled || settings.wholeFrame.neutral()) &&
                (mask[index] == 0 || settings.subject.neutral()))) continue;
        WorkingRgb pixel = {float(original.r)/255, float(original.g)/255, float(original.b)/255};
        if (settings.wholeFrameEnabled) pixel = grade_rgb(pixel, settings.wholeFrame);
        if (mask[index] != 0 && !settings.subject.neutral()) {
            const auto candidate = grade_rgb(pixel, settings.subject);
            const float weight = float(mask[index])/255;
            for (int channel = 0; channel < 3; ++channel) pixel[channel] += (candidate[channel]-pixel[channel])*weight;
        }
        graded.pixels[index] = pack_rgb(pixel, original.a);
    }
    });
    return sharpen(graded, mask, settings.sharpness, workers);
}
} // namespace subject_finishing
