# Automatic AJAZZ AKP03E control

PhotoGoGo 2.0.46 includes a native AKP03E controller mode. There is no AJAZZ scene to create, no plugin to install and no button hotkeys to assign. Open PhotoGoGo with one AKP03E connected; the app loads its own button graphics and uses the current page's controls.

Automatic mode starts enabled, as requested. Before opening the device, PhotoGoGo detects the exact AKP03E model, obtains its exclusive controller lease, and stops only the verified `Stream Dock AJAZZ.exe` process in the current Windows session. It does not terminate arbitrary AJAZZ-branded processes or process trees. If that process cannot be identified or stopped safely, the controller panel explains the problem and offers Retry. Multiple connected AKP03E units require choosing one physically for this version.

**AJAZZ restart is manual in this version.** Release the controller or close PhotoGoGo, then launch the AJAZZ application when wanted. PhotoGoGo does not edit the vendor's saved profiles or write a new boot logo/firmware. If AJAZZ is restarted while PhotoGoGo owns the device, PhotoGoGo stops forwarding controller input and releases its USB session; use Retry to take control again.

## Controller panel

The sidebar's **AKP03E controller** button opens connection status and a live mirror of the current six display keys, three dials and three side buttons. Use **Connect / retry**, **Release controller**, the remembered automatic-mode checkbox and display brightness. Last control identifies the most recent admitted input. The mirror calls the same application actions as the physical controls; it is not a keyboard macro editor.

Release turns automatic acquisition off until re-enabled or retried, including after a restart. Disconnecting and reconnecting while automatic mode remains on starts a fresh USB session. Another PhotoGoGo instance cannot take the controller lease or stop AJAZZ behind the current owner.

## Task layouts

| Task | Six display keys | Dials and round buttons |
| --- | --- | --- |
| Home / pages without a dedicated layout | Lightbox, Develop, Snapshots, Studio, Jobs, Home | Round buttons open Lightbox, Develop or Snapshots. Develop opens the RAW controls. |
| Lightbox — Review | One/two/three stars and next, trash and next, select active and next, skip | Dials browse originals, zoom/fit and select the active version. Round buttons choose Review, Versions or Inspect. |
| Lightbox — Versions | Exact Original, B&W and Enhanced selections, plus their three favourites | Selections address the current cropped versions when cropped view is active. Missing versions are disabled. |
| Lightbox — Inspect | Crop, Original/Cropped view, fit, clear rating, refresh, help | The same browsing/zoom/active-version dials remain available. |
| RAW Development | Draft preview, 100% preview, save photo recipe, Natural, colour/B&W preview, next original | Dials adjust exposure, Auto finish and contrast where available. Other controls retain the existing photo/defaults scope and unsaved-recipe protection. |
| Crop editor | Apply, reset, aspect ratio, orientation, B&W and Enhanced regeneration | Dials move the chosen crop handle on X/Y and choose another handle. Precision and Cancel are available on the round buttons. |
| Video Snapshots | Previous frame, capture, next frame, reverse shuttle, stop, forward shuttle | Dials provide fine/coarse accelerated stepping and source selection. Capture requires the exact currently displayed frame. |

Artwork reflects available, selected and saving states using built-in vector geometry rendered to bounded 60 × 60 JPEGs. Labels and graphics update automatically; unchanged faces are not retransmitted. No photo thumbnails, private filenames or remote images are written to the controller displays.

## Saving and input safety

Controller actions use PhotoGoGo's real editing commands. Save-and-next waits for the native save acknowledgement. Trash still marks an original; it does not physically delete the file. Selecting a Google Photos checkbox does not upload anything. Crop and export retain their existing original-preservation and validation rules.

Only one controller action is admitted at a time. Extra presses during saves are discarded, not replayed on the next photo. Layout revisions, renderer ownership and USB sessions fence stale input. Inputs queued during repaint/re-arm are drained. Hidden pages and inactive editors cannot own the layout. Dialogs retain their keyboard behaviour; opening the controller mirror does not let ordinary review shortcuts act behind it.

If an action is not acknowledged within 30 seconds, controller input fails closed until Retry. The underlying application job is not cancelled or resubmitted by that timeout. If a layout heartbeat is absent for ten seconds, inputs are disarmed and a neutral display replaces it. The page's existing save/loading checks remain authoritative.

Controller preferences, the cross-process lease and a bounded diagnostic log live in PhotoGoGo's application configuration directory under `controller`, outside staging. `preferences.json` records automatic mode/brightness; `controller.log` records connection and takeover outcomes without photo contents. Runtime actions use no network service or global keyboard injection.

## First physical test

Development checks use synthetic controller input and generated media. No AKP03E is connected to the development machine, so physical acceptance remains required:

1. Finish any AJAZZ configuration work, connect the AKP03E and launch 2.0.46. Confirm the controller panel reaches Connected and the vendor app has stopped.
2. Check all six faces are in the expected positions, upright and readable. The chosen Rust SDK specifies zero rotation for this model; another independent implementation describes a different rotation, so this detail is explicitly unverified on Stuart's unit.
3. Open a small copied test event in Lightbox. Press a rating key several times on successive photos. Every physical press should work; no alternate presses should be lost. Check save-and-next, Versions selections and all three dial turns/presses and side buttons.
4. Try a crop, RAW preview/adjustments and a Snapshot capture. Rapid scrubbing must not capture the previous displayed frame. A crop Apply must execute once.
5. Unplug/replug, Release, close PhotoGoGo and manually restart AJAZZ. Confirm its normal layout returns. Re-enable automatic control only when wanted.

## Sources and licences

The native module uses unmodified `ajazz-sdk` **0.2.1** (MPL-2.0) and `hidapi` **2.6.7**, locked by Cargo registry checksum. The exact source archives, original licence notices and source-access instructions ship under `resources/controller-source` beside the installed application. The SDK source is made available there in `.crate` archives, which are gzip-compressed tar archives.

Primary references: [AJAZZ SDK source](https://github.com/mishamyrt/ajazz-sdk), [published SDK 0.2.1 source](https://crates.io/api/v1/crates/ajazz-sdk/0.2.1/download), [HID 2.6.7 source](https://crates.io/api/v1/crates/hidapi/2.6.7/download), [independent AKP03E implementation](https://github.com/tomekceszke/ajazz-akp03e). Compatibility is based on the pinned source and application tests; those sources do not replace physical acceptance.
