//! The Minions desktop shell. It hosts the same frontend as the web app;
//! vault crypto runs in that frontend, so this process never sees keys or
//! plaintext. No shell, filesystem or HTTP plugins are enabled.
//!
//! The one thing it adds is somewhere safe to keep the session token between
//! launches: the OS credential store. The vault key is never stored; after a
//! restart the vault is locked until the master password is entered.

use tauri::{Manager, WindowEvent};

const SERVICE: &str = "com.minions.vault";
const ACCOUNT: &str = "session-token";

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_token_get() -> Result<Option<String>, String> {
    match entry()?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn session_token_set(token: String) -> Result<(), String> {
    // A session token is 43 base64url characters; refuse anything else.
    if token.len() > 128 || !token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("invalid token".into());
    }
    entry()?.set_password(&token).map_err(|e| e.to_string())
}

#[tauri::command]
fn session_token_clear() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![session_token_get, session_token_set, session_token_clear])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            // The frontend locks on this if the user chose "Immediately".
            let w = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = w.eval("window.dispatchEvent(new Event('minions:blur'))");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Minions");
}
