PhotoGoGo - cached subject-finishing comparison
Windows 11 x64 validation kit. NOT an installer or production finishing release.

13 October 2026 controller repair: verified NVIDIA cases may contain the exact
ordinary empty NVIDIA Corporation/umdlogs driver directory structure. No log
files or other extras are accepted, read or included in the return-report ZIP.
Existing CPU/NVIDIA observations remain valid for their original kit; do not
mix reports from different runner builds into one comparison.

1. Copy this entire ZIP to the render PC and extract ALL files to a short local
   folder, for example D:\PG-Test. Do not run the executable inside the ZIP.
2. Let active renders finish normally. This kit does not stop or detect them.
3. Double-click bin\PhotoGoGo-Cached-Picture-Test.exe. Choose a short ordinary
   local results folder with at least 512 MiB free, tick the idle confirmation,
   then select Run four tests. Nothing starts until you choose to run it.
4. The kit creates a NEW PG-Test-xxxxxxxx results folder. It runs two supplied
   two-second UHD samples, once on CPU and once on explicit NVIDIA D3D11, one
   case at a time. NVIDIA absence/failure stays failed; it is not substituted.
5. Use Open results. Copy ONLY PhotoGoGo-Return-Reports.zip back to the computer
   with this Codex conversation and attach it here, even if NVIDIA cases failed.
   This small ZIP contains reports and verification markers, not videos,
   private filesystem paths or an environment dump.

You do NOT need Codex, Python, Node, a compiler, FFmpeg installation, admin
rights, a driver update, an execution-policy change or a reboot on that PC.
The runner is unsigned. If Windows or organizational policy blocks it, report
the exact warning. Do not disable protections, run as administrator or change
policy to get around a block.

Cancel or close waits for this test's owned process cleanup. Completed case
evidence is retained, and incomplete cases have no valid completion marker.
If stopped before the return ZIP is created: open each COMPLETED case-n folder
and select only picture-report.json and its matching
picture-report.<hash>.committed file. Compress JUST those selected files into
a small ZIP and return it with the stop code shown in the window. Do not zip
the whole result folder; that includes videos. Missing marker means incomplete.

What this measures
- Fixed cached-mask filtering with subject-only sharpening/colour and software
  libx264 encoding; existing cached bases are not re-stabilized.
- All 100 decoded/output frames, CFR timing, SDR709 profile and 95 original AAC
  packets must verify before a case receives its hash-bearing completion marker.
- One sequential observation per case, not a statistical speedup prediction.
- Filter/transfer, native decode/filter/encode, render-owner wall and complete
  validation wall times are distinct. Peak memory is render-job committed bytes,
  not GPU VRAM, working set or the entire-session peak.

What this does NOT prove
- No inference runtime/model is bundled: no automatic mask/CUDA inference speed.
- No NVIDIA hardware video encoder or stabilization algorithm is being tested.
- The black sample shows a mounted rider; the white sample shows a handler.
  Two-second cached masks do not establish complete horse-and-rider suitability.
- No continuous-playback, bokeh/edge quality, correction UI or whole-clip quality
  acceptance. Production export remains unqualified and disabled in the app.
- A successful CPU or Intel development-PC test is not RTX 2060 evidence.

Bounds and retained files
Each case has a 90-second render budget, 180-second deadline checkpoints,
64 MiB output cap and 4 GiB owned-job committed-memory cap. The session runs
four cases sequentially. Local synchronous disk IO may delay a checkpoint or
cancellation; the deadlines are not a physically hard limit on blocked IO.
No originals, app/project settings, installed software or drivers are changed.
No network upload occurs. The kit creates only the new selected result folder.
Keep the complete media/source/notice tree intact; payload identity is checked.
Do not follow the legacy backend README's installation/rollback steps for this
kit: it is portable and requires no installation or rollback.

See NOTICE.txt and the matching source/licence material included with this kit.
