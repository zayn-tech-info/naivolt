//! HttpOnly refresh cookie for the website.
//!
//! Access JWTs stay 15 minutes and travel on `Authorization`. The refresh
//! secret is a 7-day cookie (`HttpOnly`, `Secure` on HTTPS, `SameSite=Lax`)
//! so a reload does not depend on `localStorage` and JavaScript cannot read it.
//! The JSON body still carries `refreshToken` for native clients.

use axum::http::header::{HeaderMap, SET_COOKIE};
use axum::http::HeaderValue;

pub const COOKIE_NAME: &str = "naivolt_refresh";
pub const MAX_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const PATH: &str = "/api/v1/auth";

pub fn set_refresh(headers: &mut HeaderMap, secret: &str, secure: bool) {
    headers.insert(SET_COOKIE, cookie_value(secret, MAX_AGE_SECONDS, secure));
}

pub fn clear_refresh(headers: &mut HeaderMap, secure: bool) {
    headers.insert(SET_COOKIE, cookie_value("", 0, secure));
}

pub fn cookie_secure(web_app_url: &str) -> bool {
    web_app_url.starts_with("https://")
}

/// Body wins when the client still holds the secret (native / first cookie write).
pub fn presented_refresh(headers: &HeaderMap, body: Option<&str>) -> Option<String> {
    if let Some(secret) = body.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(secret.to_string());
    }
    cookie_from_header(headers)
}

fn cookie_from_header(headers: &HeaderMap) -> Option<String> {
    let header = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for part in header.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name == COOKIE_NAME {
            let value = value.trim();
            if value.is_empty() {
                return None;
            }
            return Some(value.to_string());
        }
    }
    None
}

fn cookie_value(secret: &str, max_age: i64, secure: bool) -> HeaderValue {
    let mut value = format!(
        "{COOKIE_NAME}={secret}; Max-Age={max_age}; Path={PATH}; HttpOnly; SameSite=Lax"
    );
    if secure {
        value.push_str("; Secure");
    }
    HeaderValue::from_str(&value).expect("refresh cookie is ASCII")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::COOKIE;

    #[test]
    fn https_dashboard_gets_a_secure_cookie() {
        assert!(cookie_secure("https://www.naivolt.com"));
        assert!(!cookie_secure("http://localhost:5173"));
    }

    #[test]
    fn body_beats_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_static("naivolt_refresh=from-cookie"));
        assert_eq!(
            presented_refresh(&headers, Some("from-body")).as_deref(),
            Some("from-body")
        );
        assert_eq!(
            presented_refresh(&headers, Some("")).as_deref(),
            Some("from-cookie")
        );
    }

    #[test]
    fn cookie_header_is_httponly_lax_and_seven_days() {
        let mut headers = HeaderMap::new();
        set_refresh(&mut headers, "abc", true);
        let value = headers.get(SET_COOKIE).unwrap().to_str().unwrap();
        assert!(value.contains("abc"));
        assert!(value.contains("Max-Age=604800"));
        assert!(value.contains("HttpOnly"));
        assert!(value.contains("SameSite=Lax"));
        assert!(value.contains("Secure"));
        assert!(value.contains("Path=/api/v1/auth"));
    }
}
