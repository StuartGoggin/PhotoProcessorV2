# Cached-picture diagnostic controller repair — 13 October 2026

## Scope and outcome

The returned black-horse CPU/NVIDIA observations remain valid for the original
kit. This repair changes only diagnostic case inventory validation and its final
session recheck. It does not change sharpening, masks, stabilization, encoding,
app settings, inference readiness or the fail-closed production export gate.

The previous checker accepted the verified NVIDIA case without extra directories
and returned `REPORT_COMMIT_FAILED` after adding the exact empty directory tree
present in `testresults.zip`. The failure also reproduces with just the empty
`NVIDIA Corporation` root. The user's historical stop code was not supplied, so
this demonstrates the compatibility defect without claiming to prove that exact
historical termination.

## Safety policy

Only after checking the report, output bytes, marker and adapter identity may a
non-CPU case reporting NVIDIA vendor `0x10de` contain an ordinary empty
`NVIDIA Corporation` directory, optionally with the sole empty `umdlogs` child.
Both named directories are leased before child enumeration. Unknown entries,
files, nesting, reparses/junctions and non-NVIDIA/CPU exceptions refuse.

Each successful case is rechecked before session publication. Directory leases
block replacement but do not freeze arbitrary new descendants; the final recheck
narrows that race, not an atomic-emptiness guarantee. Driver contents are never
read, executed, copied or included in the return ZIP. Nonempty logs remain refused;
separate owned incidental scratch would be a later alternative if real logs occur.

## Executed validation

- Native harness includes the actual controller implementation and calls its
  `checked_case_report`; it does not duplicate the inventory algorithm or render.
- Before repair: unchanged NVIDIA case passed; observed and minimized driver
  structures deterministically failed `REPORT_COMMIT_FAILED`.
- After repair: all 21 native acceptance/refusal checks passed. These cover CPU,
  explicit/default NVIDIA, non-NVIDIA default GPU, extra files/directories,
  root/child junctions, retained leases, late child creation, and output/report/
  completion-marker tampering.
- Native builds passed `/O2 /W4 /WX /MT` with the existing compiler and Windows SDK.
- Separate real-checker/native-report-ZIP/safe-extractor round-trip passed with
  the accepted incidental directory case. Its 1,898-byte ZIP contained exactly
  the report and matching marker, with no video or driver-directory entries.
- New candidate completed four supplied two-second cases on the development PC:
  CPU, Intel default GPU, Intel default GPU, CPU. All four passed. The 14,730-byte
  session return ZIP contained only eight case report/marker files plus the two
  comparison report/marker files. This is not NVIDIA target-hardware evidence.
- Package qualification passed refusal, owner admission, timeout/descendant drain,
  report-reader corruptions, build/input attribution and report ZIP round-trip.
- Independently extracted/relocated package: exact 56-file inventory and hashes,
  source/payload closure, paths with spaces, actual CPU media execution with
  100 frames and 95 AAC packets, unchanged package after execution all passed.
- Independent read-only review found no P1/P2 defect. Its report-ZIP coverage gap
  was closed by the separate accepted-incidental-case round-trip described above.

The local native harness initially needed unsandboxed execution for its directory
leases; default sandbox refusal was not mistaken for a product failure. An initial
ZIP-test assertion also incorrectly forbade `.mp4` text inside report JSON; it was
corrected to assert exact extracted ZIP-entry inventory instead of forbidding the
legitimate output filename reference. Neither was a media-quality repair attempt.

## Repaired portable kit

- Local artifact:
  `test-output/subject-picture-driverfix-package-20261013/PhotoGoGo-Cached-Picture-Test.zip`
- Bytes: **98,243,741**.
- SHA-256: `e3b913056261e9705fb8309e98d5d4fdfa8e368e60a4f4dcd196d05ab18316ad`.
- Runner SHA-256: `38a0ee8f386ba75e09f4524d1ed473a7f2db4e59ea81bdb339346b2cf20faa83`.
- Changed controller header SHA-256:
  `adff54746634b516bb2fdf0cf55348e8390856ea4d9899e09fa96accad0f7c89`.
- Unsigned portable diagnostic kit; **not an installer or production release**.
- Original retained kit and results are unchanged. Do not mix reports from the
  old and new runner builds into a claimed four-case comparison.

Slack transfer/publication is recorded separately after acknowledgement and
visible read-back; package qualification alone is not a delivery receipt.

## Remaining gates

Collect the new four-case render-PC reports while the machine is idle. Continuous
horse/rider/bokeh quality, CUDA mask inference/runtime distribution, correction
semantics and useful full-pipeline throughput remain unqualified. No subject
finishing installer, commit/merge/push or production release is claimed here.
