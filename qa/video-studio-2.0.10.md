# Video Studio 2.0.10 — clear and restart

Clear all Studio renders is available under Render history & recovery, including when the queue is empty. Confirmation is required. It cancels queued/running/paused work, waits for workers to finish, archives job records, removes all Studio attempts from the queue, resets clip render references, and changes a persisted cache generation so future renders start fresh. Other application job types are unaffected.

Source clips, project edits, selected/generated music, exported media, caches and diagnostic logs are deliberately preserved on disk. This is a queue/render-state reset, not disk cleanup. Archived records remain in the app's studio-jobs/cleared-history folder, outside startup recovery scanning.

If cancellation cannot finish within 60 seconds, history is retained and the UI explains how to retry. New enqueue requests are refused while clearing. Frontend polling epochs and clip revisions prevent stale responses from restoring cleared state.

Validation: frontend build; workflow tests including stale completion after reset; browser confirmation cancellation and successful reset; isolated native clear_jobs_smoke for cancellation, archival, persistent generation and preserved source media. The isolated native test must run alone because it sets the global recovery store. No real user jobs are cleared during testing.
