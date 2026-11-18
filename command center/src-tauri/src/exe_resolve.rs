//! Find the program an MCP server's command line names, the way a terminal would.
//!
//! The app's own PATH is a snapshot from when it was launched (often by Explorer, before
//! `uv tool install` / `npm i -g` added a folder), and Rust's `Command` only appends
//! `.exe` to an extension-less name, so `npx` / `uvx` (`.cmd` shims) and freshly
//! installed tools are "not found". `resolve_program` searches, in order:
//!   1. a `PATH` the server's own env sets,
//!   2. this process's PATH,
//!   3. the persisted user + machine PATH from the registry (read once, `%VAR%` expanded),
//!   4. the usual install folders (`~/.local/bin`, `%APPDATA%\npm`, Node, WinGet, uv, cargo),
//!
//! trying `.exe`, `.cmd`, `.bat`, `.com` for a bare name (never an extension-less file on
//! Windows), and returns the merged PATH so the child (npx → node, uvx → git) finds its
//! own helpers too. Nothing here reads or returns env *values* other than PATH folders.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The program to spawn plus the PATH to give it.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub program: PathBuf,
    pub path_env: OsString,
}

#[cfg(windows)]
const EXTS: [&str; 4] = ["exe", "cmd", "bat", "com"];

/// Launchers that install / resolve packages on first run (and Serena, which starts
/// language servers): they get the long startup timeout.
const SLOW_LAUNCHERS: [&str; 8] = ["npx", "uvx", "uv", "pnpm", "pnpx", "bunx", "pipx", "serena"];

/// `program` (a name or a resolved path) is a package launcher with a slow cold start.
pub fn is_slow_launcher(program: &str) -> bool {
    let stem = Path::new(program.trim()).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    SLOW_LAUNCHERS.contains(&stem.as_str())
}

/// Expand `%VAR%` references (the registry stores PATH as REG_EXPAND_SZ). Unknown
/// variables are left as written.
pub fn expand_vars(s: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match lookup(name) {
                    Some(v) => out.push_str(&v),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The `Path` value from `reg query <key> /v Path` output, if present.
pub fn parse_reg_path(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let l = l.trim();
        let mut parts = l.splitn(2, char::is_whitespace);
        let name = parts.next()?;
        if !name.eq_ignore_ascii_case("path") {
            return None;
        }
        let rest = parts.next()?.trim_start();
        let (kind, value) = rest.split_once(char::is_whitespace)?;
        kind.starts_with("REG_").then(|| value.trim().to_string())
    })
}

/// Split a PATH-style list into folders (empty entries dropped).
pub fn split_list(list: &str) -> Vec<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    list.split(sep).map(|p| p.trim().trim_matches('"')).filter(|p| !p.is_empty()).map(PathBuf::from).collect()
}

/// Concatenate folder lists, keeping the first occurrence (case-insensitive on Windows,
/// trailing separators ignored).
pub fn merge_dirs(groups: Vec<Vec<PathBuf>>) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for d in groups.into_iter().flatten() {
        let key = d.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        let key = if cfg!(windows) { key.to_ascii_lowercase() } else { key };
        if !key.is_empty() && seen.insert(key) {
            out.push(d);
        }
    }
    out
}

/// Whether `name` already carries an executable extension (`node.exe`, `npx.CMD`).
fn has_exec_ext(name: &str) -> bool {
    #[cfg(windows)]
    {
        Path::new(name).extension().map(|e| EXTS.iter().any(|x| e.eq_ignore_ascii_case(x))).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        true
    }
}

/// Pure search: the first `dir/name[.ext]` that `is_file` accepts.
pub fn search(name: &str, dirs: &[PathBuf], is_file: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let exact = has_exec_ext(name);
    for d in dirs {
        if exact {
            let p = d.join(name);
            if is_file(&p) {
                return Some(p);
            }
            continue;
        }
        #[cfg(windows)]
        for ext in EXTS {
            let p = d.join(format!("{name}.{ext}"));
            if is_file(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// A one-line "how to install it" for well-known commands.
pub fn install_hint(cmd: &str) -> Option<&'static str> {
    let stem = Path::new(cmd.trim()).file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    match stem.as_str() {
        "serena" => Some("install it with: uv tool install -p 3.13 serena-agent"),
        "uv" | "uvx" => Some("install uv with: winget install astral-sh.uv"),
        "npx" | "npm" | "node" => Some("install Node.js (https://nodejs.org) and restart the app"),
        "pal-mcp-server" => Some("install it with: uv tool install git+https://github.com/BeehiveInnovations/pal-mcp-server.git"),
        "mcp-server-sqlite" => Some("install it with: uv tool install mcp-server-sqlite"),
        _ => None,
    }
}

pub fn not_found_msg(cmd: &str, searched: usize) -> String {
    let hint = install_hint(cmd).map(|h| format!(" — {h}")).unwrap_or_default();
    format!("could not start {cmd}: not found (searched {searched} folders: the server's PATH, the app's PATH, the saved user/system PATH and the usual install folders){hint}")
}

/// The pure decision once the folder list is known.
pub fn resolve_in(cmd: &str, dirs: &[PathBuf], cwd: Option<&Path>, is_file: impl Fn(&Path) -> bool) -> Result<PathBuf, String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return Err("no command set".into());
    }
    let p = Path::new(cmd);
    let has_sep = cmd.contains('/') || cmd.contains('\\');
    if p.is_absolute() || has_sep {
        let full = if p.is_absolute() { p.to_path_buf() } else { cwd.map(|c| c.join(p)).unwrap_or_else(|| p.to_path_buf()) };
        if is_file(&full) {
            if !has_exec_ext(cmd) {
                return Err(format!("could not start {cmd}: it has no .exe/.cmd/.bat extension — point the command at the real executable"));
            }
            return Ok(full);
        }
        // An explicit path without its extension (`C:\tools\foo`): try the usual ones.
        if !has_exec_ext(cmd) {
            if let (Some(dir), Some(name)) = (full.parent(), full.file_name()) {
                if let Some(found) = search(&name.to_string_lossy(), &[dir.to_path_buf()], &is_file) {
                    return Ok(found);
                }
            }
        }
        return Err(format!("could not start {cmd}: no such file{}", install_hint(cmd).map(|h| format!(" — {h}")).unwrap_or_default()));
    }
    search(cmd, dirs, is_file).ok_or_else(|| not_found_msg(cmd, dirs.len()))
}

/// User + machine PATH as saved in the registry (so a tool installed after the app
/// started is still found). Read once per run; empty off Windows or on any error.
fn persisted_path() -> &'static Vec<PathBuf> {
    static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
    CACHE.get_or_init(|| {
        #[cfg(windows)]
        {
            let mut out = Vec::new();
            for key in [r"HKCU\Environment", r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment"] {
                if let Some(v) = crate::proc::stdout("reg", &["query", key, "/v", "Path"]).ok().and_then(|o| parse_reg_path(&o)) {
                    out.extend(split_list(&expand_vars(&v, |n| std::env::var(n).ok())));
                }
            }
            out
        }
        #[cfg(not(windows))]
        {
            Vec::new()
        }
    })
}

/// Common install folders that are often missing from a GUI app's PATH.
fn fallback_dirs() -> Vec<PathBuf> {
    let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
    let mut v = Vec::new();
    if let Some(h) = var("USERPROFILE").or_else(|| var("HOME")) {
        v.push(h.join(".local").join("bin"));
        v.push(h.join(".cargo").join("bin"));
    }
    if let Some(a) = var("APPDATA") {
        v.push(a.join("npm"));
    }
    if let Some(pf) = var("ProgramFiles") {
        v.push(pf.join("nodejs"));
    }
    if let Some(l) = var("LOCALAPPDATA") {
        v.push(l.join("Microsoft").join("WinGet").join("Links"));
        let pkgs = l.join("Microsoft").join("WinGet").join("Packages");
        if let Ok(rd) = std::fs::read_dir(&pkgs) {
            let mut uv: Vec<PathBuf> = rd.flatten().filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().starts_with("astral-sh.uv_")).map(|e| e.path()).collect();
            uv.sort();
            v.extend(uv);
        }
    }
    v
}

/// The folder list for a server: its own PATH, ours, the saved one, then the fallbacks.
pub fn search_dirs(env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let own = env.iter().find(|(k, _)| k.eq_ignore_ascii_case("path")).map(|(_, v)| split_list(v)).unwrap_or_default();
    let process = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    merge_dirs(vec![own, process, persisted_path().clone(), fallback_dirs()])
}

/// Resolve `cmd` for a server with environment `env` (only its PATH is read) and working
/// folder `cwd`. Errors start with "could not start {cmd}: …".
pub fn resolve_program(cmd: &str, env: &BTreeMap<String, String>, cwd: Option<&Path>) -> Result<Resolved, String> {
    let dirs = search_dirs(env);
    let program = resolve_in(cmd, &dirs, cwd, |p| p.is_file())?;
    let path_env = std::env::join_paths(dirs.iter()).unwrap_or_default();
    Ok(Resolved { program, path_env })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn fs(files: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<String> = files.iter().map(|f| f.to_ascii_lowercase()).collect();
        move |p: &Path| set.contains(&p.to_string_lossy().to_ascii_lowercase())
    }

    #[test]
    fn expands_known_vars_and_keeps_unknown() {
        let look = |n: &str| (n.eq_ignore_ascii_case("USERPROFILE")).then(|| r"C:\Users\me".to_string());
        assert_eq!(expand_vars(r"%USERPROFILE%\.local\bin;%NOPE%\x;50%", look), r"C:\Users\me\.local\bin;%NOPE%\x;50%");
        assert_eq!(expand_vars("plain", look), "plain");
        assert_eq!(expand_vars("%%", look), "%%");
    }

    #[test]
    fn parses_reg_query_output() {
        let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools\r\n\r\n";
        assert_eq!(parse_reg_path(out).as_deref(), Some(r"%USERPROFILE%\.local\bin;C:\Tools"));
        assert_eq!(parse_reg_path("    PATHEXT    REG_SZ    .COM;.EXE"), None);
        assert_eq!(parse_reg_path("ERROR: The system was unable to find the specified registry key"), None);
    }

    #[test]
    fn merges_dirs_without_duplicates() {
        let m = merge_dirs(vec![vec![PathBuf::from("/a"), PathBuf::from("/b/")], vec![PathBuf::from("/b"), PathBuf::from("/c")], vec![PathBuf::from("")]]);
        assert_eq!(m, vec![PathBuf::from("/a"), PathBuf::from("/b/"), PathBuf::from("/c")]);
    }

    #[test]
    fn slow_launchers_by_stem() {
        for c in ["npx", "uvx", r"C:\x\npx.cmd", "UV.EXE", "serena", "pnpm", "bunx", "pipx"] {
            assert!(is_slow_launcher(c), "{c}");
        }
        for c in ["node", "multi-account-gmail-mcp", "pal-mcp-server", ""] {
            assert!(!is_slow_launcher(c), "{c}");
        }
    }

    #[test]
    fn hints_for_known_commands() {
        assert!(not_found_msg("serena", 12).starts_with("could not start serena: not found (searched 12 folders"));
        assert!(not_found_msg("serena", 1).contains("serena-agent"));
        assert!(not_found_msg("uvx", 1).contains("winget install astral-sh.uv"));
        assert!(!not_found_msg("whatever", 1).contains(" — "));
    }

    #[cfg(windows)]
    #[test]
    fn windows_search_tries_shim_extensions_in_dir_order() {
        let dirs = vec![PathBuf::from(r"C:\a"), PathBuf::from(r"C:\b")];
        let f = fs(&[r"C:\a\npx", r"C:\b\npx.cmd", r"C:\b\npx.exe", r"C:\a\uv.exe"]);
        // Extension-less files are never accepted; .exe before .cmd in the same folder.
        assert_eq!(resolve_in("npx", &dirs, None, &f).unwrap(), PathBuf::from(r"C:\b\npx.exe"));
        assert_eq!(resolve_in("uv", &dirs, None, &f).unwrap(), PathBuf::from(r"C:\a\uv.exe"));
        // A name with an executable extension is searched as written.
        assert_eq!(resolve_in("npx.cmd", &dirs, None, &f).unwrap(), PathBuf::from(r"C:\b\npx.cmd"));
        // A dotted name that isn't an extension still gets the extensions appended.
        let f2 = fs(&[r"C:\a\tool.v2.exe"]);
        assert_eq!(resolve_in("tool.v2", &dirs, None, &f2).unwrap(), PathBuf::from(r"C:\a\tool.v2.exe"));
        let e = resolve_in("serena", &dirs, None, &f).unwrap_err();
        assert!(e.starts_with("could not start serena: not found") && e.contains("serena-agent"), "{e}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_explicit_paths() {
        let f = fs(&[r"C:\tools\srv.exe", r"C:\tools\noext", r"D:\w\bin\x.cmd"]);
        assert_eq!(resolve_in(r"C:\tools\srv.exe", &[], None, &f).unwrap(), PathBuf::from(r"C:\tools\srv.exe"));
        // Extension omitted on an explicit path: the usual extensions are tried.
        assert_eq!(resolve_in(r"C:\tools\srv", &[], None, &f).unwrap(), PathBuf::from(r"C:\tools\srv.exe"));
        // An extension-less file is refused with a clear message.
        let e = resolve_in(r"C:\tools\noext", &[], None, &f).unwrap_err();
        assert!(e.contains("no .exe/.cmd/.bat extension"), "{e}");
        // Relative paths resolve against the server's working folder.
        assert_eq!(resolve_in(r"bin\x.cmd", &[], Some(Path::new(r"D:\w")), &f).unwrap(), PathBuf::from(r"D:\w\bin\x.cmd"));
        assert!(resolve_in(r"C:\missing\srv.exe", &[], None, &f).unwrap_err().contains("no such file"));
        assert_eq!(resolve_in("  ", &[], None, &f).unwrap_err(), "no command set");
    }

    #[test]
    fn server_path_comes_first() {
        let mut env = BTreeMap::new();
        env.insert("Path".to_string(), if cfg!(windows) { r"C:\first;C:\second".to_string() } else { "/first:/second".to_string() });
        let dirs = search_dirs(&env);
        assert_eq!(dirs[0], PathBuf::from(if cfg!(windows) { r"C:\first" } else { "/first" }));
        assert_eq!(dirs[1], PathBuf::from(if cfg!(windows) { r"C:\second" } else { "/second" }));
    }
}
