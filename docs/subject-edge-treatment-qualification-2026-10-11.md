# Selected subject-edge treatment inspection - 11 October 2026

Status: selected pre-encoding picture behavior is exercised on retained footage.
This is not temporal, semantic selection, current-tracker, whole-clip or release
acceptance. All global quality/export flags remain false.

## Executed picture comparison

`node scripts/inspect-subject-edge-treatment.mjs` executes the public
`--finish-cached` native picture interface twice for each selected UHD frame:
the actual non-neutral subject grade with gain zero, then the same grade with
detail gain 26 / threshold 32. Whole-frame grading stays disabled.

The exact selected frames are black horse 32/33/34 and white horse 68/69/70,
from the earlier two-second normalized-original excerpts. Both masks are cached
v1 masks, not results of the new v3 tracker. The white sample contains a running
handler, not a second mounted rider. No inference or stabilization is rerun.

The retained native worker is SHA-256
`db0e3b20e52cfad9d4e3eceafab2c347631c570e40fc4a5a14d6cc5628e4417d`.
The explicit D3D11 adapter is Intel Arc, vendor `0x8086`; this does not establish
NVIDIA compatibility or throughput.

The first [receipt](../test-output/subject-edge-treatment-XPS78K/receipt.json)
passed support invariants. Independent source review identified an omitted
positive grade-activation control and an overly broad name for the mask/border
exclusion counter. The diagnostic was tightened without changing production
filters, masks or source media. The [second receipt](../test-output/subject-edge-treatment-jqYAKr/receipt.json)
records the positive control and precise counter name.

Across all 8,294,400 pixels in each of six frames:

- Source alpha is preserved exactly.
- Where expanded mask alpha is zero, both grade-only and grade-plus-detail RGB
  equal the decoded source exactly.
- Where the 3x3 mask stencil or picture border excludes sharpening,
  grade-plus-detail equals grade-only exactly. This counter does not claim to
  test every opacity/contrast exclusion in the kernel.
- Detail adds the same integer delta to all three RGB channels, at most three
  codes in magnitude, measured against the already graded picture.
- Non-neutral grading actually changes selected pixels in every tested frame.

Black grading changed 594,847 / 595,735 / 601,919 pixels (maximum channel change
14 codes). White grading changed 1,651,309 / 1,624,824 / 1,629,424 pixels
(maximum nine codes). Detail changed 22,613--58,684 pixels across these frames.
These are descriptive observations, not perceptual flicker/halo thresholds.
Input hashes before/after match. The rerun's four crop-sheet hashes match the
first run; adding the measurement did not alter the pictures.

## Native-pixel visual inspection

The main agent inspected all four 1536x1152 PNGs at original resolution:
black and white silhouette crops plus subject-interior crops. Each row is a
successive selected frame. Columns are base, grade-only, grade-plus-detail and
the exact nearest-neighbour-expanded alpha. Native crop size is 384x384.

No obvious new bright/dark outline was seen when comparing grade-plus-detail
against grade-only in these selected crops. This is a limited still-image
observation, not proof of no halos or uninterrupted smooth playback. Fine mane
strands extend outside the conservative inward mask and remain untreated; that
is visible selection coverage, not a sharpener spill.

A small dark hole in the black horse's shoulder mask is visible in frames 33
and 34 but not 32. Its underlying pixels appear to be subject rather than a
background gap. This is a selection-quality anomaly worth investigating; it
is not yet a reproduced visible grade-pop failure or a basis for filling all
mask holes. Such filling could incorrectly treat real gaps around reins/legs.
No representative-quality repair attempt is counted by this inspection.

The mild test grades and three still frames cannot establish that the anomaly
is invisible at other settings or during motion. These triplets also do not
cross the recorded window handoffs at 36 and 72. Normal-speed motion review,
hard close-up/occlusion, post-stabilization behavior and current-tracker
correction effectiveness remain open.

## Next aligned action

Prepare a new short mounted-horse/rider interval and separately identified v3
application runner from the current source, reusing the unchanged retained CPU
dependencies. Verify its candidate manifest against the original pinned input
archives, preserve the old manifest/runner and delivered test ZIP, then exercise
one real prompt-correction job through the owned native mask interface.
This private evaluation does not authorize inference-runtime redistribution or
admit the new runner into the application/release.

Do not substitute more portable packaging or synthetic guard tests for actual
correction, temporal quality, NVIDIA inference, integration and final installer
qualification. The full delivery goal remains active.
