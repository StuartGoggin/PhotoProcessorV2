# Quality stabilisation: measured bottleneck and bounded threading change

Local investigation: 22 September 2026. This is not a render-PC acceptance result.

## Reproduction

`scripts/benchmark-quality-pipeline.ps1` generates synthetic, full-range 3840x2160
H.264 at 50 fps. It runs the recorded gentle/edge-safe Quality chain, including
bicubic vid.stab transformation, sharpening and limited-range conversion. It
refuses to start beside a local FFmpeg/PhotoGoGo process, bounds child and total
runtime, verifies completed frame counts, and never opens private footage.

Local hardware is an Intel Core Ultra 7 165H; FFmpeg is the existing Gyan 8.1.1
build. The render PC has different hardware and reported FFmpeg 9.0.1. Null and
frame-checksum outputs do not measure NVENC, audio, disk publication or a full
production queue. All comparisons use the same generated source and motion file.

Two 100-frame baseline runs gave:

| Pipeline | Wall time, run 1 | Wall time, run 2 |
| --- | ---: | ---: |
| Decode only | 0.454 s | 0.489 s |
| Output conversion only | 0.838 s | 0.780 s |
| Sharpen and output conversion | 4.564 s | 5.105 s |
| Stabilise and output conversion | 22.549 s | 24.324 s |
| Complete Quality filtering | 25.863 s | 28.071 s |

The transform is the dominant cost. Complete filtering used about one CPU core
on average, despite a requested six-thread decoder/OpenMP budget. Removing a
stage was diagnostic, not a proposal to reduce quality. Peak-memory values of
zero in the first report are a measurement defect, not zero memory use; later
runs sample working set while the process is alive.

Explicit planar conversion before vid.stab did not improve timing. Verbose logs
confirmed the original path already negotiated planar YUV, preserving full range
until output conversion. That hypothesis was rejected without an application edit.

## Narrow improvement

This candidate was not integrated or packaged. Stuart redirected the work to
parallelising pixels in the transform itself. A draft native command-inspection
test rendered successfully but inspected the wrong log collection and failed to
observe either Quality pass; it was removed, not counted as a valid red/green
regression. Application production code and the existing test runner are unchanged.

With unchanged filters, six graph threads versus one took 23.726/22.512 seconds
versus 26.637/26.916 seconds for 100 frames, including per-frame checksum work:
13.7% lower average wall time (15.8% higher throughput). All four frame-checksum
files were byte-identical.

A separate 50-frame, B-frame-source comparison explicitly limited the
`vidstabtransform` instance with `threads=1` while allowing six graph threads.
It took 13.102/11.459 seconds versus 14.544/14.498 seconds for the original serial
graph. All four checksum files again matched exactly. These are short synthetic
comparisons, not a universal speedup or proof of stability on every FFmpeg build.

FFmpeg's graph thread budget supplies slice-capable filters. An individual
filter's `threads` option bounds its own permitted filter threading; it does not
change the application's OpenMP budget. The intended surgical change keeps the
two vid.stab filter instances explicitly limited to one filter thread, but lets
sharpening, scaling and other graph filters use the existing scheduler grant.
No encoder settings, stabilisation strength, smoothing, interpolation, framing,
resolution, frame rate, memory reserve or process admission limit is relaxed.

Primary references:

- [FFmpeg graph-thread options](https://ffmpeg.org/ffmpeg.html)
- [FFmpeg 8.1.1 per-filter thread limit and slice-thread dispatch](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.1/libavfilter/avfilter.c)
- [FFmpeg 8.1.1 vid.stab wrapper](https://raw.githubusercontent.com/FFmpeg/FFmpeg/n8.1.1/libavfilter/vf_vidstabtransform.c)
- [Released vid.stab planar transform implementation](https://raw.githubusercontent.com/georgmartius/vid.stab/v1.1.1/src/transformfixedpoint.c)

## Larger speedup: rows before chunks

Parallel application of one frame's transform to independent pixel rows targets
the dominant cost without creating temporal joins. Current upstream
[vid.stab transform code](https://github.com/georgmartius/vid.stab/blob/master/src/transformfixedpoint.c)
contains OpenMP row parallelism. This is a lead for a separate, pinned dependency
evaluation, not evidence that the installed FFmpeg contains it or that it is
pixel-identical to the installed version. No dependency was replaced here.

Independent chunk stabilisation solves a different camera path/zoom at each join
and risks visible seams. Quality-preserving chunk rendering would need a shared
whole-clip motion solution, correctly aligned frame transforms and zoom, plus
validated timestamps, encoder joins, audio synchronisation and memory admission.
The raw first-pass motion file is not a ready-to-slice final camera path. That
approach is materially larger than a thread-setting fix and needs separate approval.

Raw local reports are retained under `test-output/quality-pipeline-*`:

- `20260921T201424321Z`: stage baseline.
- `20260921T201754625Z`: rejected pixel-format hypothesis.
- `20260921T202443392Z`: graph-thread comparison and frame checksums.
- `20260921T202819652Z`: explicit vid.stab guard with B-frame source.

The four measurement sets used approximately 475 seconds plus short fixture and
version calls. Benchmark processes have finished. No render-PC process was touched.
