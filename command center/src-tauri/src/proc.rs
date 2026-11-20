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

/// A Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: every process assigned
/// to it — and every process those spawn afterwards (npx → node → server, uv → python…) —
/// is terminated when the job is killed or its last handle closes, including when this
/// app exits or crashes. A no-op elsewhere.
pub struct Job {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The job handle is an owned kernel handle; the Win32 job calls are thread-safe.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    #[cfg(windows)]
    pub fn kill_on_close() -> std::io::Result<Job> {
        use windows_sys::Win32::System::JobObjects::{CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};
        // SAFETY: plain Win32 calls with valid (null / stack) pointers; the handle is checked.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job { handle };
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(job.handle, JobObjectExtendedLimitInformation, &info as *const _ as *const core::ffi::c_void, std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            if ok == 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(job)
        }
    }

    #[cfg(not(windows))]
    pub fn kill_on_close() -> std::io::Result<Job> {
        Ok(Job {})
    }

    /// Put `child` (and so its future descendants) into the job.
    #[cfg(windows)]
    pub fn assign(&self, child: &std::process::Child) -> std::io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: both handles are valid for the duration of the call.
        let ok = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as _) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn assign(&self, _child: &std::process::Child) -> std::io::Result<()> {
        Ok(())
    }

    /// Terminate every process in the job now (the handle stays open until drop).
    pub fn kill(&self) {
        #[cfg(windows)]
        // SAFETY: valid job handle owned by `self`.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: closing the handle we own exactly once; KILL_ON_JOB_CLOSE ends the tree.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

/// Spawn `cmd` (with Windows `flags`, e.g. CREATE_NO_WINDOW) inside a fresh kill-on-close
/// job, with no window in which the child can start a grandchild outside it: it is created
/// suspended, assigned, then resumed. When no job can be made the child still runs (the
/// caller falls back to `kill_tree`); when it can't be resumed it is killed.
#[cfg(windows)]
pub fn spawn_in_job(cmd: &mut std::process::Command, flags: u32) -> std::io::Result<(std::process::Child, Option<Job>)> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
    cmd.creation_flags(flags | CREATE_SUSPENDED);
    let mut child = cmd.spawn()?;
    let job = match Job::kill_on_close().and_then(|j| j.assign(&child).map(|_| j)) {
        Ok(j) => Some(j),
        Err(e) => {
            eprintln!("[proc] pid {}: no job object ({e}); will kill by pid tree", child.id());
            None
        }
    };
    if let Err(e) = resume_main_thread(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok((child, job))
}

#[cfg(not(windows))]
pub fn spawn_in_job(cmd: &mut std::process::Command, _flags: u32) -> std::io::Result<(std::process::Child, Option<Job>)> {
    Ok((cmd.spawn()?, None))
}

/// Resume every thread of a process created suspended (it has exactly one).
#[cfg(windows)]
fn resume_main_thread(pid: u32) -> std::io::Result<()> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32};
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    // SAFETY: Win32 calls with a stack-allocated, size-initialised THREADENTRY32; every
    // handle opened here is checked and closed exactly once.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap == INVALID_HANDLE_VALUE || snap.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        let mut te: THREADENTRY32 = std::mem::zeroed();
        te.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0;
        let mut ok = Thread32First(snap, &mut te);
        while ok != 0 {
            if te.th32OwnerProcessID == pid {
                let th = OpenThread(THREAD_SUSPEND_RESUME, 0, te.th32ThreadID);
                if !th.is_null() {
                    if ResumeThread(th) != u32::MAX {
                        resumed += 1;
                    }
                    CloseHandle(th);
                }
            }
            ok = Thread32Next(snap, &mut te);
        }
        CloseHandle(snap);
        if resumed == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::Other, "could not resume the new process"));
        }
    }
    Ok(())
}

/// Last resort when a child could not be put in a job: kill its whole tree by pid.
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let _ = run("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]);
    }
    #[cfg(not(windows))]
    let _ = pid;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A job kills a process assigned to it (Windows only; elsewhere a no-op).
    #[cfg(windows)]
    #[test]
    fn job_kills_assigned_process() {
        use std::process::{Command, Stdio};
        let mut child = Command::new("cmd").args(["/C", "ping", "-n", "30", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("spawn");
        let job = Job::kill_on_close().expect("job");
        job.assign(&child).expect("assign");
        drop(job);
        let t0 = std::time::Instant::now();
        loop {
            if child.try_wait().unwrap().is_some() {
                break;
            }
            assert!(t0.elapsed() < std::time::Duration::from_secs(5), "child survived its job");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    /// `spawn_in_job` resumes the suspended child (it runs to its own exit code) and its
    /// job still kills it (and anything it started) when dropped.
    #[cfg(windows)]
    #[test]
    fn spawn_in_job_resumes_and_contains() {
        use std::process::{Command, Stdio};
        let (mut child, job) = spawn_in_job(Command::new("cmd").args(["/C", "exit", "7"]).stdout(Stdio::null()).stderr(Stdio::null()), 0x0800_0000).expect("spawn");
        assert!(job.is_some());
        assert_eq!(child.wait().unwrap().code(), Some(7), "the suspended child was resumed");
        let (mut child, job) = spawn_in_job(Command::new("cmd").args(["/C", "ping", "-n", "30", "127.0.0.1"]).stdout(Stdio::null()).stderr(Stdio::null()), 0x0800_0000).expect("spawn");
        std::thread::sleep(std::time::Duration::from_millis(300)); // let cmd start ping.exe
        drop(job);
        let t0 = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(t0.elapsed() < std::time::Duration::from_secs(5), "child survived its job");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}
