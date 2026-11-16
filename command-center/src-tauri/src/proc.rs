//! Run a fixed external CLI (nvidia-smi, docker, netbird) without flashing a
//! console window on Windows. Only ever called with hard-coded program names
//! and arguments — never with strings from the webview.

use std::process::{Command, Output};

pub fn run(program: &str, args: &[&str]) -> std::io::Result<Output> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
}

pub fn stdout(program: &str, args: &[&str]) -> Result<String, String> {
    let out = run(program, args).map_err(|e| format!("{program} not available: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("{program} failed: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}
