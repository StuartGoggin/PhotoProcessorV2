PhotoGoGo subject-finishing: hardware readiness test
==================================================

This is a small Windows x64 test utility, NOT an installer or the completed
sharpening feature. It helps us check your render PC without running Codex there.

No Codex, Node, Python, CUDA toolkit or development tools are required.
The utility installs nothing, changes no drivers or execution policies,
processes no video, and does not stop or restart a render.

How to use it
-------------
1. Copy this ZIP to the render PC and extract it into a NEW ordinary local folder.
   Do not run it inside the ZIP. Avoid network drives, junctions and cloud-folder
   redirects. Keep the complete extracted package together.
2. Open bin and double-click PhotoGoGo-Finishing-Test.exe.
3. Choose an ordinary local folder where you would like the report saved.
   The utility creates a NEW PhotoGoGo-Finishing-Report-{identifier} subfolder.
   It never overwrites an existing report or project.
4. Open that new subfolder and attach readiness-report.json in the Codex chat.
   You do NOT need to send the whole ZIP or any of your videos.

The hardware inspection has a 30-second deadline, with up to 2.5 seconds to
confirm the owned inspector has stopped, and a 512 MiB child-memory cap.
The folder picker is outside that deadline. Cancel the picker to stop without
creating a report. Normal report size is under 64 KiB.

The native command-line/report workflow and controlled failure tests have been
exercised on the development PC. The interactive picker still needs your first
render-PC use; this package does not claim a completed GUI or NVIDIA media test.

If you prefer PowerShell (no policy change is needed to launch an EXE):
  & '.\bin\PhotoGoGo-Finishing-Test.exe' --preflight 'D:\PhotoGoGo-readiness-001'
Choose a NEW destination under an existing ordinary local parent. If that folder
already exists, choose a different name. The command refuses overwrite.

Privacy and security
--------------------
The JSON contains CPU count, available memory, graphics-adapter descriptions and
capabilities. It does not contain your media, chosen folder, project paths,
hostname, username or environment variables. Please still inspect it before
sharing. Failure diagnostics use fixed codes, not raw filesystem/driver errors.

This is an UNSIGNED test utility. package-receipt.json includes the exact file
hashes. SHA-256 checks detect changed files; they are not a publisher signature.
If SmartScreen, antivirus or an organizational policy blocks it, stop and tell
me the exact warning. Do not disable protection, change policy or run as admin.

What the report means
---------------------
nvidiaAdapterPresent means an NVIDIA adapter was enumerated. d3d11ShaderReady
means the default graphics adapter could initialize the picture-filter shader.
These are DIFFERENT checks; the default adapter might not be NVIDIA.

cudaInferenceReady, mediaTestReady, subjectQualityAccepted and
productionExportQualified are deliberately false. This utility does not test
segmentation, NVENC, sharpening quality, throughput, stabilization or export.

Next is a separately labelled bounded cached-mask picture benchmark on the
render PC, followed by the separately admitted inference/quality tests. This
readiness package is not a shortcut around those checks or runtime licences.

Package contents
----------------
bin/PhotoGoGo-Finishing-Test.exe: native readiness utility.
evidence/: exact development build and readiness-validation receipts.
source/: matching PhotoGoGo-owned utility/headers and development build script.
package-receipt.json: package inventory and hashes.

No FFmpeg, Torch, NumPy, SAM model, CUDA runtime or original footage is bundled.
The source build script is for the DEVELOPMENT PC only; do not run it on the
render PC. The utility uses the render PC's existing Windows system libraries.
