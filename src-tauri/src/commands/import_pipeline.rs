//! One sequential source reader and a bounded handoff to destination processing.
//! Payload ownership carries temporary-file cleanup across the same test/production seam.
pub(super) fn run<T: Sync, P: Send>(
    items: &[T],
    prepare: impl Fn(&T) -> Option<P> + Sync,
    finish: impl Fn(P),
) -> Result<(), String> {
    std::thread::scope(|scope| {
        // No extra queued payload: one may be processed and one prepared. A slow
        // destination naturally backpressures the source instead of staging an
        // entire card. Owned payloads clean themselves up on disconnect/unwind.
        let (sender, receiver) = std::sync::mpsc::sync_channel(0);
        let prepare = &prepare;
        let reader = scope.spawn(move || {
            for item in items {
                if let Some(prepared) = prepare(item) {
                    if sender.send(prepared).is_err() { break; }
                }
            }
        });
        // Own (not borrow) the receiver iterator: a consumer panic drops it
        // before scope joins the reader, releasing any blocked rendezvous send.
        for prepared in receiver { finish(prepared); }
        reader.join().map_err(|_| "Import source-reader pipeline failed; unpublished copies were retained only until cleanup".into())
    })
}
