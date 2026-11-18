//! CLI Hub: status + install/repair for the agent CLIs the OS can run
//! (opencode, claude, gemini, llm, gh, agy).
//!
//! Windows note: npm and uv install `.cmd` / `.exe` shims that a plain
//! `Command::new("opencode")` can't find (no PATHEXT lookup) — that was the
//! "opencode CLI not installed" error. Paths are resolved explicitly here.
//! Install commands are fixed strings in this file — never from the webview.

use serde::Serialize;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::State;

use super::bridge::{Actor, BridgeState, Scope};

struct Cli {
    name: &'static str,
    label: &'static str,
    version_args: &'static [&'static str],
    /// Program + args; None = can't be installed automatically.
    install: Option<(&'static str, &'static [&'static str])>,
    how: &'static str,
}

const CLIS: [Cli; 6] = [
    Cli { name: "opencode", label: "opencode", version_args: &["--version"], install: Some(("npm.cmd", &["install", "-g", "opencode-ai@latest"])), how: "npm install -g opencode-ai@latest" },
    Cli { name: "claude", label: "Claude Code", version_args: &["--version"], install: Some(("npm.cmd", &["install", "-g", "@anthropic-ai/claude-code@latest"])), how: "npm install -g @anthropic-ai/claude-code" },
    Cli { name: "gemini", label: "Gemini CLI", version_args: &["--version"], install: Some(("npm.cmd", &["install", "-g", "@google/gemini-cli@latest"])), how: "npm install -g @google/gemini-cli" },
    Cli { name: "llm", label: "llm (Simon Willison)", version_args: &["--version"], install: Some(("uv", &["tool", "install", "--force", "llm", "--with", "llm-anthropic", "--with", "llm-gemini"])), how: "uv tool install llm --with llm-anthropic --with llm-gemini" },
    Cli { name: "gh", label: "GitHub CLI", version_args: &["--version"], install: Some(("winget", &["install", "--id", "GitHub.cli", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"])), how: "winget install GitHub.cli" },
    Cli { name: "agy", label: "agy (Antigravity)", version_args: &["--version"], install: None, how: "Install Antigravity and enable its CLI from the app" },
];

/// Full path of a CLI: PATH (with PATHEXT) + the npm / uv shim folders.
pub fn resolve(name: &str) -> Option<PathBuf> {
    let exts: Vec<String> = std::env::var("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD".into()).split(';').map(|e| e.to_ascii_lowercase()).collect();
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("AppData").join("Local").join("Microsoft").join("WindowsApps"));
    }
    for d in dirs {
        for e in exts.iter().map(String::as_str).chain([""]) {
            let p = d.join(format!("{name}{e}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

fn run(program: &std::path::Path, args: &[&str], secs: u64) -> Result<String, String> {
    let mut c = Command::new(program);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    let mut child = c.spawn().map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() > deadline => {
                let _ = child.kill();
                return Err(format!("timed out after {secs}s"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() {
        Ok(text)
    } else {
        Err(text.trim().chars().rev().take(600).collect::<String>().chars().rev().collect())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    name: String,
    label: String,
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    error: Option<String>,
    can_install: bool,
    how: String,
}

#[tauri::command]
pub async fn cli_status() -> Vec<CliStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        CLIS.iter()
            .map(|c| {
                let path = resolve(c.name);
                let (version, error) = match &path {
                    Some(p) => match run(p, c.version_args, 15) {
                        Ok(v) => (v.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| l.chars().take(80).collect()), None),
                        Err(e) => (None, Some(e.chars().take(200).collect())),
                    },
                    None => (None, None),
                };
                CliStatus {
                    name: c.name.into(),
                    label: c.label.into(),
                    installed: path.is_some(),
                    version,
                    path: path.map(|p| p.display().to_string()),
                    error,
                    can_install: c.install.is_some(),
                    how: c.how.into(),
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

/// Install or repair one CLI with its fixed command. Needs the Execute scope.
#[tauri::command]
pub async fn cli_install(bridge: State<'_, BridgeState>, name: String, approved: Option<bool>) -> Result<String, String> {
    let cli = CLIS.iter().find(|c| c.name == name).ok_or("unknown CLI")?;
    let (prog, args) = cli.install.ok_or_else(|| format!("{} can't be installed automatically: {}", cli.label, cli.how))?;
    bridge.check("cli-install", &[Scope::Execute, Scope::Network], approved.unwrap_or(false), Actor::User, false, serde_json::json!({ "cli": name, "command": cli.how }))?;
    let program = resolve(prog.trim_end_matches(".cmd")).ok_or_else(|| format!("{prog} not found — install it first"))?;
    let out = tauri::async_runtime::spawn_blocking(move || run(&program, args, 600)).await.map_err(|e| e.to_string())??;
    bridge.log(serde_json::json!({ "type": "cli-install", "cli": name, "ok": true }));
    Ok(out.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n"))
}
