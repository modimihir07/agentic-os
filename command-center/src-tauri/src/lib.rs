mod commands;
mod proc;

use commands::{dispatch, n8n, secrets, system, telemetry, voice};

/// Event the webview listens for to start/stop a voice session.
pub const VOICE_TOGGLE_EVENT: &str = "voice-toggle";

pub fn run() {
    tauri::Builder::default()
        .manage(system::SysState::default())
        .manage(dispatch::DispatchState::default())
        .setup(|app| {
            use tauri::Manager;
            // Provider endpoints live in a file the user edits, not in the webview.
            if let Ok(dir) = app.path().app_config_dir() {
                app.state::<dispatch::DispatchState>().load_or_init(&dir);
            }
            #[cfg(desktop)]
            register_voice_hotkey(app)?;
            Ok(())
        })
        // Keep this list in sync with `NativeCommands` in src/lib/platform.ts.
        .invoke_handler(tauri::generate_handler![
            system::system_stats,
            secrets::secret_set,
            secrets::secret_status,
            secrets::secret_delete,
            dispatch::providers_list,
            dispatch::dispatch_chat,
            voice::stt_transcribe,
            voice::tts_synthesize,
            n8n::n8n_workflows,
            n8n::n8n_trigger,
            telemetry::docker_ps,
            telemetry::netbird_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Jarvis Command Center");
}

/// System-wide Ctrl+Shift+Space: bring Jarvis forward and toggle listening,
/// even when the window is minimised or another app has focus.
#[cfg(desktop)]
fn register_voice_hotkey(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

    let hotkey = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if shortcut == &hotkey && event.state() == ShortcutState::Pressed {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit(VOICE_TOGGLE_EVENT, ());
                }
            })
            .build(),
    )?;
    // Another app may already own the combo; the in-window shortcut still works then.
    if let Err(e) = app.global_shortcut().register(hotkey) {
        eprintln!("[hotkey] Ctrl+Shift+Space unavailable: {e}");
    }
    Ok(())
}
