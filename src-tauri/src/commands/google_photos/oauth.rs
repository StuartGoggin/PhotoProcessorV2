//! Desktop OAuth: system browser, random loopback port, PKCE S256, one-use state.
//! The webview never receives tokens. Google endpoints are constants, not config.
use super::store::GoogleStore;
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    time::{Duration, Instant},
};

pub const SCOPES: [&str; 5] = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/photoslibrary.appendonly",
    "https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
    "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
];

#[derive(Clone, Serialize, Deserialize)]
pub struct ClientConfig {
    pub client_id: String,
    pub client_secret: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub email: String,
    pub display_name: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub account: Account,
    google_sub: String,
    client_fingerprint: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    scopes: Vec<String>,
}
#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: u64,
    scope: Option<String>,
    token_type: String,
}
#[derive(Deserialize)]
struct Identity {
    sub: String,
    email: String,
    email_verified: bool,
    name: Option<String>,
}

pub fn client() -> Result<Client, String> {
    static HTTP: std::sync::OnceLock<Result<Client, String>> = std::sync::OnceLock::new();
    HTTP.get_or_init(|| {
        Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .user_agent("PhotoGoGo/GooglePhotosExport")
            .build()
            .map_err(|_| "Could not initialize secure Google connection.".into())
    })
    .clone()
}
pub fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Operating-system randomness unavailable.".to_string())?;
    Ok(base64url(&bytes))
}
fn base64url(bytes: &[u8]) -> String {
    crate::utils::base64_encode(bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}
fn client_fingerprint(client_id: &str) -> String {
    hex::encode(Sha256::digest(client_id.as_bytes()))
}
fn account_key(client_id: &str, sub: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(client_id.as_bytes());
    hash.update([0]);
    hash.update(sub.as_bytes());
    hex::encode(hash.finalize())
}
fn scoped_account(client_id: &str, identity: &Identity) -> Account {
    Account {
        id: account_key(client_id, &identity.sub),
        display_name: identity
            .name
            .clone()
            .unwrap_or_else(|| identity.email.clone()),
        email: identity.email.clone(),
    }
}
fn config_unchanged(store: &GoogleStore, expected: &ClientConfig) -> Result<(), String> {
    let current: ClientConfig = store.load("oauth_config")?.ok_or(
        "Google OAuth configuration changed during authorization. Reconnect before continuing.",
    )?;
    if current.client_id != expected.client_id || current.client_secret != expected.client_secret {
        return Err(
            "Google OAuth configuration changed during authorization. Reconnect before continuing."
                .into(),
        );
    }
    Ok(())
}
fn required_scopes(scopes: Option<&str>, previous: &[String]) -> Result<Vec<String>, String> {
    let scopes: Vec<String> = scopes
        .map(|value| value.split_whitespace().map(String::from).collect())
        .unwrap_or_else(|| previous.to_vec());
    if SCOPES[2..]
        .iter()
        .any(|needed| !scopes.iter().any(|scope| scope == needed))
    {
        return Err("Allow all three Photos permissions to create, verify and set covers for app-created albums. Reconnect before continuing.".into());
    }
    Ok(scopes)
}
fn validate_binding(
    credentials: &Credentials,
    config: &ClientConfig,
    expected: &str,
) -> Result<(), String> {
    if credentials.client_fingerprint != client_fingerprint(&config.client_id)
        || credentials.account.id != account_key(&config.client_id, &credentials.google_sub)
        || credentials.account.id != expected
    {
        return Err("This job belongs to a different Google account or OAuth client. Reconnect the original account/client; nothing was uploaded.".into());
    }
    Ok(())
}

pub fn import_config(store: &GoogleStore, path: &Path) -> Result<(), String> {
    let bytes = super::store::read_bounded(path, 64 * 1024)?
        .ok_or("Choose a readable desktop OAuth JSON file.")?;
    let data: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid OAuth JSON file.")?;
    let installed = data
        .get("installed")
        .ok_or("Use a Google Cloud Desktop app OAuth client, not a Web application client.")?;
    let id = installed["client_id"]
        .as_str()
        .filter(|v| {
            v.ends_with(".apps.googleusercontent.com")
                && v.len() < 300
                && v.len() > ".apps.googleusercontent.com".len()
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        })
        .ok_or("Invalid Desktop OAuth client ID.")?;
    let secret = match installed.get("client_secret") {
        None => "",
        Some(value) => value
            .as_str()
            .filter(|v| v.len() < 1000 && !v.chars().any(char::is_control))
            .ok_or("Invalid Desktop OAuth client secret.")?,
    };
    if let Some(previous) = store.load::<ClientConfig>("oauth_config")? {
        if previous.client_id != id {
            return Err("This installation is already bound to a different Google OAuth client. Changing clients requires explicitly forgetting its Google jobs and receipts; no existing configuration was changed.".into());
        }
    }
    store.save(
        "oauth_config",
        &ClientConfig {
            client_id: id.into(),
            client_secret: secret.into(),
        },
    )
}

pub(super) const SAFE_OAUTH_CODES: &[&str]=&["INVALID_GRANT","INVALID_CLIENT","UNAUTHORIZED_CLIENT","INVALID_SCOPE","ACCESS_DENIED","TEMPORARILY_UNAVAILABLE","RATE_LIMITED","REJECTED"];
pub(super) fn oauth_code(error:&str)->Option<&'static str>{
    SAFE_OAUTH_CODES.iter().copied().find(|code|error.contains(&format!("[OAuth {code}]")))
}
pub(super) fn oauth_hint(code:&str)->&'static str{
    match code {
        "INVALID_GRANT"=>"Google no longer accepts this authorization. In Transfer to Google Photos choose Reconnect same account, sign in to the same Google account with the unchanged Desktop OAuth setup, then Retry this saved job. Receipts and selections are retained. Expired or revoked authorization requires a new sign-in; retry alone cannot renew it.",
        "INVALID_CLIENT"|"UNAUTHORIZED_CLIENT"=>"Check the original Google Cloud Desktop OAuth client setup. Re-import that same client's JSON if necessary, then Reconnect same account and Retry this saved job. Do not create a different client to bypass saved-job account binding.",
        "INVALID_SCOPE"|"ACCESS_DENIED"=>"Reconnect the same Google account and grant the requested Photos permissions using the unchanged Desktop OAuth setup, then Retry this saved job.",
        "TEMPORARILY_UNAVAILABLE"|"RATE_LIMITED"=>"Google authorization is temporarily unavailable or rate limited. Wait before retrying this saved job; no photos were transferred by this account-check step.",
        _=>"Google rejected the authorization request without a recognized safe error code. Reconnect the same account using the unchanged Desktop OAuth setup, then Retry this saved job. Check Desktop client and consent/test-user settings if it persists.",
    }
}
pub(super) fn recovery_message(error:&str)->Option<String>{
    oauth_code(error).map(|code|format!("Google authorization needs attention ({code}). {}",oauth_hint(code)))
        .or_else(||error.contains("Google authorization returned HTTP 400").then(||format!("Google authorization needs attention. {}",oauth_hint("REJECTED"))))
}
fn check_reconnect_account(previous:Option<&Account>, next:&Account)->Result<(),String>{
    if previous.is_some_and(|p|p.id!=next.id){return Err("Reconnect must use the same Google account and unchanged Desktop OAuth client. The previous connection and saved jobs were retained. Disconnect explicitly only when you intend to change accounts.".into());}
    Ok(())
}
fn token_response(response: reqwest::blocking::Response) -> Result<TokenResponse, String> {
    if !response.status().is_success() {
        let status=response.status().as_u16();
        let mut body=Vec::new();
        // Never echo error_description, arbitrary fields, or an unbounded body.
        let _=response.take(8193).read_to_end(&mut body);
        let value=if body.len()<=8192 { serde_json::from_slice::<serde_json::Value>(&body).ok() } else { None };
        let code=value.as_ref().and_then(|v|v.get("error")).and_then(|v|v.as_str());
        let code=match code {
            Some("invalid_grant")=>"INVALID_GRANT", Some("invalid_client")=>"INVALID_CLIENT",
            Some("unauthorized_client")=>"UNAUTHORIZED_CLIENT", Some("invalid_scope")=>"INVALID_SCOPE",
            Some("access_denied")=>"ACCESS_DENIED", Some("temporarily_unavailable")=>"TEMPORARILY_UNAVAILABLE",
            _ if status==429=>"RATE_LIMITED", _ if status>=500=>"TEMPORARILY_UNAVAILABLE", _=>"REJECTED",
        };
        return Err(format!("Google authorization returned HTTP {status}. [OAuth {code}] {}",oauth_hint(code)));
    }
    let token: TokenResponse = response
        .json()
        .map_err(|_| "Google returned an invalid token response.")?;
    if !token.token_type.eq_ignore_ascii_case("bearer")
        || token.access_token.is_empty()
        || token.access_token.len() > 16384
    {
        return Err("Google returned an unsupported token type.".into());
    }
    Ok(token)
}
fn identity(http: &Client, token: &str) -> Result<Identity, String> {
    let response = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(token)
        .send()
        .map_err(|_| "Could not verify the signed-in Google account.")?;
    if !response.status().is_success() {
        return Err("Google account identity verification failed; nothing was saved.".into());
    }
    let id: Identity = response
        .json()
        .map_err(|_| "Invalid Google account identity.")?;
    if id.sub.is_empty()
        || id.sub.len() > 255
        || !id.sub.is_ascii()
        || !id.email_verified
        || id.email.is_empty()
        || id.email.len() > 1024
        || id.name.as_ref().is_some_and(|name| name.len() > 1024)
    {
        return Err("Google did not verify the account identity/email.".into());
    }
    Ok(id)
}

pub fn connect(store: &GoogleStore) -> Result<Account, String> {
    let previous=account(store)?;
    let config: ClientConfig = store
        .load("oauth_config")?
        .ok_or("Import your Google Cloud Desktop OAuth JSON first.")?;
    let state = random_id()?;
    let verifier = random_id()?;
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "Could not open the local Google sign-in callback.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "Could not initialize sign-in callback.")?;
    let redirect = format!(
        "http://127.0.0.1:{}/oauth2/callback",
        listener
            .local_addr()
            .map_err(|_| "Sign-in port unavailable.")?
            .port()
    );
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", &SCOPES.join(" ")),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("access_type", "offline"),
        ("prompt", "consent select_account"),
    ]);
    open_url(url.as_str())?;
    let deadline = Instant::now() + Duration::from_secs(180);
    let code = loop {
        if Instant::now() >= deadline {
            return Err("Google sign-in timed out. You can safely try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, address)) => {
                if !address.ip().is_loopback() {
                    continue;
                }
                let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                let result = read_callback_line(&mut stream, deadline)
                    .and_then(|line| callback_code(&line, &state));
                let message = if result.is_ok() {
                    "Sign-in received. Return to PhotoGoGo. This window can be closed."
                } else {
                    "This sign-in response was not accepted. Return to PhotoGoGo."
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}", message.len(), message);
                match result {
                    Ok(code) => break code,
                    Err(error) if error == "Sign-in cancelled in Google." => return Err(error),
                    Err(_) => continue,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("Local sign-in callback failed.".into()),
        }
    };
    let http = client()?;
    let token = token_response(
        http.post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("code", code.as_str()),
                ("code_verifier", verifier.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .map_err(|_| "Google token exchange failed. Try connecting again.")?,
    )?;
    let scopes = required_scopes(token.scope.as_deref(), &[])?;
    let verified = identity(&http, &token.access_token)?;
    let account = scoped_account(&config.client_id, &verified);
    check_reconnect_account(previous.as_ref(),&account)?;
    let credentials = Credentials {
        account: account.clone(),
        google_sub: verified.sub,
        client_fingerprint: client_fingerprint(&config.client_id),
        access_token: token.access_token,
        refresh_token: token
            .refresh_token
            .filter(|s| !s.is_empty() && s.len() <= 16384)
            .ok_or("Google did not issue a valid offline token. Reconnect with consent.")?,
        expires_at: chrono::Utc::now().timestamp() + token.expires_in.min(86400) as i64,
        scopes,
    };
    config_unchanged(store, &config)?;
    store.save("credentials", &credentials)?;
    Ok(account)
}

fn read_callback_line(
    stream: &mut TcpStream,
    sign_in_deadline: Instant,
) -> Result<Vec<u8>, String> {
    let deadline = std::cmp::min(sign_in_deadline, Instant::now() + Duration::from_secs(2));
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or("Incomplete sign-in callback.")?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| "Could not bound the sign-in callback.")?;
        let mut buffer = [0u8; 1024];
        let count = stream
            .read(&mut buffer)
            .map_err(|_| "Incomplete sign-in callback.")?;
        if count == 0 {
            return Err("Incomplete sign-in callback.".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(2).position(|pair| pair == b"\r\n") {
            if end + 2 > 8192 {
                return Err("Sign-in callback is too large.".into());
            }
            bytes.truncate(end + 2);
            return Ok(bytes);
        }
        if bytes.len() >= 8192 {
            return Err("Sign-in callback is too large.".into());
        }
    }
}

fn callback_code(bytes: &[u8], state: &str) -> Result<String, String> {
    if bytes.len() > 8192 || !bytes.ends_with(b"\r\n") {
        return Err("Incomplete sign-in callback.".into());
    }
    let request = std::str::from_utf8(bytes).map_err(|_| "Invalid callback.")?;
    let line = request
        .strip_suffix("\r\n")
        .ok_or("Invalid callback line.")?;
    if line.contains(['\r', '\n', '\t']) {
        return Err("Invalid callback line.".into());
    }
    let mut first = line.split(' ');
    if first.next() != Some("GET") {
        return Err("Invalid callback method.".into());
    }
    let target = first.next().ok_or("Invalid callback target.")?;
    if !matches!(first.next(), Some("HTTP/1.1" | "HTTP/1.0")) || first.next().is_some() {
        return Err("Invalid callback HTTP request.".into());
    }
    if !target.starts_with("/oauth2/callback?") || target.contains('#') || target.contains('\\') {
        return Err("Invalid callback path.".into());
    }
    let url =
        Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| "Invalid callback URL.")?;
    let values: Vec<_> = url.query_pairs().collect();
    if values.iter().filter(|(k, _)| k == "state").count() != 1
        || values
            .iter()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.as_ref())
            != Some(state)
    {
        return Err("Sign-in state mismatch.".into());
    }
    let errors = values.iter().filter(|(k, _)| k == "error").count();
    if errors > 1 || (errors == 1 && values.iter().any(|(k, _)| k == "code")) {
        return Err("Invalid sign-in response.".into());
    }
    if errors == 1 {
        return Err("Sign-in cancelled in Google.".into());
    }
    if values.iter().filter(|(k, _)| k == "code").count() != 1 {
        return Err("Invalid sign-in code.".into());
    }
    values
        .iter()
        .find(|(k, _)| k == "code")
        .map(|(_, v)| v.to_string())
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or_else(|| "Invalid sign-in code.".into())
}

pub fn account(store: &GoogleStore) -> Result<Option<Account>, String> {
    let Some(credentials) = store.load::<Credentials>("credentials")? else {
        return Ok(None);
    };
    let config: ClientConfig = store
        .load("oauth_config")?
        .ok_or("Google OAuth configuration is missing.")?;
    validate_binding(&credentials, &config, &credentials.account.id)?;
    Ok(Some(credentials.account))
}
pub fn access_token(store: &GoogleStore, expected: &str) -> Result<String, String> {
    let mut credentials: Credentials = store
        .load("credentials")?
        .ok_or("Connect Google Photos before continuing this job.")?;
    let config: ClientConfig = store
        .load("oauth_config")?
        .ok_or("Google OAuth configuration is missing.")?;
    validate_binding(&credentials, &config, expected)?;
    required_scopes(None, &credentials.scopes)?;
    if credentials.expires_at > chrono::Utc::now().timestamp() + 120 {
        return Ok(credentials.access_token);
    }
    let previous_access = credentials.access_token.clone();
    let previous_refresh = credentials.refresh_token.clone();
    let http = client()?;
    let token = token_response(
        http.post("https://oauth2.googleapis.com/token")
            .form(&[
                ("client_id", config.client_id.as_str()),
                ("client_secret", config.client_secret.as_str()),
                ("refresh_token", credentials.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .map_err(|_| "Could not refresh Google authorization. Reconnect if this persists.")?,
    )?;
    let verified = identity(&http, &token.access_token)?;
    if verified.sub != credentials.google_sub
        || account_key(&config.client_id, &verified.sub) != expected
    {
        return Err(
            "Google returned a different account identity. Reconnect before retrying.".into(),
        );
    }
    credentials.scopes = required_scopes(token.scope.as_deref(), &credentials.scopes)?;
    credentials.access_token = token.access_token;
    if let Some(refresh) = token.refresh_token {
        if refresh.is_empty() || refresh.len() > 16384 {
            return Err(
                "Google returned an invalid offline token. Reconnect before retrying.".into(),
            );
        }
        credentials.refresh_token = refresh;
    }
    credentials.expires_at = chrono::Utc::now().timestamp() + token.expires_in.min(86400) as i64;
    config_unchanged(store, &config)?;
    let current: Credentials = store.load("credentials")?.ok_or(
        "Google authorization was disconnected while refreshing. Reconnect before continuing.",
    )?;
    if current.account.id != expected
        || current.access_token != previous_access
        || current.refresh_token != previous_refresh
    {
        return Err(
            "Google authorization changed while refreshing. Retry using the current connection."
                .into(),
        );
    }
    store.save("credentials", &credentials)?;
    Ok(credentials.access_token)
}
pub fn disconnect(store: &GoogleStore, revoke: bool) -> Result<(), String> {
    if revoke {
        if let Some(credentials) = store.load::<Credentials>("credentials")? {
            let response = client()?.post("https://oauth2.googleapis.com/revoke").form(&[("token", credentials.refresh_token)]).send().map_err(|_| "Could not revoke Google access. Retry, or disconnect locally and revoke in your Google account.")?;
            if !response.status().is_success() {
                return Err(
                    "Google access revocation failed. Retry or revoke in your Google account."
                        .into(),
                );
            }
        }
    }
    store.remove("credentials")
}

pub fn open_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|_| "Invalid Google link.")?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some(
                "accounts.google.com"
                    | "photos.google.com"
                    | "developers.google.com"
                    | "console.cloud.google.com"
            )
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err("Only verified Google links can be opened.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        let wide: Vec<u16> = std::ffi::OsStr::new(url)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let code = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                wide.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        } as isize;
        if code <= 32 {
            return Err("Could not open your default browser.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Browser sign-in is not enabled on this platform build.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_s256_matches_rfc7636() {
        assert_eq!(
            base64url(&Sha256::digest(
                b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
            )),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn callback_requires_single_state_and_code() {
        assert_eq!(
            callback_code(
                b"GET /oauth2/callback?state=abc&code=ok HTTP/1.1\r\n",
                "abc"
            )
            .unwrap(),
            "ok"
        );
        for request in [
            "POST /oauth2/callback?state=abc&code=x HTTP/1.1\r\n",
            "GET /oauth2/callback?state=wrong&code=x HTTP/1.1\r\n",
            "GET /oauth2/callback?state=abc&state=abc&code=x HTTP/1.1\r\n",
            "GET /other?state=abc&code=x HTTP/1.1\r\n",
            "GET /oauth2/callback?state=abc&code=x&code=y HTTP/1.1\r\n",
            "GET /oauth2/callback?state=abc&code=x HTTP/2\r\n",
            "GET /oauth2/callback?state=abc&code=x HTTP/1.1 extra\r\n",
            "GET /oauth2/callback?state=abc&code=x HTTP/1.1",
            "GET /oauth2/callback?state=abc&code=x#fragment HTTP/1.1\r\n",
            "GET /oauth2/callback?state=abc&error=access_denied&code=x HTTP/1.1\r\n",
            "GET /oauth2/callback?state=abc&error=x&error=y HTTP/1.1\r\n",
        ] {
            assert!(callback_code(request.as_bytes(), "abc").is_err());
        }
        assert_eq!(
            callback_code(
                b"GET /oauth2/callback?state=abc&error=access_denied HTTP/1.1\r\n",
                "abc"
            )
            .unwrap_err(),
            "Sign-in cancelled in Google."
        );
    }
    #[test]
    fn random_identifiers_are_url_safe_and_unique() {
        let a = random_id().unwrap();
        let b = random_id().unwrap();
        assert_eq!(a.len(), 43);
        assert_ne!(a, b);
        assert!(a
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'));
    }
    #[test]
    fn callback_reader_reassembles_fragmented_request_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let writer = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            for fragment in [
                "GET /oauth2/call",
                "back?state=abc&code=ok ",
                "HTTP/1.1\r",
                "\nHost: localhost\r\n\r\n",
            ] {
                stream.write_all(fragment.as_bytes()).unwrap();
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        let (mut stream, _) = listener.accept().unwrap();
        let line =
            read_callback_line(&mut stream, Instant::now() + Duration::from_secs(5)).unwrap();
        assert_eq!(callback_code(&line, "abc").unwrap(), "ok");
        writer.join().unwrap();
    }
    #[test]
    fn callback_reader_rejects_incomplete_and_oversized_lines() {
        for text in [
            "GET /oauth2/callback?state=abc".to_string(),
            "x".repeat(8192),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let writer = std::thread::spawn(move || {
                let mut stream = TcpStream::connect(address).unwrap();
                stream.write_all(text.as_bytes()).unwrap();
            });
            let (mut stream, _) = listener.accept().unwrap();
            assert!(
                read_callback_line(&mut stream, Instant::now() + Duration::from_secs(5)).is_err()
            );
            writer.join().unwrap();
        }
    }
    #[test]
    fn client_and_subject_jointly_identify_an_account() {
        assert_eq!(
            account_key("client-a", "subject-a"),
            account_key("client-a", "subject-a")
        );
        assert_ne!(
            account_key("client-a", "subject-a"),
            account_key("client-b", "subject-a")
        );
        assert_ne!(
            account_key("client-a", "subject-a"),
            account_key("client-a", "subject-b")
        );
        assert_ne!(account_key("ab", "c"), account_key("a", "bc"));
    }
    #[test]
    fn refresh_scopes_retain_only_when_omitted_and_reject_reduction() {
        let previous: Vec<String> = SCOPES.iter().map(|value| value.to_string()).collect();
        assert_eq!(required_scopes(None, &previous).unwrap(), previous);
        assert_eq!(
            required_scopes(Some(&SCOPES.join(" ")), &[]).unwrap().len(),
            5
        );
        assert!(required_scopes(Some("openid email"), &previous).is_err());
        assert!(required_scopes(None, &[]).is_err());
        assert!(required_scopes(Some(""), &previous).is_err());
    }
    struct TestSeal;
    impl super::super::store::Sealer for TestSeal {
        fn seal(&self, bytes: &[u8]) -> Result<Vec<u8>, String> {
            Ok(bytes.iter().map(|value| value ^ 0xa7).collect())
        }
        fn open(&self, bytes: &[u8]) -> Result<Vec<u8>, String> {
            self.seal(bytes)
        }
    }
    fn test_store() -> (std::path::PathBuf, GoogleStore) {
        let directory =
            std::env::temp_dir().join(format!("photogogo-oauth-test-{}", random_id().unwrap()));
        let store = GoogleStore::new(directory.clone(), std::sync::Arc::new(TestSeal)).unwrap();
        (directory, store)
    }
    #[test]
    fn import_is_bounded_and_cannot_replace_client_binding() {
        let (directory, store) = test_store();
        let path = directory.join("desktop.json");
        std::fs::write(&path, serde_json::to_vec(&serde_json::json!({"installed":{"client_id":"test-a.apps.googleusercontent.com","client_secret":"test-config"}})).unwrap()).unwrap();
        import_config(&store, &path).unwrap();
        let config: ClientConfig = store.load("oauth_config").unwrap().unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(
                &serde_json::json!({"installed":{"client_id":"test-b.apps.googleusercontent.com"}}),
            )
            .unwrap(),
        )
        .unwrap();
        assert!(import_config(&store, &path).is_err());
        assert!(config_unchanged(&store, &config).is_ok());
        std::fs::write(&path, vec![b' '; 64 * 1024 + 1]).unwrap();
        assert!(import_config(&store, &path).is_err());
        store
            .save(
                "oauth_config",
                &ClientConfig {
                    client_id: config.client_id.clone(),
                    client_secret: "different-test-config".into(),
                },
            )
            .unwrap();
        assert!(config_unchanged(&store, &config).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn cached_access_is_never_returned_for_changed_client_or_subject() {
        let (directory, store) = test_store();
        let config = ClientConfig {
            client_id: "test-a.apps.googleusercontent.com".into(),
            client_secret: "test-only".into(),
        };
        let identity = Identity {
            sub: "subject-a".into(),
            email: "test@example.test".into(),
            email_verified: true,
            name: None,
        };
        let account = scoped_account(&config.client_id, &identity);
        let credentials = Credentials {
            account: account.clone(),
            google_sub: identity.sub,
            client_fingerprint: client_fingerprint(&config.client_id),
            access_token: "test-cached-access".into(),
            refresh_token: "test-offline".into(),
            expires_at: chrono::Utc::now().timestamp() + 3600,
            scopes: SCOPES.iter().map(|value| value.to_string()).collect(),
        };
        store.save("oauth_config", &config).unwrap();
        store.save("credentials", &credentials).unwrap();
        assert_eq!(
            access_token(&store, &account.id).unwrap(),
            "test-cached-access"
        );
        assert!(access_token(&store, "different-account").is_err());
        store
            .save(
                "oauth_config",
                &ClientConfig {
                    client_id: "test-b.apps.googleusercontent.com".into(),
                    client_secret: "test-only".into(),
                },
            )
            .unwrap();
        assert!(access_token(&store, &account.id).is_err());
        assert!(super::account(&store).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}

#[cfg(test)]
mod renewal_error_tests {
    use super::*;
    fn reject(body: &str) -> String {
        let listener=TcpListener::bind("127.0.0.1:0").unwrap();
        let address=listener.local_addr().unwrap();
        let body=body.to_owned();
        let server=std::thread::spawn(move||{
            let (mut stream,_)=listener.accept().unwrap();
            let mut request=[0u8;2048]; let _=stream.read(&mut request);
            write!(stream,"HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).unwrap();
        });
        let response=Client::builder().no_proxy().timeout(Duration::from_secs(5)).build().unwrap().post(format!("http://{address}/token")).send().unwrap();
        let error=match token_response(response){Ok(_)=>panic!("Expected rejection"),Err(e)=>e};
        server.join().unwrap(); error
    }
    #[test]
    fn renewal_error_retains_only_allowlisted_machine_code_and_recovery() {
        let error=reject(r#"{"error":"invalid_grant","error_description":"private-token email@example.test","refresh_token":"secret"}"#);
        assert!(error.contains("[OAuth INVALID_GRANT]"),"{error}");
        assert!(error.contains("same Google account"));
        for secret in ["private-token","email@example.test","secret"]{assert!(!error.contains(secret));}
        let error=reject(r#"{"error":"invalid_client","error_description":"arbitrary"}"#);
        assert!(error.contains("[OAuth INVALID_CLIENT]"));
        assert!(error.contains("Desktop"));
    }
    #[test]
    fn renewal_unknown_and_oversize_error_bodies_never_echo_input() {
        let error=reject(r#"{"error":"private@example.test","error_description":"invalid_grant"}"#);
        assert!(!error.contains("private@")&&!error.contains("[OAuth INVALID_GRANT]"));
        let body=format!("{{\"error\":\"invalid_grant\",\"description\":\"{}\"}}","private".repeat(2000));
        let error=reject(&body);
        assert!(!error.contains("private")&&!error.contains("[OAuth INVALID_GRANT]"));
    }
}

#[cfg(test)]
mod reconnect_tests {
 use super::*;
 #[test]fn reconnect_refuses_a_different_account_without_discarding_the_old_identity(){
  let a=Account{id:"same-client-account-a".into(),email:"a@example.test".into(),display_name:"A".into()};let b=Account{id:"same-client-account-b".into(),email:"b@example.test".into(),display_name:"B".into()};
  assert!(check_reconnect_account(Some(&a),&b).is_err());assert!(check_reconnect_account(Some(&a),&a).is_ok());assert!(check_reconnect_account(None,&b).is_ok());assert_eq!(a.id,"same-client-account-a");
 }
}
