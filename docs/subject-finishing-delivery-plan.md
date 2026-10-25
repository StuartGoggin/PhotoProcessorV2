# Subject aware video finishing delivery plan

PhotoGoGo will offer optional finishing filters that improve the horse and rider while preserving the deliberately blurred background. Image quality takes priority over processor utilization. Existing stabilization methods and defaults remain available, and finishing edits must not invalidate their reusable base renders.

## Approved scope

Stuart approved this delivery goal on 10 October 2026: research the current algorithms, implement in an isolated worktree, use two bounded research and review helpers, coordinate with the stabilization fork, validate the integrated application, and build and release the result. Horse and rider are selected together by default; colour and light changes affect the selected subject unless whole-frame corrections are explicitly enabled.

Existing Quality renders may be reused with a warning that their background already contains global sharpening. An explicit clean-base regeneration option is required for stricter bokeh preservation. Newly prepared subject-finishing footage should use a separately identified clean-base profile. Regeneration must never be automatic, overwrite originals, or silently discard an existing cache.

## Processing interface

The integration seam is immediately after verified stabilized-base production or reuse and before clip titles, replay derivation and scorecards. A finishing module accepts the base identity, effective settings, colour interpretation and a versioned subject-mask recipe; it returns a verified finished-picture artifact and diagnostics. Disabled finishing is a strict no-op. The assembled project consumes these pictures through the existing sequence and audio workflow.

The stabilized-base identity and the finished-picture identity are distinct. Filter strength and subject-selection edits invalidate the finished picture and affected finishing graphics, not camera-motion analysis. Finished identity includes the base checksum, algorithm version, effective settings, mask model and prompt versions, and colour profile. Replays use the same corrected source picture rather than estimating another mask at slow-motion frame intervals.

An already assembled external video has baked-in graphics. Such a route must either preserve explicitly identified graphic regions or clearly state its limits; it cannot claim to restore separate layers from pixels.

## Algorithm selection gates

- Compare temporally tracked, correctable masks against the close-up and wider original samples Stuart will supply. Do not use a human-only matting model as evidence of horse suitability.
- Evaluate conservative contrast-adaptive and noise-gated detail enhancement. Generative detail synthesis, super-resolution and automatic deblurring are outside the initial default.
- Preserve original picture values outside the selected subject before export encoding. Protect the subject fringe and uncertain regions from sharpening spill, ringing and confidence-loss flicker.
- Reset temporal state at cuts; bound frame, embedding, anchor and mask-cache storage over long videos. Invalid or uncertain selection must reduce or bypass correction, never switch to whole-frame sharpening.
- Confirm the exact code, weight and runtime distribution licences and pin the artifacts before dependency selection or release.
- Interpret transfer function, range, primaries and chroma explicitly. The current Studio export is 8-bit H.264; a float filter alone does not add a high-bit-depth colour-managed export path.

## Quality and performance acceptance

The agreed test interfaces are saved-project loading and editing, native preview and render commands, resulting picture frames and audio, cache reuse, and cancellation/recovery. The initial test-first slice checks that legacy projects default to disabled finishing and unchanged picture behavior. Later slices test the real worker and preview/export rather than mocks of private internals.

Quality gates cover the horse and rider's shape, stable mane/rein/leg edges, no new halos or invented texture, unchanged bokeh outside the mask, smooth confidence transitions, and deliberate tracking composition. Frame sequence, timestamps, duration and audio alignment must remain valid, including cuts, short clips, tails and replay derivation.

Performance measurements include complete uncached finishing time and cached-mask reuse, not shader-only timings. Record decoder, segmentation, filter, transfer, encoder and mux timings, CPU use, GPU engine use, memory high-water marks and fallback reasons. Tune bounded overlap of decoding, mask inference, image kernels and encoding; do not force 100 percent CPU and GPU occupancy at the expense of quality or throughput. Intel Arc development-host results are not RTX 2060 results.

Stop for a user decision after two bounded repair attempts for a repeated quality failure, an unsuitable selected dependency or licence, or integration conflicts requiring a behavior choice. Do not publish a quality claim before representative sample acceptance.

## Integration and release

Subject finishing is isolated on branch `SWG/subject-finishing`. The stabilization owner abandoned and rolled back GPU Tripod to baseline `2cd9b18`; the finishing tree has now removed the inherited active experiment while retaining its finishing additions. Fast and Quality remain the supported methods. Historical experimental selections and output provenance are rejected rather than silently converted or reused. Keep the main checkout's source/index and unrelated `scripts/test-video-studio.ps1` and `assets/` work untouched.

Integration must retain legacy saved projects and cache identities, preserve immutable queued render requests, and reject invalid settings before processing. Native workers run with bounded input sizes, validated paths, explicit arguments and application-owned cancellation. No media, masks or identifiers are uploaded for inference.

Release requires source and browser regressions, worker/video checks, installer extraction and identity checks, runtime and model closure, matching licences and hashes, integration and remote-ref read-back, then delivery and message read-back in GoggoVille `#swghermes`. Release delivery does not authorize installation, driver changes or interrupting renders on the render PC.

## Approved user-run handoff (11 October 2026)

Stuart approved the revised build-here / test-there / return-report workflow. Codex and development tools are not required on the render PC. Finishing qualification uses existing stabilization methods and exact cached bases; it does not depend on the abandoned experimental stabilizer. The isolated source has not been merged into the main checkout.

The agreed handoff seams are the user-launched native test executable, its bounded local excerpt request, its comparison artifacts and redacted report, and the existing native picture/media and app render interfaces. Test these public interfaces, not private implementation helpers. Start with one hardware/readiness tracer slice, then add the actual bounded video test to the same launcher; readiness alone is not the completed handoff or feature. No test may promote an evaluation runtime, fabricate whole-clip acceptance, or bypass production export qualification.

The launcher must require no Python, Node or Codex installation for readiness, install nothing, change no drivers or execution policies, create only a new user-selected report directory, and never overwrite artifacts. Media tests additionally require exact source/mask/runtime/tool binding, retained leases, a supervised worker tree, bounded wall/memory/disk/diagnostics, cancellation drain, frame/audio verification and completion-marker-last publication. Any dependency acquisition or installation remains a separately explained approval step. Do not send a package containing unqualified third-party runtime files.

## Current qualification checkpoint

The [11 October integration and session checkpoint](subject-finishing-integration-qualification-2026-10-11.md) records the surgical removal of the retired stabilizer, preservation of the finishing pipeline and a test-first fix for unnecessary preparation invalidation. Dormant Off/Fast rotation edits now retain the prepared base; effective Quality rotation changes still invalidate it. The full Studio browser regression, five finishing UI fixtures, fourteen workflow tests and TypeScript checks pass; the unchanged native binary passes 133 tests with 19 ignored. These checks do not qualify automatic subject quality, NVIDIA inference, public export or the installer. The correction-behaviour decision, one-of-two footage repair count, runtime acquisition approval and release gates are unchanged.

The [Intel NuGet comparison candidates](subject-finishing-runtime-provenance-2026-10-10.md#intel-nuget-package-comparison-candidates) narrow the exact-DLL comparison to the July 2026.1.0 package: both catalogue member sizes match, unlike the checked March/April packages, and the exact version displays the Intel Simplified licence. Member hashes and packaged notices remain unverified. One bounded, inspection-only download awaits explicit approval because Intel treats acquisition as agreement; no software was acquired, replaced or executed. This evidence does not qualify runtime distribution, image quality or the installer.

The [11 October Python notice binding](subject-finishing-runtime-provenance-2026-10-10.md#python-component-notice-binding-on-11-october) closes the exact Python CRT-to-notice association in offline staging. Both DLLs are freshly hash-checked but not copied; the full licence and an explicitly explanatory guide are readable, and 51 notice/filesystem/staging regressions pass. Recipient assent, installed availability, the separate Intel/NumPy grant mappings and release qualification remain open. This does not change the mask policy, correction-behaviour decision, one-of-two footage repair count, frozen runtime or test ZIP.

The [11 October real-correction checkpoint](subject-real-correction-qualification-2026-10-11.md) binds private candidates to unchanged CPU dependencies. The 26-frame baseline completes; the repeated point-only correction refuses at horse frame 2 with IoU 0.0094. A manually inspected whole-horse box plus the same point completes, but changes earlier frames and leaves the clicked leg below sharpening eligibility. All 26 union-alpha comparisons and selected native-pixel crops are recorded; they do not qualify continuous quality or independent rider invariance. Diagnostic-only object/direction/IoU wording passes all 14 guard regressions. Count the prompt remedy as the first bounded repair attempt for this case. Prefix-preserving tracked-frame refinement is proposed, pending the editing-behaviour decision and separately versioned tests. No guard was weakened; the frozen runner, app admission and portable picture ZIP remain unchanged.

The [11 October selected-edge inspection](subject-edge-treatment-qualification-2026-10-11.md) exercises six actual UHD frames with non-neutral grading and conservative detail. Zero-alpha bypass, mask/border exclusion, grade activation and bounded detail pass, and four native-pixel crop sheets were inspected. The older black-horse shoulder hole is not reproduced in the inspected newer baseline; that is not proof of an algorithm fix. The later real-correction checkpoint above records actual prompt failures and comparisons. Still inspection does not qualify continuous quality, the frozen runtime or the delivered ZIP.

The [11 October identity-reacquisition checkpoint](subject-mask-reacquisition-qualification-2026-10-11.md) reproduces and closes an unreferenced visible/empty/visible transition inside a tracking window. The v3 policy preserves safe absence and permits named-object correction, including reverse traversal, without silently qualifying v1/v2 caches. Fourteen owned synthetic jobs, recipe/cache suites, TypeScript and the existing browser regression pass. This is not confidence smoothing or uninterrupted offscreen tracking; the empty-window-seed limitation, real correction effectiveness, continuous bokeh and release/runtime gates remain open. The frozen runner and delivered test ZIP are unchanged.

The [11 October object-scoped correction checkpoint](subject-mask-correction-qualification-2026-10-11.md) reproduces and fixes a horse-only prompt waiving the rider's independent adjacency/overlap checks. The generation policy is versioned consistently, with old caches and sealed runners preserved rather than relabelled. Targeted synthetic job, recipe, cache and browser checks pass; representative correction effectiveness, continuous image quality and fresh app/runtime qualification remain open. The existing portable cached-picture ZIP is unchanged; local availability is not proof of Slack publication.

The [11 October cached-picture handoff](subject-picture-handoff-qualification-2026-10-11.md) now provides a separate 98 MB portable native test kit with four sequential CPU/NVIDIA cases and a small report-only return ZIP. Exact package/source/payload identity and relocated real CPU media execution are verified. NVIDIA absence is exercised as an explicit partial result, not adapter fallback. The visible folder picker and actual render-PC run remain user tests; CUDA inference, continuous image quality and production export remain unqualified. This extends the handoff, not the goal's definition of done.

The [11 October native readiness handoff](subject-handoff-readiness-qualification-2026-10-11.md) records the delivered 185 KB control ZIP, six source/binary-bound safety checks and independent relocation/inventory verification. It runs without Codex or development tools on the render PC. Readiness is not the completed video-test handoff; all CUDA/media/quality/export qualification flags remain false. The next cached-mask picture benchmark uses a separately identified, unchanged managed media/source package and the retained exact sample/cache inputs, without redistributing the unresolved inference runtime.

See [10 October qualification evidence](subject-finishing-qualification-2026-10-10.md) for the executed preview, exact-frame user-review receipts, integrity and CPU bottleneck checks, plus the remaining NVIDIA, whole-clip visual acceptance, runtime distribution, integration and Slack delivery gates. Sampled review cannot qualify the algorithm or authorize export. This is an implementation/evidence checkpoint, not release acceptance. Enabled public export remains fail-closed.

The [Windows runtime provenance checkpoint](subject-finishing-runtime-provenance-2026-10-10.md) independently verifies retained DLL/archive origins and publisher signatures, while separating those findings from unresolved redistribution and installer obligations. It does not modify the sealed evaluation runtime or accept new proprietary terms.

The [model/source checkpoint](subject-finishing-model-source-checkpoint-2026-10-10.md) verifies the retained checkpoint and 40 SAM source files, stages only the runtime source subset and README, and identifies the already-present LGPL/MPL Python source. Its 14 synthetic regressions and read-back receipts do not qualify image quality, GPU throughput or redistribution.

The same checkpoint records the later offline notice/source stage: reviewed legacy classifications remain separate from original metadata, 37 covered Python modules are staged with identity checks, and 49 metadata/filesystem/preflight regressions pass. Installed availability, LGPL replacement compliance and release approval remain outstanding.
