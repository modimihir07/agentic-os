//! OS-level alarm fallback (Windows). A saved alarm / reminder also registers a one-shot
//! Scheduled Task under `\AgenticOS\` that shows an alarm toast at the due time, even when
//! the app is closed; the task deletes itself after showing it. While the app runs, the
//! in-app scheduler fires first and cancels the task, so it never rings twice.
//!
//! Security: nothing from the webview reaches a command line as-is. The id is checked
//! against `^[A-Za-z0-9-]{1,64}$`; the title is stripped of control characters, capped at
//! 120 characters and written into the toast XML as character entities (so the script holds
//! only plain ASCII, inside a single-quoted literal); the due time is an integer turned into
//! an ISO-8601 UTC string here. The whole script is built in Rust and run with
//! `-EncodedCommand` (UTF-16LE base64) through `proc::run` (CREATE_NO_WINDOW).

use base64::Engine;

/// Task Scheduler folder holding every alarm task (`Alarm-<id>`).
const TASK_PATH: &str = r"\AgenticOS\";
const TASK_PREFIX: &str = "Alarm-";
const TITLE_MAX: usize = 120;
const MIN_LEAD_MS: i64 = 5_000;
const MAX_AHEAD_MS: i64 = 366 * 86_400_000;
/// PowerShell's own AppUserModelID: registered on every Windows install, so the toast shows
/// for dev and bundled builds alike (an unregistered app id is dropped silently).
const TOAST_APP_ID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";
/// Most ids `alarm_os_prune` keeps in one call.
const PRUNE_MAX: usize = 1000;

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
    if valid_id(id) {
        Ok(())
    } else {
        Err("alarm id must be 1-64 letters, digits or dashes".into())
    }
}

/// Control characters (newlines, tabs, escapes) removed, whitespace trimmed, 1-120 characters.
fn clean_title(title: &str) -> Result<String, String> {
    let t: String = title.chars().filter(|c| !c.is_control()).collect();
    let t = t.trim();
    match t.chars().count() {
        1..=TITLE_MAX => Ok(t.to_string()),
        _ => Err(format!("alarm title must be 1-{TITLE_MAX} characters")),
    }
}

fn check_due(due_at_ms: i64, now_ms: i64) -> Result<(), String> {
    if due_at_ms < now_ms + MIN_LEAD_MS || due_at_ms > now_ms + MAX_AHEAD_MS {
        return Err("alarm time must be between 5 seconds and 366 days from now".into());
    }
    Ok(())
}

/// Toast-XML text: plain ASCII letters, digits and a few punctuation marks as-is; every
/// other character (quotes, `$`, backticks, `<>&`, non-ASCII) as a numeric entity.
fn xml_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || " .,!?:;()-_/#@%+".contains(c) {
            out.push(c);
        } else {
            out.push_str(&format!("&#{};", c as u32));
        }
    }
    out
}

/// A PowerShell single-quoted literal (every quote PowerShell treats as one is doubled).
fn ps_quote(s: &str) -> String {
    let mut out = String::from("'");
    for c in s.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

/// `-EncodedCommand` payload: UTF-16LE, base64.
fn encode(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// The script the task runs at the due time: an alarm toast (looping sound, Dismiss), then it
/// deletes its own task. `title` is already cleaned.
fn toast_script(id: &str, title: &str) -> String {
    let xml = format!(
        r#"<toast scenario="alarm" duration="long"><visual><binding template="ToastGeneric"><text>Command Center</text><text>{}</text></binding></visual><audio src="ms-winsoundevent:Notification.Looping.Alarm" loop="true"/><actions><action activationType="system" arguments="dismiss" content=""/></actions></toast>"#,
        xml_text(title)
    );
    format!(
        "$ErrorActionPreference = 'SilentlyContinue'\n\
         [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null\n\
         [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null\n\
         $x = New-Object Windows.Data.Xml.Dom.XmlDocument\n\
         $x.LoadXml({xml})\n\
         [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier({app}).Show([Windows.UI.Notifications.ToastNotification]::new($x))\n\
         Unregister-ScheduledTask -TaskPath {path} -TaskName {name} -Confirm:$false\n",
        xml = ps_quote(&xml),
        app = ps_quote(TOAST_APP_ID),
        path = ps_quote(TASK_PATH),
        name = ps_quote(&format!("{TASK_PREFIX}{id}")),
    )
}

/// Pure: the registration script for one alarm, after validating every input.
fn build_script(id: &str, title: &str, due_at_ms: i64, now_ms: i64) -> Result<String, String> {
    check_id(id)?;
    let title = clean_title(title)?;
    check_due(due_at_ms, now_ms)?;
    let due = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(due_at_ms).ok_or("invalid alarm time")?;
    let iso = due.format("%Y-%m-%dT%H:%M:%S+00:00").to_string();
    let action_args = format!("-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}", encode(&toast_script(id, &title)));
    Ok(format!(
        "$ErrorActionPreference = 'Stop'\n\
         $at = [DateTimeOffset]::Parse({iso}, [Globalization.CultureInfo]::InvariantCulture).LocalDateTime\n\
         $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument {args}\n\
         $trigger = New-ScheduledTaskTrigger -Once -At $at\n\
         $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)\n\
         Register-ScheduledTask -TaskPath {path} -TaskName {name} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null\n",
        iso = ps_quote(&iso),
        args = ps_quote(&action_args),
        path = ps_quote(TASK_PATH),
        name = ps_quote(&format!("{TASK_PREFIX}{id}")),
    ))
}

fn cancel_script(id: &str) -> Result<String, String> {
    check_id(id)?;
    Ok(format!("Unregister-ScheduledTask -TaskPath {} -TaskName {} -Confirm:$false -ErrorAction SilentlyContinue\n", ps_quote(TASK_PATH), ps_quote(&format!("{TASK_PREFIX}{id}"))))
}

/// Deletes every `Alarm-*` task whose id is not in `live_ids` (invalid ids are ignored).
fn prune_script(live_ids: &[String]) -> String {
    let keep: Vec<String> = live_ids.iter().filter(|i| valid_id(i)).take(PRUNE_MAX).map(|i| ps_quote(i)).collect();
    format!(
        "$keep = @({keep})\n\
         Get-ScheduledTask -TaskPath {path} -ErrorAction SilentlyContinue | Where-Object {{ $_.TaskName.StartsWith({prefix}) -and ($keep -notcontains $_.TaskName.Substring({len})) }} | Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue\n",
        keep = keep.join(","),
        path = ps_quote(TASK_PATH),
        prefix = ps_quote(TASK_PREFIX),
        len = TASK_PREFIX.len(),
    )
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Runs a built script with `-EncodedCommand`, off the async runtime.
async fn run_script(script: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err("OS alarms are only available on Windows".into());
    }
    let encoded = encode(&script);
    let out = tauri::async_runtime::spawn_blocking(move || crate::proc::run("powershell.exe", &["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", &encoded]))
        .await
        .map_err(|e| format!("alarm task failed: {e}"))?
        .map_err(|e| format!("powershell not available: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        // First line only: the script echoes nothing of the title, but keep the error short.
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!("Task Scheduler refused the alarm: {}", err.lines().find(|l| !l.trim().is_empty()).unwrap_or("unknown error").trim()))
    }
}

/// Register (or replace) the OS alarm for reminder `id`.
#[tauri::command]
pub async fn alarm_os_schedule(id: String, title: String, due_at_ms: i64) -> Result<(), String> {
    run_script(build_script(&id, &title, due_at_ms, now_ms())?).await
}

/// Remove the OS alarm for reminder `id` (no error when there is none).
#[tauri::command]
pub async fn alarm_os_cancel(id: String) -> Result<(), String> {
    run_script(cancel_script(&id)?).await
}

/// Remove every OS alarm whose reminder is no longer live (startup cleanup).
#[tauri::command]
pub async fn alarm_os_prune(live_ids: Vec<String>) -> Result<(), String> {
    run_script(prune_script(&live_ids)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    fn decode(b64: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&units).unwrap()
    }

    /// The toast script embedded (encoded) in a registration script.
    fn inner(script: &str) -> String {
        let b64 = script.split("-EncodedCommand ").nth(1).unwrap().split('\'').next().unwrap();
        decode(b64)
    }

    #[test]
    fn ids_are_strict() {
        for ok in ["a", "0f8c2e1a-1b2c-4d3e-9f00-123456789abc", &"x".repeat(64)] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "a b", "../x", "a'b", "a;b", "é", "a_b", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad}");
            assert!(build_script(bad, "Wake up", NOW + 60_000, NOW).is_err());
            assert!(cancel_script(bad).is_err());
        }
    }

    #[test]
    fn titles_are_cleaned_and_capped() {
        assert_eq!(clean_title("  Call\nSam\t ").unwrap(), "CallSam");
        assert!(clean_title(" \n ").is_err());
        assert!(clean_title(&"x".repeat(121)).is_err());
        assert!(clean_title(&"é".repeat(120)).is_ok());
    }

    #[test]
    fn due_window_is_enforced() {
        assert!(build_script("a", "t", NOW + 4_999, NOW).is_err());
        assert!(build_script("a", "t", NOW + 5_000, NOW).is_ok());
        assert!(build_script("a", "t", NOW + MAX_AHEAD_MS, NOW).is_ok());
        assert!(build_script("a", "t", NOW + MAX_AHEAD_MS + 1, NOW).is_err());
        assert!(build_script("a", "t", i64::MIN, NOW).is_err());
    }

    #[test]
    fn hostile_titles_never_reach_the_script_raw() {
        let title = "Call \"Sam\" O'Neil ‘now’ $(Remove-Item C:\\x) `whoami` <b>&amp;\r\n; exit";
        let s = build_script("abc-123", title, NOW + 60_000, NOW).unwrap();
        // The outer script carries the title only inside the encoded toast script.
        let toast = inner(&s);
        let b64 = s.split("-EncodedCommand ").nth(1).unwrap().split('\'').next().unwrap();
        let outer = s.replace(b64, "");
        assert!(!outer.contains("Sam") && !outer.contains("whoami") && !outer.contains("$(Remove"));
        for raw in ["\"Sam\"", "O'Neil", "‘", "$(", "`", "<b>", "&amp;", "\r", "\n;"] {
            assert!(!toast.contains(raw), "raw {raw:?} in toast script");
        }
        assert!(toast.contains("&#34;Sam&#34;") && toast.contains("O&#39;Neil") && toast.contains("&#36;(Remove-Item C:&#92;x)") && toast.contains("&#96;whoami&#96;"));
        assert!(toast.contains("&#60;b&#62;&#38;amp;; exit"));
        // The only single quotes are the literal delimiters: an even count per line.
        for line in toast.lines().chain(s.lines()) {
            assert_eq!(line.matches('\'').count() % 2, 0, "{line}");
        }
        assert!(toast.contains("Unregister-ScheduledTask -TaskPath '\\AgenticOS\\' -TaskName 'Alarm-abc-123' -Confirm:$false"));
    }

    #[test]
    fn schedule_uses_an_iso_utc_time_and_the_alarm_folder() {
        let s = build_script("r1", "Wake up", NOW + 60_000, NOW).unwrap();
        assert!(s.contains("[DateTimeOffset]::Parse('2027-01-15T08:01:00+00:00', [Globalization.CultureInfo]::InvariantCulture).LocalDateTime"), "{s}");
        assert!(s.contains("Register-ScheduledTask -TaskPath '\\AgenticOS\\' -TaskName 'Alarm-r1'"));
        assert!(!s.contains("schtasks"));
    }

    #[test]
    fn ps_quote_doubles_every_single_quote_form() {
        assert_eq!(ps_quote("a'b"), "'a''b'");
        assert_eq!(ps_quote("a’b"), "'a’’b'");
        assert_eq!(ps_quote("$x `y`"), "'$x `y`'");
    }

    #[test]
    fn prune_keeps_only_valid_live_ids() {
        let s = prune_script(&["keep-1".into(), "bad id'".into(), "keep-2".into()]);
        assert!(s.starts_with("$keep = @('keep-1','keep-2')"), "{s}");
        assert!(!s.contains("bad id"));
        assert!(s.contains("Substring(6)"));
        assert!(prune_script(&[]).starts_with("$keep = @()"));
    }

    #[test]
    fn encode_round_trips_utf16() {
        assert_eq!(decode(&encode("Write-Output 'é'")), "Write-Output 'é'");
    }
}
