# Video Studio 2.0.8: full-range camera correction

Installer: `release/PhotoGoGoV2_2.0.8_x64_en-US.msi` (8,826,880 bytes).
SHA-256: `203573EEB0B6810664AD46ABB042B7FE1A355C8B2CCB987E34A20CF19FC8A230`.
Release build and MSI packaging succeeded. The MSI database reports ProductVersion 2.0.8; the release copy matches the build checksum. Not installed automatically.

## Root cause

The reported clip is 4K/50 fps H.264 with full-range (`pc`) colour. FFmpeg can retain full-range signalling even with `-pix_fmt yuv420p`, causing ffprobe to report `yuvj420p`. Version 2.0.7's fragment validator rejected this with an unhelpfully generic message.

A 0.2-second diagnostic sample from `20260911_194005.mp4` reproduced that behaviour: geometry, FPS, duration and audio were correct, but the pixel format was `yuvj420p`.

## Correction

- Convert pixel values explicitly using `scale:out_range=tv`, then normalize pixel format and frame range metadata. Encode with limited-range signalling.
- Preserve strict output validation; do not merely accept or relabel full-range pixels as limited-range.
- Bump the fragment cache version so previous colour handling cannot be reused in a corrected render.
- Include expected/actual colour, codec, geometry, FPS, audio or duration details in verification errors.
- Add unit coverage for detailed failures and a native full-range regression that includes balanced stabilisation, titles and final assembly.
- The real-camera regression exposed a second issue: global `-t` could discard a final video packet before timestamp normalization. Bound copied video by the sum of verified frame counts and trim audio independently. The diagnostic join now has 36/36 frames at 50 fps, rather than 35/36.

The corrected direct diagnostic from the user's clip reports H.264/yuv420p, limited range, 3840×2160, 50 fps and stereo 48 kHz AAC. The original media and existing exports were not changed.

## Verification

- Ten native Studio unit tests passed, including detailed verification failures.
- Nine frontend workflow tests passed; production TypeScript/Vite build passed.
- Native `full_range_colour_smoke` passed using a short stream-copied sample of the user's actual clip: balanced stabilisation, 4K/50 fps/32 Mbps target, opening and clip titles, fragment publication and final assembly.
- Native `restart_assembly_smoke` passed: checkpoint recovery, verified clip reuse, settings mismatch rejection and final music mixing.
- Native `render_smoke` passed: stabilisation, titles, replays, source preservation, fragment reuse and silent-source preview.
- `git diff --check` passed.

The full 140.52-second source was not rerendered during diagnosis; the real-camera regression used a short sample to avoid another lengthy render. No app settings or existing job records were modified by testing.

## Updating

Close the application, install 2.0.8, then use **Resume saved render** for the failed job. The failed fragment must be encoded again; old cached fragments are intentionally invalidated. The original failed intermediate had already been removed by 2.0.7's cleanup, so it cannot be recovered from that job.
