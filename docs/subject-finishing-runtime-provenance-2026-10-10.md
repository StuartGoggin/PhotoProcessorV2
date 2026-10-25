# Subject finishing: Windows runtime provenance checkpoint

Status: **evaluation evidence, not redistribution or release approval**. This pass inspected already-retained archives, signatures and publisher-owned source. It did not change the sealed CPU candidate, acquire CUDA, download a new Intel package, accept a new proprietary licence or change export qualification.

## Verdict and scope

**Upside:** the five previously uncertain Windows DLLs now have exact package membership evidence and valid publisher signatures. Python's CRT packaging intent and downstream conditions are independently identifiable.

**Downside:** package membership and signatures do not establish a redistribution grant. In particular, the retained Windows Intel OpenMP binaries are not covered merely by finding a macOS LLVM notice. Runtime terms, notices and source/replacement obligations must reach the actual installer.

**Verdict:** retain the evaluation candidate; close the narrow archive-origin checks below, but keep `redistributionApproved:false`. Do not replace libraries or rebuild the inference profile merely to make a notice inventory look complete.

**Alternatives:** where an exact Windows grant cannot be established, investigate a publisher-supported runtime with explicit redistribution terms or a separately validated source build. A different OpenMP DLL is not a drop-in fix to ship without ABI, performance and video requalification.

**Next step:** resolve the remaining grant/notice obligations against the exact production profile, then verify their inclusion after installer extraction. GPU speed and continuous-video quality remain separate gates.

## Exact retained evidence

Candidate root: `.build-cache/subject-finishing-manual-cpu-v1`. The following checks used SHA-256 of retained files and archive-member streams, not filename/version equality. `Get-AuthenticodeSignature` reported **Valid** for all five DLLs on this Windows host. Signature status is a current platform verification result, not proof of licensing or suitability.

| Retained DLL | Bytes | File / product version | SHA-256 | Verified containing archive |
|---|---:|---|---|---|
| `runtime/vcruntime140.dll` | 178,616 | 14.51.36247.0 | `D1F4225DF2CD877DBF130D5668A021DCE3F94118455FF5EC952061C30AFC9CE7` | Python embedded ZIP, member `vcruntime140.dll` |
| `runtime/vcruntime140_1.dll` | 50,112 | 14.51.36247.0 | `A7146C08F89FE5B04541AB507CDB59FF7B44534D4BA3C668A426C6450A03434E` | Python embedded ZIP, member `vcruntime140_1.dll` |
| `runtime/Lib/site-packages/torch/lib/libiomp5md.dll` | 1,617,536 | file 20260213 / product 5.0 | `DE6D18B2DEC5811F7932950282A4C8218C5F287DB04FF320DCBAA74733D6FCCE` | PyTorch wheel, member `torch/lib/libiomp5md.dll` |
| `runtime/Lib/site-packages/torch/lib/libiompstubs5md.dll` | 44,160 | file 20260213 / product 5.0 | `C477314C1B489C75455B9738452760CD275A254822762079E001E27F79EB25CB` | PyTorch wheel, member `torch/lib/libiompstubs5md.dll` |
| `runtime/Lib/site-packages/numpy.libs/msvcp140-a4c2229bdc2a2a630acdc095b4d86008.dll` | 575,056 | 14.40.33810.0 | `A4C2229BDC2A2A630ACDC095B4D86008E5C3E3BC7773174354F3DA4F5BEB9CDE` | NumPy wheel, exact same member name |

Microsoft signed the three CRTs; Intel signed the two OpenMP binaries. The NumPy DLL's hash-prefixed filename therefore does **not** itself establish a binary modification. No PE/import rewrite or upstream-original mismatch is asserted here.

The retained archives also matched their acquisition/lock hashes:

- `python-3.13.16-embed-amd64.zip`: `97DAE5274CC54867065E8D5A3226E48C35017ED332A0FDB0E27D5B5821961297`, under `.build-cache/subject-finishing-evaluation-cpu`.
- `torch-2.14.1+cpu-cp313-cp313-win_amd64.whl`: `4EEC5A4FADD7A18F9C75B97FDB374FBB579CE4B1604BF66EEB14DC2201D54DEF`, under the candidate's `wheelhouse`.
- `numpy-2.5.3-cp313-cp313-win_amd64.whl`: `71CAD2B2A7451AB79D8F5E71B453485B6775963D5CF794179144A7463FE6E8EC`, same wheelhouse.

The exact wheel publisher URLs and hashes are already recorded in [the manual evaluation wheel specification](../scripts/subject-finishing/runtime/wheels-manual-cpu.json) and [offline lock](../scripts/subject-finishing/runtime/requirements-manual-cpu.lock). No fresh artifact was downloaded for these comparisons.

## Python / Microsoft CRT

The retained `runtime/LICENSE.txt` and the embedded ZIP's `LICENSE.txt` match exactly: 33,861 bytes, SHA-256 `62BEC384DF47B0328307DB41455FF6EA2559E5546B394AC69148561B21703120`.

CPython v3.13.16 explicitly packages `vcruntime*.dll` and `LICENSE.txt`; its build properties locate the runtime files under the Visual Studio redist CRT directory. This independently supports intentional Python distribution membership, rather than an incidental loose DLL. Fresh source reads found those operations at `PC/layout/main.py:201–207` and `PCbuild/pyproject.props:246–251`. [CPython layout](https://github.com/python/cpython/blob/v3.13.16/PC/layout/main.py), [CRT selection](https://github.com/python/cpython/blob/v3.13.16/PCbuild/pyproject.props).

Python's Windows conditions permit conditional interpreter redistribution and require downstream protection of Microsoft's distributable code. Preserve these terms, platform restrictions and notices in the delivered runtime; do not infer that Python's licence alone grants rights to every independently obtained CRT. [CPython Windows conditions](https://github.com/python/cpython/blob/v3.13.16/PC/crtlicense.txt).

Microsoft's release lists distinguish redistributable release files from non-redistributable debug files and condition rights on applicable Visual Studio terms. They are useful grant references, not proof of this user's particular tool entitlement or of an upstream package's complete downstream conditions. No licence acceptance or entitlement assertion was made in this pass. [VS 2026 redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution), [VS 2022 redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution).

## Windows Intel OpenMP

The cached PyTorch wheel is now the verified immediate origin of both exact signed DLLs. Its retained `torch/version.py` identifies source revision `5c4886908584029761b579af026dcfb627c84070`; the public source tree exists. The Windows dependency script names MKL dependencies but does not, by itself, bind these DLL hashes to an Intel licence/redist list. [Pinned PyTorch dependency recipe](https://github.com/pytorch/pytorch/blob/5c4886908584029761b579af026dcfb627c84070/.ci/pytorch/windows/build_install_deps.py).

The wheel's `third_party/llvm-openmp/LICENSE.txt` begins with a statement about **macOS** `libomp.dylib`. It is not recorded as the controlling grant for these Windows Intel-signed DLLs. No separate Intel redist designation was found in the narrow retained-wheel check.

A subsequent bounded read-only check verified the retained Torch `METADATA` SHA256 `CB0F1C6B8DA448E869095B3A10865CFEF25F67935341A5DA305D59B1CF6D5B02`. It declares a compound Apache/BSD/BSL/MIT expression and lists `third_party/llvm-openmp/LICENSE.txt`; it does not provide an Intel originating-package, agreement/version or exact-DLL designation mapping. The retained OpenMP notice SHA256 is `EB3EAB74FE9245818659556ACF23E81B8C8A24915A4A244A23804F3FCDF1FD9C`. Its opening statement explicitly discusses macOS LLVM binaries from conda-forge. This confirms the notice's stated context; it does not establish which grant governs these Windows binaries.

The pinned PyTorch top-level licence was freshly retrievable and contains its own BSD redistribution conditions, without naming these Intel DLLs or supplying their exact-package mapping. It cannot by itself close this component-specific evidence gap. [Pinned PyTorch licence](https://raw.githubusercontent.com/pytorch/pytorch/5c4886908584029761b579af026dcfb627c84070/LICENSE).

The reviewer limited this delta check to six primary-source searches/opens. The pinned dependency recipe and Windows wheel-build script could not be retrieved through that check; this is an access/retrieval limitation, **not evidence that those files do not exist**. No additional package/terms mapping was found. A useful next evidence source is the originating Windows dependency receipt/SBOM plus accompanying Intel terms, or an explicit publisher statement covering both retained hashes. No package was acquired, no terms accepted and no sealed payload changed; `redistributionApproved:false` remains unchanged.

Intel's public terms say the supplied agreement controls; their Developer Tools terms permit only designated redistributables, subject to product-only distribution and downstream restrictions. The page also treats download as acceptance. A public copy cannot establish which terms accompanied these exact binaries. This is an unresolved evidence question, not a conclusion that OpenMP distribution is prohibited. [Intel agreements](https://www.intel.com/content/www/us/en/developer/articles/license/end-user-license-agreement.html).

The publisher metadata for `intel-openmp 2024.2.2` names the Developer Tools EULA. Its Windows wheel is a **candidate to investigate**, not a proved binary match: 3,602,214 bytes, SHA-256 `900fe6d93127b2e3f9ac41f2d7fa2e636bb94afcb8a12c75331f4f60052be4da`. It was not downloaded, and no new EULA was accepted. Acceptance-sensitive acquisition is paused pending appropriate authority if it becomes necessary. [Intel-published metadata](https://pypi.org/project/intel-openmp/2024.2.2/).

### Verified alternative licensing route, not an exact-binary grant

Intel's January 2020 NuGet guide identifies Windows OpenMP runtime packages (`intelopenmp.redist.win`) distributed under its Simplified Software License. It also treats package download as agreement to the terms. This establishes a publisher-described alternative to the Developer Tools route, not the terms of the retained 2026 DLLs. [Intel NuGet guide](https://www.intel.com/content/www/us/en/developer/articles/guide/installing-performance-libraries-using-nuget.html).

The October 2022 Simplified Software License conditionally permits unmodified binary redistribution, with retained notices and terms, no unauthorized endorsement, reverse-engineering/modification restrictions and separate treatment of third-party files. Reading that licence did not accept it or establish that it governs this candidate. [Intel Simplified Software License](https://cdrdv2-public.intel.com/749362/intel-simplified-license-software-october-2022.pdf).

Intel's compiler documentation independently identifies `libiomp5md.dll` as the Windows parallel runtime and `libiompstubs5md.dll` as the serial stubs library. Identity by name still does not bind either retained hash to a particular package or licence. [Intel OpenMP support libraries](https://www.intel.com/content/www/us/en/docs/fortran-compiler/developer-guide-reference/2025-0/openmp-support-libraries.html).

**Decisive evidence still missing:** a publisher-backed package containing both exact retained DLL hashes, with its supplied agreement/version, redistributable designation and downstream obligations. The comparison below could establish an applicable official-package route without reconstructing Torch's historical acquisition. Acquisition requires separate approval; substitution and shipment require the completed checks. Neither the historical guide nor a current public licence alone closes this gate.

### Intel NuGet package comparison candidates

The versioned NuGet catalogue narrows the next comparison to `intelopenmp.redist.win 2026.1.0.239`. The March and April packages have different member sizes from the retained Torch DLLs and therefore cannot be exact full-byte matches. Both checked July versions have matching sizes, but the catalogue supplies no DLL hashes. Matching sizes identify candidates, not binary equality, Torch's acquisition history or a redistribution approval.

| Intel package version | Published | Main DLL bytes | Stubs DLL bytes | Exact size comparison |
|---|---|---:|---:|---|
| [2025.3.3.31](https://api.nuget.org/v3/catalog0/data/2026.03.25.10.37.25/intelopenmp.redist.win.2025.3.3.31.json) | 25 March 2026 | 1,614,184 | 43,880 | Both differ |
| [2026.0.0.944](https://api.nuget.org/v3/catalog0/data/2026.04.24.14.12.45/intelopenmp.redist.win.2026.0.0.944.json) | 24 April 2026 | 1,617,256 | 43,880 | Both differ |
| [2026.1.0.239](https://api.nuget.org/v3/catalog0/data/2026.07.01.15.15.39/intelopenmp.redist.win.2026.1.0.239.json) | 1 July 2026 | 1,617,536 | 44,160 | Both match sizes only |
| [2026.1.1.327](https://api.nuget.org/v3/catalog0/data/2026.07.29.14.19.23/intelopenmp.redist.win.2026.1.1.327.json) | 29 July 2026 | 1,617,536 | 44,160 | Both match sizes only |

The earliest of these matching candidates is **2,163,555 bytes**. Its catalogue declares SHA512 `sKYiZqZEDhNTthJ+h+5LpJaL9mlVvR4EL+t+6inqseXbjhGku44VvCSyGCAWvu+jPklepq2MZbYUCvJ5HQ1D9Q==` and the [registration](https://api.nuget.org/v3/registration5-semver1/intelopenmp.redist.win/2026.1.0.239.json) supplies its exact archive URL. This digest is publisher metadata, not an independently computed package hash. The target paths are `runtimes/win-x64/native/libiomp5md.dll` and `runtimes/win-x64/native/libiompstubs5md.dll`; a permitted archive comparison must hash their unchanged member streams against the literal retained identities above.

The [exact version's displayed licence](https://www.nuget.org/packages/intelopenmp.redist.win/2026.1.0.239/License) is the Intel Simplified Software License, October 2022. It conditionally permits unmodified binary use and redistribution, requires retained notices and terms, restricts endorsement and reverse engineering/modification, and treats identified third-party files separately. The catalogue includes `share/doc/compiler/licensing/openmp/third-party-programs.txt` at 31,578 bytes; that file's contents and the actual packaged licence must be inspected before notice closure.

The [standalone nuspec](https://api.nuget.org/v3-flatcontainer/intelopenmp.redist.win/2026.1.0.239/intelopenmp.redist.win.nuspec) names Intel Corporation, `license.txt` and `requireLicenseAcceptance:false`. The flag is not Stuart's consent or evidence that download has no agreement consequence. Its served length also differs from the catalogue's nuspec entry, so it is not treated as a byte-verified archive member. Intel's [NuGet guidance](https://www.intel.com/content/www/us/en/developer/articles/guide/installing-performance-libraries-using-nuget.html) expressly treats downloading as agreement; its January 2020 date remains distinct from the exact 2026 package licence.

Acquisition awaits one explicit decision: inspect this single candidate under those terms, with a 4 MiB download cap, no installation/execution and no alteration of the sealed runtime. A full match would establish an Intel-published package containing identical DLL bytes and supplied terms; it would not retrospectively prove how Torch acquired them. A mismatch must retain the unresolved classification, not trigger automatic package replacement or an unapproved second download. Main-agent metadata reads and an independent four-request review agree on the candidate sizes, package digest and displayed licence. No package was acquired or terms accepted; `redistributionApproved:false` and `installerQualified:false` remain unchanged.

## NumPy CRT / OpenBLAS

The retained NumPy wheel proves the exact renamed CRT's immediate origin. A fresh PyPI metadata read independently matched its 12,560,965-byte size, publisher URL and archive SHA-256. The publisher's versioned Windows repair script vendors DLL dependencies with `delvewheel`. Its licence does not list a separate Microsoft grant. An applicable upstream/downstream CRT grant and final installer terms remain to be recorded; valid signing and filename changes do not settle those rights. [Exact NumPy release metadata](https://pypi.org/project/numpy/2.5.3/), [Windows wheel repair](https://github.com/numpy/numpy/blob/v2.5.3/tools/wheels/repair_windows.sh).

The retained wheel's `numpy-2.5.3.dist-info/DELVEWHEEL` records **1.11.2** and an OpenBLAS-directory repair input. In contrast, the v2.5.3 source requirement pins **1.12.1**. Therefore the versioned recipe is build context, not an exact receipt for this wheel's repair environment or CRT acquisition. This discrepancy does not assert tampering or a different DLL hash. [Versioned repair-tool requirement](https://raw.githubusercontent.com/numpy/numpy/v2.5.3/requirements/delvewheel_requirements.txt).

NumPy's versioned project metadata explicitly distinguishes its source-built licence expression from PyPI wheels containing additional vendored components. The retained wheel licence (SHA-256 `A804DFF0EAD9FADC5293456410BCBFC32BF024BE9C4513459663FB7B442D2341`) maps its additional terms to `libscipy_openblas*.dll`, not to the renamed Microsoft CRT. That leaves a CRT-specific terms mapping unresolved; it is not a finding that NumPy's licence is incompatible. [NumPy licence metadata](https://github.com/numpy/numpy/blob/v2.5.3/pyproject.toml).

Microsoft's listed direct redistribution routes condition rights on the applicable Visual Studio licence and unmodified files. This page alone does not prove that every downstream wheel distributor needs a separate Visual Studio purchase. Record the applicable upstream/downstream route for the exact CRT, or an independently applicable direct route, before redistribution. No entitlement or legal approval is inferred here. [Microsoft CRT redistribution conditions](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution#visual-c-runtime-files).

The retained NumPy licence explicitly maps `numpy.libs/libscipy_openblas*.dll` to OpenBLAS, LAPACK and GCC runtime terms, including the GCC runtime exception. Its generated configuration records Windows x64, MSVC 19.44.35228 and OpenBLAS 0.3.34.106.0. Preserve that binary-to-notice mapping; do not apply NumPy's top-level BSD grant to every bundled component or claim a source rebuild occurred. The pinned publisher workflow supplies build context, not a substitute for the retained wheel's terms. [NumPy wheel workflow](https://github.com/numpy/numpy/blob/v2.5.3/.github/workflows/wheels.yml).

The retained OpenBLAS DLL is `libscipy_openblas64_-ed4f167a5330424524f45258e7ca2c8d.dll`, SHA-256 `ED4F167A5330424524F45258E7CA2C8D7F03C0CBA1F30EE4985553AC1F88ECF8`. BSD does not itself impose a source-offer requirement; the GCC exception is not a finding that PhotoGoGo as a whole must become GPL. Component-specific build eligibility and obligations must be considered separately.

## Obligations still open

1. Record the controlling Windows Intel OpenMP grant, redistributable designation and downstream conditions for the exact chosen production binaries.
2. Carry applicable CRT conditions, notices and protective downstream terms into the real installer; resolve the independently bundled NumPy CRT grant.
3. Carry the now-verified [model/source subset and covered Python source](subject-finishing-model-source-checkpoint-2026-10-10.md) into the installer with notices, source-access information and applicable rights. The retained-source identity check is closed; installed-payload and applicable LGPL replacement-route checks are not. Retained `tqdm` metadata says `MPL-2.0 AND MIT`; preserve that distinction.
4. Remove unsupported unused CLI launchers from a **new** production pack or establish their publisher/transformation provenance and notice closure. Never mutate the sealed evaluation candidate in place.
5. Verify the exact qualified runtime, models, source/notice material and terms after installer extraction. A notice index alone is not installed-payload closure.

The earlier 33-component notice stages remain unchanged and `redistributionApproved:false`. The new Python binding stage below narrows one notice-association gap; it does not qualify NVIDIA speed, whole-clip visual quality, public export or release. See [the delivery qualification checkpoint](subject-finishing-qualification-2026-10-10.md).

## Python component notice binding on 11 October

The offline [notice staging command](../scripts/prepare-subject-runtime-notices.mjs) now binds exactly the two Python-packaged CRTs in the table above to the complete retained Python licence and its Windows conditions. It freshly reads and verifies both DLLs against their literal sizes/hashes and the sealed inventory's `python-embed` origin, but copies no DLLs into the notice stage. Archive membership remains attributed to the earlier comparison, not reverified by this command.

The recorded route is `cpython-windows-binary-build`, classified as conditional evidence. The publisher's conditions address that Windows binary build rather than individually naming either DLL hash. They require protective downstream terms for Microsoft's component, preservation of notices and restrictions on endorsement, platform and unlawful use. This association is not a standalone CRT grant, recipient assent or a finding that Stuart must buy Visual Studio. [Pinned CPython Windows conditions](https://raw.githubusercontent.com/python/cpython/v3.13.16/PC/crtlicense.txt).

Fresh output: `.build-cache/subject-finishing-notices-aca64cbb-df9b-4e85-b401-f727a4c15a5b`; receipt SHA-256 `9d9f6684478129c907e500e86596b352fcd9bab40e9448b7dc2d21b08215dbe7`. Its 191 ordinary files retain the 33 package components, 147 declared notices, four upstream supplementals and 37 covered Python source files. The generated `python-windows-conditions-guide.txt` is a separate explanatory artifact, not another upstream licence: 1,558 bytes, SHA-256 `9381073b2c213f7ab449d049bc320d411c3e40626e1234bfc49152ed0f12aeec`. The complete staged Python licence still matches the 33,861-byte identity above.

Both public-stage additions failed before implementation and passed afterwards. All **51 metadata/filesystem/staging regressions** pass. The tests read actual command output and files, check literal component identities and absence of staged DLLs, compare complete licence bytes and verify readable guide content while keeping approval false. Independent source-only review found no material defect; the main agent executed the tests and independently read back the fresh receipt and hashes.

`recipientTermsVerified`, `installedAvailabilityVerified`, `redistributionApproved` and `installerQualified` remain false. The exact Intel package/agreement mapping and the independently bundled NumPy CRT grant still require separate evidence. Appropriate recipient terms and actual installer inclusion/extraction remain required; staging this guide does not meet those obligations. The frozen runtime inventory, both Python CRTs, Python licence and portable picture ZIP have unchanged hashes. No runtime was executed, package acquired, terms accepted, media changed, installer built or Slack message sent for this slice. The representative-footage repair count remains **one of two**, with correction behaviour still awaiting Stuart's choice.
