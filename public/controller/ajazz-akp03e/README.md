# PhotoGoGo Photo Lightbox — AJAZZ AKP03E setup

This pack contains a manual setup reference and static button artwork. It is **not** an AJAZZ/Stream Dock importable scene or plugin. It installs no driver, firmware or software. Hardware operation remains to be checked on your controller.

1. Open your installed AJAZZ/Stream Dock software and create a PhotoGoGo Lightbox scene.
2. Use its **Hotkey** action to assign the six keys below. Record actual key combinations; the text-input action does not trigger app commands.
3. Assign the corresponding PNG file as each button's icon. Editable SVG sources are included.
4. Set dial left/right/press actions if your installed software exposes those options.
5. Open PhotoGoGo, select Photo Lightbox and choose a photo. Keep PhotoGoGo in the foreground. Use F1 or ? for the current in-app keymap.

| Button position | Action | Hotkey | Artwork |
|---|---|---|---|
| Top left | One star, save and next | Shift+1 | one-star-next.png |
| Top middle | Two stars, save and next | Shift+2 | two-stars-next.png |
| Top right | Three stars, save and next | Shift+3 | three-stars-next.png |
| Bottom left | Mark trash, save and next | X | trash-next.png |
| Bottom middle | Select active version, save and next | G | select-next.png |
| Bottom right | Skip to next original | Right arrow | skip.png |

| Dial | Turn left / right | Press |
|---|---|---|
| 1 | Previous / next photo: Left / Right arrows | Original / Cropped view: V |
| 2 | Zoom out / in: - / + | Fit/reset zoom and pan: 0 |
| 3 | Previous / next image panel: [ / ] | Toggle active panel's Google Photos selection: A |

The cyan Active border identifies the panel controlled by A and G. In cropped view it controls cropped versions. G sets selection **on** before advancing; A toggles it. Missing versions are not substituted. A failed save does not advance. Trash marks a filename; it does not physically delete a photo. Keep the control held only for browsing/zooming; state changes run once per press.

For a second scene, Q / W / E toggle the exact Original / B&W / Enhanced Google Photos checkboxes; Shift+Q / Shift+W / Shift+E toggle those versions' favourites. Star ratings and Google Photos favourites are separate. Selecting a checkbox does not upload anything. The existing Google Photos publishing and selective archive rules use these same saved selections.

Use the app's on-screen save/selection state. Static hardware icons do not mirror current ratings or checkmarks. In text fields, the file tree, help and crop editor, keyboard input follows the focused context. Activate a photo with Enter or Space to return to review.

`reference-keymap.json` contains command IDs and bindings generated from the app's shared command definition. It is a documentation format, not an AJAZZ import profile. `scripts/render-lightbox-controller-icons.mjs` regenerates that reference and all six SVG/PNG icons from the command definition; no external image service is used.
