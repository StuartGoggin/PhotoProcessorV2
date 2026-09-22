# Exact dependency configuration for PhotoGoGo-rowtest1

Companion to `ffmpeg-row-backport-build.md`. These commands reproduce the
effective settings recovered from the successful local CMake caches, x264
configure record and Meson build options. This is not a claim of a second clean
rebuild. Use the pinned source snapshots and patches in the associated source
archive, plus the installed x64 MSVC developer environment, CMake, Git Bash,
Python and Ninja. No administrator installation is needed.

In the commands below, `B` is `test-output/ffmpeg-row-backport` under the checkout,
`P` is `B/prefix`, and `D` is `scripts/diagnostics`. Expand those to absolute
forward-slash paths. The archived source directories retain their build names.
Apply patches only to pristine inputs; the delivered source snapshots already
contain the modifications. Build one dependency at a time with one worker.

## CMake projects

Every configure command uses `-G "Visual Studio 17 2022" -A x64`.
Installed libraries also use `-DCMAKE_INSTALL_PREFIX=P`.
Use `cmake --build BUILD --config Release --parallel 1`, followed by
`cmake --install BUILD --config Release` except where noted.

| Source and build directory under B | Additional configure arguments |
| --- | --- |
| `freetype-VER-2-13-3` → `freetype-build` | `-DBUILD_SHARED_LIBS=OFF -DFT_DISABLE_ZLIB=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON -DFT_ENABLE_ERROR_STRINGS=OFF` |
| `harfbuzz-10.4.0` → `harfbuzz-build` | `-DBUILD_SHARED_LIBS=OFF -DCMAKE_PREFIX_PATH=P -DHB_HAVE_FREETYPE=ON -DHB_BUILD_SUBSET=OFF -DHB_BUILD_UTILS=OFF -DHB_HAVE_CAIRO=OFF -DHB_HAVE_DIRECTWRITE=OFF -DHB_HAVE_GDI=OFF -DHB_HAVE_GLIB=OFF -DHB_HAVE_GOBJECT=OFF -DHB_HAVE_GRAPHITE2=OFF -DHB_HAVE_ICU=OFF -DHB_HAVE_INTROSPECTION=OFF -DHB_HAVE_UNISCRIBE=OFF` |
| `vpl-source` → `vpl-build` | `-DBUILD_SHARED_LIBS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_TESTS=OFF -DINSTALL_EXAMPLES=OFF -DBUILD_EXPERIMENTAL=ON -DINSTALL_DEV=ON -DINSTALL_LIB=ON -DUSE_MSVC_STATIC_RUNTIME=OFF -DCMAKE_BUILD_TYPE=Release` |
| `zlib-1.3.1` → `zlib-build` | Apply `zlib-msvc-header.patch` before configure. `-DZLIB_BUILD_EXAMPLES=OFF`. Build only `--target zlibstatic`; copy `Release/zlibstatic.lib` to `P/lib/zlib.lib`, source `zlib.h` and generated `zconf.h` to `P/include`. |
| `D/vidstab-backport` → `vidstab-build` | Apply `vidstab-v1.1.1.patch` to `B/vidstab-source`; `-DVIDSTAB_SOURCE=B/vidstab-source`. The supplied wrapper defines C11, static linkage, OpenMP and SSE2. |
| `D/pkgconf-msvc` → `pkgconf-build` | `-DPKGCONF_SOURCE=B/pkgconf-pkgconf-2.3.0`; build only `--target pkgconf`, do **not** install into Program Files. |

The Release libraries use dynamic MSVC CRT (`/MD`), not the static CRT.

## x264

In `B/x264-source`, using Git Bash with MSVC/NASM/patched GNU Make on the child PATH:

```sh
CC=cl ./configure --host=x86_64-w64-mingw32 --enable-static --disable-cli \
  --disable-opencl --bit-depth=8 --prefix="$P" --extra-cflags="-MD -GS"
gnumake -j1 SHELL=sh.exe lib-static
gnumake -j1 SHELL=sh.exe install-lib-static
```

Recorded output is `libx264.lib`, native Windows threads, 8-bit output, all
chroma formats and interlacing enabled. Upstream configure appends `-GS-` after
the supplied `-GS`; therefore **do not claim stack-cookie protection is enabled
throughout all linked code**. No x264 algorithm or compiler-policy change was made.

## dav1d

Using extracted Meson 1.9.1, installed Python, MSVC, NASM and Ninja:

```text
python B/meson-1.9.1/meson.py setup B/dav1d-build B/dav1d-1.5.3 --prefix=P --buildtype=release --default-library=static -Db_vscrt=md -Denable_tools=false -Denable_tests=false -Denable_examples=false
ninja -C B/dav1d-build -j1 install
```

Keep the installed MSVC-format `P/lib/libdav1d.a`; copy its identical contents
to `P/lib/dav1d.lib` for FFmpeg's MSVC linker naming. Effective defaults:
assembly on, bitdepths 8 and 16, optimisation 3, C99, logging on, docs/tests/seek
stress off, `trim_dsp=if-release`, `b_ndebug=if-release`; no extra C/link arguments.

## Staged headers and pkg-config metadata

Copy NVIDIA `include/ffnvcodec` headers to `P/include/ffnvcodec`. Stage its
`ffnvcodec.pc` template with `@@PREFIX@@` replaced by `P` (version 13.0.19.0,
include flags only). The following metadata edits are required:

- `harfbuzz.pc`: remove Unix `-lm` from `Libs.private`; retain
  `Requires.private: freetype2 >= 12.0.6`.
- `vpl.pc`: set `Libs.private: -ladvapi32 -lole32`; retain its
  `${pcfiledir}`-relative prefix/lib/include paths.
- `vidstab.pc`: use the supplied metadata below.
- Preserve generated `freetype2.pc` version **26.2.20**, `x264.pc` version
  **0.165.x**, and `dav1d.pc` version **1.5.3**. No functional edits to those files.
- No zlib `.pc` is staged; FFmpeg resolves staged headers and `zlib.lib` directly.

```pkgconfig
prefix=P
libdir=${prefix}/lib
includedir=${prefix}/include
Name: vidstab
Description: vid.stab v1.1.1 with PhotoGoGo ownership and row-parallel backport
Version: 1.1.1
Libs: -L${libdir} -lvidstab
Cflags: -I${includedir}
```

Set `PKG_CONFIG_PATH=P/lib/pkgconfig`. Every FFmpeg pkgconf query must use
`--static --personality=D/pkgconf-msvc/static.personality`. Leave
`WantDefaultPure` absent; do not set it to the string `false`.

Create `B/ffmpeg-build` first (the bounded runner requires an existing work
directory), then use `build-ffmpeg-candidate.ps1 -Stage Configure`, then `-Stage Build`.
The corresponding source archive includes the exact staged `.pc` files as a
cross-check; replace their original local prefix when rebuilding elsewhere.

For the header regression, run `binary-header-test.exe` with the archived
`test-output/quality-pipeline-20260921T202819652Z/motion.trf` argument. This is
synthetic motion data, not private footage. The test reads only its first 32
bytes and also generates its own six tiny accuracy-8-through-13 header cases.
