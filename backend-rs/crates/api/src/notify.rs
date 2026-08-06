//! Delivering OTP codes.
//!
//! Two transports behind one trait, chosen by the identifier's channel. SMS goes
//! via Termii (best deliverability into Nigerian networks); email via Resend.
//!
//! Delivery failures must surface. An earlier shape returned `Ok` on a failed
//! send so signup "worked" — which produces a user staring at a code entry
//! screen for a message that was never sent, with nothing in the logs tying the
//! two together.

use anyhow::{bail, Context, Result};
use naivolt_auth::Channel;

#[allow(async_fn_in_trait)]
pub trait Notifier: Send + Sync {
    async fn send_code(&self, destination: &str, channel: Channel, code: &str) -> Result<()>;
}

/// The message a user receives. Kept in one place so SMS and email stay
/// consistent, and so the code is never accidentally logged alongside it.
fn sms_body(code: &str) -> String {
    // No link, and an explicit warning: Nigerian OTP phishing overwhelmingly
    // works by getting the user to read their code to a caller.
    format!("{code} is your Naivolt code. It expires in 10 minutes. We will never call you to ask for it.")
}

fn email_subject(code: &str) -> String {
    // Putting the code in the subject means it is readable from the
    // notification shade without opening the mail.
    format!("{code} is your Naivolt code")
}

fn email_body(code: &str) -> String {
    format!(
        "<p style=\"font:16px system-ui\">Your Naivolt sign-in code is</p>\
         <p style=\"font:600 32px/1.2 ui-monospace,monospace;letter-spacing:.15em\">{code}</p>\
         <p style=\"font:14px system-ui;color:#666\">It expires in 10 minutes. \
         If you didn't ask for this, you can ignore this email — \
         we will never call or message you to ask for this code.</p>"
    )
}

/// Sends nothing; writes the code to the log.
///
/// Development only. Constructing it in production is refused at boot by
/// [`crate::config::Config::validate_for_environment`], because a "successful"
/// send that never leaves the process is indistinguishable from a real one to
/// everything downstream.
pub struct LogNotifier;

impl Notifier for LogNotifier {
    async fn send_code(&self, destination: &str, channel: Channel, code: &str) -> Result<()> {
        tracing::warn!(
            destination,
            ?channel,
            code,
            "DEV ONLY — code logged instead of sent"
        );
        Ok(())
    }
}

pub struct HttpNotifier {
    client: reqwest::Client,
    termii_key: Option<String>,
    termii_sender: String,
    resend_key: Option<String>,
    email_from: String,
}

impl HttpNotifier {
    pub fn new(
        termii_key: Option<String>,
        termii_sender: String,
        resend_key: Option<String>,
        email_from: String,
    ) -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .expect("reqwest client"),
            termii_key,
            termii_sender,
            resend_key,
            email_from,
        }
    }

    async fn send_sms(&self, to: &str, code: &str) -> Result<()> {
        let key = self
            .termii_key
            .as_ref()
            .context("SMS requested but TERMII_API_KEY is not configured")?;

        let response = self
            .client
            .post("https://api.ng.termii.com/api/sms/send")
            .json(&serde_json::json!({
                "to": to,
                "from": self.termii_sender,
                "sms": sms_body(code),
                "type": "plain",
                "channel": "dnd", // reaches numbers on the DND registry, which most NG numbers are
                "api_key": key,
            }))
            .send()
            .await
            .context("Termii request failed")?;

        let status = response.status();
        if !status.is_success() {
            // Body may contain the provider's reason; it goes to the log only.
            let body = response.text().await.unwrap_or_default();
            bail!("Termii rejected the send ({status}): {body}");
        }
        Ok(())
    }

    async fn send_email(&self, to: &str, code: &str) -> Result<()> {
        let key = self
            .resend_key
            .as_ref()
            .context("email requested but RESEND_API_KEY is not configured")?;

        let response = self
            .client
            .post("https://api.resend.com/emails")
            .bearer_auth(key)
            .json(&serde_json::json!({
                "from": self.email_from,
                "to": [to],
                "subject": email_subject(code),
                "html": email_body(code),
            }))
            .send()
            .await
            .context("Resend request failed")?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("Resend rejected the send ({status}): {body}");
        }
        Ok(())
    }
}

impl Notifier for HttpNotifier {
    async fn send_code(&self, destination: &str, channel: Channel, code: &str) -> Result<()> {
        match channel {
            Channel::Sms => self.send_sms(destination, code).await,
            Channel::Email => self.send_email(destination, code).await,
        }
    }
}

/// Either transport, chosen at boot.
///
/// An enum rather than `Box<dyn Notifier>` because the trait has an async method;
/// `async_fn_in_trait` is not dyn-compatible.
#[allow(dead_code)]
pub enum AnyNotifier {
    Log(LogNotifier),
    Http(HttpNotifier),
}

impl Notifier for AnyNotifier {
    async fn send_code(&self, destination: &str, channel: Channel, code: &str) -> Result<()> {
        match self {
            AnyNotifier::Log(n) => n.send_code(destination, channel, code).await,
            AnyNotifier::Http(n) => n.send_code(destination, channel, code).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_carry_the_code_and_an_anti_phishing_warning() {
        let sms = sms_body("428193");
        assert!(sms.contains("428193"));
        assert!(sms.to_lowercase().contains("never call"));

        let html = email_body("428193");
        assert!(html.contains("428193"));
        assert!(html.to_lowercase().contains("never call"));
    }

    #[test]
    fn the_code_is_visible_without_opening_the_email() {
        assert!(email_subject("428193").starts_with("428193"));
    }

    #[test]
    fn sms_stays_within_one_segment() {
        // Over 160 GSM-7 characters bills as two messages and can be reordered
        // on delivery, which splits the code across two notifications.
        assert!(
            sms_body("428193").len() <= 160,
            "SMS body is {} chars",
            sms_body("428193").len()
        );
    }
}
