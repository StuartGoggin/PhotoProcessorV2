//! Bounded, encrypted checkpoint history and a deliberately redacted export.
//! Never serialize the Job itself into a user-copyable report: it owns tokens,
//! session URLs, paths, account identifiers and private Google receipts.
use super::{engine::Job, transport};
use serde::{Deserialize, Serialize};
use std::fmt::Write;

const MAX_EVENTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Account,
    Preflight,
    CreateAlbum,
    AlbumDetails,
    Prepare,
    UploadBytes,
    RegisterMedia,
    VerifyMedia,
    AlbumCover,
    Job,
}
impl Stage {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Account => "Check account",
            Self::Preflight => "Check local sources",
            Self::CreateAlbum => "Create album",
            Self::AlbumDetails => "Confirm album details",
            Self::Prepare => "Prepare upload copy",
            Self::UploadBytes => "Transfer photo bytes",
            Self::RegisterMedia => "Register uploaded media",
            Self::VerifyMedia => "Read back registered media",
            Self::AlbumCover => "Confirm album cover",
            Self::Job => "Job",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Started,
    Succeeded,
    Failed,
    Paused,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Event {
    at: String,
    stage: Stage,
    item: Option<usize>,
    outcome: Outcome,
    rpc_code: Option<i64>,
    http_status: Option<u16>,
    reason: Option<String>,
}

fn marker_number(value: &str, marker: &str) -> Option<i64> {
    let rest = value.split_once(marker)?.1;
    let digits: String = rest
        .chars()
        .take_while(char::is_ascii_digit)
        .take(4)
        .collect();
    digits.parse().ok()
}
fn error_codes(error: &str) -> (Option<i64>, Option<u16>, Option<String>) {
    let rpc = marker_number(error, "(code ").filter(|v| (0..=16).contains(v));
    let http = marker_number(error, "HTTP ")
        .filter(|v| (100..=599).contains(v))
        .map(|v| v as u16);
    let reason = transport::SAFE_REASONS
        .iter()
        .find(|reason| error.contains(**reason))
        .map(|v| (*v).to_string());
    (rpc, http, reason)
}
pub fn note(
    job: &mut Job,
    stage: Stage,
    item: Option<usize>,
    outcome: Outcome,
    error: Option<&str>,
) {
    if outcome == Outcome::Started
        && job
            .diagnostics
            .last()
            .is_some_and(|last| last.stage == stage && last.item == item && last.outcome == outcome)
    {
        return;
    }
    let (rpc_code, http_status, reason) = error.map(error_codes).unwrap_or_default();
    job.diagnostics.push(Event {
        at: chrono::Utc::now().to_rfc3339(),
        stage,
        item,
        outcome,
        rpc_code,
        http_status,
        reason,
    });
    if job.diagnostics.len() > MAX_EVENTS {
        job.diagnostics.drain(..job.diagnostics.len() - MAX_EVENTS);
    }
}
pub fn finish(job: &mut Job, error: &str, stopped: bool) {
    let outcome = if stopped {
        Outcome::Paused
    } else {
        Outcome::Failed
    };
    let (rpc_code, http_status, reason) = error_codes(error);
    if job.diagnostics.last().is_some_and(|last| {
        last.outcome == outcome
            && last.rpc_code == rpc_code
            && last.http_status == http_status
            && last.reason == reason
    }) {
        return;
    }
    let (stage, item) = job
        .diagnostics
        .last()
        .map(|last| (last.stage, last.item))
        .unwrap_or((Stage::Job, None));
    note(job, stage, item, outcome, Some(error));
}
pub fn rate_limited(error: &str) -> bool {
    let (rpc, http, reason) = error_codes(error);
    rpc == Some(8)
        || http == Some(429)
        || matches!(
            reason.as_deref(),
            Some("RATE_LIMIT_EXCEEDED" | "QUOTA_EXCEEDED")
        )
}
fn known_state(value: &str) -> &str {
    match value {
        "pending"
        | "preparing"
        | "uploading"
        | "uploaded_bytes"
        | "registering"
        | "registered"
        | "verified"
        | "skipped"
        | "blocked"
        | "failed"
        | "paused"
        | "aborted"
        | "running"
        | "completed"
        | "completed_with_errors"
        | "needs_attention"
        | "creation_outcome_unknown" => value,
        _ => "unknown",
    }
}
fn time(value: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|v| v.to_rfc3339())
        .unwrap_or_else(|_| "unavailable".into())
}
fn explain(rpc: Option<i64>, http: Option<u16>, reason: Option<&str>) -> String {
    let mut output = String::new();
    if let Some(code) = rpc.filter(|v| (0..=16).contains(v)) {
        let _ = write!(
            output,
            "{} (code {code}). {}",
            transport::status_name(code),
            transport::status_hint(code)
        );
    }
    if let Some(code) = http.filter(|v| (100..=599).contains(v)) {
        let _ = write!(output, " HTTP {code}.");
    }
    if let Some(reason) = reason.filter(|v| transport::SAFE_REASONS.contains(v)) {
        let _ = write!(output, " Reason: {reason}.");
    }
    if output.is_empty() {
        output.push_str("No API code was retained. Read the current in-app message; no free-form response content is exported.");
    }
    output
}

pub fn report(job: &Job) -> String {
    let summary = job.summary();
    let confirmation = format!("Accepted by Google: {}; verified by read-back: {}; awaiting verification: {}; verification needs attention: {}\n", summary.accepted, summary.uploaded, summary.awaiting_verification, summary.verification_needs_attention);
    let mut text = format!("PhotoGoGo {} — Google Photos diagnostics\nCreated: {}\nStatus: {}\nConfirmed uploaded: {}; skipped: {}; need attention: {}; total: {}\nBytes transferred: {} / {} (byte transfer is not confirmation of upload success)\n\n", env!("CARGO_PKG_VERSION"), time(&job.plan.created_at), known_state(&job.status), summary.uploaded, summary.skipped, summary.failed, summary.total, summary.bytes_done, summary.total_bytes);
    text.push_str(&confirmation);
    text.push_str("Privacy: filenames, local paths, account details, album/media IDs, credentials, upload tokens, session URLs and raw Google response messages are omitted. Photo numbers refer to this saved job's reviewed order.\n\nPhoto checkpoints (first 200):\n");
    for (index, item) in job.items.iter().enumerate().take(200) {
        let variant = job
            .plan
            .items
            .get(index)
            .map(|v| format!("{:?}", v.variant))
            .unwrap_or_else(|| "unknown".into());
        let _ = writeln!(
            text,
            "Photo {} | {} | {} | {} bytes sent | registered receipt {}",
            index + 1,
            variant,
            known_state(&item.state),
            item.offset,
            if item.media.is_some() {
                "saved"
            } else {
                "not saved"
            }
        );
        if let Some(error) = &item.error {
            let (rpc, http, reason) = error_codes(error);
            let _ = writeln!(text, "  {}", explain(rpc, http, reason.as_deref()));
        }
    }
    if job.items.len() > 200 {
        text.push_str("Additional photo checkpoints omitted to keep this report bounded.\n");
    }
    text.push_str("\nSaved checkpoint log (latest 256 events):\n");
    if job.diagnostics.is_empty() {
        text.push_str("This earlier job has no checkpoint history. Version 2.0.32 did not retain the original per-photo Google status code. A deliberate retry of the existing saved job records new diagnostics; this report makes no Google requests.\n");
    }
    for event in job
        .diagnostics
        .iter()
        .rev()
        .take(MAX_EVENTS)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        let _ = write!(
            text,
            "{} | {} | {:?}",
            time(&event.at),
            event.stage.label(),
            event.outcome
        );
        if let Some(index) = event.item.filter(|i| *i < job.items.len()) {
            let _ = write!(text, " | photo {}", index + 1);
        }
        if event.outcome == Outcome::Failed {
            let _ = write!(
                text,
                " | {}",
                explain(event.rpc_code, event.http_status, event.reason.as_deref())
            );
        }
        text.push('\n');
    }
    if !job.errors.is_empty() {
        text.push_str("\nCurrent job codes:\n");
        for error in job.errors.iter().take(20) {
            let (rpc, http, reason) = error_codes(error);
            let _ = writeln!(text, "{}", explain(rpc, http, reason.as_deref()));
        }
    }
    text.push_str("\nRecovery: use this saved job's Resume/Retry action after reviewing the error. Registered media is read back again rather than re-uploaded. Never change OAuth client/account or create a fresh job just to bypass verification. No remote checksum verification is claimed.\n");
    text
}

pub(super) fn phase(job: &Job) -> String {
    job.diagnostics
        .last()
        .map(|event| event.stage.label().to_string())
        .unwrap_or_else(|| "Google Photos upload".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_numeric_codes_and_known_reasons_survive_free_form_error_export() {
        let (rpc, http, reason) = error_codes("private@example.test https://evil.invalid?token=secret bearer fixture (code 5) HTTP 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT");
        let text = explain(rpc, http, reason.as_deref());
        assert!(
            text.contains("NOT_FOUND")
                && text.contains("HTTP 403")
                && text.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
        );
        for private in [
            "private@example",
            "evil.invalid",
            "secret",
            "bearer fixture",
        ] {
            assert!(!text.contains(private));
        }
        assert_eq!(
            error_codes("HTTP secret (code secret) TOKEN_SECRET"),
            (None, None, None)
        );
    }
    #[test]
    fn quota_status_and_http_backoff_are_recognized_without_matching_random_numbers() {
        assert!(rate_limited(
            "Google verification failed: RESOURCE_EXHAUSTED (code 8)."
        ));
        assert!(rate_limited("Google request failed (HTTP 429)."));
        assert!(!rate_limited("File 429.jpg was not found"));
        assert!(!rate_limited("(code 5)"));
    }
}
