//! A small JSON-RPC client.
//!
//! Retries transient failures with backoff. Public RPC endpoints rate-limit and
//! drop connections routinely, and a watcher that gives up on the first 429
//! stops seeing deposits until someone notices.
//!
//! Not every failure deserves the same response, which is what [`RpcError`]
//! separates. A rate limit clears if we wait; a refused block range never does,
//! and retrying it four times only wastes the quota that the next, smaller query
//! needs.

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use std::time::Duration;

const MAX_ATTEMPTS: u32 = 4;

/// Ceiling on how long a rate-limited call waits, however large `Retry-After` is.
/// A watcher parked for ten minutes is indistinguishable from a stopped one.
const MAX_RATE_LIMIT_WAIT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum RpcError {
    /// The endpoint asked us to slow down. Waiting fixes it.
    #[error("rate limited: {0}")]
    RateLimited(String),
    /// The endpoint refused this query's block range or result size. Waiting
    /// does not fix it — the caller has to ask for less.
    #[error("range refused: {0}")]
    RangeRefused(String),
    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

pub type RpcResult<T> = Result<T, RpcError>;

pub struct JsonRpc {
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
}

impl JsonRpc {
    pub fn new(url: String) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .expect("reqwest client"),
            url,
            headers: Vec::new(),
        }
    }

    /// Add a header sent with every request — an API key, in practice.
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_owned(), value.to_owned()));
        self
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> RpcResult<T> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });

        let mut last_error = None;

        for attempt in 0..MAX_ATTEMPTS {
            match self.try_call::<T>(&body, method).await {
                Ok(value) => return Ok(value),
                // Asking again for a range the node will not serve wastes the
                // request budget the smaller retry is about to need.
                Err(err @ RpcError::RangeRefused(_)) => return Err(err),
                Err(err) => {
                    let wait = backoff(&err, attempt);
                    tracing::warn!(
                        method, attempt, error = %err, wait_ms = wait.as_millis() as u64,
                        "rpc call failed, retrying"
                    );
                    last_error = Some(err);
                    if attempt + 1 < MAX_ATTEMPTS {
                        tokio::time::sleep(wait).await;
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("{method} failed").into()))
    }

    async fn try_call<T: DeserializeOwned>(
        &self,
        body: &serde_json::Value,
        method: &str,
    ) -> RpcResult<T> {
        let mut request = self.client.post(&self.url).json(body);
        for (name, value) in &self.headers {
            request = request.header(name.as_str(), value.as_str());
        }

        let response = request
            .send()
            .await
            .with_context(|| format!("{method}: request failed"))?;

        let status = response.status();
        if status.as_u16() == 429 {
            return Err(RpcError::RateLimited(format!(
                "{method}: {}",
                retry_after_hint(&response)
            )));
        }

        let payload: serde_json::Value = response
            .json()
            .await
            .with_context(|| format!("{method}: response was not JSON (status {status})"))?;

        // A JSON-RPC error arrives with HTTP 200, so the status alone proves
        // nothing — the error member has to be checked explicitly.
        if let Some(error) = payload.get("error") {
            let code = error.get("code").and_then(|c| c.as_i64());
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("")
                .to_owned();
            return Err(classify(code, &message, &format!("{method}: {error}")));
        }

        let result = payload
            .get("result")
            .with_context(|| format!("{method}: response had no result"))?;

        Ok(serde_json::from_value(result.clone())
            .with_context(|| format!("{method}: unexpected result shape"))?)
    }

    /// Plain GET, for HTTP APIs that are not JSON-RPC (TronGrid, Blockstream).
    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> RpcResult<T> {
        self.http(path, None).await
    }

    /// Plain POST with a JSON body, for the same APIs — TRON's node endpoints
    /// take their arguments this way rather than as a JSON-RPC envelope.
    pub async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> RpcResult<T> {
        self.http(path, Some(body)).await
    }

    async fn http<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> RpcResult<T> {
        let url = format!(
            "{}/{}",
            self.url.trim_end_matches('/'),
            path.trim_start_matches('/')
        );

        let verb = if body.is_some() { "POST" } else { "GET" };
        let mut last_error = None;
        for attempt in 0..MAX_ATTEMPTS {
            let mut request = match &body {
                Some(body) => self.client.post(&url).json(body),
                None => self.client.get(&url),
            };
            for (name, value) in &self.headers {
                request = request.header(name.as_str(), value.as_str());
            }

            let error = match request.send().await {
                Ok(response) if response.status().is_success() => {
                    return Ok(response
                        .json::<T>()
                        .await
                        .with_context(|| format!("{verb} {path}: unexpected shape"))?);
                }
                Ok(response) if response.status().as_u16() == 429 => {
                    RpcError::RateLimited(format!(
                        "{verb} {path}: {}",
                        retry_after_hint(&response)
                    ))
                }
                Ok(response) => {
                    RpcError::Other(anyhow::anyhow!(
                        "{verb} {path}: status {}",
                        response.status()
                    ))
                }
                Err(err) => RpcError::Other(anyhow::Error::new(err)),
            };

            let wait = backoff(&error, attempt);
            tracing::warn!(
                verb, path, attempt, error = %error, wait_ms = wait.as_millis() as u64,
                "http call failed, retrying"
            );
            last_error = Some(error);
            if attempt + 1 < MAX_ATTEMPTS {
                tokio::time::sleep(wait).await;
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("{verb} {path} failed").into()))
    }
}

/// How long to wait before retrying.
///
/// A rate limit needs seconds, not milliseconds — the 200ms ladder that suits a
/// dropped connection just spends four more requests against a quota that is
/// already exhausted, which is how the TRON scan managed to 429 on every address.
fn backoff(error: &RpcError, attempt: u32) -> Duration {
    match error {
        RpcError::RateLimited(hint) => retry_after_seconds(hint)
            .map(Duration::from_secs)
            .unwrap_or_else(|| Duration::from_secs(2u64.pow(attempt.min(4))))
            .min(MAX_RATE_LIMIT_WAIT),
        // Exponential: 200ms, 400ms, 800ms.
        _ => Duration::from_millis(200 * (1 << attempt.min(3))),
    }
}

fn retry_after_hint(response: &reqwest::Response) -> String {
    match response.headers().get("retry-after").and_then(|v| v.to_str().ok()) {
        Some(value) => format!("retry-after {value}"),
        None => "no retry-after".to_owned(),
    }
}

fn retry_after_seconds(hint: &str) -> Option<u64> {
    hint.rsplit("retry-after ").next()?.trim().parse().ok()
}

/// Decide what a JSON-RPC error member actually means.
///
/// Providers disagree on codes — BSC's dataseed answers `-32005 limit exceeded`
/// for a range it will not serve, publicnode answers `-32602 archive request`
/// for the same thing, and both would look like plain failures without this.
fn classify(code: Option<i64>, message: &str, context: &str) -> RpcError {
    let lower = message.to_ascii_lowercase();

    // A load-balanced endpoint answers from whichever node is free, and that
    // node can be a block behind the one that just reported the head. Nothing is
    // wrong with the query — ask again.
    const TRANSIENT_MARKERS: [&str; 3] = [
        "beyond current head",
        "header not found",
        "block not found",
    ];

    const RANGE_MARKERS: [&str; 9] = [
        "limit exceeded",
        "block range",
        "range is too large",
        "too many blocks",
        "query returned more than",
        "response size exceeded",
        "archive",
        "exceed maximum",
        "log response size",
    ];
    const RATE_MARKERS: [&str; 4] = [
        "rate limit",
        "too many requests",
        "throughput",
        "capacity exceeded",
    ];

    if TRANSIENT_MARKERS.iter().any(|m| lower.contains(m)) {
        return RpcError::Other(anyhow::anyhow!("rpc error {context}"));
    }
    if RATE_MARKERS.iter().any(|m| lower.contains(m)) {
        return RpcError::RateLimited(context.to_owned());
    }
    if RANGE_MARKERS.iter().any(|m| lower.contains(m)) {
        return RpcError::RangeRefused(context.to_owned());
    }
    // -32005 is "limit exceeded" in the JSON-RPC spec's reserved space and is
    // what most nodes use for a range they will not serve.
    if code == Some(-32005) {
        return RpcError::RangeRefused(context.to_owned());
    }

    RpcError::Other(anyhow::anyhow!("rpc error {context}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refused_range_is_not_mistaken_for_a_transient_failure() {
        // Observed verbatim from bsc-dataseed.binance.org, which refuses
        // eth_getLogs at any range at all.
        let err = classify(Some(-32005), "limit exceeded", "eth_getLogs");
        assert!(matches!(err, RpcError::RangeRefused(_)));

        // And from ethereum-rpc.publicnode.com, for a window reaching further
        // back than the node keeps.
        let err = classify(
            Some(-32602),
            "Archive requests require a personal token.",
            "eth_getLogs",
        );
        assert!(matches!(err, RpcError::RangeRefused(_)));
    }

    #[test]
    fn a_rate_limit_is_distinguished_from_a_range_limit() {
        // Both arrive as JSON-RPC errors; only one is fixed by waiting.
        let err = classify(None, "You reached Public endpoint rate limit", "eth_getLogs");
        assert!(matches!(err, RpcError::RateLimited(_)));
    }

    #[test]
    fn an_unrecognised_error_stays_a_plain_failure() {
        // Shrinking the window for an unrelated error would hide the real fault.
        let err = classify(Some(-32000), "execution reverted", "eth_call");
        assert!(matches!(err, RpcError::Other(_)));
    }

    #[test]
    fn rate_limits_back_off_in_seconds_not_milliseconds() {
        let limited = RpcError::RateLimited("no retry-after".into());
        assert!(backoff(&limited, 0) >= Duration::from_secs(1));
        assert!(backoff(&limited, 3) > backoff(&limited, 0));

        let other = RpcError::Other(anyhow::anyhow!("connection reset"));
        assert!(backoff(&other, 0) < Duration::from_secs(1));
    }

    #[test]
    fn a_retry_after_header_is_honoured_but_capped() {
        let short = RpcError::RateLimited("GET x: retry-after 5".into());
        assert_eq!(backoff(&short, 0), Duration::from_secs(5));

        // A provider asking for an hour would otherwise park the watcher.
        let long = RpcError::RateLimited("GET x: retry-after 3600".into());
        assert_eq!(backoff(&long, 0), MAX_RATE_LIMIT_WAIT);
    }
}
