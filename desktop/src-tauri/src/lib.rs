mod db;
mod secure_storage;
mod system;
mod tools;

use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Event name emitted to the webview whenever the OS hands us a deep link.
/// The React `useDeepLink` hook listens for this and routes to the matching
/// in-app view (currently just `ultralight://app/:id` → app store view).
const DEEP_LINK_EVENT: &str = "ul://deep-link";

/// Helper: grab the `ultralight://...` URL out of a second-launch argv on
/// Windows/Linux. macOS never hits this path (it uses native `openUrl`).
fn extract_deep_link_from_args(args: &[String]) -> Option<String> {
  args.iter().find(|a| a.starts_with("ultralight://")).cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // The production release pipeline ships a universal macOS binary, so the
  // updater must advertise the same custom target to match GitHub latest.json.
  let mut updater = tauri_plugin_updater::Builder::new();
  #[cfg(target_os = "macos")]
  {
    updater = updater.target("darwin-universal");
  }

  let builder = tauri::Builder::default()
    // single-instance MUST be registered first so it can intercept
    // second-launch attempts before any other plugin sets up state.
    // On second launch: extract the deep link URL from argv, emit the
    // deep-link event to the running webview, then focus the main window.
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      log::info!("[single-instance] second launch, argv: {:?}", args);
      if let Some(url) = extract_deep_link_from_args(&args) {
        if let Err(err) = app.emit(DEEP_LINK_EVENT, url) {
          log::warn!("[single-instance] failed to emit deep link: {}", err);
        }
      }
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
      }
    }))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_process::init());

  // Updater checks are production-only. Dev builds should boot without
  // requiring the signed updater config generated in the release workflow.
  let builder = if cfg!(debug_assertions) {
    builder
  } else {
    builder.plugin(updater.build())
  };

  builder
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Dev-mode deep-link registration. Production builds register
      // `ultralight://` at install time (Info.plist / Windows registry /
      // .desktop). In dev, the binary lives at target/debug and the OS
      // has no record of it, so we install a temporary URL handler
      // pointing at the dev binary. Release builds skip this path.
      #[cfg(debug_assertions)]
      {
        if let Err(err) = app.deep_link().register_all() {
          log::warn!("[deep-link] dev-mode register_all failed: {}", err);
        } else {
          log::info!("[deep-link] dev-mode scheme registered");
        }
      }

      // Forward URL-open events to the webview. Fires for:
      //   1. macOS cold start after clicking `ultralight://...`
      //   2. macOS app-already-running `openUrl`
      //   3. any OS's initial-launch URL (captured before webview is up)
      let handle = app.handle().clone();
      app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
          let url_str = url.to_string();
          log::info!("[deep-link] open_url: {}", url_str);
          if let Err(err) = handle.emit(DEEP_LINK_EVENT, url_str) {
            log::warn!("[deep-link] failed to emit: {}", err);
          }
        }
      });

      // Initialize SQLite database in app data directory
      let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))
        .expect("app data dir should be available");

      let conn = db::init_db(&app_data_dir)
        .expect("Failed to initialize database");

      app.manage(db::DbState(Mutex::new(conn)));

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      // Filesystem tools
      tools::fs::file_read,
      tools::fs::file_write,
      tools::fs::file_edit,
      tools::fs::glob_search,
      tools::fs::grep_search,
      tools::fs::ls,
      // Shell + Git tools
      tools::shell::shell_exec,
      tools::shell::git,
      // Database commands
      db::db_list_conversations,
      db::db_create_conversation,
      db::db_update_conversation,
      db::db_delete_conversation,
      db::db_load_messages,
      db::db_save_message,
      db::db_save_messages_batch,
      // Agent commands
      db::db_create_agent,
      db::db_list_agents,
      db::db_get_agent,
      db::db_get_agent_by_conversation,
      db::db_update_agent,
      db::db_delete_agent,
      db::db_new_agent_session,
      db::db_list_system_agents,
      // Kanban commands
      db::db_create_board,
      db::db_list_boards,
      db::db_get_board,
      db::db_delete_board,
      db::db_create_column,
      db::db_update_column,
      db::db_delete_column,
      db::db_list_columns,
      db::db_create_card,
      db::db_update_card,
      db::db_delete_card,
      db::db_list_cards,
      // Card report commands
      db::db_create_card_report,
      db::db_list_card_reports,
      db::db_delete_card_report,
      // Execution plan commands
      db::db_create_execution_plan,
      db::db_update_execution_plan_status,
      db::db_get_execution_plan,
      db::db_get_execution_plans_by_message,
      // Secure storage commands
      secure_storage::secure_get_auth_token,
      secure_storage::secure_set_auth_token,
      secure_storage::secure_clear_auth_token,
      secure_storage::secure_get_secret,
      secure_storage::secure_set_secret,
      secure_storage::secure_clear_secret,
      // System commands
      system::open_auth_url,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
