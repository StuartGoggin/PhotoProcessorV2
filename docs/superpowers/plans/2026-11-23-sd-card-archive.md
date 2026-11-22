# SD Card Archive Implementation Plan

**Goal:** Make a verified, restorable copy of a selected card volume through PhotoGoGo Jobs.

**Architecture:** Freeze a read-only inventory at preflight. Use the import source scheduler and bounded copy pipeline, with per-file checkpoints in a private repository directory. A final verification receipt authorizes a no-overwrite directory publication. Project durable jobs into core Jobs.

**Tech stack:** Rust, Tauri, React, and existing hashing, scheduling and metadata tools.

**Scope:** The user-approved SD Card Archive brief. Validate only with synthetic sources unless a disposable card is explicitly provided.

- [x] Inventory scope, safe paths, date fallback, manifest and independent offline verification.
- [x] Bounded copier, recovery, cancellation, identity checks and final publication.
- [x] Register durable jobs, controls, settings and menu. Add the live transfer graphic and actions.
- [x] Run native and browser regressions and a bounded synthetic baseline comparison. Record hardware limits.

## Validation

- Windows native suite passed 492 tests, with 32 opt-in tests excluded. SD Card Archive cases covered exact paths and bytes, Unicode, empty directories, offline verification, changed card identity or tree, interrupted publication, damaged checkpoints, repeat archives and a destination collision immediately before publication. The reader lease test covered the physical-device lane.
- The production frontend build passed. Nine Edge checks exercised the actual PhotoGoGo interface and Jobs controls with simulated native responses. Screenshots and the report are in `test-output/sd-card-archive-browser/`.
- Physical card removal, an out-of-space write and a disconnected network share were not reproduced on real hardware. The automated fixtures cover card identity mismatch, an unusable destination and insufficient space in the UI. Card-reader saturation and wired and Wi-Fi repository throughput still need hardware measurements.

### Optimized local benchmark

Both methods used the same local Windows volume for source and destination. The straight-copy baseline flushed each file. The archive measured copy, independent verification and publication. These are synthetic fixture results.

| Fixture | Straight copy | Verified archive | Sustained reader rate | Reader waiting for queue space |
| --- | ---: | ---: | ---: | ---: |
| Two 64 MiB clips | 68.04 MiB/s | 66.42 MiB/s | Below minimum measurement interval | 0 ms |
| 256 mixed 8 KiB and 2 MiB files | 8.59 MiB/s | 8.11 MiB/s | 8.38 MiB/s | 1,054 ms |

The mixed run exposed destination-verification backpressure on shared local storage. The large-file run recorded no queue wait and finished the reader phase within the measurement interval. These results do not establish physical card or network throughput. See `test-output/sd-card-archive-throughput.log`.
