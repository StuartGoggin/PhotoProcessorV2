# Canon CR3 originals and RAW development — research and proposal

Date checked: 27 October 2026 (Australia/Sydney).
Status: historical advisory design captured before implementation. The approved 2.0.42 implementation, user workflow, validation evidence and remaining limits are documented in [CR3 RAW Development](cr3-raw-development.md). The observations below describe the pre-implementation baseline; they are not a current release-status report.

## Recommendation

Treat CR3 as the immutable photographic master. Separate fast review using a camera-rendered preview from high-quality, full-resolution RAW development. Use a mature developer through a small, isolated worker interface rather than implementing a colour pipeline around a bare decoder. RawTherapee CLI is the leading quality-first candidate; compare darktable if GPU acceleration materially improves the same accepted output. Select and pin the backend after real-file quality/performance validation. Canon DPP is not installed and is not a prerequisite for implementation, validation or use.

## Verified current application boundaries

At source commit c0db31a3f3de5f9bcf9a13cadc7f9dc1c1608a72:

- Import and archive recognise CR3. Relevant code: src-tauri/src/commands/import.rs and archive_plan.rs.
- src/utils/lightboxCatalogue.ts includes CR3/DNG original entries and conservatively associates generated JPEG versions. A same-stem JPEG currently takes precedence for Photo Process lineage; RAW/JPEG pairs are not yet one explicit capture model.
- src-tauri/src/commands/lightbox.rs accepts JPEG/PNG content only, with bounded reads; it explicitly does not decode RAW. useReview.ts explains this limitation to the user.
- Photo Process Enhance/B&W source discovery uses collect_jpgs in process.rs. photo_process.rs::render_enhanced converts to RGB8. Adding a decoder alone would not preserve RAW adjustment headroom through the existing renderer.
- lightbox_crop.rs implements JPEG-based cropped derivatives. RAW cropping needs a saved recipe, orientation-aware coordinates and regenerated outputs.
- The current Google Photos plan does not validate RAW upload; it asks for a full-resolution JPEG version. This is an application validation boundary, not a claim that every Google Photos interface rejects all RAW formats.

## Primary-source engine findings

**Camera support.** LibRaw 0.22 explicitly lists EOS R6 Mark II. RawTherapee 5.13 also directly declares Canon EOS R6m2 in its camera constants; its bundled LibRaw header declares 0.22.2. These establish documented camera support, not exhaustive certification of every capture mode or a particular redistributed executable. Ordinary RAW and C-RAW remain required real-file acceptance inputs. [LibRaw list](https://www.libraw.org/supported-cameras), [RT camera constants](https://raw.githubusercontent.com/RawTherapee/RawTherapee/5.13/rtengine/camconst.json), [RT bundled decoder](https://raw.githubusercontent.com/RawTherapee/RawTherapee/5.13/rtengine/libraw/libraw/libraw_version.h).

**LibRaw role.** It extracts sensor data, processing metadata and embedded previews. Its authors explicitly exclude production-quality rendering from the scope of its basic conversion routines. It is useful infrastructure, but a premium developer would still need substantial colour/tone/detail processing around it. [LibRaw scope](https://www.libraw.org/about).

**RawTherapee candidate.** Official 5.13 was released 26 July 2026. It uses enhanced LibRaw and includes modern detail-preserving processing controls. Its dedicated CLI supports PP3 recipes, explicit destinations, JPEG and 16-bit TIFF/PNG. Final export should use the full-quality pipeline, not silently enable its optional fast-export mode. Treat this backend as multithreaded CPU/OpenMP; a production GPU path was not established. [Official release](https://rawtherapee.com/downloads/5.13/), [CLI options](https://rawpedia.pixls.us/command-line_options/), [pinned build configuration](https://raw.githubusercontent.com/RawTherapee/RawTherapee/5.13/CMakeLists.txt).

**darktable alternative.** Its official camera list includes R6 Mark II. Its documented core uses 4x32-bit floating-point buffers and supports colour management and OpenCL acceleration for many operations. Its CLI accepts processing history/XMP and output colour-profile options. Actual GPU availability and speed depend on the selected build, modules, device and driver, so the RTX 2060 should be probed rather than assumed to accelerate every stage. [Camera list](https://www.darktable.org/resources/camera-support/), [features](https://www.darktable.org/about/features/), [CLI](https://docs.darktable.org/usermanual/5.6/en/special-topics/program-invocation/darktable-cli/), [OpenCL](https://docs.darktable.org/usermanual/5.6/en/special-topics/opencl/activate-opencl/).

**Canon reference.** Canon describes RAW/C-RAW and same-file-number RAW+JPEG/HEIF capture, and recommends DPP for its RAW images. DPP provides Canon-specific rendering and lens tools, making it an optional visual reference only if already available. A supported public headless interface or redistributable DPP runtime was not established, so do not make DPP the automatic bundled backend without verifying that route. Do not promise another engine reproduces Canon Picture Styles/Digital Lens Optimizer exactly. [Camera image-quality manual](https://cam.start.canon/en/C012/manual/html/UG-04_Shooting-1_0030.html), [DPP tools](https://cam.start.canon/en/S002/manual/html/UG-04_EditImage_0040.html).

**Embedded previews.** ExifTool documents extraction of ThumbnailImage, PreviewImage and JpgFromRaw. The bundled ExifTool source also recognises CR3 JPEG streams. Probe available images and their dimensions; do not assume every embedded image is full resolution, sRGB or already correctly oriented. [ExifTool application examples](https://raw.githubusercontent.com/exiftool/exiftool/master/html/exiftool_pod.html).

## Proposed user workflow

1. **Import:** keep verified CR3 copies and existing checksum protection. Do not make SD-card import wait for RAW conversion or add competing source-card readers to generate previews.
2. **Lightbox:** show a fast preview immediately where available, label it Camera preview and display its resolution. Develop the selected image on demand for a true detailed view. Prefetch a bounded number of nearby capture previews, not all full RAW images.
3. **Capture grouping:** group an unambiguous RAW+JPEG pair into one navigation entry, with explicit Original RAW and Camera JPEG source choices. Keep ambiguous files separate. Do not pair different folders solely because basenames match.
4. **Photo Process:** add RAW Development within the existing page and core Jobs architecture. Provide job defaults and per-photo overrides, plus before/after preview, histogram/clipping indication and reset-to-as-shot/neutral controls.
5. **Develop and export:** produce selected full-quality outputs, verify planned dimensions/metadata, then show the generated versions under the same capture. Keep Google Photos checkboxes exact-version-specific.

A separate main navigation area for RAW is not necessary. The original/comparison layout can remain compact: the Original panel gains a clearly labelled source selector, and development controls open in a focused panel.

## Capabilities to include

| Area | Proposed behaviour |
|---|---|
| Supported sources | Ordinary CR3 RAW/C-RAW, RAW-only and unambiguous RAW+JPEG sets. Identify camera/mode and reject unsupported modes clearly. |
| Development controls | As-shot/auto/custom white balance, temperature/tint, exposure, highlights/shadows, black/white points, contrast, saturation and tone curve. Neutral and natural-detail presets with editable values. |
| Colour quality | Camera input profiling and a high-precision working pipeline; embedded sRGB for normal JPEG exports, optional explicit wide-gamut 16-bit TIFF. Convert late to 8-bit output. |
| Detail/noise | Separate luminance/chroma noise reduction; conservative edge/detail-masked sharpening. Avoid applying aggressive clarity or sharpening to deliberately blurred backgrounds. Offer mask/100% detail inspection where supported. |
| Lens treatment | Matching-profile distortion/vignetting/chromatic-aberration controls. An unavailable or ambiguous lens profile stays off with an explanation. Do not claim Canon DLO equivalence. |
| Orientation/crop | Respect portrait orientation once; retain correct output dimensions and normalise export orientation metadata. Save RAW crop/straightening as a recipe; offer the camera framing or full recorded area where available. |
| B&W/Enhanced | Independent branches from the same high-precision developed RAW base. B&W never depends on Enhanced. Preserve the existing B&W channel/strength and S-curve concepts, mapping them into a quality-preserving RAW path. |
| Output | Default full-resolution high-quality JPEG, no automatic rescale/upscale; optional 16-bit TIFF. Export must decode RAW and verify resolution, never reuse a screen thumbnail as the finished photo. |
| Metadata | Retain capture date/subseconds/timezone when present, camera/lens/exposure information, ratings/captions and colour profile. Apply output GPS/privacy choices without editing RAW bytes. Copy an allowlist of compatible metadata, not raw-container offsets or inconsistent orientation/dimensions. |
| Batch control | All/selected/rated/non-trash scopes, saved presets, per-photo overrides, core Jobs progress/cancel/retry and atomic no-overwrite publication. Log backend/profile/source identity and per-stage timings. |

For the 400mm f/2.8 photographs, the first quality gate is natural horse/rider detail with smooth bokeh: no halos, crunchy hair, amplified background grain, waxy denoising or exaggerated global contrast. Automated subject masks and advanced local editing can follow the reliable RAW baseline; they should not be a prerequisite for simply viewing/developing CR3.

## Precision, files and caching

Proposed pipeline: CR3 decode → high-precision RAW development → shared developed base → independent colour/B&W/cropped outputs → final colour transform and encoding. Avoid an intermediate 8-bit JPEG before RAW exposure, white-balance or tone edits.

Keep source CR3 bytes unchanged. Store portable recipes/source-output lineage with staging metadata; place disposable previews and working caches in a bounded app cache excluded from archival. Avoid retaining a huge TIFF for every source by default. Regenerate only stale owned derivatives; preserve previous good outputs until a replacement is validated.

Candidate naming: IMG_1234.CR3, existing IMG_1234.JPG, IMG_1234_developed.jpg and its explicitly owned B&W/Enhanced/crop versions. The ownership manifest, rather than suffix guessing, should connect the family and prevent collisions with an existing camera JPEG or a user-named original. Existing files must not be silently reclassified.

Cache keys need source identity/fingerprint, recipe, backend/build, camera/profile data, output colour space and requested size. Invalidate after actual source/recipe changes, not checkbox changes. Prioritise the visible image and discard stale preview results after navigation.

Bound CPU workers, decoded buffers, disk cache and GPU allocations. As a capacity illustration,6000×4000 pixels in a 4-channel 32-bit working buffer use 384 MB before additional buffers. Preview latency and final quality are stronger targets than forcing both processors to 100% or launching one job per core.

## RAW-burst and other limits

A Canon RAW-burst roll is a CR3 containing multiple images. Canon documents the distinction; current RawTherapee code has a burst-subframe feature, but PhotoGoGo still needs explicit frame selection, naming and timestamp handling. Detect rolls from the first release; either support them deliberately or present an explicit limitation. Never treat a representative preview as proof that all frames were imported/developed. [Canon RAW burst](https://cam.start.canon/en/C012/manual/html/UG-04_Shooting-1_0330.html), [RT subframe change](https://github.com/RawTherapee/RawTherapee/pull/7212).

A historical high-ISO R6 II C-RAW decoder artefact was corrected upstream. It supports pinning and testing a current decoder, not claiming that current C-RAW is unsupported. [Upstream fix](https://github.com/darktable-org/darktable/pull/16065).

Highlight recovery has physical limits; do not promise reconstruction of information never recorded. Embedded camera previews may legitimately look different from a neutral RAW development. RAW source-file admission limits should be separate from current JPEG display-payload limits, especially for large rolls.

## Packaging, safety and validation gate

LibRaw core offers LGPL 2.1 or CDDL 1.0; optional demosaic packs carry separate GPL terms. RawTherapee uses GPLv3. A worker-process boundary is useful isolation, not automatic legal clearance. Audit the exact packaged runtime, applicable licences/notices and corresponding-source/build obligations before distributing. Keep it version-pinned and self-contained so users need no manual runtime setup. [LibRaw scope/licences](https://www.libraw.org/about), [RT licence](https://raw.githubusercontent.com/RawTherapee/RawTherapee/5.13/LICENSE), [optional GPL3 pack](https://github.com/LibRaw/LibRaw-demosaic-pack-GPL3).

Use argument-array process launches, controlled outputs, process/memory/time limits and local-only processing. Cancel through existing worker controls. Malformed, changed, missing, oversized or unsupported inputs must fail without replacing source or unrelated outputs. No new durable job tracker is needed.

Before choosing the packaged backend, run a bounded proof with representative real files: RAW/C-RAW; mechanical/electronic shutter; high ISO; portrait/landscape; bright coats and dark fur; shallow-depth backgrounds; RAW+JPEG pairs; and a burst roll if used. Compare at 100% using a pinned, colour-managed reference recipe, representative real CR3 files, any available camera JPEG companions and a second mature developer when useful. Canon DPP is optional and must not gate delivery. Different engines need not produce identical pixels; visual comparison alone does not establish calibrated colour accuracy. Check source hashes, dimensions after orientation/crop, capture metadata, ICC tagging, independent B&W lineage, no-overwrite behaviour, cancel/retry and cold/warm preview/final throughput with peak memory/VRAM.

Verdict: proceed with the two-stage RAW-original workflow and mature backend candidate. Actual image quality, camera-mode coverage and deployment-machine throughput are unverified until that proof. Application code, installed tools, user media and release artifacts remain unchanged by this research.

## User steering: a standalone best-practice approach

Stuart does not have Canon's RAW-processing tool. PhotoGoGo must work end to end without Canon software, accounts, SDK installation or a manual external-app workflow.

The proposed first backend remains RawTherapee CLI, isolated behind a worker interface. Bundle a tested, version-pinned runtime and owned profiles, subject to the documented packaging/licence gate. Do not inherit a separately installed editor's user preferences or silently change default profiles on updates. An engine change remains an explicit, versioned recipe change.

Recommended default preset: Natural.

- Use the source camera's as-shot white balance and a validated camera input profile.
- Preserve recorded exposure as the starting point; make auto exposure an explicit choice rather than an unexplained automatic change.
- Apply a gentle, documented tone treatment with highlight/shadow controls. Do not promise recovery of unrecorded clipped detail.
- Keep noise reduction and edge/detail sharpening conservative; avoid strong background clarity, halos or smoothing of real horse/rider texture.
- Offer saved Natural, Neutral and High ISO starting presets with visible settings, reset controls and per-photo overrides.
- Keep colour and B&W branches independent after their shared high-precision development base. Existing JPEG processing should retain its current behaviour.

Export defaults: full recorded resolution after the chosen crop/orientation; high-quality sRGB JPEG, with explicit optional 16-bit TIFF. Never substitute an embedded preview for a full-quality export. Preserve compatible capture metadata and apply privacy choices to output copies only.

Validation without DPP must cover unchanged source hashes, ordinary RAW/C-RAW decoding, full dimensions, portrait orientation, crop consistency, ICC tagging, capture metadata, predictable recipes and no-overwrite/cancel/retry behaviour. Review 100% crops for fine detail, chroma noise, halos, false colour, banding, white coats, black fur and smooth bokeh. Optional camera JPEGs help assess a familiar rendering, but are not mandatory and are not a colour-calibration target. A repeatable CLI-versus-saved-reference test checks integration consistency; a second developer comparison can reveal anomalies without requiring pixel equality.

Prioritise fast review from embedded previews and staged-copy caches; full development runs only for the requested/selected batch through core Jobs. Bound worker/thread/memory/cache budgets and log per-stage timings. Judge performance by measured preview responsiveness and completed full-quality images per minute, not processor utilisation alone.

This steering updates the proposal only. The major implementation and new bundled dependency still require Stuart's project-level execution approval.
