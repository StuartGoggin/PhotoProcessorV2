#include "core.h"
#include "process_owner.h"
#include <iostream>
#include <stdexcept>
#include <atomic>
#include <fcntl.h>
#include <io.h>

void require(bool value, const char* message) {
    if (!value) throw std::runtime_error(message);
}

int main(int argc,char** argv) {
    if(argc==2&&std::string(argv[1])=="closed-probe-stdout") {
        CloseHandle(GetStdHandle(STD_OUTPUT_HANDLE));Sleep(2000);return 0;
    }
    try {
        using namespace subject_finishing;
        // Bounded raw regression seam in the unshipped test executable only.
        // The public media worker and app export gate gain no bypass or new mode.
        if(argc==4&&std::string(argv[1])=="parallel-fixture") {
            const std::string budget=argv[2],scope=argv[3];
            require(budget=="1"||budget=="4"||budget=="8","Invalid fixture parallelism");
            require(scope=="subject-only"||scope=="combined","Invalid fixture scope");
            const uint32_t workers=uint32_t(budget[0]-'0');
            _setmode(_fileno(stdin),_O_BINARY);_setmode(_fileno(stdout),_O_BINARY);
            Frame fixture{224,126,std::vector<Rgba>(224*126)};
            std::vector<uint8_t> fixtureMask(fixture.pixels.size());
            Finishing settings;
            settings.subject=Colour{.25f,1.03f,1.04f,.02f};
            settings.wholeFrameEnabled=scope=="combined";
            settings.wholeFrame=Colour{.25f,1,1,0};
            for(uint32_t frame=0;frame<8;++frame) {
                std::cin.read(reinterpret_cast<char*>(fixture.pixels.data()),std::streamsize(fixture.pixels.size()*sizeof(Rgba)));
                require(bool(std::cin),"Truncated raw fixture picture");
                std::cin.read(reinterpret_cast<char*>(fixtureMask.data()),std::streamsize(fixtureMask.size()));
                require(bool(std::cin),"Truncated raw fixture mask");
                const auto result=finish(fixture,fixtureMask,settings,workers);
                std::cout.write(reinterpret_cast<const char*>(result.pixels.data()),std::streamsize(result.pixels.size()*sizeof(Rgba)));
                require(bool(std::cout),"Raw fixture output closed");
            }
            require(std::cin.peek()==std::char_traits<char>::eof(),"Trailing raw fixture bytes");
            std::cout.flush();require(bool(std::cout),"Raw fixture could not flush");
            return 0;
        }
        wchar_t binary[32768]{};
        require(GetModuleFileNameW(nullptr,binary,32768)>0,"Cannot identify owned probe test executable");
        const auto deadlineStart=std::chrono::steady_clock::now();bool deadlineRejected=false;
        try {capture_bounded(binary,{L"closed-probe-stdout"},1024,std::chrono::seconds(1));}
        catch(const std::runtime_error&) {deadlineRejected=true;}
        require(deadlineRejected,"Closing stdout must not evade the overall probe deadline");
        require(std::chrono::steady_clock::now()-deadlineStart<std::chrono::milliseconds(1500),
            "Final child wait must use the remaining overall probe budget");
        Frame source{16, 12, std::vector<Rgba>(16 * 12, Rgba{112, 121, 126, 255})};
        std::vector<uint8_t> emptyMask(source.pixels.size(), 0);
        const auto unchanged = sharpen(source, emptyMask, Sharpness{});
        require(unchanged.pixels == source.pixels, "Empty subject must preserve every RGBA pixel exactly");
        for (uint32_t y = 0; y < source.height; ++y) {
            for (uint32_t x = 0; x < source.width; ++x) {
                const auto level = uint8_t(112 + ((x + y) % 2 == 0 ? 12 : 0));
                source.pixels[y * source.width + x] = Rgba{level, level, level, 255};
            }
        }
        source.pixels[6 * source.width + 8] = Rgba{121, 121, 121, 255};
        std::vector<uint8_t> selected(source.pixels.size(), 255);
        selected[6 * source.width + 4] = 0;
        const auto detailed = sharpen(source, selected, Sharpness{128, 32});
        require(!(detailed.pixels == source.pixels), "Trusted fine detail should change with sharpening enabled");
        for (uint32_t y = 0; y < source.height; ++y) {
            for (uint32_t x = 0; x < source.width; ++x) {
                const size_t index = y * source.width + x;
                const int delta = int(detailed.pixels[index].r) - source.pixels[index].r;
                require(std::abs(delta) <= 3, "Detail gain must be capped at three encoded RGB luma codes");
                require(detailed.pixels[index].r >= 112 && detailed.pixels[index].r <= 124,
                    "Sharpening must not exceed local source bounds");
                require(detailed.pixels[index].a == source.pixels[index].a, "Sharpening must preserve alpha");
                if (x == 0 || y == 0 || x + 1 == source.width || y + 1 == source.height ||
                    (x >= 3 && x <= 5 && y >= 5 && y <= 7)) {
                    require(detailed.pixels[index] == source.pixels[index], "Incomplete trusted stencil must bypass");
                }
            }
        }
        const auto original = source.pixels;
        for (int alpha = 0; alpha <= 240; ++alpha) {
            std::fill(selected.begin(), selected.end(), uint8_t(alpha));
            require(sharpen(source, selected, Sharpness{128, 32}).pixels == original,
                "Untrusted soft mask must preserve every pixel");
        }
        std::fill(selected.begin(), selected.end(), uint8_t(255));
        require(sharpen(source, selected, Sharpness{0, 32}).pixels == original,
            "Zero sharpness must preserve every pixel");
        require(source.pixels == original, "The source stencil must be immutable");
        Frame flat{16, 12, std::vector<Rgba>(16 * 12, Rgba{112, 112, 112, 255})};
        for (size_t index = 0; index < flat.pixels.size(); ++index) {
            const uint8_t value = uint8_t(112 + index % 3);
            flat.pixels[index] = Rgba{value, value, value, 255};
        }
        require(sharpen(flat, selected, Sharpness{128, 32}).pixels == flat.pixels,
            "Small-amplitude flat noise must not be sharpened");
        bool rejected = false;
        try { sharpen(source, std::vector<uint8_t>(1), Sharpness{}); }
        catch (const std::invalid_argument&) { rejected = true; }
        require(rejected, "Mismatched masks must be rejected");
        rejected = false;
        try { sharpen(source, selected, Sharpness{128, 0}); }
        catch (const std::invalid_argument&) { rejected = true; }
        require(rejected, "The minimum two-code noise threshold is a public safety contract");
        std::fill(selected.begin(), selected.end(), uint8_t(255));
        Frame translucent = source;
        translucent.pixels[6 * source.width + 8].a = 128;
        require(sharpen(translucent, selected, Sharpness{128, 32}).pixels == translucent.pixels,
            "Nonopaque subject support must bypass rather than interpret premultiplied pixels");
        Finishing colours;
        colours.sharpness.gain256 = 0;
        require(finish(source, selected, colours).pixels == source.pixels,
            "Neutral colour and disabled sharpness must be an exact identity");
        colours.subject.lightEv = -0.5f;
        std::fill(selected.begin(), selected.end(), uint8_t(0));
        selected[6 * source.width + 8] = 255;
        const auto graded = finish(source, selected, colours);
        require(graded.pixels[6 * source.width + 8].r < source.pixels[6 * source.width + 8].r,
            "Selected subject midtone light must actually change the picture");
        for (size_t index = 0; index < source.pixels.size(); ++index) {
            if (selected[index] == 0) require(graded.pixels[index] == source.pixels[index],
                "Subject colour must not change background pixels");
        }
        Frame ramp{256, 1, std::vector<Rgba>(256)};
        for (size_t index = 0; index < ramp.pixels.size(); ++index) {
            const auto value = uint8_t(index);
            ramp.pixels[index] = Rgba{value, value, value, 255};
        }
        std::vector<uint8_t> full(ramp.pixels.size(), 255);
        Finishing light;
        light.sharpness.gain256 = 0;
        light.subject.lightEv = 0.5f;
        const auto lifted = finish(ramp, full, light);
        require(lifted.pixels.front() == ramp.pixels.front() && lifted.pixels.back() == ramp.pixels.back(),
            "Protected light trim must preserve black and white endpoints");
        for (const size_t index : {size_t(215), size_t(225), size_t(235), size_t(245)}) {
            require(lifted.pixels[index].r < lifted.pixels[index + 10].r,
                "Positive light trim must not collapse distinct highlights to flat white");
        }
        light.wholeFrameEnabled = true;
        light.wholeFrame.lightEv = 0.5f;
        light.subject.lightEv = -0.5f;
        require(finish(ramp, full, light).pixels == ramp.pixels,
            "Opposite full-mask light trims must cancel without an intermediate byte conversion");
        for (float contrast : {0.75f, 1.25f}) {
            light.wholeFrameEnabled = false;
            light.subject = Colour{0, contrast, 1, 0};
            const auto contrasted = finish(ramp, full, light);
            require(contrasted.pixels.front() == ramp.pixels.front() && contrasted.pixels.back() == ramp.pixels.back(),
                "Contrast must preserve black and white endpoints");
            for (size_t index = 1; index < ramp.pixels.size(); ++index) {
                require(contrasted.pixels[index].r >= contrasted.pixels[index - 1].r,
                    "Contrast must remain monotonic across the encoded SDR ramp");
            }
        }
        for(const uint32_t height : {1u,2u,7u,126u}) {
            Frame rows{16,height,std::vector<Rgba>(16*height)};
            std::vector<uint8_t> rowMask(rows.pixels.size(),255);
            for(size_t index=0;index<rows.pixels.size();++index) {
                const auto level=uint8_t(70+(index+index/16)%2*30);
                rows.pixels[index]=Rgba{uint8_t(level+10),uint8_t(level+5),level,uint8_t(index%53==0?128:255)};
                if(index%59==0)rowMask[index]=128;
            }
            const auto rowSource=rows.pixels;const auto maskSource=rowMask;
            Finishing rowSettings;rowSettings.subject=Colour{.25f,1.03f,1.04f,.02f};
            rowSettings.wholeFrameEnabled=true;rowSettings.wholeFrame=Colour{.25f,1,1,0};
            const auto serial=finish(rows,rowMask,rowSettings,1);
            for(const uint32_t workers : {1u,4u,8u}) {
                require(finish(rows,rowMask,rowSettings,workers).pixels==serial.pixels,
                    "Short and nondivisible row pictures must preserve exact serial RGBA");
                require(rows.pixels==rowSource&&rowMask==maskSource,"Parallel work must not mutate input pixels or masks");
            }
        }
        for(const uint32_t workers : {1u,4u,8u}) {
            std::array<std::atomic<uint32_t>,13> visits;
            for(auto& visit:visits)visit.store(0);
            picture_rows(13,workers,[&](uint32_t first,uint32_t last) {
                for(uint32_t row=first;row<last;++row)++visits[row];
            });
            for(const auto& visit:visits)require(visit.load()==1,"Every row must have exactly one owner");
        }
        std::atomic<uint32_t> drained{0};bool callerFailure=false;
        try {
            picture_rows(13,4,[&](uint32_t first,uint32_t) {
                if(first==0)throw std::runtime_error("Intentional caller-band failure");
                Sleep(25);++drained;
            });
        } catch(const std::runtime_error&) {callerFailure=true;}
        require(callerFailure&&drained.load()==3,"Caller failure must join every launched picture task before returning");
        drained.store(0);bool taskFailure=false;
        try {
            picture_rows(13,4,[&](uint32_t first,uint32_t) {
                if(first==3)throw std::runtime_error("Intentional worker-band failure");
                Sleep(25);++drained;
            });
        } catch(const std::runtime_error&) {taskFailure=true;}
        require(taskFailure&&drained.load()==3,"Worker failure must join every other picture task before returning");
        for(const uint32_t invalid : {0u,9u}) {
            bool refused=false;
            try {finish(source,selected,Finishing{},invalid);}
            catch(const std::invalid_argument&){refused=true;}
            require(refused,"Invalid CPU picture budget must be refused");
        }
        std::cout << "{\"schema\":1,\"emptyMaskIdentity\":true,\"trustedDetail\":true,\"boundedGain\":true,\"parallelRowsExact\":true,\"exceptionDrain\":true}\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
