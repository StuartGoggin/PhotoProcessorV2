# PhotoGoGo row-parallel FFmpeg test backend

This is a narrowly modified **vid.stab v1.1.1**, not the modern upstream
stabilisation algorithm. Full-pipeline release evidence must be recorded before
shipping a test installer; unit equivalence alone does not establish throughput.

## Behavioural scope

- `vsTransformPrepare`: allocate an owned source snapshot when first changing
  from separate caller buffers to in-place operation (`!srcMalloced`). The old
  null-pointer test could overwrite a retained caller/decoder input buffer.
- `transformPlanar`: statically partition destination rows with OpenMP, keeping
  the horizontal index private and the existing per-plane barrier.
- Binary motion header: remove the trailing whitespace directive from
  `fscanf("TRF%hhu")`. The writer emits no newline; accuracy 10 starts with
  byte `0x0A`. Consuming it misaligns the header and can turn an empty motion
  list into a request for 33,554,432 entries. This corrects format parsing,
  not smoothing or interpolation.
- Do not change camera-path smoothing, interpolation mathematics, colour/range
  conversion, quality settings, scheduler budgets or memory admission policy.
- MSVC portability only: standard variadic macros; omit unused Unix `libgen.h`;
  recognise x86/x64 little-endian targets; canonical OpenMP loop syntax; emit
  externally referenced interpolation functions under C11 inline semantics.

The saved patch is `scripts/diagnostics/vidstab-backport/vidstab-v1.1.1.patch`.
It is checked against the pinned old source using `git apply --reverse --check`.
The standalone CMake definition builds the static library and its regression
harness without importing the modern library's algorithms or build system.

## Pinned inputs

All sources live below `test-output/ffmpeg-row-backport` during the local build.
No compiler, driver or dependency is installed globally.

| Input | Version / source revision |
| --- | --- |
| FFmpeg | n8.1.1, `239f2c733de417201d7ad3b3b8b0d9b63285b2b1` |
| vid.stab | v1.1.1, `90c76aca2cb06c3ff6f7476a7cd6851b39436656` |
| NVIDIA codec headers | n13.0.19.0, `e844e5b26f46bb77479f063029595293aa8f812d` |
| x264 | stable, `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` |
| Intel VPL | v2.17.0, `d77f9195cf495b937631607333288fd917ae8939` |
| FreeType | VER-2-13-3, official `freetype/freetype` source archive |
| HarfBuzz | 10.4.0, official `harfbuzz/harfbuzz` source archive |
| zlib | v1.3.1, official `madler/zlib` source archive |
| GNU Make | 4.4.1 source from ftp.gnu.org, built with installed MSVC |
| NASM | 2.16.03 source from nasm.us, built with installed MSVC |
| pkgconf | 2.3.0 source from `pkgconf/pkgconf`, local native CMake wrapper |
| dav1d | 1.5.3 official VideoLAN source archive |
| Meson | 1.9.1 official mesonbuild release archive; build-only, no global install |

Downloaded archive SHA-256 values:

```text
make-4.4.1.tar.gz       dd16fb1d67bfab79a72f5e8390735c49e3e8e70b4945a15ab1f81ddb78658fb3
nasm-2.16.03.tar.xz    1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148
freetype-2.13.3.tar.gz bc5c898e4756d373e0d991bab053036c5eb2aa7c0d5c67e8662ddc6da40c4103
harfbuzz-10.4.0.tar.gz 0d25a3f74af4e8744700ac19050af5a80ae330378a5802a5cd71e523bb6fda1f
zlib-1.3.1.tar.gz     17e88863f3600672ab49182f217281b6fc4d3c762bde361935e436a95214d05c
dav1d-1.5.3.tar.xz    732010aa5ef461fa93355ed2c6c5fedb48ddc4b74e697eaabe8907eaeb943011
meson-1.9.1.tar.gz    4e076606f2afff7881d195574bddcd8d89286f35a17b4977a216f535dc0c74ac
```

These hashes record the exact downloaded inputs, not a claim of detached-signature
verification. Compiler: installed Visual Studio 2022 Build Tools, MSVC 14.44.35207;
CMake 3.31.6; x64 Release. Static dependency libraries use the dynamic MSVC CRT.

## Low-disk build route

`scripts/diagnostics/invoke-native-build.ps1` runs a bounded hidden child with a
case-insensitive environment dictionary, imports Visual Studio only into that
child, records exit/timing logs, and terminates only its own process tree if a
time/disk limit is reached. It changes no global PATH or security settings.
The per-command approved execution route was required for Visual Studio tools
on this host; a Codex restart was not required.

Build steps, sequentially:

1. GNU Make: apply `scripts/diagnostics/make-git-bash.patch`, then upstream
   `build_w32.bat --without-guile`; use `WinRel/gnumake.exe`. Its documented
   `BATCH_MODE_ONLY_SHELL` mode avoids native CreateProcess/Git Bash quoting
   loss. Do not combine it with `HAVE_CYGWIN_SHELL`. Verify
   `posix-shell-probe.mk` returns `object.o: C:/sdk/foo.h` before building.
2. NASM: `nmake /f Mkfiles/msvc.mak CFLAGS=/O2 "LDFLAGS=/OPT:REF /OPT:ICF" nasm.exe`.
3. pkgconf: `scripts/diagnostics/pkgconf-msvc` CMake wrapper, with
   `PKGCONF_SOURCE` set to the extracted 2.3.0 source. Use the supplied
   `static.personality` with `--static`: upstream Windows defaults enable pure
   dependency mode, which otherwise omits `Libs.private`. The personality
   deliberately leaves `WantDefaultPure` absent (zero-initialized false).
4. FreeType: static CMake Release install into `prefix`; disable optional zlib,
   bzip2, PNG, HarfBuzz and Brotli integrations to avoid a circular dependency.
5. HarfBuzz: static Release install into the same prefix, FreeType enabled,
   subset/utilities disabled. Its generated Windows `.pc` file must not request
   Unix `-lm`; the mathematical functions are in the MSVC runtime.
6. VPL: static Release install; examples/tests disabled; keep the default
   dynamic CRT setting. Its generated Windows `.pc` needs `-ladvapi32 -lole32`
   in `Libs.private` for static linkage. Do not install system graphics drivers.
7. x264: MSVC `CC=cl`, NASM on child PATH; static library, no CLI/OpenCL,
   8-bit output, all chroma formats, native Windows threads; install to prefix.
8. zlib: build upstream CMake `zlibstatic`, stage it as `prefix/lib/zlib.lib`
   together with `zlib.h` and generated `zconf.h`. Apply `zlib-msvc-header.patch`
   before configuration: FFmpeg defines `HAVE_UNISTD_H=0`, but zlib's original
   `#ifdef` treats that as true. The MSVC-only guard avoids a nonexistent Unix
   header; no compression algorithm changes are made.
9. vid.stab: apply the saved patch to the pinned checkout; build/install from
   `scripts/diagnostics/vidstab-backport`, setting `VIDSTAB_SOURCE` and the prefix.
   Stage matching `vidstab.pc` and NVIDIA headers/`ffnvcodec.pc`.
10. dav1d: run the extracted Meson with bundled Python; static Release,
    `b_vscrt=md`, tools/tests/examples disabled, NASM and installed Ninja on the
    child PATH. Run Ninja `-j1 install` into the same prefix, then copy its
    MSVC-format `libdav1d.a` to `dav1d.lib` for FFmpeg's MSVC linker naming. This preserves
    software AV1 decoding on machines without an AV1-capable GPU.
11. Run `scripts/diagnostics/build-ffmpeg-candidate.ps1 -Stage Configure`, then
    `-Stage Build`. The script preserves ordinary builtin media formats and
    enables x264, NVENC, QSV, vid.stab, FreeType/HarfBuzz captions and zlib.
    For native Make, the script normalizes generated MSYS source-root paths
    to relative paths and explicitly selects `SHELL=sh.exe` on its child PATH.
    Both C and C++ must use `-MD -GS`. The first link exposed a static/dynamic
    CRT mismatch in `vsrc_gfxcapture_winrt.cpp`; the incremental recovery added
    those C++ flags to generated `ffbuild/config.mak` and rebuilt that object.
    The configure recipe now supplies `--extra-cxxflags=-MD -GS` for clean builds.
    The initial configure string alone does not record that incremental override.

Exact effective dependency flags and staged metadata edits are recorded in
`ffmpeg-dependency-recipe.md` and included with the corresponding sources.

Dependencies build with one worker; the final FFmpeg compile uses at most two.
New build directories inherit NTFS compression. Configure reserves 768 MiB;
the incremental compile reserves 512 MiB and has a 30-minute limit per run.
The checksum-only validation can use the same 512 MiB floor explicitly; it
reuses the reference input and writes small checksum/log files, not raw video.
Source/build logs are local diagnostics, not installer contents. Never ship a
raw configure log or an environment dump.

## Validation already established at the library seam

- `ownership-before.log`: the uncorrected library failed on mutation of a
  retained earlier caller buffer during separate-to-in-place transition.
- `ownership-after.log`: passed after the one-line ownership correction.
- `rows-after.log`: 192 byte-identical frame pairs at 1 versus 6/12 workers,
  changing frames/transforms, black/retained borders, separate/in-place/alternating
  buffers, 638x358 and 3840x2160, with padded strides and padding canaries.
- `extra-regressions.log`: in-place output matches an always-separate-buffer
  reference for both border modes; 24 additional GRAY8/YUV444P/YUVA420P pairs
  cover all four interpolation choices and both borders.
- `media-resolver-tests.log`: explicit override, managed-bundle precedence,
  sibling ffprobe and PATH fallback checks pass.
- `binary-header-before.log`: bounded header-only regression reproduced offset
  25, frame 0 and list length 33,554,432 without allocating any motion list.
- `binary-header-after.log`: the original synthetic motion fixture and tiny
  accuracy 8-13 cases all preserve offset 24, frame 1 and list length 0.

## Installer and rollback contract

Both FFmpeg and matching ffprobe belong in `tools/ffmpeg/bin` next to the app,
with needed Microsoft redistributable DLLs, upstream license texts, source pins
and the modification/build recipe. Deliver an associated compressed archive of
the exact FFmpeg and linked dependency sources, modifications and build scripts;
record its hash and link beside the installer. Version links alone are not that
source deliverable. Never silently depend on the build machine's developer
runtime: recursively audit executable and packaged DLL imports with dumpbin,
and record runtime DLL hashes. Restricted-PATH execution alone does not prove
closure because Windows also searches System32. Verify extracted MSI payload
hashes, version, capabilities and synthetic tool execution before upload.

Both app resolution paths share `commands/media_tools.rs`: explicit
`PHOTOGOGO_FFMPEG` first, then managed bundle, legacy adjacent binary, then PATH.
The change does not modify or uninstall external FFmpeg. For rollback, after
the user has let work finish and closed the app normally, a temporary process
override may select their previous verified FFmpeg and its sibling ffprobe.

Render-PC performance acceptance must use a fresh output location/uncached clip.
Do not delete existing render caches: a cache hit cannot prove the new transform
ran. Check the actual binary path/version and `h264_nvenc`, not merely its
presence in an encoder list. Local Intel results cannot prove RTX throughput.
