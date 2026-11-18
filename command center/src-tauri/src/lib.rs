mod audio;
mod commands;
mod exe_resolve;
mod proc;

use commands::{agents, bridge, clihub, devqueue, introspect, modellab, dispatch, gmail, market, mcp, memory, n8n, os_core, pipeline, pipelines, secrets, services, spotify, system, telemetry, voice};

/// Event the webview listens for to start/stop a voice session.
pub const VOICE_TOGGLE_EVENT: &str = "voice-toggle";

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(system::SysState::default())
        .manage(dispatch::DispatchState::default())
        .manage(bridge::BridgeState::default())
        .manage(pipelines::PipelineState::default())
        .manage(os_core::OsState::default())
        .manage(devqueue::DevQueueState::default())
        .manage(audio::commands::AudioEngineState::default())
        .manage(introspect::IntrospectState::default())
        .setup(|app| {
            use tauri::Manager;
            // System Map: app uptime counts from here.
            introspect::mark_started();
            // System Map live routing trace: `os-trace` events from os_turn / mcp::call_tool.
            commands::trace::install(app.handle());
            // Provider endpoints live in a file the user edits, not in the webview.
            if let Ok(dir) = app.path().app_config_dir() {
                let state = app.state::<dispatch::DispatchState>();
                state.load_or_init(&dir);
                // Permission Bridge policy + synaptic training log in <repo>/training_logs.
                let repo = std::path::PathBuf::from(state.snapshot().gateway.workdir);
                app.state::<bridge::BridgeState>().init(&dir, repo.join("training_logs"));
                // OS identity, compute mode, skills/MCP registry, privacy shield, memory lifecycle.
                app.state::<os_core::OsState>().load_or_init(&dir, &repo);
                if app.state::<os_core::OsState>().snapshot().privacy.network_lock {
                    os_core::ensure_gateway_token(&state);
                }
                pipelines::load_last_sync(&state, &app.state::<pipelines::PipelineState>());
                // System Map dev task queue: <config dir>/devqueue.db (works without the gateway).
                app.state::<devqueue::DevQueueState>().init(&dir);
            }
            // Spotify: load the saved session / refresh silently so the widget's first status
            // check is instant. Never opens a browser; no-op when not connected.
            tauri::async_runtime::spawn(spotify::warm(app.handle().clone()));
            // MCP: start listing enabled stdio servers ~5 s after launch (into the cache, in
            // the background). No HTTP / token-gated server is contacted.
            tauri::async_runtime::spawn(mcp::warm(app.handle().clone()));
            tauri::async_runtime::spawn(pipelines::auto_sync_loop(app.handle().clone()));
            tauri::async_runtime::spawn(memory::auto_monthly_loop(app.handle().clone()));
            // Phone HUD → desktop: Tony turns, pipelines, kill switch / compute mode.
            tauri::async_runtime::spawn(pipeline::inbox_loop(app.handle().clone()));
            // GPU baton events → top-bar "ACTIVE GPU SLOT" pill; droplet auto-reconnect.
            {
                use tauri::Emitter;
                let h = app.handle().clone();
                app.state::<os_core::OsState>().slot.set_notify(move |v| {
                    let _ = h.emit("gpu-slot", v);
                });
            }
            tauri::async_runtime::spawn(os_core::droplet_link_loop(app.handle().clone()));
            // Keep the local model sized to fit VRAM even after Bionic auto-reloads it.
            tauri::async_runtime::spawn(services::local_fit_loop(app.handle().clone()));
            tauri::async_runtime::spawn(services::tts_warm_loop(app.handle().clone()));
            // Bring up the gateway (sync hub for the phone) and bind n8n to its
            // Docker container in the background, so the window opens instantly.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let st = handle.state::<dispatch::DispatchState>();
                match services::gateway_ensure(st.clone()).await {
                    Ok(s) => eprintln!("[gateway] {}", if s.is_up() { "up" } else { "down" }),
                    Err(e) => eprintln!("[gateway] {e}"),
                }
                let _ = n8n::n8n_discover(st, Some(true)).await;
            });
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
            dispatch::providers_update,
            dispatch::provider_add,
            dispatch::provider_remove,
            dispatch::policy_update,
            dispatch::agent_voice_update,
            dispatch::dispatch_chat,
            services::services_health,
            services::provider_models,
            services::gateway_ensure,
            voice::stt_transcribe,
            voice::stt_configure,
            voice::tts_synthesize,
            voice::tts_voices,
            voice::tts_voice_upload,
            audio::commands::audio_engine_devices,
            audio::commands::audio_engine_start,
            audio::commands::audio_engine_stop,
            audio::commands::audio_engine_status,
            audio::commands::audio_engine_barge_in,
            audio::commands::audio_engine_test_tone,
            n8n::n8n_workflows,
            n8n::n8n_workflows_set,
            n8n::n8n_trigger,
            n8n::n8n_fetch,
            n8n::n8n_discover,
            bridge::bridge_get,
            bridge::bridge_set,
            pipelines::pipelines_status,
            pipelines::pipeline_run,
            pipelines::pipeline_set_active,
            pipelines::pipelines_settings,
            pipelines::pipelines_settings_update,
            pipelines::n8n_instance_add,
            pipelines::trigger_gdrive_sync,
            telemetry::docker_ps,
            telemetry::netbird_status,
            os_core::os_config_get,
            os_core::os_config_update,
            os_core::os_identity,
            os_core::os_secret_set,
            os_core::os_secret_status,
            commands::envfile::os_secret_sources,
            os_core::os_secret_delete,
            os_core::privacy_last_payload,
            os_core::privacy_preview,
            os_core::droplet_test,
            os_core::network_audit,
            os_core::gateway_token_rotate,
            agents::anythingllm_workspaces,
            agents::os_turn,
            agents::os_turn_cancel,
            agents::overseer_ask,
            mcp::mcp_list_tools,
            agents::tony_tools_preview,
            mcp::mcp_call,
            mcp::mcp_sync_anythingllm,
            mcp::skills_scan,
            gmail::gmail_status,
            gmail::gmail_import_anythingllm,
            gmail::gmail_create_draft,
            spotify::spotify_auth_start,
            spotify::spotify_status,
            spotify::spotify_disconnect,
            spotify::spotify_now_playing,
            spotify::spotify_control,
            spotify::spotify_play,
            spotify::spotify_play_uri,
            spotify::spotify_recent,
            spotify::spotify_playlists,
            spotify::spotify_tool,
            commands::spotify_intent::spotify_parse,
            memory::memory_harvest,
            memory::memory_flush,
            memory::memory_ledger,
            memory::memory_mount,
            memory::memory_unmount,
            memory::memory_export,
            market::market_candles,
            pipeline::idea_capture,
            pipeline::idea_pipeline_run,
            pipeline::playplace_iterate,
            pipeline::playplace_approve,
            pipeline::playplace_commit,
            pipeline::comms_whatsapp,
            pipeline::comms_whatsapp_send,
            clihub::cli_status,
            modellab::model_lab_list,
            modellab::model_bench,
            modellab::model_use,
            pipeline::pipeline_resume,
            os_core::droplet_link,
            os_core::gpu_slot_view,
            clihub::cli_install,
            devqueue::dev_task_add,
            devqueue::dev_task_list,
            devqueue::dev_task_update,
            devqueue::dev_task_delete,
            devqueue::dev_brief_export,
            introspect::system_introspect,
            introspect::app_uptime,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Jarvis Command Center")
        .run(|app, event| {
            // Clean exit → one last Drive sync, if auto-sync (the standing consent) is on.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                let state = app.state::<dispatch::DispatchState>();
                let cfg = state.snapshot().pipelines;
                if cfg.auto_sync_enabled && cfg.sync_on_exit && !cfg.gdrive_sync_webhook_url.is_empty() {
                    let bridge = app.state::<bridge::BridgeState>();
                    let pipes = app.state::<pipelines::PipelineState>();
                    // Bounded by the 3 s network timeout inside the sync.
                    let _ = tauri::async_runtime::block_on(pipelines::run_gdrive_sync(&state, &bridge, &pipes, bridge::Actor::Scheduler, false, "app-exit"));
                }
            }
        });
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
