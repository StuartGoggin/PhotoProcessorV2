# Automatic AJAZZ AKP03E control

PhotoGoGo 2.0.48 includes a native AKP03E controller mode. There is no AJAZZ scene to create, no plugin to install and no button hotkeys to assign. Open PhotoGoGo with one AKP03E connected; the app loads its own button graphics and uses the current page's controls.

Automatic mode starts enabled, as requested. Before opening the device, PhotoGoGo detects the exact AKP03E model, obtains its exclusive controller lease, and stops only the verified `Stream Dock AJAZZ.exe` process in the current Windows session. It does not terminate arbitrary AJAZZ-branded processes or process trees. If that process cannot be identified or stopped safely, the controller panel explains the problem and offers Retry. Multiple connected AKP03E units require choosing one physically for this version.

**AJAZZ restart is manual in this version.** Release the controller or close PhotoGoGo, then launch the AJAZZ application when wanted. PhotoGoGo does not edit the vendor's saved profiles or write a new boot logo/firmware. If AJAZZ is restarted while PhotoGoGo owns the device, PhotoGoGo stops forwarding controller input and releases its USB session; use Retry to take control again.

## Controller panel

The sidebar's **AKP03E controller** button opens connection status and a live mirror of the current six display keys, three dials and three side buttons. Use **Connect / retry**, **Release controller**, the remembered automatic-mode checkbox and display brightness. Last control identifies the most recent admitted input. The mirror calls the same application actions as the physical controls; it is not a keyboard macro editor.

Release turns automatic acquisition off until re-enabled or retried, including after a restart. Disconnecting and reconnecting while automatic mode remains on starts a fresh USB session. Another PhotoGoGo instance cannot take the controller lease or stop AJAZZ behind the current owner.

Display brightness defaults to **100%**. The previous, unmarked 70% default is upgraded to 100%; other remembered values are preserved. After you choose a brightness in this version, including 70%, it is retained on later launches. Upgrading brightness does not re-enable a released controller. The slider remains available for adjustment.

Keys use a black background, bright white icons/labels, heavier strokes and borders, and strong gold/yellow/red state accents. Hardware images receive a **90-degree clockwise correction** for the reported counter-clockwise panel orientation; the app's mirror remains upright. This changes controller artwork only, not photo/video orientation or the physical key positions.

### Configure the three Lightbox dials

In **AKP03E controller → Lightbox dials**, each physical dial has separate **Turn** and **Press** choices. Turning can browse original photos, zoom, switch image version or be off. Pressing can fit the view, toggle the active Google selection, switch Original/Cropped view, move previous/next, toggle trash or be off. Changes affect Lightbox only; RAW, crop and video layouts retain their controls.

Choose **Identify the large dial**, then turn the actual large dial. Photo actions pause during identification; no image is selected, trashed or advanced. **Apply identified dial** makes that dial browse originals and its press fit the view. The on-screen mirror cannot identify a physical dial. **Cancel identification**, closing, a context/connection change or timeout cancels without applying.

For other assignments, change the draft dropdowns then **Apply dial controls**. **Cancel changes** restores the saved choices; **Reset defaults** creates a draft which still needs Apply. Failed saves preserve the prior assignments. Invalid saved preferences pause controller actions and require an explicit replacement Apply or a successful retry, rather than silently changing controls.

## Task layouts

| Task | Six display keys | Dials and round buttons |
| --- | --- | --- |
| Home / pages without a dedicated layout | Lightbox, Develop, Snapshots, Studio, Jobs, Home | Round buttons open Lightbox, Develop or Snapshots. Develop opens the RAW controls. |
| Lightbox — Review | Top: Previous, Trash/Restore, Next. Lower: Google Original, Google B&W, Google Enhanced | Saved turn/press assignments for all three dials. Identify the large dial to make it browse originals. Round buttons choose Review, Versions or Inspect. |
| Lightbox — Versions | Exact Original, B&W and Enhanced selections, plus their three favourites | Selections address the current cropped versions when cropped view is active. Missing versions are disabled. |
| Lightbox — Inspect | Crop, Original/Cropped view, fit, clear rating, refresh, help | The same browsing/zoom/active-version dials remain available. |
| RAW Development | Draft preview, 100% preview, save photo recipe, Natural, colour/B&W preview, next original | Dials adjust exposure, Auto finish and contrast where available. Other controls retain the existing photo/defaults scope and unsaved-recipe protection. |
| Crop editor | Apply, reset, aspect ratio, orientation, B&W and Enhanced regeneration | Dials move the chosen crop handle on X/Y and choose another handle. Precision and Cancel are available on the round buttons. |
| Video Snapshots | Previous frame, capture, next frame, reverse shuttle, stop, forward shuttle | Dials provide fine/coarse accelerated stepping and source selection. Capture requires the exact currently displayed frame. |

Artwork reflects available, selected and saving states using built-in vector geometry rendered to bounded 60 × 60 JPEGs. Labels and graphics update automatically; unchanged faces are not retransmitted. No photo thumbnails, private filenames or remote images are written to the controller displays.

## Saving and input safety

Controller actions use PhotoGoGo's real editing commands. Save-and-next, where used, waits for the native save acknowledgement. The default Trash key toggles the original's trash mark without advancing or physically deleting the file. Lower Google keys toggle the exact current displayed Original/B&W/Enhanced selections, including their cropped versions when active; missing/unloaded versions are disabled. Selecting a Google Photos checkbox does not upload anything. Crop and export retain their existing original-preservation and validation rules.

Button and dial-press release reports consume input without executing the action again. Turns retain their direction. This avoids an acknowledged Google/Trash toggle being undone when the physical button is released.

After a trash or rating rename, saved upload selections follow the new filename.
Pending or failed checkbox writes still require acknowledgement or a deliberate
retry. Trash marks the original and keeps it visible so it can be restored;
keyboard **X** marks trash and advances after saving.

For a paired RAW capture, choose **Original source → Camera JPEG** to enable
**Crop** (also on the controller's Inspect page). The crop and chosen B&W/Enhanced
outputs are created from that full JPEG and remain grouped under the capture.
Both the RAW and Camera JPEG originals stay untouched. Camera RAW preview stays
ineligible for cropping; no embedded thumbnail or RAW development is substituted.

Only one controller action is admitted at a time. Extra presses during saves are discarded, not replayed on the next photo. Layout revisions, renderer ownership and USB sessions fence stale input. Inputs queued during repaint/re-arm are drained. Hidden pages and inactive editors cannot own the layout. Dialogs retain their keyboard behaviour; opening the controller mirror does not let ordinary review shortcuts act behind it.

If an action is not acknowledged within 30 seconds, controller input fails closed until Retry. The underlying application job is not cancelled or resubmitted by that timeout. If a layout heartbeat is absent for ten seconds, inputs are disarmed and a neutral display replaces it. The page's existing save/loading checks remain authoritative.

Controller preferences, the cross-process lease and a bounded diagnostic log live in PhotoGoGo's application configuration directory under `controller`, outside staging. `preferences.json` records automatic mode/brightness, `bindings.json` records the three typed Lightbox assignments, and `controller.log` records connection and takeover outcomes without photo contents. Runtime actions use no network service or global keyboard injection.

## Connection diagnosis

The connection now selects the unique AKP03E control collection (VID 0300, PID 3002, usage page FFA0) and opens its exact path. A keyboard/mouse collection sharing its serial is never substituted. Missing/ambiguous protocol collections fail before opening or stopping AJAZZ. Firmware variants with another identity require diagnosis, not a guessed fallback. Logs list bounded interface/usage descriptors without HID paths or serials.

**Looking for AKP03E** means no matching model was enumerated. **Reconnecting** means it opened but a later operation failed. The panel and log retain the actual operation/cause, such as initialise/brightness, display update or input read, rather than replacing it with a generic reconnect error. Do not interpret the layout preview as proof of a USB connection.

## First physical test

Development checks use synthetic controller input and generated media. No AKP03E is connected to the development machine, so physical acceptance remains required:

1. Finish any AJAZZ configuration work, connect the AKP03E and launch 2.0.48. Confirm the controller panel reaches Connected and the vendor app has stopped. If it fails, send the exact operation/error shown; the earlier screenshot alone does not identify the failed operation.
2. Check all six faces are in the expected positions, upright and readable. Version 2.0.48 applies the clockwise correction for Stuart's reported counter-clockwise rotation; the physical result still needs confirmation. Check that the old 70% default now shows 100%; a different saved custom brightness is intentionally retained.
3. Open a small copied test event in Lightbox. Identify the large dial and Apply. Confirm that turning it moves between originals. Hold and release each lower Google key: it must toggle exactly once, retain its state on release and affect only its displayed version. Toggle Trash and verify it does not advance. Check all three saved dial turns/presses and side buttons, then reopen to check preferences persist.
4. On a paired RAW capture, choose Camera JPEG, open Crop and Apply once. Confirm the cropped versions appear under the same capture and both originals remain unchanged. Switch back to Camera RAW preview: Crop must be disabled. Try RAW adjustments and a Snapshot capture; rapid scrubbing must not capture the previous displayed frame.
5. Unplug/replug, Release, close PhotoGoGo and manually restart AJAZZ. Confirm its normal layout returns. Re-enable automatic control only when wanted.

## Sources and licences

The native module uses `ajazz-sdk` **0.2.1** (MPL-2.0) with a small PhotoGoGo path-open/press-only extension, and unmodified `hidapi` **2.6.7**. Original registry source archives remain checksum-pinned. The actual modified SDK source used to compile is shipped in `resources/controller-source/ajazz-sdk-photogogo`, with all 28 files checked by the source receipt. Only `src/device.rs` and `src/lib.rs` changed; `PHOTOGOGO-CHANGES.md` records the changes. Existing upstream readers and other models retain their original semantics. Exact upstream archives, licence notices and source-access instructions also ship there; `.crate` files are gzip-compressed tar archives.

Primary references: [AJAZZ SDK source](https://github.com/mishamyrt/ajazz-sdk), [published SDK 0.2.1 source](https://crates.io/api/v1/crates/ajazz-sdk/0.2.1/download), [HID 2.6.7 source](https://crates.io/api/v1/crates/hidapi/2.6.7/download), [independent AKP03E implementation](https://github.com/tomekceszke/ajazz-akp03e). Compatibility is based on the pinned source and application tests; those sources do not replace physical acceptance.
