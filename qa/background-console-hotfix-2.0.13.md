# Windows background-console hotfix 2.0.13

Validated on the Windows build PC on 20 September 2026. Installer hashes and
delivery details are recorded separately in the local build receipt.

## Cause and surgical fix

Import starts staging preview/cache workers alongside copying. Their FFmpeg
thumbnail/hover-preview and FFprobe metadata launches used bare `Command::new`.
When the parent is the installed GUI application, these console programs open
visible child windows. Existing staged videos can trigger this even when the
new source contains photos. Version 2.0.12 retained the affected launch code.

A single local `background_media_command` helper now applies Windows
`CREATE_NO_WINDOW` to exactly those three launches. Output pipes, stderr, exit
status, arguments, candidate lookup and existing error handling are unchanged.
No import admission, encoding parameters, Video Studio concurrency, Explorer,
VLC or explicit default-app launch behaviour changed. No dependencies were added.

## Reproduction and regression

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-background-processes.ps1
```

The script compiles the current native tests, identifies the exact executable
from Cargo JSON, and modifies ONLY a fresh test copy to the Windows GUI subsystem.
The production source calls execute console-mode FFmpeg/FFprobe stand-ins. The
stand-ins inspect `GetConsoleWindow` and `IsWindowVisible` without reading media.
One intentionally visible control proves the environment can detect the bug.

Before applying the flag, the test failed with `console=true visible=true` for
thumbnail, metadata, hover-preview and the diagnostic error case. With the flag:

```text
control: console=true visible=true
thumbnail: console=false visible=false
metadata: console=false visible=false
hover-preview: console=false visible=false
capture-error: console=false visible=false
test result: ok. 1 passed; 0 failed
```

The test also checks exact output bytes, parsed metadata, successful preview
publication, spaces/metacharacters in path arguments, and captured stdout/stderr
with exit code 19. It requires all expected helper invocations in order. An empty
test selection fails the script instead of silently passing.

A parent started with `CreateNoWindow` is NOT an adequate regression: it masked
the original bug during diagnosis. The new test is ignored by ordinary unit runs
and explicitly executed by the dedicated script in the correct GUI environment.

## Additional verification and limits

- Full native suite: 85 passed; eight ignored by default. GUI regression and
  isolated Studio queue-clear/recovery test separately passed. The child-only
  import lock probe is exercised by its parent integration test.
- Frontend/workflow checks: 10 import, 10 Studio scheduler and 12 Studio tests passed.
- Independent read-only review found no missing automatic-import subprocess path.
  Other explicit face/tag/process workflows were kept outside this hotfix.
- Existing import and Video Studio implementation files have no diff.
- No temporary debug instrumentation remains in the application. Historical
  reproduction artifacts are retained only in the ignored test-output directory.
- This verifies the process/window behaviour using real production launch paths,
  not a full live SD import or an end-to-end render-PC acceptance test. Five
  FFmpeg/LMMS media smoke tests and the unavailable Playwright suite were not run.

On the render PC, finish current jobs, close PhotoGoGo, install 2.0.13, then import
with staged video previews present and confirm the console flashes are gone.
Explicitly opening VLC/Explorer should still open its normal window.
