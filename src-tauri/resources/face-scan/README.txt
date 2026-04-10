Face scan bundle payload directory

This folder is intentionally mostly empty in git.

Production build flow:
1) Provide a prebuilt face-scan bundle zip via PHOTOGOGO_FACE_BUNDLE_SOURCE
   or place src-tauri/resources/face-scan-bundle.zip
2) Run scripts/build-release.ps1

The build script unpacks bundled python-runtime and wheelhouse here so
end users do not need Python installed.
