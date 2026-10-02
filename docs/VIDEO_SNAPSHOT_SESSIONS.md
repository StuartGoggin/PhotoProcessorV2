# Video Snapshots sessions

Video Snapshots now opens on a session library. Each session remembers your original-video references, selected frames, shooting times, person labels, photo adjustments, video position and export folder. These records save automatically on this computer; they do not copy or modify your videos.

## Everyday use

1. Choose **New session**, give it a useful name, then add your original videos. A new session starts with an empty workspace, photo tray and export folder.
2. Work as usual. The header shows **Saving…** and **Saved automatically**. Scrubbing saves in the background without waiting for you to stop indefinitely.
3. Choose **Sessions** to return to the library. Open any recent session, search by name, or choose **Continue last session**. Reopening checks the original videos and rebuilds their frame indexes as needed.
4. Use **More** in the editor to rename, duplicate or export a portable session copy. **Import saved session** brings older saved JSON sessions into the library without modifying the imported file.
5. **Delete** moves the session to **Recently deleted**, where **Restore session** brings it back. Deleting a session never deletes source videos, exported photographs or portable session files.

## When something is unavailable

- A disconnected drive, moved video or changed source file is shown in the source list. Its saved photo choices stay in the session. Reconnect the original source and choose **Retry video**; do not substitute a different file at the same path.
- If saving fails, the latest edits remain in the open workspace. **Retry save** or **Save recovery copy**. Switching to another session or closing normally is blocked until the edits are saved successfully. Do not force-quit while the status reports unsaved changes.
- If a record is damaged and a last-good backup exists, it is explicitly marked recovered. Choose **Save recovered copy** to continue; the damaged original and backup remain untouched.
- Restored export receipts are history, not proof that the photographs still exist. The app labels them unverified and allows exporting again. **Show original in folder** checks the file before revealing it.

## Storage and portability

Managed session records live in the current Windows account's PhotoGoGo application-data directory, under `video-snapshot-sessions`. The library is separate from media and staging folders. Export a session copy before moving to another computer; its original paths still need to be available on the destination computer.

Limits remain 64 videos and 200 photo selections per session, including references to currently unavailable media. Preview caches and frame indexes are not embedded in session JSON. Full-resolution photo export still reads the original video, not a tray thumbnail.

Autosave protects normal editing and application-close flows. It cannot guarantee the most recent unsaved keystrokes after power loss or force termination; durable saves use atomic replacement, a last-good backup and revision checks. The library retains recently deleted records until restored; there is no permanent-delete command in this release.
