#pragma once
#include <cstdint>
namespace picture_handoff {
struct PayloadPin {const wchar_t* path;uint64_t bytes;const char* sha256;};
// Fixed retained payload, including corresponding source/notices. No downloads.
inline constexpr PayloadPin payload[]={
 {L"media/bin/ffmpeg.exe",27354624,"898c1ea98f42755b57f1ef845ab50fc7cb1840fc6c1d64f2f0d150727fbc5630"},
 {L"media/bin/ffprobe.exe",27144704,"5dfbfa385580d884ba599a0356e36d80b14adc614fd95deee935bbf19b90bebc"},
 {L"media/bin/msvcp140.dll",557728,"0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9"},
 {L"media/bin/vcomp140.dll",193152,"55aba23cdcd6484fbb06f4155b8ca75adfce7a881f10afd0c49457165e677164"},
 {L"media/bin/vcruntime140_1.dll",49792,"1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f"},
 {L"media/bin/vcruntime140.dll",124544,"d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066"},
 {L"media/ffmpeg-dependency-recipe.md",5904,"96b3b18e760c36856040e9d682cb67488231a2755e7086b31d27f73cb08a7dc2"},
 {L"media/ffmpeg-row-backport-build.md",10922,"a1425d3dd083ca54773194993e808dd9d39b1967bfec02e9a12aa49af97d5c0a"},
 {L"media/licenses/dav1d-COPYING.txt",1317,"dd92c3c2247c5651606fc23a5e2d6a1ebc5ace9a3e49cbde0e12f05ad1cb1ee5"},
 {L"media/licenses/FFmpeg-GPLv2.txt",18431,"189b1af95d661151e054cea10c91b3d754e4de4d3fecfb074c1fb29476f7167b"},
 {L"media/licenses/FFmpeg-GPLv3.txt",35821,"0b383d5a63da644f628d99c33976ea6487ed89aaa59f0b3257992deac1171e6b"},
 {L"media/licenses/FFmpeg-LGPLv2.1.txt",27019,"37828f96b745455c387a19946bc005b5e0b7c4cef782bbd67e9de5130d7d0bdc"},
 {L"media/licenses/FFmpeg-LGPLv3.txt",7816,"ea7d049c7705dc13afc202dd18e1827f3484f8212fd3fa7b82fc4a0c363432c9"},
 {L"media/licenses/FFmpeg-LICENSE.md",4473,"36f6e2cb63f6a40a72b5c1b6169fb03f338d7eccd336fb3ccd4dcc0b49116dd1"},
 {L"media/licenses/FreeType-FTL.txt",6743,"08c135755dd589039470f1fdbb400daaabaaa50d0b366d19cebff4d22986baa1"},
 {L"media/licenses/FreeType-LICENSE.txt",2074,"2e3bbb7d7c5c396368dd0853a790ec29ce5b8647163dde42a0493fb0d6556b2b"},
 {L"media/licenses/HarfBuzz-COPYING.txt",1971,"ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64"},
 {L"media/licenses/HarfBuzz-ms-use-COPYING.txt",1141,"c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383"},
 {L"media/licenses/Intel-VPL-LICENSE.txt",1095,"6b53987f5de35662ccbcf2753dc84a713068443acb482fd6fd431ff7cf5da9f9"},
 {L"media/licenses/NVIDIA-nvEncodeAPI.h",316550,"6cca5db41ba7a3120de9987f9ce5c54ac9089da97a7faa6a3a81fae62b9c4269"},
 {L"media/licenses/vid.stab-LICENSE.txt",1151,"e430f8c5bae1565abd766766de91e1f9fa1a8b82d04b1e34039717fe56290ed7"},
 {L"media/licenses/x264-COPYING.txt",18332,"da0eca0fb517ac939d167924c9d4b3f8750a6b7191932ef2cb145acfa624ac7e"},
 {L"media/licenses/zlib-LICENSE.txt",1002,"845efc77857d485d91fb3e0b884aaa929368c717ae8186b66fe1ed2495753243"},
 {L"media/README-test-backend.txt",2857,"e531c3777737481fa04c5a80a3b424a924462763919e28eecdfa9ee6a7f8572f"},
 {L"media/validation/media-report.json",2398,"85316b6bfe667c64db7780fd2f2eb9107794f9822debea5b18781d98e9cede49"},
 {L"media/validation/quality-report.json",8399,"94583a97c0ff3ccd48b52e8f21c445f1ade27b174a47c0e465af3a86c141a683"},
 {L"media/validation/runtime-report.json",4438,"ba2a1e8ca100427003c9f640cf480d1a7b4de4e667d62ab60f4c67b774119f7f"},
 {L"media/build-manifest.json",4764,"8276c56a5dc3ddef5d8dd9ff0b3dc6fc65247d1587cc33b92d00e23be65540b2"},
 {L"source/PhotoGoGo-FFmpeg-rowtest1-source.tar.gz",49570807,"27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8"},
 {L"samples/black-horse/base.mp4",10610056,"e252b692c87d81e56d6f8c1f38541ea3bb3bd184ac70cb501aba5ce364dca59a"},
 {L"samples/black-horse/masks.pgmask",8844150,"b47b56ae38818bcf0bded06e98a640a7e361d88265976c8bc45d5670b2575116"},
 {L"samples/black-horse/manifest.json",1634,"85f12a87473b51592cfa182cb2850ca5bd3f6f1145c21f1595be49749e634fd8"},
 {L"samples/white-horse/base.mp4",10565625,"aa0bb9a813cc9eda18368005438986fcc907b23cdf8f738daae3f0b0397bfcc6"},
 {L"samples/white-horse/masks.pgmask",13402200,"03b124e34b2409ca5fd4e4bb552ae48414ec726aa668b6780fff4263c1b677a9"},
 {L"samples/white-horse/manifest.json",1628,"dafe8bc3d21b5fc85468d6c036ce596cc60d8dee819e82e6f3950788a7c968d1"},
};
}
