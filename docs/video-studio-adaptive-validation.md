# Adaptive Video Studio: render-PC acceptance

Target: Windows 11, Intel i7-8700 (6 cores / 12 logical processors), 16 GB RAM,
NVIDIA RTX2060 6 GB, working NVIDIA driver, Video Studio **Quality / two-pass**.

The pass criterion is more completed video per unit of wall time without quality
changes, instability or unacceptable memory pressure. Neither 100% CPU nor 100%
GPU is a required outcome. Native tests and local synthetic smoke tests cannot
prove a speedup on this separate render PC.

## Keep the comparison fair

1. Use the same application build, FFmpeg binary/version, NVIDIA driver, input
   clips in the same order, trims, titles, transitions and output location/device.
   Save these settings once. Use at least six comparable real clips, long enough
   for the adaptive controller to settle, with more than one worker's worth of
   work waiting. Keep the source files unchanged.
2. Compare **A: adaptive scheduling off** with **B: adaptive scheduling on**, both
   using the same Max performance mode. Keep Quality / two-pass, stabilisation
   preset/custom values, interpolation, resolution, frame rate, bitrate, encoder
   selection and audio settings identical. Record the *actual* encoder shown by
   the job; reject a comparison where one run silently fell back from NVENC.
3. Make a **new empty output root** for every run, for example `A1`, `B1`, `B2`,
   `A2`, on the same disk. The fragment cache lives under the output root as
   `.photogogo-video-studio-cache`, outside individual render folders. A new render
   folder inside a reused output root does **not** guarantee an uncached run.
   Do not delete existing footage or caches. Record cache hits and exclude any
   run with reused fragments from this cold-fragment-cache comparison.
4. Run one queue at a time in order **A1, B1, B2, A2**: two repetitions of each
   configuration with reversed ordering in the second pair. This reduces, but
   does not eliminate, disk/OS-cache and temperature bias. Use the same idle
   recovery interval between runs. Do not reboot, change power plans or update
   software midway. If results disagree, add another reversed pair and report
   the spread instead of choosing the best result.
5. Close optional heavy applications before *both* variants. Keep AC power,
   Windows power settings and any essential background programs constant.
   Don't disable security software or change driver clocks/power limits.

## Measure an existing render safely

The following sampler does **not** launch a render or change scheduling. Start it
in a separate PowerShell window while your queue is running. Sample a comparable
part of each run; record the phase and UI aggregate progress beside the sample.
Use a fresh label for each sample. The default is 60 seconds at two-second
intervals; the maximum requested sampling window is 300 seconds.

```powershell
.\scripts\measure-video-studio-load.ps1 -RunLabel fixed-A1 -DurationSeconds 60
.\scripts\measure-video-studio-load.ps1 -RunLabel adaptive-B1 -DurationSeconds 60
```

Run each command during its corresponding render, **not both during the same
run**. The script saves `samples.csv` and `summary.json` under a new timestamped
`test-output/video-studio-load-*` folder. It records system CPU, available/total
RAM, and separate NVIDIA kernel/encoder/decoder activity plus used/total VRAM.
It does not save source names, process command lines, usernames or raw GPU XML.
An unavailable measurement is `N/A`, not zero. NVIDIA query failures/timeouts
are shown as status values; they do not stop or reset the GPU/render. Use
`-SkipGpu` to gather CPU/RAM only. Windows counters do not require WMI; unavailable
native APIs still degrade to `N/A`. NVIDIA query children have a two-second timeout
and are created without visible windows. Bounded query cleanup and receipt writing
may finish slightly after the sampling window. The Windows CPU counter is scoped
to the calling processor group on machines with more than 64 logical processors;
that limitation does not affect the target i7-8700.

These are system-wide counters, not PhotoGoGo-only measurements. NVIDIA's kernel,
video encoder and decoder percentages measure different engines and must not be
added together. CPU-only stabilisation analysis may legitimately leave the video
encoder idle. [NVIDIA counter definitions](https://docs.nvidia.com/deploy/nvidia-smi/index.html)

Record these facts for **every** run:

| Measurement | Record |
| --- | --- |
| Variant / order | A1, B1, B2 or A2; app build and mode |
| Work | Clip count and total intended output duration; stable anonymous clip IDs |
| Elapsed wall time | Queue start through verified final completion, including analysis/assembly |
| Throughput | Total identical output seconds divided by wall seconds |
| Queue state | Actual encoder, phase, active workers, thread allocation, scheduling reason |
| Load | CPU distribution; RAM minimum; encoder/decoder/kernel load separately; VRAM maximum |
| Correctness | Completion status, cache hits, output checks, playback checks, responsiveness |

Preserve `verification.json` from each final render folder. Logs/project files
can contain private paths and titles: review/redact them before sharing. The
sampler's output alone cannot establish a speedup; pair it with full queue times.

## Output and safety acceptance

- For each output, verify expected width, height, frame rate, duration, frame
  count and audio stream presence/channels/sample rate. Compare every A/B pair,
  not just one representative file. Use the saved verification receipt and, if
  necessary, a separate read-only FFprobe check after rendering has completed.
  `-count_frames` decodes the file and adds load: never include that check in the
  rendering timing window. Metadata equality is **not** visual equivalence.
- Watch matching sections from A and B, including camera movement, edges/crop,
  titles/transitions and audio synchronisation. Ensure no changes to the selected
  stabilisation preset, quality, resolution, frame rate, bitrate or encoder.
  Hardware encoding/thread scheduling need not produce byte-identical files.
- Verify queue controls stay responsive, cancellation stops owned processes,
  and resuming/retrying does not corrupt previously completed outputs. Perform
  cancellation testing as a separate short acceptance run, not in timed A/B runs.
- Stop the experiment if there is a crash, out-of-memory error, driver reset,
  sustained paging/UI unresponsiveness, or available RAM stays below 1 GiB for
  about ten seconds. Record the failure and switch adaptive scheduling off for
  a subsequent run. Do not force-kill processes or create artificial memory
  pressure to rescue a score. The 1 GiB stop rule is a conservative operator
  guard for this 16 GB machine, not the scheduler's normal RAM target.
- Accept a speed improvement only if repeated full-queue times improve beyond
  their run-to-run variation and the correctness/safety checks pass. If the result
  is neutral or slower, preserve the receipts and tune/review the controller; do
  not describe increased utilisation alone as success.

Optional manual metadata check (replace the literal paths; run after timing):

```powershell
& 'C:\path\to\ffprobe.exe' -v error -count_frames -show_entries 'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration,channels,sample_rate:format=duration' -of json 'C:\path\to\completed-output.mp4'
```

Frame counts may need an expected tolerance for variable-frame-rate source trims,
but the same intended project should give consistent output timing/frame policy.
Do not silently excuse a mismatch. [FFprobe documentation](https://ffmpeg.org/ffprobe.html)

## Developer checks before the installer is sent

Run from the repository root on a machine with the existing build prerequisites:

```powershell
node scripts/test-video-studio-ui.mjs
.\scripts\test-video-studio.ps1
.\scripts\invoke-npm.ps1 run build
```

The native script imports the MSVC environment and runs the locked release-profile
`studio` tests using the existing build cache. `test-video-studio.ps1 -Smoke`
additionally includes ignored FFmpeg/process tests: these perform actual small
renders and are **not** a read-only counter sample. Use them as a deliberate,
separate developer acceptance step.

For the existing release path, when dependencies are already installed and the
optional face bundle is not required:

```powershell
.\scripts\build-release.ps1 -SkipDependencyInstall -SkipFaceBundle
```

No command above is automatically launched by the sampler. The pre-existing
`benchmark-video-studio.ps1` compares stabilisers/encoders using synthetic video;
it does not drive the production adaptive queue and cannot replace this A/B test.

Required coverage includes controller settling/noise, stale or missing telemetry,
RAM/VRAM pressure, performance regression/backoff, phase changes, fairness across
jobs, the one-clip tail, permit release on failure/cancellation, adaptive-off
compatibility, and queue diagnostics/settings persistence. Tests should target
the actual permit/launch seam as well as the pure policy, so a fixed-size caller
cannot accidentally prevent a policy increase from taking effect.
