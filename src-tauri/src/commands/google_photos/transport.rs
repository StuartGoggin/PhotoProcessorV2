//! Google protocol adapter. No configurable production origin or HTTP redirects.
use super::{oauth, store::GoogleStore};
use reqwest::{blocking::Response, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const BASE: &str = "https://photoslibrary.googleapis.com/v1";
const UPLOADS: &str = "https://photoslibrary.googleapis.com/v1/uploads";
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub id: String,
    pub title: String,
    pub product_url: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub url: String,
    pub granularity: u64,
    pub started_at: i64,
}
pub struct Offset {
    pub received: u64,
    pub token: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Media {
    pub id: String,
    pub product_url: String,
    pub width: u64,
    pub height: u64,
    pub creation_time: Option<String>,
}
pub struct Registration {
    pub token: String,
    pub result: Result<Media, String>,
}

pub trait GoogleApi {
    fn create_album(&mut self, title: &str) -> Result<Album, String>;
    fn list_albums(&mut self) -> Result<Vec<Album>, String>;
    fn begin(&mut self, name: &str, mime: &str, size: u64) -> Result<Session, String>;
    fn query(&mut self, session: &Session) -> Result<Offset, String>;
    fn chunk(
        &mut self,
        session: &Session,
        offset: u64,
        bytes: Vec<u8>,
        final_chunk: bool,
    ) -> Result<Offset, String>;
    fn register(
        &mut self,
        album: &str,
        items: &[(String, String)],
    ) -> Result<Vec<Registration>, String>;
    fn verify(&mut self, ids: &[String]) -> Result<Vec<Media>, String>;
    fn cover(&mut self, album: &str, media: &str) -> Result<(), String>;
    fn update_title(&mut self, album: &str, title: &str) -> Result<Album, String>;
}
pub struct LiveGoogle<'a> {
    pub store: &'a GoogleStore,
    pub account_id: &'a str,
}
fn checked(response: Response) -> Result<Response, String> {
    let code = response.status().as_u16();
    if response.status().is_success() {
        Ok(response)
    } else if code == 429 {
        Err(
            "Google rate limit (HTTP 429). Wait at least 30 seconds before retrying this job."
                .into(),
        )
    } else if code == 401 || code == 403 {
        Err(format!("Google authorization/permission error (HTTP {code}). Reconnect the same account and check Photos permissions."))
    } else {
        Err(format!("Google request failed (HTTP {code}). No response content or credentials have been logged."))
    }
}
fn json_response(response: Response) -> Result<Value, String> {
    checked(response)?.json().map_err(|_| {
        "Google response was incomplete or invalid. The outcome may need reconciliation.".into()
    })
}
pub fn safe_session_url(value: &str) -> bool {
    Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("photoslibrary.googleapis.com")
            && url.path() == "/v1/uploads"
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.query().is_some()
    })
}
fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty()
        && id.len() <= 1000
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        Ok(id)
    } else {
        Err("Invalid Google object identifier.".into())
    }
}
fn album(v: &Value) -> Result<Album, String> {
    let id = v["id"]
        .as_str()
        .ok_or("Google did not return an album identifier.")?;
    safe_id(id)?;
    Ok(Album {
        id: id.into(),
        title: v["title"].as_str().unwrap_or("").into(),
        product_url: v["productUrl"].as_str().unwrap_or("").into(),
    })
}
fn media(v: &Value) -> Result<Media, String> {
    let id = v["id"]
        .as_str()
        .ok_or("Google did not return a media identifier.")?;
    safe_id(id)?;
    let number = |key: &str| {
        v["mediaMetadata"][key]
            .as_str()
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
    };
    Ok(Media {
        id: id.into(),
        product_url: v["productUrl"].as_str().unwrap_or("").into(),
        width: number("width"),
        height: number("height"),
        creation_time: v["mediaMetadata"]["creationTime"]
            .as_str()
            .map(String::from),
    })
}
fn session_valid(session: &Session) -> Result<(), String> {
    if !safe_session_url(&session.url) {
        return Err("Invalid saved upload endpoint.".into());
    }
    if session.granularity == 0 || session.granularity > 32 * 1024 * 1024 {
        return Err("Invalid saved upload chunk granularity. Start a fresh byte session using the same prepared file.".into());
    }
    Ok(())
}
fn chunk_end(
    session: &Session,
    offset: u64,
    length: usize,
    final_chunk: bool,
) -> Result<u64, String> {
    session_valid(session)?;
    if length > 32 * 1024 * 1024
        || (!final_chunk && (length == 0 || length as u64 % session.granularity != 0))
    {
        return Err("Upload chunk does not match the bounded server granularity.".into());
    }
    // A queried partial offset belongs to Google, not to a client-side rounding
    // rule. The protocol requires resuming at that exact received offset.
    offset
        .checked_add(length as u64)
        .ok_or_else(|| "Upload progress exceeded its safety limit.".into())
}
fn parse_offset(
    status: &str,
    received: Option<&str>,
    confirmed_end: Option<u64>,
    token: Option<String>,
) -> Result<Offset, String> {
    if status != "active" && status != "final" {
        return Err("Upload session is terminated. Start a fresh byte session using the exact same prepared file.".into());
    }
    if status == "final"
        && ((received.is_none() && confirmed_end.is_none())
            || token.as_ref().is_none_or(|s| s.is_empty()))
    {
        return Err("The finalized session cannot recover its token/progress. Start a fresh byte session using the exact same prepared file.".into());
    }
    let received = match received {
        Some(value) => Some(
            value
                .parse::<u64>()
                .map_err(|_| "Google returned an invalid resumable offset.")?,
        ),
        None => None,
    };
    let received = received
        .or(confirmed_end)
        .ok_or("Google did not return a resumable offset. Saved progress was not changed.")?;
    if status == "final" {
        let token = token.filter(|value| !value.is_empty() && value.len() <= 16384).ok_or("The finalized byte session did not return its upload token. Start a fresh byte session with the exact same prepared file; do not create a new album.")?;
        Ok(Offset {
            received,
            token: Some(token),
        })
    } else if status == "active" {
        Ok(Offset {
            received,
            token: None,
        })
    } else {
        Err("Upload session is cancelled, expired or returned an unknown status. Start a fresh byte session using the exact same prepared file.".into())
    }
}
fn upload_offset(
    response: Response,
    confirmed_end: Option<u64>,
    final_upload: bool,
) -> Result<Offset, String> {
    let response = checked(response)?;
    let status = response
        .headers()
        .get("X-Goog-Upload-Status")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .to_string();
    // Query responses require server status/offset. Successful byte writes may
    // omit those headers; their 200 response confirms the submitted range, and
    // a final upload returns its token in the body (documented protocol).
    let status = effective_upload_status(&status, confirmed_end, final_upload)?;
    let received = response
        .headers()
        .get("X-Goog-Upload-Size-Received")
        .map(|value| {
            value
                .to_str()
                .map(String::from)
                .map_err(|_| "Google returned an invalid resumable offset.")
        })
        .transpose()?;
    // Google documents a token on successful final upload, but does not promise
    // that a later query can recover that token from a terminated session.
    let token = if status == "final" {
        Some(response.text().map_err(|_| "Final upload token was not received. Start a fresh byte session with the same prepared file.")?)
    } else {
        None
    };
    parse_offset(status, received.as_deref(), confirmed_end, token)
}
fn effective_upload_status(
    status: &str,
    confirmed_end: Option<u64>,
    final_upload: bool,
) -> Result<&str, String> {
    if !status.is_empty() {
        return Ok(status);
    }
    if confirmed_end.is_some() {
        Ok(if final_upload { "final" } else { "active" })
    } else {
        Err("Google query response has no upload status. Saved progress was not changed.".into())
    }
}
fn registration_tokens(items: &[(String, String)]) -> Result<HashSet<&str>, String> {
    let expected: HashSet<&str> = items.iter().map(|(token, _)| token.as_str()).collect();
    if expected.len() != items.len()
        || expected
            .iter()
            .any(|token| token.is_empty() || token.len() > 16384)
    {
        return Err("Upload registration tokens are empty or duplicated.".into());
    }
    if items.iter().any(|(_, name)| {
        name.is_empty() || name.chars().count() > 255 || name.chars().any(char::is_control)
    }) {
        return Err("Google photo filenames must contain 1–255 printable characters.".into());
    }
    Ok(expected)
}
fn registrations(value: &Value, items: &[(String, String)]) -> Result<Vec<Registration>, String> {
    let expected = registration_tokens(items)?;
    let results = value["newMediaItemResults"]
        .as_array()
        .ok_or("Google registration response is incomplete.")?;
    if results.len() != items.len() {
        return Err("Google registration results are incomplete. Preserve these prepared files and retry the unresolved registration.".into());
    }
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for result in results {
        let token = result["uploadToken"]
            .as_str()
            .ok_or("Google registration result is missing its upload token.")?;
        if !expected.contains(token) || !seen.insert(token) {
            return Err("Google registration returned duplicate or unexpected upload tokens. No ambiguous receipt was accepted.".into());
        }
        let code = match result.get("status").and_then(|status| status.get("code")) {
            None => 0,
            Some(code) => code.as_i64().ok_or("Invalid Google registration status.")?,
        };
        output.push(Registration {
            token: token.into(),
            result: if code == 0 {
                media(&result["mediaItem"])
            } else {
                Err(format!(
                    "Google could not register this photo (code {code})."
                ))
            },
        });
    }
    Ok(output)
}
fn verification(value: &Value, ids: &[String]) -> Result<Vec<Media>, String> {
    let expected: HashSet<&str> = ids.iter().map(String::as_str).collect();
    if expected.len() != ids.len() {
        return Err("Media verification identifiers are duplicated.".into());
    }
    let results = value["mediaItemResults"]
        .as_array()
        .ok_or("Incomplete Google media read-back.")?;
    if results.len() != ids.len() {
        return Err("Google media read-back did not confirm every requested item.".into());
    }
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for result in results {
        if result
            .get("status")
            .and_then(|value| value.get("code"))
            .is_some_and(|code| code.as_i64() != Some(0))
        {
            return Err(
                "Google reported an error during media read-back. No upload success was assumed."
                    .into(),
            );
        }
        let item = media(&result["mediaItem"])?;
        if !expected.contains(item.id.as_str()) || !seen.insert(item.id.clone()) {
            return Err(
                "Google media read-back returned duplicate or unexpected identifiers.".into(),
            );
        }
        output.push(item);
    }
    Ok(output)
}
fn next_album_page(
    value: &Value,
    pages: usize,
    seen: &mut HashSet<String>,
) -> Result<Option<String>, String> {
    let next = match value.get("nextPageToken") {
        None | Some(Value::Null) => "",
        Some(value) => value
            .as_str()
            .ok_or("Google returned an invalid album page token.")?,
    };
    if next.is_empty() {
        return Ok(None);
    }
    if pages >= 200 || next.len() > 8192 || !seen.insert(next.into()) {
        return Err("Google album pagination repeated or exceeded its safety limit. Listing stopped without further requests.".into());
    }
    Ok(Some(next.into()))
}
fn upload_start_request(
    http: &reqwest::blocking::Client,
    token: &str,
    mime: &str,
    size: u64,
) -> reqwest::blocking::RequestBuilder {
    http.post(UPLOADS)
        .bearer_auth(token)
        .header("X-Goog-Upload-Protocol", "resumable")
        .header("X-Goog-Upload-Command", "start")
        .header("X-Goog-Upload-Raw-Size", size)
        .header("X-Goog-Upload-Content-Type", mime)
        .header("Content-Length", 0)
}
impl LiveGoogle<'_> {
    fn token(&self) -> Result<String, String> {
        oauth::access_token(self.store, self.account_id)
    }
}
impl GoogleApi for LiveGoogle<'_> {
    fn create_album(&mut self, title: &str) -> Result<Album, String> {
        let response = oauth::client()?
            .post(format!("{BASE}/albums"))
            .bearer_auth(self.token()?)
            .json(&json!({"album":{"title":title}}))
            .send()
            .map_err(|_| {
                "Album creation response was lost. Reconcile before creating anything else."
            })?;
        album(&json_response(response)?)
    }
    fn list_albums(&mut self) -> Result<Vec<Album>, String> {
        let mut result = Vec::new();
        let mut page = String::new();
        let mut seen = HashSet::new();
        let mut pages = 0;
        loop {
            let value = json_response(
                oauth::client()?
                    .get(format!("{BASE}/albums"))
                    .bearer_auth(self.token()?)
                    .query(&[
                        ("pageSize", "50"),
                        ("pageToken", page.as_str()),
                        ("excludeNonAppCreatedData", "true"),
                    ])
                    .send()
                    .map_err(|_| "Could not list app-created albums.")?,
            )?;
            for value in value["albums"].as_array().into_iter().flatten() {
                result.push(album(value)?);
            }
            pages += 1;
            if result.len() > 10000 {
                return Err("Album listing exceeds the safety limit. Use a smaller Google project catalogue.".into());
            }
            match next_album_page(&value, pages, &mut seen)? {
                Some(next) => page = next,
                None => break,
            }
        }
        Ok(result)
    }
    fn begin(&mut self, _name: &str, mime: &str, size: u64) -> Result<Session, String> {
        // The UTF-8 filename belongs in batchCreate JSON, not an HTTP header.
        let response = checked(
            upload_start_request(&oauth::client()?, &self.token()?, mime, size)
                .send()
                .map_err(|_| "Could not initiate Google upload. No media was registered.")?,
        )?;
        let url = response
            .headers()
            .get("X-Goog-Upload-URL")
            .and_then(|h| h.to_str().ok())
            .ok_or("Google did not return a resumable session.")?
            .to_string();
        if !safe_session_url(&url) {
            return Err("Google returned a session outside the approved HTTPS upload endpoint. Upload refused.".into());
        }
        let granularity = response
            .headers()
            .get("X-Goog-Upload-Chunk-Granularity")
            .and_then(|h| h.to_str().ok())
            .and_then(|n| n.parse::<u64>().ok())
            .filter(|n| *n > 0 && *n <= 32 * 1024 * 1024)
            .ok_or("Unsupported Google upload chunk granularity.")?;
        Ok(Session {
            url,
            granularity,
            started_at: chrono::Utc::now().timestamp(),
        })
    }
    fn query(&mut self, session: &Session) -> Result<Offset, String> {
        session_valid(session)?;
        let response = oauth::client()?
            .post(&session.url)
            .bearer_auth(self.token()?)
            .header("X-Goog-Upload-Command", "query")
            .header("Content-Length", 0)
            .send()
            .map_err(|_| "Could not query resumable progress; saved offset has not advanced.")?;
        if matches!(response.status().as_u16(), 404 | 410) {
            return Err("Upload session expired. Start a fresh byte session using the exact same prepared file.".into());
        }
        upload_offset(response, None, false)
    }
    fn chunk(
        &mut self,
        session: &Session,
        offset: u64,
        bytes: Vec<u8>,
        final_chunk: bool,
    ) -> Result<Offset, String> {
        let end = chunk_end(session, offset, bytes.len(), final_chunk)?;
        upload_offset(oauth::client()?.post(&session.url).bearer_auth(self.token()?).header("X-Goog-Upload-Command", if final_chunk { "upload, finalize" } else { "upload" }).header("X-Goog-Upload-Offset", offset).body(bytes).send().map_err(|_| "Upload interrupted. Query server progress before resuming; local bytes were not assumed received.")?, Some(end), final_chunk)
    }
    fn register(
        &mut self,
        album_id: &str,
        items: &[(String, String)],
    ) -> Result<Vec<Registration>, String> {
        if items.is_empty() || items.len() > 50 {
            return Err("Google registration batches must contain 1–50 photos.".into());
        }
        registration_tokens(items)?;
        safe_id(album_id)?;
        let value = json_response(oauth::client()?.post(format!("{BASE}/mediaItems:batchCreate")).bearer_auth(self.token()?).json(&json!({"albumId":album_id,"newMediaItems":items.iter().map(|(token,name)| json!({"simpleMediaItem":{"uploadToken":token,"fileName":name}})).collect::<Vec<_>>()})).send().map_err(|_| "Media registration response was lost. Retry uses the same prepared bytes, never a new album.")?)?;
        registrations(&value, items)
    }
    fn verify(&mut self, ids: &[String]) -> Result<Vec<Media>, String> {
        if ids.is_empty() || ids.len() > 50 {
            return Err("Invalid media verification batch.".into());
        }
        if ids.iter().map(String::as_str).collect::<HashSet<_>>().len() != ids.len() {
            return Err("Media verification identifiers are duplicated.".into());
        }
        let mut url = Url::parse(&format!("{BASE}/mediaItems:batchGet")).unwrap();
        for id in ids {
            safe_id(id)?;
            url.query_pairs_mut().append_pair("mediaItemIds", id);
        }
        let value = json_response(
            oauth::client()?
                .get(url)
                .bearer_auth(self.token()?)
                .send()
                .map_err(|_| {
                    "Google media read-back failed. This is not a checksum verification."
                })?,
        )?;
        verification(&value, ids)
    }
    fn cover(&mut self, album: &str, media_id: &str) -> Result<(), String> {
        safe_id(album)?;
        safe_id(media_id)?;
        json_response(
            oauth::client()?
                .patch(format!("{BASE}/albums/{album}"))
                .query(&[("updateMask", "coverPhotoMediaItemId")])
                .bearer_auth(self.token()?)
                .json(&json!({"coverPhotoMediaItemId":media_id}))
                .send()
                .map_err(|_| "Album cover update did not complete; photos remain uploaded.")?,
        )?;
        let value = json_response(
            oauth::client()?
                .get(format!("{BASE}/albums/{album}"))
                .bearer_auth(self.token()?)
                .send()
                .map_err(|_| "Album cover read-back failed.")?,
        )?;
        if value["coverPhotoMediaItemId"].as_str() != Some(media_id) {
            return Err("Google did not confirm the selected album cover.".into());
        }
        Ok(())
    }
    fn update_title(&mut self, id: &str, title: &str) -> Result<Album, String> {
        safe_id(id)?;
        let current = json_response(
            oauth::client()?
                .get(format!("{BASE}/albums/{id}"))
                .bearer_auth(self.token()?)
                .send()
                .map_err(|_| "Could not read the existing app-created album.")?,
        )?;
        if current["title"].as_str() != Some(title) {
            json_response(oauth::client()?.patch(format!("{BASE}/albums/{id}")).query(&[("updateMask", "title")]).bearer_auth(self.token()?).json(&json!({"title":title})).send().map_err(|_| "Album title update was interrupted. Retry will verify the same target album before repeating the idempotent update.")?)?;
        }
        let verified = json_response(
            oauth::client()?
                .get(format!("{BASE}/albums/{id}"))
                .bearer_auth(self.token()?)
                .send()
                .map_err(|_| "Album title/link read-back failed.")?,
        )?;
        if verified["title"].as_str() != Some(title) {
            return Err("Google did not confirm the album title change.".into());
        }
        album(&verified)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn successful_byte_writes_do_not_require_query_only_headers() {
        assert_eq!(
            effective_upload_status("", Some(123), false).unwrap(),
            "active"
        );
        assert_eq!(
            effective_upload_status("", Some(123), true).unwrap(),
            "final"
        );
        assert!(effective_upload_status("", None, false).is_err());
        assert!(parse_offset("final", None, None, None)
            .err()
            .unwrap()
            .contains("Start a fresh byte session"));
        assert!(parse_offset("cancelled", None, None, None)
            .err()
            .unwrap()
            .contains("Start a fresh byte session"));
    }
    #[test]
    fn bearer_session_never_follows_untrusted_origins() {
        assert!(safe_session_url(
            "https://photoslibrary.googleapis.com/v1/uploads?upload_id=secret"
        ));
        for url in [
            "http://photoslibrary.googleapis.com/v1/uploads?x=1",
            "https://photoslibrary.googleapis.com.evil.test/v1/uploads?x=1",
            "https://photoslibrary.googleapis.com@evil.test/v1/uploads?x=1",
            "https://evil.test/v1/uploads?x=1",
            "https://photoslibrary.googleapis.com/evil?x=1",
            "https://photoslibrary.googleapis.com:444/v1/uploads?x=1",
            "https://photoslibrary.googleapis.com/v1/uploads?x=1#fragment",
        ] {
            assert!(!safe_session_url(url));
        }
    }
    #[test]
    fn object_ids_cannot_inject_paths_or_queries() {
        for id in ["../albums", "x?key=secret", "", "abc/def"] {
            assert!(safe_id(id).is_err());
        }
        assert!(safe_id("Abc_12-XY").is_ok());
    }
    #[test]
    fn resumable_start_uses_photos_headers_without_filename_header() {
        let request = upload_start_request(
            &reqwest::blocking::Client::new(),
            "test-token",
            "image/jpeg",
            1234,
        )
        .build()
        .unwrap();
        assert_eq!(request.url().as_str(), UPLOADS);
        assert_eq!(request.headers()["X-Goog-Upload-Raw-Size"], "1234");
        assert_eq!(
            request.headers()["X-Goog-Upload-Content-Type"],
            "image/jpeg"
        );
        assert_eq!(request.headers()["X-Goog-Upload-Protocol"], "resumable");
        assert!(request.headers().get("X-Goog-Upload-File-Name").is_none());
        assert!(request
            .headers()
            .get("X-Goog-Upload-Header-Content-Length")
            .is_none());
        assert!(
            registration_tokens(&[("test-token".into(), "Caf\u{e9}-\u{99ac}.jpg".into())]).is_ok()
        );
    }
    #[test]
    fn queried_offset_is_required_and_never_rounded_or_invented() {
        assert_eq!(
            parse_offset("active", Some("100"), None, None)
                .unwrap()
                .received,
            100
        );
        assert!(parse_offset("active", None, None, None).is_err());
        assert!(parse_offset("active", Some("bad"), Some(100), None).is_err());
        assert_eq!(
            parse_offset("active", None, Some(512), None)
                .unwrap()
                .received,
            512
        );
        assert!(parse_offset("final", Some("512"), None, None).is_err());
        assert!(parse_offset("final", Some("512"), None, Some(String::new())).is_err());
        assert_eq!(
            parse_offset("final", Some("512"), None, Some("test-upload-token".into()))
                .unwrap()
                .token
                .unwrap(),
            "test-upload-token"
        );
    }
    fn session(granularity: u64) -> Session {
        Session {
            url: "https://photoslibrary.googleapis.com/v1/uploads?upload_id=test-only".into(),
            granularity,
            started_at: 0,
        }
    }
    #[test]
    fn restored_session_and_chunk_math_are_validated_without_panics() {
        assert!(chunk_end(&session(0), 0, 1, false).is_err());
        assert!(chunk_end(&session(33 * 1024 * 1024), 0, 1, true).is_err());
        assert!(chunk_end(&session(256), u64::MAX, 1, true).is_err());
        assert!(chunk_end(&session(256), 0, 255, false).is_err());
        assert!(chunk_end(&session(256), 0, 33 * 1024 * 1024, true).is_err());
        assert!(chunk_end(&session(256), 0, 0, false).is_err());
        assert_eq!(chunk_end(&session(256), 100, 256, false).unwrap(), 356);
        assert_eq!(chunk_end(&session(256), 256, 13, true).unwrap(), 269);
    }
    #[test]
    fn registration_accepts_partial_failures_but_rejects_ambiguous_results() {
        let items = vec![
            ("token-a".into(), "a.jpg".into()),
            ("token-b".into(), "b.jpg".into()),
        ];
        let good = json!({"newMediaItemResults":[{"uploadToken":"token-a","mediaItem":{"id":"media-a"}},{"uploadToken":"token-b","status":{"code":3}}]});
        let parsed = registrations(&good, &items).unwrap();
        assert!(parsed[0].result.is_ok());
        assert!(parsed[1].result.is_err());
        for bad in [
            json!({"newMediaItemResults":[]}),
            json!({"newMediaItemResults":[{"uploadToken":"token-a","mediaItem":{"id":"media-a"}},{"uploadToken":"token-a","mediaItem":{"id":"media-a"}}]}),
            json!({"newMediaItemResults":[{"uploadToken":"foreign","mediaItem":{"id":"media-a"}},{"uploadToken":"token-b","mediaItem":{"id":"media-b"}}]}),
        ] {
            assert!(registrations(&bad, &items).is_err());
        }
        assert!(registration_tokens(&[
            ("token-a".into(), "a.jpg".into()),
            ("token-a".into(), "b.jpg".into())
        ])
        .is_err());
    }
    #[test]
    fn readback_requires_exact_requested_identifiers() {
        let ids = vec!["media-a".into(), "media-b".into()];
        assert_eq!(verification(&json!({"mediaItemResults":[{"mediaItem":{"id":"media-b"}},{"mediaItem":{"id":"media-a"}}]}), &ids).unwrap().len(), 2);
        for bad in [
            json!({"mediaItemResults":[]}),
            json!({"mediaItemResults":[{"mediaItem":{"id":"media-a"}},{"mediaItem":{"id":"media-a"}}]}),
            json!({"mediaItemResults":[{"mediaItem":{"id":"media-a"}},{"mediaItem":{"id":"foreign"}}]}),
            json!({"mediaItemResults":[{"mediaItem":{"id":"media-a"}},{"status":{"code":5}}]}),
        ] {
            assert!(verification(&bad, &ids).is_err());
        }
    }
    #[test]
    fn pagination_is_bounded_even_when_pages_are_empty() {
        let mut seen = HashSet::new();
        assert_eq!(
            next_album_page(&json!({"nextPageToken":"page-a"}), 1, &mut seen).unwrap(),
            Some("page-a".into())
        );
        assert!(next_album_page(&json!({"nextPageToken":"page-a"}), 2, &mut seen).is_err());
        assert!(next_album_page(&json!({"nextPageToken":"page-b"}), 200, &mut seen).is_err());
        assert!(next_album_page(&json!({"nextPageToken":123}), 1, &mut seen).is_err());
        assert!(next_album_page(&json!({}), 200, &mut seen)
            .unwrap()
            .is_none());
    }
}
