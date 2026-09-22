PhotoGoGo 2.0.16 - row-parallel stabilisation test backend
Build: FFmpeg n8.1.1-PhotoGoGo-rowtest1, Windows x64

This is a test build, not a claim of render-PC acceptance. The old vid.stab
v1.1.1 algorithm is retained. Changes are destination-row parallelism, a
separate-to-in-place buffer ownership correction, binary motion-header parsing,
and the MSVC portability changes documented in the accompanying sources.

The synthetic 4K50 Quality filter-chain gate matched all 300 reference frames
and timestamps exactly at 1, 6 and 12 workers. Mean filter-chain time was
16.35 seconds at 1 worker and 7.57 seconds at 6 workers (2.16x). Peak working
set was approximately 324 MiB. This excludes motion detection and encoding;
it does not predict end-to-end speed on the RTX 2060 render PC.

The installer contains the tested FFmpeg/ffprobe pair, four unmodified Microsoft
Visual C++ release runtime DLLs, licenses, validation reports and a hash
manifest. Windows 11 supplies system/API-set DLLs. Graphics-driver libraries
are not included or changed. Local capability checks do not prove NVIDIA
hardware execution. No installer signing certificate is used for this test.

Corresponding source archive: PhotoGoGo-FFmpeg-rowtest1-source.tar.gz
The build manifest records its SHA-256. It is delivered beside the installer.
It contains the modified FFmpeg/dependency source snapshots, licenses, source
pins, patches, regression harnesses, and build recipes. Snapshots already have
the patches applied; do not apply them a second time. Start with
docs/ffmpeg-row-backport-build.md and docs/ffmpeg-dependency-recipe.md.
This FFmpeg build enables GPL components. Applicable upstream licenses are in
licenses/ and the source archive. The binaries are provided without warranty.
The Microsoft runtime DLLs remain subject to Microsoft's redistribution terms:
https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution

Testing: let current work finish and close PhotoGoGo normally before installing.
Use a fresh output location/uncached clip with the same Quality settings. Keep
existing outputs/caches; a cache hit cannot measure this change. Check the log
for tools/ffmpeg/bin/ffmpeg.exe, PhotoGoGo-rowtest1 and actual h264_nvenc use.
Record clip duration/resolution, elapsed time, FPS, CPU/RAM and NVIDIA encoder
use. No driver changes or queue/worker-budget changes are part of this build.

Rollback: external FFmpeg installations are untouched. After all work finishes
and the app is closed normally, launch it from a shell with PHOTOGOGO_FFMPEG
set only in that shell to the previously verified ffmpeg.exe; its sibling
ffprobe.exe is preferred too. Clear that process override to test the bundled
pair again. Keep the previous installer available; do not uninstall during
active rendering. Never replace only one executable or remove runtime DLLs.
