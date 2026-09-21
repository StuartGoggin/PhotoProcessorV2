# Parallel pixel-row stabilisation: local proof, not an installer

22 September 2026 (Australia/Sydney). Approved experiment: parallelise the
pixels of each stabilised frame without splitting the clip into independently
stabilised chunks. The installed PhotoGoGo and FFmpeg were not replaced.

## Result

The isolated planar, bicubic 4K transform scales strongly when OpenMP divides
destination rows among workers. No interpolation or framing quality was reduced.

| OpenMP threads | Mean transform time across four observations | Relative throughput |
| --- | ---: | ---: |
| 1 | 276.667 ms/frame | 1.00x |
| 6 | 73.518 ms/frame | 3.76x |
| 12 | 47.651 ms/frame | 5.81x |

Each observation is the upstream benchmark's fastest of three five-frame sweeps,
not a full-render average. Two sessions each ran 1/6/12 then 12/6/1 threads.
There was substantial timing variation: serial observations ranged from
234.593 to 393.933 ms/frame. The two sessions separately showed 3.69x/3.82x at
six threads and 5.60x/5.97x at twelve. These are exploratory measurements on a
Core Ultra 7 165H, not a performance promise for the i7-8700 render PC.

The timed benchmark includes transform prepare/finish around a fixed nonidentity
transform; it excludes motion analysis, decoding, sharpening, scaling, encoding,
audio, disk publication and concurrent render jobs. Do not infer whole-render
speed from these numbers.

## Correctness checks

- Actual OpenMP team sizes were checked, not merely requested through an
  environment variable.
- All twelve timed observations produced warm-up output FNV-1a hash
  `036bab438d6c4b91`.
- Selected upstream regression suite passed at both 1 and 12 threads in both
  sessions: 9 tests / 400 checks per invocation.
- A separate comparison used `vsTransformPrepare`, `vsDoTransform`, and
  `vsTransformFinish`, comparing every output byte with `memcmp`, not a hash.
  All 192 frame pairs matched serial output exactly.
- That comparison exercised 640x360 and 3840x2160 YUV420P, 1 versus 6/12 threads,
  eight changing source frames/transforms, black/keep borders, and separate,
  in-place and alternating buffer ownership. Transforms included identity,
  half-pixel offsets, rotation, off-frame shifts and zoom-out. Out-of-place
  input buffers were also checked for unintended changes.

This proves equality between thread counts on the pinned newer implementation
for the tested cases. It does **not** prove equality to the older installed
library, camera-path equivalence, audio sync, successful NVENC integration,
bounded production-queue memory use, or long-duration stability.

## Source, artifacts and reproduction

Pinned upstream: `e2445c4081658318223762a696eb1c645c2d7168` (vid.stab 1.4.0).
The relevant upstream [row-parallel commit](https://github.com/georgmartius/vid.stab/commit/579cd3698ae75bd5184b28bb4f15cfce0b0ad8ab)
divides independent destination rows using static OpenMP scheduling.
The evaluated HEAD also contains unrelated algorithm and SIMD changes, so it
must not be described as a minimal production backport.

Local diagnostic-only changes are retained in
`scripts/diagnostics/vidstab-row-benchmark.patch`: Windows timer support,
thread-count instrumentation, bicubic/black-border timing, byte-equivalence
checks and a CMake benchmark target. The production transform was not edited.

Artifacts:

- `test-output/vidstab-rows-20260921T204325381Z/report.json`: first successful
  timing and regression run, 13.2 seconds.
- `test-output/vidstab-rows-20260921T205006478Z/report.json`: second successful
  timing/regression run plus byte-equivalence test, 64.2 seconds.
- The latter folder's `row-equivalence.log` records all 192 comparisons.
- `test-output/vidstab-rows-20260921T204224968Z/report.json`: rejected earlier
  attempt, missing thread-count instrumentation in a stale binary. Excluded
  from the table. A fresh rebuild resolved that harness issue.

Build: existing Visual Studio 2022 BuildTools, MSVC 19.44, x64 Release,
`USE_OMP=ON`. No compiler or system package was installed. Existing upstream
numeric-conversion warnings were emitted; they were not silenced.

SHA-256 of final binaries and diagnostic patch:

```text
rowbench.exe  84D03AA6115CF31BCC282DB1D362640B1D64FEBA304D90BA7479814F1BE6665A
tests.exe     DB6F9DC52F80A6E3CD9A4DE7374BBEAD52164B9E1F916BABB47CCD540DDEBD42
source patch  7340307C556A81027A1C9AECCAD1A5F96A5F94ADD323F00DBBE911F79A9357BA
```

From the repository root, with a checkout of that exact upstream commit at
`test-output/parallel-vidstab-source`, apply the diagnostic patch **once**:

```powershell
git -C test-output/parallel-vidstab-source apply ../../scripts/diagnostics/vidstab-row-benchmark.patch
$rowCmake = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
& $rowCmake -S test-output/parallel-vidstab-source/tests -B test-output/parallel-vidstab-build -G 'Visual Studio 17 2022' -A x64 -DUSE_OMP=ON
& $rowCmake --build test-output/parallel-vidstab-build --config Release --target rowbench tests --parallel 4
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/benchmark-vidstab-rows.ps1 -FramesPerSweep 5 -TotalTimeoutSeconds 180
```

The current local checkout already has the patch. Reverse-apply `--check` was
used to verify the saved patch matches those local modifications. The runner
refuses to start alongside local FFmpeg/PhotoGoGo processes, launches hidden
children, enforces per-child/total time limits and only terminates its own child
on timeout. It uses synthetic data, not private footage.

## Blue-team verdict and release gate

**Upside:** proceed with pixel rows. It targets the measured transform cost
without the temporal joins and camera-path discontinuities of chunking.

**Downside:** this proof uses a newer library in a standalone harness. Existing
FFmpeg statically includes its older vid.stab. A DLL swap or a PhotoGoGo thread
setting cannot insert the new loop into that binary. Taking all of upstream
1.4.0 would also import algorithm changes outside the requested smallest fix.

**Preferred next step:** a separately approved, isolated FFmpeg build with a
narrow row-parallel backport to a pinned compatible vid.stab baseline. Preserve
the current codec/encoder support, distribution notices, Quality settings and
resource-admission budgets. Use the existing process-local `PHOTOGOGO_FFMPEG`
override to exercise that binary, without changing PATH or installed tools.

Validation before a test installer:

1. Establish serial versus parallel output equivalence on the narrow backport.
2. Run the same complete Quality pipeline and compare decoded frames,
   durations, frame counts, timestamps and audio sync, including B-frame input.
3. Verify actual NVENC encoding on suitable hardware and measure full-render
   throughput, working set and concurrent-job behaviour under existing limits.
4. Run native/app tests and package only the verified binary and required
   dependencies with an explicit version, hashes and rollback path.

Stop and report if the build repeatedly fails, pixel equivalence fails, required
encoder support is missing, resource use exceeds the existing budget, or the
full pipeline does not improve. Do not mask failure with quality reductions.

## Approved build: preflight blocked

Stuart approved the isolated FFmpeg/backport, full-pipeline validation and
conditional test-installer step on 22 September 2026. That approval stands;
the same implementation decision does not need to be asked again.

Before downloading the toolchain or starting compilation, local preflight found:

- C: had only 2.65 GiB free. No other filesystem drive was listed (the Temp
  drive is an alias on C:). This is insufficient safe headroom for a separate
  compiler/toolchain, dependency builds, two comparison binaries, fixtures and
  installer staging. Use a conservative minimum of 10 GiB free before resuming;
  that is this task's safety budget, not a published FFmpeg minimum.
- This project's Rust release `deps` and `build` directories occupy about
  1.90 GiB and 0.65 GiB respectively. Removing them would reclaim only about
  2.55 GiB, would discard useful build caches, and they would be recreated by
  subsequent builds. No cleanup was performed.
- The only named local video controller was Intel(R) Arc(TM) Graphics,
  driver 32.0.101.8508. No NVIDIA GPU was reported. NVENC execution therefore
  cannot be validated on this machine; that release gate still requires
  suitable NVIDIA hardware, such as the render PC, with a separately authorised
  bounded test. An encoder appearing in `ffmpeg -encoders` is not execution proof.

Next user action: make at least 10 GiB free on C:, or provide a suitable other
build volume and path. Resume the already-approved build after that check passes.
Do not delete unrelated files, change PATH, install system packages or touch the
render PC to work around these constraints.

No performance-fix installer exists yet, no dependency/toolchain was downloaded
for this build step, no remote render process was touched, and the Slack
follow-up remains paused. Production source has no content diff from HEAD.

## Low-disk continuation (supersedes the 10 GiB preflight budget)

Stuart cannot free the previously requested space and asked to work within the
available capacity. The 10 GiB threshold was conservative, not a hard build
requirement. It has been replaced for this experiment with a staged approach:
reuse fixtures, avoid duplicate build trees/debug symbols, extract only the
needed portable compiler components, use NTFS compression in the new compiler
directory, and stop owned test/build processes before free disk falls below
1 GiB. This is a best-effort build budget, not proof that every release step fits.

The already-cached Gyan FFmpeg 9.0.2 package lists vid.stab
`v1.1.2-214-ge2445c4`. Its ZIP SHA-256 matched the publisher's
[checksum](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256):
`60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`.
Testing that package required no new media download or full raw-video output.

`scripts/test-low-disk-ffmpeg.ps1` reuses the earlier 50-frame 4K50 B-frame
fixture and first-pass motion file. It checks source identity, frame count,
completion, every frame checksum and frame timestamps against the baseline.
It has a 1 GiB disk reserve and bounded process/total runtime.

Both broad-upgrade candidates were rejected by the equivalence gate:

- `test-output/low-disk-ffmpeg-20260921T224149561Z/report.json`: default camera
  path, 17.987 seconds, changed output.
- `test-output/low-disk-ffmpeg-20260921T224251674Z/report.json`: explicit
  `optalgo=gauss`, 16.759 seconds, still changed output.

The older library maps its unimplemented optimal-path choice to Gaussian; the
newer one can actually solve the L1 path. Explicit Gaussian alone did not recover
exact output in this test. No claim is made about the remaining difference's
cause, perceptual severity or acceptability. No broad upgrade was installed or
packaged, and no speedup is claimed from those rejected runs.

For the narrow-backport route, these sources were staged under
`test-output/ffmpeg-row-backport`:

| Component | Pinned revision / integrity |
| --- | --- |
| FFmpeg n8.1.1 | `239f2c733de417201d7ad3b3b8b0d9b63285b2b1` |
| vid.stab v1.1.1 | `90c76aca2cb06c3ff6f7476a7cd6851b39436656` |
| nv-codec-headers n13.0.19.0 | `e844e5b26f46bb77479f063029595293aa8f812d` |
| x264 stable snapshot | `b35605ace3ddf7c1a5d67a2eb553f034aef41d55` |
| Intel VPL v2.17.0 | `d77f9195cf495b937631607333288fd917ae8939` |
| w64devkit x64 2.10.0 archive | SHA-256 `18d0a4c71a166f8401ab6305781bec5882b40b5e06ba9807c61cb5f3b3c6325e` |

The compiler archive is 64.02 MiB and verified against the official GitHub
release asset digest. The retained archives/checkouts total approximately
214.52 MiB of logical file data. No source patch has yet been applied to this
older library, no compiler has been extracted, and compilation has not begun.

### Extraction launch failure (unresolved; alternate compiler route below)

Archive listing, ordinary read-only PowerShell and source downloads succeeded.
Attempts to launch the extraction command failed before extraction, including:

```text
CreateProcessAsUserW failed: 5 (Access is denied.)
```

The tool identified the PowerShell process launch as the failure. This does not
establish whether Codex's runner, Windows policy or security software caused it.
A targeted read of recent Defender events produced no evidence resolving the
cause. No security settings were changed and no alternative mechanism was used
to bypass the denial. The new compressed `compiler` directory remains empty.

At the final check, C: had 1.961 GiB free and no FFmpeg, PhotoGoGo, compiler,
make, 7-Zip or curl process was running. Free space changed during preparation,
so a live reserve check remains necessary; do not attribute all disk movement
to this task's approximately 214.52 MiB of staged files.

Resume when normal process-launch/extraction permission is available, keeping
the low-disk limits and unchanged-pixel gate. The existing implementation
approval remains valid. No deletion, system installation, PATH change, driver
change, remote test or installer deployment has been performed.

## No-restart compiler recovery verified, 22 September 2026

Stuart has other Codex tasks running and cannot restart the application. No
restart, process termination of another task, global permission change, security
setting change or persistent environment change was performed.

The tiny extraction of just `w64devkit\VERSION.txt` still failed at PowerShell
process creation, including through the normal approved-command route and the
sandboxed terminal transport. Archive listing and ordinary workspace-directory
creation succeeded. No alternative interpreter or extraction implementation was
used to bypass that denial. Its root cause remains unproven. There were no
matching events in the bounded recent Defender, AppLocker and Code Integrity
checks; this does not rule out other security policies or a runner fault.

A different dependency strategy has a verified first step: use the already
installed Visual Studio MSVC compiler instead of extracting a new compiler.
The small isolated compiler test exposed two problems in the sandboxed route:

1. The environment contained both `Path` and `PATH`, and MSBuild failed with
   `MSB6001: Item has already been added ... 'Path' ... 'PATH'`.
2. A case-insensitively canonicalized child environment removed that failure,
   after which MSBuild's `FileTracker` failed with `E_ACCESSDENIED`.

The same small compile/run test succeeded through Codex's supported per-command
approval route. This does not disable the sandbox globally or alter its ACLs.
The approved process already had one PATH entry in the final repeat; child-only
canonicalization is retained defensively and must not be represented as a
persistent fix to Codex's parent environment.

Reusable probe: `scripts/diagnostics/test-existing-msvc.ps1`. Source fixture:
`scripts/diagnostics/existing-msvc-probe`. It uses one compilation worker,
two OpenMP runtime threads, hidden children, a 120-second total time limit,
a 1.2 GiB start threshold and a 1 GiB running disk reserve. It only terminates
its own children on timeout/reserve failure. Logs contain tool output, not
environment-variable dumps. PATH entries from the parent are preserved and
deduplicated in child processes only.

Read-back-verified result:
`test-output/ffmpeg-row-backport/existing-msvc-probe/report.json`:

- `complete: true`, all three commands exit 0.
- Configure 8.595 seconds; compile 2.351 seconds; execution 0.107 seconds.
- Runtime result: `existing_compiler_openmp_threads=2`.
- MSVC 19.44.35229, x64 Release, OpenMP found.
- Test EXE SHA-256:
  `0027887C912ED7504FA91140E747B4F11FC6BE43717C659C67446299A20FEAB3`.
- C: free at the final check: 1.439 GiB. This is shared with other active work,
  so every later build must recheck its reserve.

This clears the installed-compiler smoke-test gate without restarting Codex.
It does **not** establish that the entire FFmpeg dependency build will work or
fit. FFmpeg's source documents an MSVC route but also requires shell/make and
assembler tooling; GNU make and NASM were not found in the checked existing
locations. Those prerequisites, full-pipeline unchanged-pixel validation,
throughput validation and installer validation remain outstanding. No production
FFmpeg was replaced and no test installer was created by this recovery step.
