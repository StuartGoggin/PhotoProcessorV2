# Native render-PC readiness handoff - 11 October 2026

Status: the first hardware-readiness control package is built and independently relocated/tested. It is not a video benchmark, finishing release, installer, CUDA qualification or image-quality acceptance. The full subject-finishing delivery goal remains active.

## Delivered control artifact

- Retained ZIP: `test-output/subject-handoff-readiness-package-v2/PhotoGoGo-Readiness-Test.zip`.
- ZIP size: 184,781 bytes; SHA-256 `3b70f98ee41df927f4423e4c3be3198479c5005f1ad2ace800ab5e5cacab08df`.
- Normal native executable SHA-256: `d6616923983e690a35c681adcd8e41d292f44891318febff265c4e0d7fa152ae`.
- Eleven package files, including the native executable, instructions, matching PhotoGoGo-owned source, the exact development build receipt, validation evidence and package inventory.
- No test-fault binary, FFmpeg, Python/Torch/NumPy, SAM model, CUDA runtime or footage is bundled. The executable is unsigned. Do not bypass an organizational/security block to run it.

The matching normal build is `test-output/subject-handoff-readiness-v7`; the separately marked, unshippable fault build is `test-output/subject-handoff-fault-v7`. Old failed/partial build and test evidence remains retained and was not overwritten.

## Executed validation

Six public native CLI/report checks passed with before/after source, executable and build-receipt binding:

1. Ordinary local report publication and path-free shared JSON.
2. Competing write-capable ancestor handle refused before hardware inspection.
3. Existing report/sentinel preserved, junction refused and nonexistent volume rejected at the volume gate.
4. Invocation through an actual file-level executable alias refused before creating an output directory.
5. Injected unknown failure reduced to a fixed redacted code, with no output publication.
6. Controlled hardware stall ended through the native two-second deadline and owned inspector drain; the external harness did not supply the timeout. A prior green observation was about 2.21 seconds including process startup/drain.

The packager independently read the real PE load configuration/imports: dependent-load flag `0800`, six expected system DLL imports and no external VC runtime prerequisite. Actual PE dumper version is recorded separately from the compiler-directory version.

`scripts/test-subject-handoff-package.mjs` then created the final ZIP, extracted it to a different new folder with spaces, checked the exact inventory and every file's size/hash, ran the relocated native executable against a new report path with spaces, read its returned report, and rechecked all delivered files and the transport ZIP. The create-new `delivery-validation.json` was flushed and read back successfully.

The native interactive folder picker has not been exercised through UI automation. It remains a first-user test; the exercised command-line interface is documented as an alternative. There was no live mapped-network-drive test: the missing-volume refusal was exercised, while fixed/removable-only admission was independently source-reviewed. Do not describe either unexecuted case as a passed test.

## Test-first corrections and independent review

The public checks exposed actual defects before their corrections: attribute-only directory access did not enforce the intended Windows sharing policy; pipe output gained CRT CRLF conversion; EOF could precede process exit; arbitrary exceptions escaped the fixed-code claim; and a leased executable reparse leaf was admitted. The implementation now uses read-capable directory leases with no write/delete sharing, byte-exact child output, bounded exit drain, a public error whitelist and ordinary executable-leaf checks. The bounded read-only reviewer identified the final leaf defect; the public alias regression reproduced it and passed after the surgical correction.

No changes were made to the production worker, sealed inference runtime, app export gate, stabilization caches or originals for this readiness slice. No merge/push, installer build, driver change, render-PC installation, third-party download or Slack release publication occurred.

## Next media slice, not yet implemented

This section records the original readiness-only checkpoint. The subsequent [cached-picture handoff qualification](subject-picture-handoff-qualification-2026-10-11.md) documents the separately built and relocated/media-tested benchmark kit; it does not modify this earlier delivered readiness ZIP.

An independently inspected retained cached-mask benchmark path avoids shipping the unresolved inference runtime. The unchanged managed FFmpeg backend has 28 files / 55,909,162 bytes, manifest SHA-256 `8276c56a5dc3ddef5d8dd9ff0b3dc6fc65247d1587cc33b92d00e23be65540b2`, and matching corresponding-source archive SHA-256 `27f7cd21a21e661314d76fe4689f7e4d92b0c0e13bc101376e8443e10eec8fd8`.

The two retained normalized excerpts and matching caches are each 100 frames, 3840x2160, 50 fps, two-second SDR709 bases. Their base/cache/manifest identities and exact AAC integrity are already recorded in the earlier cached-throughput evidence. Both cases plus the retained worker and unchanged media/source package total approximately 149.3 MB before a new controller/evidence package. This is an identified input set, not a delivered benchmark kit.

The next public handoff must enforce exact relocated payload/cache identity, owned process-tree deadlines and cancellation, new output directories, finite disk/memory/diagnostics, explicit CPU versus D3D backend with actual adapter attribution, and full decoded-frame/profile/timing/AAC checks. It may measure cached-mask picture/decode/encode throughput and support short visual comparison. It cannot establish CUDA inference speed, segmentation accuracy, stabilization or whole-clip quality. The unresolved admitted CUDA profile/runtime acquisition/distribution and representative continuous visual acceptance remain full-goal gates.
