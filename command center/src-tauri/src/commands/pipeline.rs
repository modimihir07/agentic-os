//! Idea-to-Execution pipeline, Play Place actions, Comms recall/WhatsApp, and
//! the phone → desktop queue.
//!
//!   Stage 1  idea_capture   Tony → Prompter (task breakdown) → Librarian (Ideas & Tasks ledger)
//!   Stage 2  pipeline_run   Prompter → Designer (design brief ⇄ UI blueprint)
//!   Stage 3                 Prompter → Coder (build prompt) → prototype → Play Place card
//!   Stage 4                 at every handoff a non-blocking Verifier check (privacy-diffused if remote)
//!
//! Every agent-to-agent message is emitted as a `pipeline-step` event with the
//! thread it belongs to (Designer / Coder / Prompter / Librarian tabs) and as
//! progress to the gateway for the phone HUD.

use serde::Serialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agents::{workspace_chat_t, OsStep};
use super::bridge::BridgeState;
use super::dispatch::{extract_json, run_chat, short, ChatMessage, DispatchState, Priority};
use super::os_core::{self, OsConfig, OsState};

// ── Gateway client (loopback; carries the mesh token when the lock is on) ──

pub(crate) async fn gw(state: &DispatchState, os: &OsConfig, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let base = state.snapshot().gateway.url;
    let mut rb = state.http.request(method, format!("{}{path}", base.trim_end_matches('/'))).timeout(Duration::from_secs(20));
    if let Some(t) = os_core::mesh_bearer(os) {
        rb = rb.bearer_auth(t);
    }
    if let Some(b) = body {
        rb = rb.json(&b);
    }
    let r = rb.send().await.map_err(short)?;
    let status = r.status();
    let v: Value = r.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("gateway {}: {}", status.as_u16(), v["detail"].as_str().unwrap_or("error")));
    }
    Ok(v)
}

fn slug(cfg: &OsConfig, role: &str) -> Result<String, String> {
    cfg.anythingllm.workspaces.get(role).filter(|s| !s.is_empty()).cloned().ok_or_else(|| format!("no AnythingLLM workspace mapped for {role} (Settings → Services)"))
}

/// The last ```html … ``` block (or a bare <!doctype html> document).
pub(crate) fn extract_html(text: &str) -> Option<String> {
    let low = text.to_ascii_lowercase();
    if let Some(start) = low.rfind("```html") {
        let body = &text[start + 7..];
        let end = body.find("```").unwrap_or(body.len());
        let h = body[..end].trim();
        if h.len() > 40 {
            return Some(h.to_string());
        }
    }
    let s = low.find("<!doctype html").or_else(|| low.find("<html"))?;
    let e = low.rfind("</html>").map(|e| e + 7).unwrap_or(text.len());
    (e > s).then(|| text[s..e].trim().to_string())
}

fn slugify(s: &str) -> String {
    let mut out: String = s.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(48).collect::<String>().trim_end_matches('-').to_string()
}

// ── Events ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepEvent {
    pipeline_id: String,
    idea_id: Option<String>,
    card_id: Option<String>,
    stage: String,
    pct: u8,
    /// Dispatcher tab the step is logged in.
    thread: String,
    #[serde(flatten)]
    step: OsStep,
}

struct Run<'a> {
    app: &'a AppHandle,
    id: String,
    idea_id: Option<String>,
    steps: Vec<OsStep>,
}

impl Run<'_> {
    fn emit(&mut self, stage: &str, pct: u8, thread: &str, step: OsStep, card_id: Option<String>) {
        let ev = StepEvent { pipeline_id: self.id.clone(), idea_id: self.idea_id.clone(), card_id, stage: stage.into(), pct, thread: thread.into(), step: step.clone() };
        let _ = self.app.emit("pipeline-step", ev);
        // Phone HUD progress (best-effort).
        let app = self.app.clone();
        let body = json!({ "ideaId": self.idea_id.clone().unwrap_or_else(|| self.id.clone()), "pipelineId": self.id, "stage": stage, "pct": pct, "label": format!("{} → {}", step.from, step.to) });
        self.steps.push(step);
        tauri::async_runtime::spawn(async move {
            let st = app.state::<DispatchState>();
            let os = app.state::<OsState>().snapshot();
            let _ = gw(&st, &os, reqwest::Method::POST, "/api/pipeline/progress", Some(body)).await;
        });
    }

    /// Stage 4: non-blocking verifier at a handoff. Reports into the same thread.
    fn verify(&self, handoff: &str, thread: &str, original: &str, payload: &str) {
        let app = self.app.clone();
        let (id, idea, thread, handoff) = (self.id.clone(), self.idea_id.clone(), thread.to_string(), handoff.to_string());
        let msg = format!(
            "Original request: \"{}\"\nHandoff {handoff} payload:\n{}\n\nCheck: valid JSON/structure where JSON is expected, no invented file paths or tool calls, and aligned with the original request. Reply ONLY JSON {{\"ok\": boolean, \"issues\": [string]}}.",
            original.chars().take(1500).collect::<String>(),
            payload.chars().take(4000).collect::<String>()
        );
        tauri::async_runtime::spawn(async move {
            let st = app.state::<DispatchState>();
            let os = app.state::<OsState>();
            let t0 = Instant::now();
            let r = run_chat(&st, &os, vec![ChatMessage::new("system", "You are a terse verifier."), ChatMessage::new("user", msg)], Priority::Background, Some("verifier".into()), Some(45)).await;
            let (ok, text) = match r.ok().and_then(|r| extract_json(&r.content)) {
                Some(j) if j["ok"].as_bool() == Some(true) => (true, format!("✓ {handoff} verified")),
                Some(j) => (false, format!("⚠ {handoff}: {}", j["issues"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; ")).unwrap_or_default())),
                None => (true, format!("{handoff}: verifier unavailable (non-blocking)")),
            };
            let step = super::agents::step("verify", "verifier", "os", text, ok, t0.elapsed().as_millis());
            let _ = app.emit("pipeline-step", StepEvent { pipeline_id: id, idea_id: idea, card_id: None, stage: "verify".into(), pct: 0, thread, step });
        });
    }
}

/// Ask a role. `offload` = run it on an external engine (Claude/Gemini/llm CLI…)
/// instead of the local GPU. Otherwise: its AnythingLLM workspace, then the local
/// chain as stand-in. Pipeline work is BACKGROUND — Tony keeps the GPU first.
async fn ask(state: &DispatchState, os: &OsState, role: &str, prompt: &str, secs: u64, offload: Option<&str>) -> Result<(String, String), String> {
    if let Some(engine) = offload {
        let (a, _) = super::agents::external_chat(state, os, engine, &[ChatMessage::new("user", prompt.to_string())], secs).await?;
        return Ok((a, format!("ext:{engine}")));
    }
    let cfg = os.snapshot();
    if let Ok(s) = slug(&cfg, role) {
        if let Ok((a, _)) = workspace_chat_t(state, os, &s, prompt, Some(secs), false).await {
            return Ok((a, format!("anythingllm:{s}")));
        }
    }
    let r = run_chat(state, os, vec![ChatMessage::new("user", prompt.to_string())], Priority::Background, None, Some(secs)).await.map_err(|e| format!("{role} unavailable: {e}"))?;
    Ok((r.content, format!("{} (stand-in for {role})", r.provider_id)))
}

// ── Stage 1: idea capture ───────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeaResult {
    idea: Value,
    reply: String,
    steps: Vec<OsStep>,
}

#[tauri::command]
pub async fn idea_capture(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, text: String) -> Result<IdeaResult, String> {
    capture(&app, &state, &os, &text).await
}

pub async fn capture(app: &AppHandle, state: &DispatchState, os: &OsState, text: &str) -> Result<IdeaResult, String> {
    let cfg = os.snapshot();
    let mut run = Run { app, id: format!("idea-{}", os_core::now_secs()), idea_id: None, steps: vec![] };
    let ask_prompter = format!(
        "[{} → Prompter] Break this idea into a buildable spec. Reply ONLY with JSON: {{\"title\": short name, \"summary\": 2 sentences, \"tasks\": [5-10 concrete tasks as strings], \"spec\": {{\"problem\": str, \"users\": str, \"coreFeatures\": [str], \"screens\": [str], \"dataModel\": str, \"risks\": [str]}}}}.\n\nIdea (in the user's words): {text}",
        cfg.os_name
    );
    run.emit("capture", 10, "prompter", super::agents::step("delegate", "os", "prompter", &ask_prompter, true, 0), None);
    let t0 = Instant::now();
    let (raw, by) = ask(state, os, "prompter", &ask_prompter, 180, None).await.unwrap_or_else(|e| (format!("({e})"), "none".into()));
    let j = extract_json(&raw).unwrap_or_else(|| json!({ "title": text.chars().take(48).collect::<String>(), "summary": raw.chars().take(400).collect::<String>(), "tasks": [], "spec": {} }));
    run.emit("capture", 40, "prompter", super::agents::step("reply", "prompter", "os", format!("{}\n\nTasks:\n{}", j["summary"].as_str().unwrap_or(""), j["tasks"].as_array().map(|t| t.iter().filter_map(|x| x.as_str()).map(|x| format!("• {x}")).collect::<Vec<_>>().join("\n")).unwrap_or_default()), true, t0.elapsed().as_millis()), None);
    run.verify("Tony → Prompter", "prompter", text, &raw);

    // Librarian: ledger entry (synced + vault-indexed), markdown in C:\ai-hub\memory, and the librarian workspace.
    let title = j["title"].as_str().unwrap_or("Untitled idea").to_string();
    let tasks: Vec<Value> = j["tasks"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|t| t.as_str().map(|s| json!({ "id": uuid_like(), "text": s, "done": false }))).collect();
    run.emit("ledger", 60, "librarian", super::agents::step("delegate", "os", "librarian", format!("Save “{title}” to the Ideas & Tasks Ledger"), true, 0), None);
    let item = gw(state, &cfg, reqwest::Method::POST, "/api/cc/c/ideas", Some(json!({ "title": title, "idea": text, "summary": j["summary"], "tasks": tasks, "spec": j["spec"], "status": "captured", "by": by }))).await?;
    let idea_id = item["id"].as_str().unwrap_or("").to_string();
    run.idea_id = Some(idea_id.clone());
    let md = format!(
        "# {title}\n\n_{}_ · captured by {}\n\n## The idea\n{text}\n\n## Summary\n{}\n\n## Tasks\n{}\n\n## Spec\n```json\n{}\n```\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M"),
        cfg.os_name,
        j["summary"].as_str().unwrap_or(""),
        tasks.iter().filter_map(|t| t["text"].as_str()).map(|t| format!("- [ ] {t}")).collect::<Vec<_>>().join("\n"),
        serde_json::to_string_pretty(&j["spec"]).unwrap_or_default()
    );
    let path = ideas_dir().join(format!("{}-{}.md", chrono::Local::now().format("%Y-%m-%d"), slugify(&title)));
    let saved_file = std::fs::create_dir_all(ideas_dir()).and_then(|_| std::fs::write(&path, &md)).is_ok();
    let in_ws = librarian_ingest(state, os, &format!("Idea: {title}"), &md).await;
    run.emit(
        "ledger",
        80,
        "librarian",
        super::agents::step("reply", "librarian", "os", format!("Saved to the Ideas & Tasks Ledger{}{}", if saved_file { format!(" · {}", path.display()) } else { String::new() }, if in_ws { " · indexed in the Librarian workspace" } else { "" }), true, 0),
        None,
    );
    let reply = format!(
        "I broke “{title}” into {} tasks and saved the concept to your Ideas & Tasks Ledger. Want me to have the Prompter, Designer, and Coder spin up a prototype in the Play Place?",
        tasks.len()
    );
    Ok(IdeaResult { idea: item, reply, steps: run.steps })
}

fn ideas_dir() -> PathBuf {
    PathBuf::from(r"C:\ai-hub\memory\ideas")
}

fn uuid_like() -> String {
    use aes_gcm::aead::rand_core::RngCore;
    let mut b = [0u8; 8];
    aes_gcm::aead::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Put a document into the Librarian's AnythingLLM workspace (best-effort).
async fn librarian_ingest(state: &DispatchState, os: &OsState, title: &str, text: &str) -> bool {
    let cfg = os.snapshot();
    let (Ok(ws), Some(key)) = (slug(&cfg, "librarian"), super::secrets::get(state, "anythingllm")) else { return false };
    super::agents::allm(state, &cfg.anythingllm.base_url, &key, reqwest::Method::POST, "/v1/document/raw-text", Some(json!({ "textContent": text, "addToWorkspaces": ws, "metadata": { "title": title, "docSource": "agentic-os" } })), 60)
        .await
        .is_ok()
}

// ── Stages 2 + 3: blueprint → prototype → Play Place ────────────────────────

const PROTOTYPE_RULES: &str = "Output ONE complete, self-contained HTML document in a single ```html fenced block: Tailwind via <script src=\"https://cdn.tailwindcss.com\"></script>, vanilla JS (or React via https://esm.sh if truly needed), realistic sample data, every button wired, dark cinematic glass look unless the brief says otherwise, mobile-first. No external images except https URLs. No explanations outside the code block beyond 3 short lines.";

/// Everything a pipeline knows so far — written as a checkpoint before every
/// handoff, so a failed step rolls back to here and can be retried or offloaded.
#[derive(Serialize, serde::Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PipeState {
    pipeline_id: String,
    idea_id: String,
    title: String,
    original: String,
    tasks: String,
    spec: Value,
    brief: String,
    blueprint: String,
    by_designer: String,
    build_prompt: String,
    code: String,
    by_coder: String,
    /// Stages finished (0–4): brief, blueprint, build prompt, code.
    done: u8,
    failed_stage: Option<String>,
    error: Option<String>,
}

const STAGES: [&str; 4] = ["brief", "blueprint", "merge", "build"];

fn checkpoint_dir() -> PathBuf {
    PathBuf::from(r"C:\ai-hub\memory\checkpoints")
}

fn save_checkpoint(st: &PipeState, step: &str) -> Option<String> {
    let dir = checkpoint_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{}-{step}.json", st.pipeline_id));
    std::fs::write(&path, serde_json::to_string_pretty(st).ok()?).ok()?;
    Some(path.display().to_string())
}

#[tauri::command]
pub async fn idea_pipeline_run(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, idea_id: String) -> Result<Value, String> {
    run_pipeline(&app, &state, &os, &idea_id).await
}

pub async fn run_pipeline(app: &AppHandle, state: &DispatchState, os: &OsState, idea_id: &str) -> Result<Value, String> {
    let cfg = os.snapshot();
    let list = gw(state, &cfg, reqwest::Method::GET, "/api/pipeline/ideas", None).await?;
    let idea = list["items"].as_array().into_iter().flatten().find(|i| i["id"] == idea_id).cloned().ok_or("idea not found in the ledger")?;
    let st = PipeState {
        pipeline_id: format!("pipe-{}", os_core::now_secs()),
        idea_id: idea_id.to_string(),
        title: idea["title"].as_str().unwrap_or("Prototype").to_string(),
        original: idea["idea"].as_str().unwrap_or("").to_string(),
        tasks: idea["tasks"].as_array().map(|t| t.iter().filter_map(|x| x["text"].as_str()).map(|x| format!("- {x}")).collect::<Vec<_>>().join("\n")).unwrap_or_default(),
        spec: idea["spec"].clone(),
        ..Default::default()
    };
    let _ = gw(state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/ideas/{idea_id}"), Some(json!({ "status": "prototyping" }))).await;
    advance(app, state, os, st, None).await
}

/// Retry a failed step from its checkpoint, optionally on an external engine.
#[tauri::command]
pub async fn pipeline_resume(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, checkpoint: String, offload: Option<String>) -> Result<Value, String> {
    let path = PathBuf::from(&checkpoint);
    let canon = std::fs::canonicalize(&path).map_err(|_| "checkpoint not found")?;
    if !canon.starts_with(std::fs::canonicalize(checkpoint_dir()).map_err(|e| e.to_string())?) {
        return Err("not a pipeline checkpoint".into());
    }
    let mut st: PipeState = serde_json::from_str(&std::fs::read_to_string(&canon).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let stage = st.failed_stage.take().unwrap_or_else(|| STAGES.get(st.done as usize).unwrap_or(&"build").to_string());
    st.error = None;
    if let Some(e) = &offload {
        if !["claude-cli", "gemini-cli", "llm-cli", "claude-api", "gemini-api"].contains(&e.as_str()) {
            return Err("offload engine must be claude-cli, gemini-cli, llm-cli, claude-api or gemini-api".into());
        }
    }
    advance(&app, &state, &os, st, offload.map(|e| (stage, e))).await
}

async fn advance(app: &AppHandle, state: &DispatchState, os: &OsState, mut st: PipeState, forced: Option<(String, String)>) -> Result<Value, String> {
    let cfg = os.snapshot();
    let sc = cfg.scheduler.clone();
    let mut run = Run { app, id: st.pipeline_id.clone(), idea_id: Some(st.idea_id.clone()), steps: vec![] };
    let cloud_ok = !cfg.privacy.kill_switch && cfg.compute.mode != os_core::ComputeMode::Local;
    // Slider 2: ≥ 50 % sends the heavy build step to the CLI/cloud engine, ≥ 80 % the design step too.
    let auto = |stage: &str| -> Option<String> {
        let heavy = (stage == "build" && sc.offload_pct >= 50) || (stage == "blueprint" && sc.offload_pct >= 80);
        (cloud_ok && heavy).then(|| sc.offload_engine.clone())
    };
    let (title, original) = (st.title.clone(), st.original.clone());
    for (i, stage) in STAGES.iter().enumerate() {
        if st.done as usize > i {
            continue;
        }
        save_checkpoint(&st, &format!("{i}-{stage}"));
        let engine = forced.as_ref().filter(|(s, _)| s == stage).map(|(_, e)| e.clone()).or_else(|| auto(stage));
        let t0 = Instant::now();
        let result: Result<(), String> = match *stage {
            "brief" => {
                let q = format!("[Prompter] Turn this idea into a design brief for the Designer agent: goal, audience, key screens, content per screen, interactions, tone, constraints. Be specific and short.\n\nIdea: {original}\nSpec: {}", st.spec);
                ask(state, os, "prompter", &q, 180, engine.as_deref()).await.map(|(b, _)| {
                    st.brief = b;
                    run.emit("brief", 15, "designer", super::agents::step("delegate", "prompter", "designer", &st.brief, true, t0.elapsed().as_millis()), None);
                    run.verify("Prompter → Designer", "designer", &original, &st.brief);
                })
            }
            "blueprint" => {
                let q = format!("{}\n\nReturn: (1) design tokens JSON, (2) component hierarchy, (3) wireframe per breakpoint, (4) a first visual prototype. {PROTOTYPE_RULES}", st.brief);
                ask(state, os, "designer", &q, 420, engine.as_deref()).await.map(|(b, by)| {
                    st.blueprint = b;
                    st.by_designer = by;
                    run.emit("blueprint", 45, "designer", super::agents::step("reply", "designer", "prompter", strip_code(&st.blueprint), true, t0.elapsed().as_millis()), None);
                })
            }
            "merge" => {
                st.build_prompt = format!(
                    "[Prompter → Coder] Build a clickable prototype of “{title}”.\n\nFUNCTIONAL GOAL:\n{original}\n\nTASKS:\n{}\n\nDESIGNER BLUEPRINT (follow its tokens, hierarchy and layout):\n{}\n\n{PROTOTYPE_RULES}",
                    st.tasks,
                    strip_code(&st.blueprint).chars().take(6000).collect::<String>()
                );
                run.emit("build", 55, "coder", super::agents::step("delegate", "prompter", if auto("build").is_some() { "offload" } else { "coder" }, &st.build_prompt, true, 0), None);
                run.verify("Prompter → Coder", "coder", &original, &st.build_prompt);
                Ok(())
            }
            _ => {
                let r = ask(state, os, "coder", &st.build_prompt, 600, engine.as_deref()).await;
                r.and_then(|(code, by)| {
                    if extract_html(&code).or_else(|| extract_html(&st.blueprint)).is_none() {
                        return Err(format!("no runnable HTML came back from {by}"));
                    }
                    st.code = code;
                    st.by_coder = by;
                    Ok(())
                })
            }
        };
        match result {
            Ok(()) => st.done = i as u8 + 1,
            Err(e) => {
                // Roll back to the pre-handoff checkpoint and offer Retry / Offload in Tony's chat.
                st.failed_stage = Some(stage.to_string());
                st.error = Some(e.clone());
                let path = save_checkpoint(&st, &format!("{i}-{stage}-failed"));
                let _ = app.emit("pipeline-failed", json!({ "pipelineId": st.pipeline_id, "ideaId": st.idea_id, "title": title, "stage": stage, "error": e, "checkpoint": path }));
                return Err(format!("{stage} step failed: {e}"));
            }
        }
    }

    let html = extract_html(&st.code).or_else(|| extract_html(&st.blueprint));
    run.emit(
        "build",
        85,
        "coder",
        super::agents::step("reply", "coder", "prompter", format!("Prototype built by {} ({} KB of HTML).\n{}", st.by_coder, html.as_ref().map(|h| h.len() / 1024).unwrap_or(0), strip_code(&st.code).chars().take(600).collect::<String>()), true, 0),
        None,
    );
    let card = gw(
        state,
        &cfg,
        reqwest::Method::POST,
        "/api/play-place",
        Some(json!({
            "title": title, "idea": original, "ideaId": st.idea_id, "brief": st.brief, "blueprint": strip_code(&st.blueprint),
            "buildPrompt": st.build_prompt, "html": html.clone().unwrap_or_default(), "source": "coder", "status": "staged",
            "by": { "designer": st.by_designer, "coder": st.by_coder },
            "versions": [{ "at": os_core::now_secs(), "by": st.by_coder, "notes": "first build" }],
            "pipelineId": st.pipeline_id,
            "chain": run.steps.iter().map(|s| json!({ "from": s.from, "to": s.to, "kind": s.kind, "text": s.text.chars().take(4000).collect::<String>() })).collect::<Vec<_>>(),
        })),
    )
    .await?;
    let card_id = card["id"].as_str().unwrap_or("").to_string();
    let _ = gw(state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/ideas/{}", st.idea_id), Some(json!({ "status": "staged", "cardId": card_id }))).await;
    save_checkpoint(&st, "done");
    run.emit("done", 100, "coder", super::agents::step("reply", "os", "user", format!("Prototype “{title}” is live in the Play Place and ready for your review."), html.is_some(), 0), Some(card_id.clone()));
    Ok(json!({ "cardId": card_id, "hasHtml": html.is_some(), "steps": run.steps }))
}

/// Blueprint text without the big code block (for threads and briefs).
fn strip_code(s: &str) -> String {
    let re = regex::Regex::new(r"(?s)```html.*?(```|$)").unwrap();
    re.replace_all(s, "[prototype HTML staged in the Play Place]").trim().to_string()
}

// ── Play Place actions ──────────────────────────────────────────────────────

async fn card(state: &DispatchState, cfg: &OsConfig, id: &str) -> Result<Value, String> {
    gw(state, cfg, reqwest::Method::GET, &format!("/api/play-place/{id}"), None).await
}

#[tauri::command]
pub async fn playplace_iterate(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, card_id: String, notes: String, target: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let role = if target == "designer" { "designer" } else { "coder" };
    let c = card(&state, &cfg, &card_id).await?;
    let mut run = Run { app: &app, id: format!("tweak-{}", os_core::now_secs()), idea_id: c["ideaId"].as_str().map(String::from), steps: vec![] };
    let q = format!(
        "[{} → {}] Revise this prototype. Revision notes from the user: {notes}\n\nKeep everything that works. {PROTOTYPE_RULES}\n\nCURRENT PROTOTYPE:\n```html\n{}\n```",
        cfg.os_name,
        if role == "designer" { "Designer" } else { "Coder" },
        c["html"].as_str().unwrap_or("").chars().take(40_000).collect::<String>()
    );
    run.emit("tweak", 20, role, super::agents::step("delegate", "os", role, format!("Revise “{}”: {notes}", c["title"].as_str().unwrap_or("")), true, 0), Some(card_id.clone()));
    let t0 = Instant::now();
    let (out, by) = ask(&state, &os, role, &q, 600, None).await?;
    let html = extract_html(&out).ok_or_else(|| format!("{role} returned no HTML: {}", out.chars().take(200).collect::<String>()))?;
    let mut versions = c["versions"].as_array().cloned().unwrap_or_default();
    versions.push(json!({ "at": os_core::now_secs(), "by": role, "notes": notes }));
    let updated = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "html": html, "versions": versions, "status": "staged", "lastBy": by }))).await?;
    run.emit("tweak", 100, role, super::agents::step("reply", role, "os", format!("Revised ({} KB). {}", html.len() / 1024, strip_code(&out).chars().take(300).collect::<String>()), true, t0.elapsed().as_millis()), Some(card_id));
    Ok(updated)
}

#[tauri::command]
pub async fn playplace_approve(app: AppHandle, state: State<'_, DispatchState>, os: State<'_, OsState>, card_id: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let c = card(&state, &cfg, &card_id).await?;
    let mut run = Run { app: &app, id: format!("approve-{}", os_core::now_secs()), idea_id: c["ideaId"].as_str().map(String::from), steps: vec![] };
    let _ = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "building" }))).await;
    let q = format!(
        "[Prompter] The user APPROVED this prototype's look and flow. Write technical build instructions for the Coder to turn it into a production feature: stack, file tree, components, state/data model, API calls, step-by-step tasks, acceptance tests. Don't invent existing file paths — propose new ones.\n\nIdea: {}\nBlueprint: {}\nPrototype HTML (reference):\n{}",
        c["idea"].as_str().unwrap_or(""),
        c["blueprint"].as_str().unwrap_or("").chars().take(4000).collect::<String>(),
        c["html"].as_str().unwrap_or("").chars().take(12_000).collect::<String>()
    );
    let t0 = Instant::now();
    let (plan, _) = ask(&state, &os, "prompter", &q, 300, None).await?;
    run.emit("approve", 40, "prompter", super::agents::step("reply", "prompter", "coder", &plan, true, t0.elapsed().as_millis()), Some(card_id.clone()));
    run.verify("Prompter → Coder (build)", "coder", c["idea"].as_str().unwrap_or(""), &plan);
    let t0 = Instant::now();
    let offload = { let c = os.snapshot(); (c.scheduler.offload_pct >= 50 && !c.privacy.kill_switch).then(|| c.scheduler.offload_engine.clone()) };
    let (impl_out, _) = ask(&state, &os, "coder", &format!("[Prompter → Coder] Build instructions for an approved prototype. Start the implementation: list the files you'd create and give the core code for each.\n\n{plan}"), 600, offload.as_deref()).await?;
    run.emit("approve", 100, "coder", super::agents::step("reply", "coder", "os", impl_out.chars().take(3000).collect::<String>(), true, t0.elapsed().as_millis()), Some(card_id.clone()));
    let updated = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "approved", "buildPlan": plan, "coderOutput": impl_out }))).await?;
    if let Some(i) = c["ideaId"].as_str() {
        let _ = gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/ideas/{i}"), Some(json!({ "status": "approved" }))).await;
    }
    Ok(updated)
}

#[tauri::command]
pub async fn playplace_commit(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, card_id: String) -> Result<Value, String> {
    let cfg = os.snapshot();
    let c = card(&state, &cfg, &card_id).await?;
    let title = c["title"].as_str().unwrap_or("prototype").to_string();
    let dir = PathBuf::from(r"C:\ai-hub\memory\play-place").join(format!("{}-{}", chrono::Local::now().format("%Y-%m-%d"), slugify(&title)));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let spec = format!(
        "# {title}\n\n## Idea\n{}\n\n## Design brief\n{}\n\n## Blueprint\n{}\n\n## Build plan\n{}\n",
        c["idea"].as_str().unwrap_or(""),
        c["brief"].as_str().unwrap_or(""),
        c["blueprint"].as_str().unwrap_or(""),
        c["buildPlan"].as_str().unwrap_or("(not approved for build yet)")
    );
    std::fs::write(dir.join("spec.md"), &spec).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("prototype.html"), c["html"].as_str().unwrap_or("")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("prompt-chain.json"), serde_json::to_string_pretty(&json!({ "buildPrompt": c["buildPrompt"], "chain": c["chain"], "versions": c["versions"] })).unwrap_or_default()).map_err(|e| e.to_string())?;
    let indexed = librarian_ingest(&state, &os, &format!("Prototype: {title}"), &spec).await;
    bridge.log(json!({ "type": "playplace-commit", "card": card_id, "dir": dir.display().to_string() }));
    gw(&state, &cfg, reqwest::Method::PATCH, &format!("/api/cc/c/playplace/{card_id}"), Some(json!({ "status": "committed", "vaultPath": dir.display().to_string(), "librarianIndexed": indexed }))).await
}

// ── Comms: recall + WhatsApp ────────────────────────────────────────────────

/// Exact quotes with timestamps from the gateway's comms history (and WhatsApp
/// MCP, if enabled). Returns (formatted quotes, comms thread key).
pub async fn comms_search(state: &DispatchState, cfg: &OsConfig, who: &str, topic: &str) -> Result<(String, Option<String>), String> {
    let q = format!("/api/comms/search?contact={}&q={}&limit=10", urlenc(who), urlenc(topic));
    let v = gw(state, cfg, reqwest::Method::GET, &q, None).await?;
    let results = v["results"].as_array().cloned().unwrap_or_default();
    let thread = results.last().and_then(|r| r["thread"].as_str().map(String::from));
    let lines: Vec<String> = results
        .iter()
        .map(|r| format!("[{}] {} {}: “{}”", r["when"].as_str().unwrap_or(""), if r["direction"] == "out" { "You →" } else { "" }, r["contact"].as_str().unwrap_or(who), r["body"].as_str().unwrap_or("")))
        .collect();
    Ok((lines.join("\n"), thread))
}

fn urlenc(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

#[tauri::command]
pub async fn comms_whatsapp(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, action: String, args: Value) -> Result<String, String> {
    let tool = match action.as_str() {
        "chats" => "whatsapp.list_chats",
        "messages" => "whatsapp.list_messages",
        "contacts" => "whatsapp.search_contacts",
        _ => return Err("action must be chats, messages or contacts (sending goes through comms_whatsapp_send)".into()),
    };
    super::mcp::call_tool(&state, &os, &bridge, tool, &args, true, "tony").await
}

/// Send a WhatsApp message. Requires `approved` (the confirmation card), unless
/// the contact is marked trusted in Comms (Instant Send).
#[tauri::command]
pub async fn comms_whatsapp_send(state: State<'_, DispatchState>, os: State<'_, OsState>, bridge: State<'_, BridgeState>, recipient: String, message: String, approved: Option<bool>) -> Result<String, String> {
    let cfg = os.snapshot();
    if cfg.privacy.kill_switch {
        return Err("kill switch is on — WhatsApp is outbound traffic".into());
    }
    let trusted = gw(&state, &cfg, reqwest::Method::GET, &format!("/api/comms/contacts?q={}", urlenc(&recipient)), None)
        .await
        .ok()
        .and_then(|v| v["contacts"].as_array().cloned())
        .is_some_and(|c| c.iter().any(|x| x["trusted"].as_i64() == Some(1)));
    if !approved.unwrap_or(false) && !trusted {
        return Err("PERMISSION_REQUIRED:send".into());
    }
    let out = super::mcp::call_tool(&state, &os, &bridge, "whatsapp.send_message", &json!({ "recipient": recipient, "message": message }), true, "tony").await?;
    bridge.log(json!({ "type": "comms-send", "channel": "whatsapp", "trusted": trusted, "chars": message.len() }));
    let _ = gw(&state, &cfg, reqwest::Method::POST, "/api/comms/sms", Some(json!({ "address": recipient, "body": message, "direction": "out", "channel": "whatsapp" }))).await;
    Ok(out)
}

// ── Phone → desktop queue ───────────────────────────────────────────────────

/// Every 3 s: run Tony turns, pipeline/Play Place actions and lockdown commands
/// that the phone HUD queued on the gateway.
pub async fn inbox_loop(app: AppHandle) {
    loop {
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_secs(3))).await.ok();
        let st = app.state::<DispatchState>();
        let os = app.state::<OsState>();
        let cfg = os.snapshot();
        let Ok(v) = gw(&st, &cfg, reqwest::Method::GET, "/api/os/inbox", None).await else { continue };
        for item in v["items"].as_array().cloned().unwrap_or_default() {
            let id = item["id"].as_str().unwrap_or("").to_string();
            let p = &item["payload"];
            let result: Result<Value, String> = match item["kind"].as_str() {
                Some("command") => os
                    .update(|c| {
                        if let Some(k) = p["killSwitch"].as_bool() {
                            c.privacy.kill_switch = k;
                        }
                        if let Some(m) = p["computeMode"].as_str() {
                            c.compute.mode = serde_json::from_value(json!(m)).map_err(|_| "bad compute mode".to_string())?;
                        }
                        Ok(())
                    })
                    .map(|c| json!({ "killSwitch": c.privacy.kill_switch, "computeMode": c.compute.mode })),
                Some("turn") => {
                    let text = p["text"].as_str().unwrap_or("").to_string();
                    if looks_like_idea(&text) {
                        capture(&app, &st, &os, &text).await.map(|r| json!({ "answer": r.reply, "idea": r.idea, "steps": r.steps }))
                    } else {
                        let bridge = app.state::<BridgeState>();
                        let req: Result<super::agents::OsTurnRequest, _> = serde_json::from_value(p.clone());
                        match req {
                            Ok(r) => super::agents::run_os_turn(&st, &os, &bridge, r, Some(&app)).await.and_then(|r| serde_json::to_value(r).map_err(|e| e.to_string())),
                            Err(e) => Err(e.to_string()),
                        }
                    }
                }
                Some("pipeline") => run_pipeline(&app, &st, &os, p["ideaId"].as_str().unwrap_or("")).await,
                Some("playplace") => {
                    let card = p["cardId"].as_str().unwrap_or("").to_string();
                    match p["action"].as_str() {
                        Some("approve") => playplace_approve(app.clone(), app.state(), app.state(), card).await,
                        Some("iterate") => playplace_iterate(app.clone(), app.state(), app.state(), card, p["notes"].as_str().unwrap_or("").to_string(), p["target"].as_str().unwrap_or("coder").to_string()).await,
                        Some("commit") => playplace_commit(app.state(), app.state(), app.state(), card).await,
                        _ => Err("playplace action must be approve, iterate or commit".into()),
                    }
                }
                _ => Err("unknown queue item".into()),
            };
            let body = match result {
                Ok(v) => json!({ "ok": true, "result": v }),
                Err(e) => json!({ "ok": false, "error": e }),
            };
            let _ = gw(&st, &cfg, reqwest::Method::POST, &format!("/api/os/inbox/{id}/result"), Some(body)).await;
        }
    }
}

/// "I've been thinking about building an app that…" → Stage 1.
pub fn looks_like_idea(text: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"(?i)\b(i'?ve been thinking (about|of)|i'?m thinking (about|of)|i (want|wanna|would like) to (build|make|create)|idea for (an?|my)? ?(app|tool|site|website|product|game|platform|service|plugin|widget)|what if (i|we) (built|made|created)|i have an idea|new idea:|app idea|business idea)\b").unwrap()
    })
    .is_match(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_extracted() {
        let t = "Here you go:\n```html\n<!doctype html><html><body><h1>Hi there friend</h1></body></html>\n```\nDone.";
        assert!(extract_html(t).unwrap().starts_with("<!doctype html>"));
        assert!(extract_html("no code").is_none());
    }

    #[test]
    fn ideas_detected() {
        assert!(looks_like_idea("I've been thinking about building a tool that tracks auditions"));
        assert!(looks_like_idea("I have an idea for an app"));
        assert!(!looks_like_idea("what's the weather"));
    }

    #[test]
    fn slugs() {
        assert_eq!(slugify("Audition Tracker — v2!"), "audition-tracker-v2");
    }
}
