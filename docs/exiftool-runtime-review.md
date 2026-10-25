# Source-built ExifTool runtime review

Reviewed: 26 October 2026. This is primary-source research and read-only
source/licence inspection for the approved Windows x64 PhotoGoGo runtime. This
reviewer downloaded no binaries, built or executed no runtime, and accessed no
accounts or user media. Actual runtime/installer results require separate receipts.

## Decision

Proceed with **stock Perl 5.44.0 built locally with MSVC x64 plus pure ExifTool
13.59 source**, accompanied by complete matching source archives, licences and
the exact build/configuration recipe. The managed entry becomes the new
`exiftool_files/perl.exe` running the packaged ExifTool script and local library
tree. No old launcher, Perl 5.32, GCC, GMP or former optional-module binaries may
be carried into this package.

The source choice resolves the former package's unestablished native source
provenance. Release acceptance still depends on actual Unicode/metadata tests,
MSVC redistribution provenance and complete installer payload verification.

## Verified source pins

| Component | Acquired artifact and primary provenance |
| --- | --- |
| Perl 5.44.0 | [Official CPAN tar.gz](https://www.cpan.org/src/5.0/perl-5.44.0.tar.gz), local `test-output/metadata-perl-build/perl-5.44.0.tar.gz`; **21,265,451 bytes**; SHA-256 **`3b855066b92491cb40e86affb1ca57d1a388aa43e51b91c7806a32c2f65f96c3`**. Local hash independently checked. |
| Perl checksum provenance | Release manager Leon Timmermans's [15 July 2026 announcement](https://www.nntp.perl.org/group/perl.perl5.porters/2026/07/msg271063.html) publishes that exact tar.gz digest. [CPAN](https://www.cpan.org/src/) identifies 5.44.0 as a maintained production branch. The different tar.xz digest must not be used for this tar.gz. A `src/5.0/CHECKSUMS` fetch was unavailable. |
| ExifTool 13.59 | [Official GitHub tag archive](https://codeload.github.com/exiftool/exiftool/tar.gz/refs/tags/13.59), local `test-output/Image-ExifTool-13.59-source.tar.gz`; **8,653,399 bytes**; SHA-256 **`87d3317882fdae9cb4dcfe57a96a378d0132ffc02c731315bf128b19ddcf7aac`**. Local hash independently checked. |
| ExifTool tag identity | [Official tag API](https://api.github.com/repos/exiftool/exiftool/git/ref/tags/13.59), read directly, maps `13.59` to commit **`2200871d9cef988051d2a99d67df3bda6cbb30a8`**. Preserve that identity with the acquired archive. |

The build helper subsequently acquired the official author's
[LEONT CHECKSUMS](https://www.cpan.org/authors/id/L/LE/LEONT/CHECKSUMS).
Its saved `perl-5.44.0.tar.gz` entry was independently read back and confirms
the same SHA-256 and 21,265,451-byte size. The saved CHECKSUMS document is
`test-output/metadata-perl-build/LEONT-CHECKSUMS`, 453,386 bytes, SHA-256
`d041de7f70f5b141dcc9a642f0b65fbd48032a38638fb8e725f3a230a397386f`.
That document's hash identifies the acquired metadata snapshot, not the Perl
archive; the author's index can change as new releases appear.

The ExifTool archive hash is an acquisition/integrity pin, not an independently
published publisher digest or signature. It does not apply to the different
upstream source distribution or Windows ZIPs. Preserve the acquired bytes;
future GitHub archive responses are not the check of these existing bytes.
Upstream [history](https://raw.githubusercontent.com/exiftool/exiftool/13.59/Changes)
labels 13.55 its latest production release and 13.59 a later development release
containing a security update. Do not call 13.59 upstream's production release.

## Licensing and MSVC files

Perl's [5.44.0 README](https://raw.githubusercontent.com/Perl/perl5/v5.44.0/README)
permits its Artistic licence or GPL-1.0-or-later. ExifTool's
[13.59 README](https://raw.githubusercontent.com/exiftool/exiftool/13.59/README)
permits the same alternatives. Use the Artistic route with complete matching
source and documented build/configuration changes. Preserve `README`,
`Artistic`, `Copying`, ExifTool's root `LICENSE`, copyright notices and component
notices. Do not claim that all independently incorporated components have one
uniform licence. A full GPL text does not erase the alternative README grant.

Build in-tree XS modules from this same Perl source. Supply the full sources,
any changes and build recipe, including compiler version/options and output
hashes. No separate GCC/GMP source closure is required when none of those
former binaries/modules ships. These are engineering compliance findings, not
a legal opinion.

The stock [Windows Makefile](https://raw.githubusercontent.com/Perl/perl5/v5.44.0/win32/Makefile)
uses `/MD` for supported MSVC release builds. `BUILD_STATIC` changes Perl's
interpreter/extension model; it is not a supported static-CRT toggle. Keep the
supported build and inspect every native file's actual imports.

The following installed release-CRT origin was inspected:

`C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT\`

Copy only required release DLLs, unmodified, from the licensed installed Redist
location, recording original path, publisher/version, SHA-256 and signature
status. The installed `Licenses/1033/Redist.txt` points to Microsoft's
[REDIST list](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution),
which allows listed unmodified files under applicable terms and excludes
`debug_nonredist`. Microsoft's [redistribution documentation](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170)
requires the relevant licence rights; directory presence alone is not an audit
of the owner's entitlement.

Include the unchanged [Visual C++ Runtime licence](https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx),
whose URL was read from the [official licence page](https://visualstudio.microsoft.com/license-terms/vs2022-cruntime/),
plus the REDIST pointer/provenance. The separate
[Build Tools terms](https://visualstudio.microsoft.com/license-terms/vs2022-ga-diagnosticbuildtools/)
govern compiler use. No Microsoft CRT source-delivery obligation is asserted.
The [Universal CRT is an OS component](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment?view=msvc-170)
on Windows 10/11. Do not copy DLLs from System32 or redistribute debug CRT.

## Unicode support and scope

No extra CPAN dependency is needed for **Win32API::File**. The
[Perl 5.44.0 MANIFEST](https://raw.githubusercontent.com/Perl/perl5/v5.44.0/MANIFEST)
includes `cpan/Win32API-File/File.pm`, `File.xs`, build inputs and tests. The
[tagged module](https://github.com/Perl/perl5/blob/v5.44.0/cpan/Win32API-File/File.pm)
was inspected: version `0.1203_01`, blob
`804a7f6ea0003c78be7429901631dc3b10aebb69`. Retain its matching built XS DLL
and module; source inclusion does not prove the extension was staged.

ExifTool uses it for wide-character filename open/rename/delete:
[main library](https://github.com/exiftool/exiftool/blob/13.59/lib/Image/ExifTool.pm),
[writer](https://github.com/exiftool/exiftool/blob/13.59/lib/Image/ExifTool/Writer.pl).
Probe module loading in the relocated packaged interpreter and perform real
Unicode-path metadata writes and temporary-file replacement through the app.

**Win32::API is a different optional non-core module.** ExifTool uses it for
automatic long-path expansion, new Unicode-directory creation and precise
Windows filesystem-time APIs. Existing-file JPEG-copy operations can use core
Win32API::File while Rust creates job directories. The Google Photos copy
command uses `-P`; without Win32::API filesystem-time handling can warn/fall
back. EXIF capture-date tags are separate. Staging-tag writes now preserve
mtime explicitly using Rust's wide-path file API, as reviewed below. Test
required mtime behavior and long paths; do not claim parity with every optional
module in the former package. No new CPAN dependency was added or approved by
this review.

## Release gates and evidence limits

1. Verify source pins before use and preserve the sources, licences, configuration
   changes and exact recipe in the packaged resources/release artifacts. The
   two acquired source archive hashes above have been independently verified.
2. Assemble a fresh runtime and inventory all native imports. Reject former
   launcher/Perl/GCC/GMP files and foreign XS modules. Verify CRT file origins,
   notices, signatures and hashes. Hash the complete staged tree and compare it
   with both extracted EXE and MSI payloads.
3. Retain `DEFAULT_INC_EXCLUDES_DOT=define`, enable `USE_NO_REGISTRY=define`,
   leave `USE_SITECUST` disabled, and record these options. Check relocated
   `@INC`; do not depend on another Perl or development directory. Clear
   `PERL5OPT`, `PERL5LIB`, `PERLLIB` and `PERL5DB` before interpreter startup.
4. Invoke an absolute interpreter/script/local-library path with no shell.
   ExifTool's first actual arguments remain `-config` and an empty value;
   interpreter options precede the script. Keep UTF-8 stdin argument lines,
   CR/LF/NUL rejection, closed stdin, bounded output/time and supervised helper
   termination. Keep Settings overrides visibly identified.
5. Relocate under spaces/Unicode and test as normal user without installed
   Perl/ExifTool or runtime-tree write access. Probe Win32API::File and test
   actual metadata writes/rename on BMP Unicode and surrogate-pair filenames;
   unsupported cases must fail clearly. Check invalid override/missing module.
6. On synthetic JPEG fixtures prove orientation, EXIF capture time/offset/
   subseconds, RGB ICC preservation, grayscale ICC exclusion, GPS retain/remove,
   encoded-picture identity and required filesystem-time preservation. Use the
   actual app adapter; a version probe alone is insufficient.
7. Record source review, runtime success, installer closure and live Google
   pilot as distinct states. Dependency validation does not prove live Google
   album/date/colour behavior. Keep the previous installer and replace or roll
   back the whole runtime tree; never mix extensions from the two Perl builds.

## Actual Perl-stage read-back

Independently inspected, without execution:
`test-output/metadata-perl-build/stages/runtime-20261026T080608525`.
It contains **1,948 files / 91,690,689 bytes**, including **52 x64 PE binaries**.
All 1,948 file paths, sizes and SHA-256 hashes matched the build receipt with
zero mismatches or unexpected file-count differences. The receipt is
`test-output/metadata-perl-build/runtime-build-receipt.json`, SHA-256
`3e50b9f8d4ff4d5e56952b19fc106c3c3a0b329473bd86525d42ece22696cb61`.

An independent static PE scan found ordinary imports only from Windows OS
DLLs/API sets, `perl544.dll` and the two app-local Microsoft runtime DLLs.
Delay imports were also inspected: `perl544.dll` delays only `ADVAPI32.dll`
and `WS2_32.dll`. No old launcher, Perl 5.32, GCC, GMP or debug CRT native file
or import was found. The stock `Win32API/File.pm` and same-build
`auto/Win32API/File/File.dll` are present.

Both CRT DLLs match the installed Redist originals byte for byte, have valid
Microsoft Authenticode signatures and file version `14.44.35211.0`:

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `VCRUNTIME140.dll` | 124,544 | `d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066` |
| `VCRUNTIME140_1.dll` | 49,792 | `1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f` |

The staged Perl README/Artistic/Copying notices exactly match the pinned stock
source. The staged Microsoft runtime licence is a valid DOCX and exactly
matches the acquired official document, SHA-256
`f1e3d56ceb2ad68aae0711b910375009e651ac5530fa0760f0dea6e81e54fae1`.
The installed Microsoft REDIST pointer is also included.

The build helper's receipt reports a passed relocated core/XS execution probe,
`@INC` restricted to `./lib`, Win32API::File `0.1203_01`, disabled registry
lookup/implicit-dot/sitecustomize, and an unpatched source build. This reviewer
read that receipt but did not independently execute the runtime. Its earlier
probe-fixture warning was corrected without changing the compiled binaries.

**Verdict: this Perl-stage native/licence inspection passes.** The subsequent
merged-payload inspection is recorded below. Final functional/installer results
and live Google acceptance remain distinct receipt states.

## Merged payload and timestamp-fix review

Read-only inspection of `src-tauri/tools/exiftool` found **2,205 actual files**.
Every one of the lock's **2,204 entries** independently matched its file size
and SHA-256; the sole additional file is the intentionally self-excluded
`build-manifest.json`. Both source archives match the pins above. The packaged
build script and Perl build receipt match the owned originals.

All **246 ExifTool library source files** and the upstream `windows_exiftool`
script, packaged as `exiftool_files/exiftool.pl`, match the pinned source bytes.
The full source archives, build recipe, provenance receipt, ExifTool README and
licence, Perl notices, Microsoft runtime licence and REDIST pointer are present.
The **52 native files** all match the accepted Perl-stage hashes; no former
launcher/GCC/GMP/Perl 5.32/debug binary was introduced during merging.

The owned `run-exiftool.pl` bootstrap sets `@INC` to `./lib` in `BEGIN`, assigns
the fixed local script path to `$0`, then loads that script and checks errors.
The native adapter sets the absolute runtime directory as working directory,
starts the absolute private interpreter with ASCII relative script/library
arguments, and supplies ExifTool's `-config`/empty value before compilation of
the tool library. This preserves Unicode installation paths while preventing
ambient/developer module lookup. Managed entry selection requires both scripts;
it does not substitute another interpreter when the selected entry is missing.

The small change in `src-tauri/src/commands/staging_tags.rs` was reviewed
read-only: snapshot mtime before the ExifTool write, run the existing tag update,
then restore that mtime with `File::set_times` on the output path. The write no
longer relies on the optional Perl filesystem-time module. Metadata/backup/tag
verification behavior is retained. If mtime restoration fails after metadata
was written, the error explicitly describes that partial outcome rather than
claiming the file was unchanged. No concrete blocker was found in this fix;
the corresponding successful real Unicode/mtime test is still required in the
implementation owner's functional receipt.

**Verdict: merged source/licence/native closure and bootstrap review pass.**
This reviewer executed neither interpreter nor metadata tests. The lock's
redistribution flag was still false at inspection; the implementation owner may
clear its packaging gate after the required functional checks pass. Extracted
EXE/MSI payload verification and live Google acceptance remain separate gates.

## Superseded investigation

The earlier Oliver Betz package was inspected but is not selected:
`13,533,363` bytes, SHA-256
`577257dd22baebe77157d905792d6ed2c5916cd03aa627f40b2175db12110ac6`.
It contained Perl 5.32, GCC DLLs and a GMP-backed XS module; its notice ZIP did
not establish the patched GCC source/build closure. The GCC Runtime Exception
did not waive source obligations for the independently shipped libraries.
This led to the approved source-built replacement. Keep old staging only as
historical evidence; carry none of its binaries or provenance claims into the
new runtime.
