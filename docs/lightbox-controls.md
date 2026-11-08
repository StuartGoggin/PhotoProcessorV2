# Photo Lightbox keyboard and AJAZZ AKP03E controls

Photo Lightbox uses one command map for keyboard dispatch, button hints and in-app help. Open **Keyboard & Controller Help** from the toolbar, or press **F1** or **?**. Help keeps the current photo open and restores focus when closed. Its keyboard, controller and crop sections show the current keymap. Search by command, action or key.

## First preview in large folders (2.0.50)

Selecting a photo starts its exact preview before folder-wide capture checks
finish. Original, B&W and Enhanced appear independently; a slower version says
**Loading image…**. Preview browsing, fit and zoom remain available while checks
run. **Checking capture pairs** explains why editing and upload choices are
temporarily paused. Unverified RAW/JPEG entries may initially appear separately;
verified pairs become one capture without changing a clicked JPEG into a RAW
preview. A missing selected Camera JPEG asks you to choose an original again.

Rating, Trash, Crop and Google selection/favourite decisions unlock after capture
identity and the selected original read are resolved. Incomplete checks offer
**Retry capture checks**; damaged lineage remains display-only until repaired.
The existing save acknowledgement rules still apply. Background work is bounded,
and unchanged metadata/image reads are reused during the app session. Full RAW
development and export remain explicit operations; the RAW camera preview is
still a labelled reference image.

## Review a folder

Verified RAW+camera-JPEG captures start in **Camera JPEG** view, showing that
JPEG's existing B&W, Enhanced and cropped versions. RAW is an alternate source:
choose **Camera RAW preview** deliberately to see the RAW preview and any
explicitly developed RAW versions. Your explicit source choice is retained while
browsing and refreshing in the current view. JPEG-only photos need no RAW step;
standalone/unverified RAW files remain separate. Browsing never develops RAW.

A version that exists but fails to read or display says **Could not load … image**
and offers its own **Retry … image**. Retry reads that exact physical version,
keeps other comparisons visible, and cannot repaint a later photo/source or
staging folder. While an original retry is pending, decisions remain paused.
**No image** means no comparison is available in that source family; for an
undeveloped CR3, missing RAW B&W/colour versions are expected. Camera JPEG and
RAW developments never borrow each other's comparison files.

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

From 2.0.46, PhotoGoGo manages the AKP03E automatically: built-in layouts, live button artwork and direct commands require no vendor scene or hotkey setup. The sidebar's AKP03E controller panel shows the live layout, automatic-mode setting, brightness, Retry and Release. Taking over stops the verified AJAZZ controller app; restarting AJAZZ is manual. See the [automatic controller guide](akp03e-controller.md) for modes, safety and the physical test checklist.

The older static artwork and Hotkey reference remain available for optional legacy use with automatic mode off. They are not an importable vendor scene or live-state integration. Those manual instructions are in `public/controller/ajazz-akp03e/README.md`; `reference-keymap.json` and static artwork are generated from the shared keyboard map.

## Responsive selection saving

Google Photos checkboxes and favourites show your requested state immediately. Saving identifies changes awaiting native confirmation; further checkbox changes queue in order. A failed or unconfirmed save restores the confirmed flags and displays a scoped error. Changing a favourite does not clear a failed checkbox save. Retry the affected checkbox, or use Reload selections to read the confirmed disk state.

Browsing, rating, trash, crop and refresh wait for pending selections. Select and next advances only after its own save succeeds. Transfer previews also wait for accepted selections and refuse to plan while a selection failure remains unresolved. Accepted writes continue if you leave Lightbox; return to that root to see a late failure. Keep PhotoGoGo open until Saving finishes: this small in-memory queue does not survive application shutdown.
