use keyring::{Entry, Error as KeyringError};

const SERVICE_NAME: &str = "dev.ultralight.chat";
const ACCOUNT_NAME: &str = "auth_token";

fn auth_token_entry() -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, ACCOUNT_NAME)
        .map_err(|err| format!("failed to open secure auth storage: {}", err))
}

// Generic per-account keychain access used by B16 BYOK key storage and any
// future surface that needs to persist a single secret string per account.
//
// We allowlist account names rather than accepting arbitrary strings — this
// avoids a misbehaving frontend writing to (or reading from) accounts it
// doesn't own. New accounts must be added to is_allowed_account below.

fn is_allowed_account(account: &str) -> bool {
    matches!(
        account,
        "byok_anthropic" | "byok_openai" | "byok_openrouter" | "byok_deepseek"
    )
}

fn secret_entry(account: &str) -> Result<Entry, String> {
    if !is_allowed_account(account) {
        return Err(format!("secure storage account '{}' is not allowlisted", account));
    }
    Entry::new(SERVICE_NAME, account)
        .map_err(|err| format!("failed to open secure storage for '{}': {}", account, err))
}

#[tauri::command]
pub fn secure_get_auth_token() -> Result<Option<String>, String> {
    let entry = auth_token_entry()?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("failed to read secure auth token: {}", err)),
    }
}

#[tauri::command]
pub fn secure_set_auth_token(token: String) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("auth token cannot be empty".to_string());
    }

    auth_token_entry()?
        .set_password(&token)
        .map_err(|err| format!("failed to store secure auth token: {}", err))
}

#[tauri::command]
pub fn secure_clear_auth_token() -> Result<(), String> {
    let entry = auth_token_entry()?;
    match entry.delete_password() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("failed to clear secure auth token: {}", err)),
    }
}

#[tauri::command]
pub fn secure_get_secret(account: String) -> Result<Option<String>, String> {
    let entry = secret_entry(&account)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(err) => Err(format!("failed to read secret for '{}': {}", account, err)),
    }
}

#[tauri::command]
pub fn secure_set_secret(account: String, value: String) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("value for '{}' cannot be empty", account));
    }
    secret_entry(&account)?
        .set_password(&value)
        .map_err(|err| format!("failed to store secret for '{}': {}", account, err))
}

#[tauri::command]
pub fn secure_clear_secret(account: String) -> Result<(), String> {
    let entry = secret_entry(&account)?;
    match entry.delete_password() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(err) => Err(format!("failed to clear secret for '{}': {}", account, err)),
    }
}
