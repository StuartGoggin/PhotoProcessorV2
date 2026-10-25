#include "gpu.h"
#include "mask_cache.h"
#include "media_pipeline.h"
#include <charconv>
#include <chrono>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <memory>

using namespace subject_finishing;

std::string json_string(const std::string& input) {
    std::string result = "\"";
    constexpr char digits[] = "0123456789abcdef";
    for (unsigned char c : input) {
        if (c == '"' || c == '\\') { result += '\\'; result += char(c); }
        else if (c < 32) { result += "\\u00"; result += digits[c >> 4]; result += digits[c & 15]; }
        else result += char(c);
    }
    return result + '"';
}

std::string name(const GpuSharpener& gpu) {
    const auto* source = gpu.adapterDescription.Description;
    const int length = WideCharToMultiByte(CP_UTF8, 0, source, -1, nullptr, 0, nullptr, nullptr);
    if (length <= 1) return "Unknown hardware adapter";
    std::string value(size_t(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, source, -1, value.data(), length, nullptr, nullptr);
    value.pop_back();
    return value;
}

uint32_t argument(const char* text, uint32_t maximum) {
    uint32_t value = 0;
    const auto length = std::strlen(text);
    const auto parsed = std::from_chars(text, text + length, value);
    if (length == 0 || parsed.ec != std::errc{} || parsed.ptr != text+length || value > maximum) {
        throw std::invalid_argument("Invalid bounded numeric worker argument");
    }
    return value;
}
float real_argument(const char* text) {
    float value = 0;
    const auto length = std::strlen(text);
    const auto parsed = std::from_chars(text, text+length, value);
    if (length == 0 || parsed.ec != std::errc{} || parsed.ptr != text+length || !std::isfinite(value)) {
        throw std::invalid_argument("Invalid bounded colour worker argument");
    }
    return value;
}

int self_test() {
    GpuSharpener gpu;
    uint32_t state = 29387, frames = 0;
    auto random = [&state]() { state = state*1664525u+1013904223u; return uint8_t(state >> 24); };
    constexpr uint32_t shapes[][2] = {{1, 1}, {2, 2}, {19, 23}, {64, 71}};
    for (const auto& shape : shapes) {
        Frame source{shape[0], shape[1], std::vector<Rgba>(shape[0]*shape[1])};
        std::vector<uint8_t> mask(source.pixels.size(), 255);
        for (size_t index = 0; index < source.pixels.size(); ++index) {
            source.pixels[index] = Rgba{random(), random(), random(), 255};
        }
        for (int mode = 0; mode < 3; ++mode) {
            if (mode == 1) {
                for (auto& alpha : mask) alpha = random();
                source.pixels[0].a = 128;
            }
            if (mode == 2) {
                std::fill(mask.begin(), mask.end(), uint8_t(255));
                source.pixels[0].a = 255;
            }
            const Sharpness settings{mode == 0 ? 0 : 128, 32};
            const Frame cpu = sharpen(source, mask, settings);
            const Frame hardware = gpu.filter(source, mask, settings);
            if (cpu.pixels != hardware.pixels) throw std::runtime_error("CPU/GPU subject pixel parity failed");
            ++frames;
        }
        for (int alpha = 241; alpha <= 255; ++alpha) {
            std::fill(mask.begin(), mask.end(), uint8_t(alpha));
            const Sharpness settings{128, 32};
            const auto cpu = sharpen(source, mask, settings);
            const auto hardware = gpu.filter(source, mask, settings);
            if (cpu.pixels != hardware.pixels) throw std::runtime_error("CPU/GPU inward fringe parity failed");
            ++frames;
        }
    }
    std::cout << "{\"schema\":1,\"engine\":\"subject-rgb709-q4-v2\",\"cpuGpuExact\":true,\"frames\":" << frames
        << ",\"adapter\":" << json_string(name(gpu)) << "}\n";
    return 0;
}

int filter(uint32_t width, uint32_t height, Finishing settings, uint32_t count, const std::string& backend,
    const std::filesystem::path& cachePath = {}) {
    if (count == 0 || width == 0 || height == 0 || uint64_t(width)*height > 33554432) {
        throw std::invalid_argument("Invalid bounded frame count or dimensions");
    }
    if (backend != "auto" && backend != "cpu" && backend != "gpu") throw std::invalid_argument("Invalid finishing backend");
    Frame source{width, height, std::vector<Rgba>(size_t(width)*height)};
    std::vector<uint8_t> mask(source.pixels.size());
    std::unique_ptr<MaskCache> cache;
    if(!cachePath.empty())cache=std::make_unique<MaskCache>(cachePath,count);
    validate(source, mask, settings.sharpness);
    validate_colour(settings.subject);
    validate_colour(settings.wholeFrame);
    std::unique_ptr<GpuSharpener> gpu;
    if (backend != "cpu") {
        try { gpu = std::make_unique<GpuSharpener>(); }
        catch (const std::exception& error) {
            if (backend == "gpu") throw;
            std::cerr << "{\"event\":\"cpuFallback\",\"reason\":" << json_string(error.what()) << "}\n";
        }
    }
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    const auto started = std::chrono::steady_clock::now();
    double filteringMs = 0;
    for (uint32_t frame = 0; frame < count; ++frame) {
        std::cin.read(reinterpret_cast<char*>(source.pixels.data()), std::streamsize(source.pixels.size()*sizeof(Rgba)));
        if (!std::cin) throw std::runtime_error("Truncated finishing picture stream");
        if(cache)mask=cache->next(width,height);
        else {
            std::cin.read(reinterpret_cast<char*>(mask.data()), std::streamsize(mask.size()));
            if (!std::cin) throw std::runtime_error("Truncated finishing subject-mask stream");
        }
        const auto filterStarted = std::chrono::steady_clock::now();
        const Frame result = gpu ? gpu->filter(source, mask, settings) : finish(source, mask, settings);
        filteringMs += std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-filterStarted).count();
        std::cout.write(reinterpret_cast<const char*>(result.pixels.data()), std::streamsize(result.pixels.size()*sizeof(Rgba)));
        if (!std::cout) throw std::runtime_error("Finishing output stream closed");
    }
    if (std::cin.peek() != std::char_traits<char>::eof()) throw std::runtime_error("Unexpected trailing finishing frame data");
    if(cache)cache->finish();
    std::cout.flush();
    if (!std::cout) throw std::runtime_error("Finishing output could not be flushed");
    const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-started).count();
    std::cerr << "{\"schema\":1,\"event\":\"finished\",\"frames\":" << count
        << ",\"backend\":" << json_string(gpu ? "d3d11" : "cpu")
        << ",\"filterAndTransferMs\":" << filteringMs << ",\"streamMs\":" << elapsed << "}\n";
    return 0;
}

int worker_main(int argc, char** argv) {
    try {
        if ((argc == 8 || argc == 9) && std::string(argv[1]) == "--mask-job") {
            const auto python=std::filesystem::u8path(argv[2]), script=std::filesystem::u8path(argv[3]);
            const auto request=std::filesystem::u8path(argv[4]), root=std::filesystem::u8path(argv[5]);
            const auto ffmpeg=std::filesystem::u8path(argv[6]);
            const auto seconds=argument(argv[7],86400);
            const auto threads=argc==9?argument(argv[8],8):8;
            for (const auto& path : {python,script,request,ffmpeg}) {
                if (!path.is_absolute() || !std::filesystem::is_regular_file(path))
                    throw std::invalid_argument("Mask owner requires exact local absolute file paths");
            }
            if (!seconds || !threads || !root.is_absolute() || !std::filesystem::is_directory(root)
                    || std::filesystem::file_size(request)>128*1024)
                throw std::invalid_argument("Invalid bounded local mask owner request");
            ChildGroup group;
            SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
            OwnedHandle input(CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,
                &security,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr));
            HANDLE outputCopy=nullptr;
            checked(DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_OUTPUT_HANDLE),GetCurrentProcess(),
                &outputCopy,0,TRUE,DUPLICATE_SAME_ACCESS),"Cannot duplicate mask progress output");
            OwnedHandle output(outputCopy);
            // Explicit CPU inference environment. Interpreter isolation alone
            // does not prevent Torch/sysconfig from reading user DLL paths.
            // Keep every writable scratch path outside the admitted import tree.
            std::array<wchar_t,32768> windowsDirectory{};
            const auto windowsLength=GetWindowsDirectoryW(windowsDirectory.data(),DWORD(windowsDirectory.size()));
            if(!windowsLength||windowsLength>=windowsDirectory.size())throw std::runtime_error("Cannot resolve authoritative Windows directory");
            const std::wstring windowsRoot(windowsDirectory.data(),windowsLength);
            const auto runtime=python.parent_path();
            std::vector<std::wstring> entries{
                L"HF_HUB_DISABLE_TELEMETRY=1",L"HF_HUB_OFFLINE=1",L"MKL_NUM_THREADS="+std::to_wstring(threads),
                L"NVTOOLSEXT_PATH="+runtime.wstring(),L"OMP_NUM_THREADS="+std::to_wstring(threads),
                L"PATH="+runtime.wstring()+L";"+(runtime/L"Lib/site-packages/torch/lib").wstring()+L";"+windowsRoot+L"\\System32",
                L"PYTHONUSERBASE="+runtime.wstring(),L"SystemRoot="+windowsRoot,
                L"TEMP="+request.parent_path().wstring(),L"TMP="+request.parent_path().wstring(),L"TRANSFORMERS_OFFLINE=1",L"windir="+windowsRoot};
            std::wstring environment;for(const auto& entry:entries){environment+=entry;environment+=L'\0';}environment+=L'\0';
            OwnedChild child(python.wstring(),{L"-I",L"-S",L"-B",L"-u",script.wstring(),L"--generate",request.wstring(),
                L"--runtime-root",root.wstring(),L"--ffmpeg",ffmpeg.wstring(),L"--threads",std::to_wstring(threads)},input.get(),output.get(),group.get(),
                environment,runtime.wstring());
            std::cerr << "{\"schema\":1,\"event\":\"maskJobStarted\",\"child\":" << child.id() << "}\n";
            const auto start=std::chrono::steady_clock::now();
            while (!child.exited()) {
                if (std::chrono::steady_clock::now()-start>std::chrono::seconds(seconds))
                    throw std::runtime_error("Mask job exceeded its bounded deadline");
                Sleep(25);
            }
            child.finish(0);
            std::cerr << "{\"schema\":1,\"event\":\"maskJobFinished\"}\n";
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--probe") {
            try {
                GpuSharpener gpu;
                std::cout << "{\"schema\":1,\"available\":true,\"backend\":\"d3d11\",\"engine\":\"subject-rgb709-q4-v2\",\"adapter\":"
                    << json_string(name(gpu)) << ",\"vendorId\":" << gpu.adapterDescription.VendorId
                    << ",\"dedicatedMiB\":" << gpu.adapterDescription.DedicatedVideoMemory/1048576 << "}\n";
            } catch (const std::exception& error) {
                std::cout << "{\"schema\":1,\"available\":false,\"reason\":" << json_string(error.what()) << "}\n";
            }
            return 0;
        }
        if (argc == 2 && std::string(argv[1]) == "--self-test") return self_test();
        if(argc==25&&std::string(argv[1])=="--render") {
            MediaRequest request;
            request.ffmpeg=std::filesystem::u8path(argv[2]);request.source=std::filesystem::u8path(argv[3]);
            request.output=std::filesystem::u8path(argv[4]);request.masks=std::filesystem::u8path(argv[5]);
            request.width=argument(argv[6],4096);request.height=argument(argv[7],4096);
            request.settings.sharpness=Sharpness{int(argument(argv[8],128)),int(argument(argv[9],128))};
            request.count=argument(argv[10],1800000);request.backend=argv[11];
            request.settings.subject=Colour{real_argument(argv[12]),real_argument(argv[13]),real_argument(argv[14]),real_argument(argv[15])};
            request.settings.wholeFrameEnabled=argument(argv[16],1)!=0;
            request.settings.wholeFrame=Colour{real_argument(argv[17]),real_argument(argv[18]),real_argument(argv[19]),real_argument(argv[20])};
            request.fps=argument(argv[21],60);request.threads=argument(argv[22],64);request.bitrate=argument(argv[23],200);request.encoder=argv[24];
            render_media(request);return 0;
        }
        if (argc == 8 && std::string(argv[1]) == "--filter") {
            Finishing settings;
            settings.sharpness = Sharpness{int(argument(argv[4], 128)), int(argument(argv[5], 128))};
            return filter(argument(argv[2], 8192), argument(argv[3], 8192),
                settings, argument(argv[6], 1800000), argv[7]);
        }
        if ((argc == 17 && std::string(argv[1]) == "--finish") ||
            (argc == 18 && std::string(argv[1]) == "--finish-cached")) {
            Finishing settings;
            settings.sharpness = Sharpness{int(argument(argv[4], 128)), int(argument(argv[5], 128))};
            settings.subject = Colour{real_argument(argv[8]), real_argument(argv[9]), real_argument(argv[10]), real_argument(argv[11])};
            settings.wholeFrameEnabled = argument(argv[12], 1) != 0;
            settings.wholeFrame = Colour{real_argument(argv[13]), real_argument(argv[14]), real_argument(argv[15]), real_argument(argv[16])};
            return filter(argument(argv[2], 8192), argument(argv[3], 8192), settings, argument(argv[6], 1800000), argv[7],
                argc == 18 ? std::filesystem::u8path(argv[17]) : std::filesystem::path{});
        }
        throw std::invalid_argument("Use --probe, --self-test, --filter width height gain256 threshold16 frameCount auto|cpu|gpu, or --finish with subjectLightEv contrast saturation warmth wholeFrameEnabled globalLightEv contrast saturation warmth");
    } catch (const std::exception& error) {
        std::cerr << "{\"event\":\"error\",\"message\":" << json_string(error.what()) << "}\n";
        return 1;
    }
}

int wmain(int argc,wchar_t** wide) {
    std::vector<std::string> values;values.reserve(argc);
    for(int index=0;index<argc;++index) {
        const int length=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[index],-1,nullptr,0,nullptr,nullptr);
        if(length<=0)return 2;
        std::string value(size_t(length),'\0');
        if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[index],-1,value.data(),length,nullptr,nullptr))return 2;
        value.pop_back();values.push_back(std::move(value));
    }
    std::vector<char*> argv;argv.reserve(argc);for(auto& value:values)argv.push_back(value.data());
    return worker_main(argc,argv.data());
}
