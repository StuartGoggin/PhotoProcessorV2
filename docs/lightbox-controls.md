# Photo Lightbox keyboard and AJAZZ AKP03E controls

Photo Lightbox uses one command map for keyboard dispatch, button hints and in-app help. Open **Keyboard & Controller Help** from the toolbar, or press **F1** or **?**. Help keeps the current photo open and restores focus when closed. Its keyboard, controller and crop sections show the current keymap. Search by command, action or key.

## Review a folder

Choose an original from the keyboard-operable folder tree. Up/Down move focus, Right expands a folder, Left collapses it or returns to the parent, and Enter or Space opens a focused photo. The tree is one Tab stop and keeps its own arrow-key behaviour.

In the image review, Left/Right browse originals; Home/End reach the first/last original in that folder. Set one to three stars with 1/2/3 and clear the rating with Backspace. Delete marks or restores trash. The physical original is not deleted. Rating and trash changes use the existing filename tags.

The quick-review commands Shift+1/2/3 set a rating and advance **after the native save succeeds**. X marks trash and advances after saving. G selects the active panel's exact version for Google Photos and advances after saving. A failed, interrupted or conflicting save leaves the photo available with an error rather than advancing. Navigation and other data actions are blocked while a reviewed change is being saved; image loading also blocks data changes until the displayed photo is ready.

## Select exact versions

Each available Original, B&W and Enhanced panel has a 24-pixel checkbox in a labelled click target at least 44 pixels high. Its favourite button also has a 44-pixel target. Q/W/E toggle those exact-version selections; Shift+Q/W/E toggle their favourites. In cropped view the same controls act on the cropped versions. Selection status distinguishes loading, saving, saved and unavailable states.

The cyan Active border identifies the panel targeted by A (toggle selection) and G (select and next). Use [ and ] to change the active available panel, or focus/click it. A missing version is not silently replaced with another. No selection action starts an upload: publish through Transfer → Google Photos. Archive rules using Marked for Google Photos read these same local selections.

## Inspect and crop

Use +/− to zoom, Shift+arrow keys to pan the active zoomed panel and 0 to fit/reset zoom and pan. Fit describes the fitted preview, not original-source pixel magnification. V switches Original/Cropped view when a crop exists. R refreshes the folder and selections. C opens the crop editor for an editable JPEG original.

The crop editor owns its own keys. Ctrl+Enter applies the crop and regenerates chosen versions; Escape cancels when no save is active. R resets full frame, V switches orientation for a fixed ratio, Q toggles B&W regeneration and E toggles enhanced regeneration. A focused handle uses arrow keys for one source pixel, Shift+arrow keys for ten. Tab and Shift+Tab reach handles and controls. F1/? expands the crop keyboard reference. Ordinary Enter activates a focused button; it does not globally apply the crop from a checkbox or slider.

## Keyboard context and rapid input

Typing fields, select menus, the folder tree and modal editors retain their keyboard behaviour. Hold navigation, zoom and pan keys to repeat them. Rating, trash, selection and view switches run once per press. Save-and-next commands capture the reviewed photo/version and do not depend on a timed controller macro.

## AJAZZ AKP03E

The release includes controller artwork and a manual setup reference. Configure its six buttons as one/two/three stars plus next, trash plus next, select active plus next and skip. Dial 1 browses photos and presses V, dial 2 zooms and presses 0, and dial 3 changes the active panel and presses A.

Use the vendor software's Hotkey action and keep PhotoGoGo foregrounded. Actual dial/press options depend on the installed AJAZZ software and must be checked on the device. The pack is a reference, not a verified vendor-import scene. Static button artwork does not provide live hardware-state feedback. The complete setup steps are in `public/controller/ajazz-akp03e/README.md`; `reference-keymap.json` and artwork are generated from the shared app keymap.
