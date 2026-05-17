<div align="center">
  <br/>
  <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"/>
  <img src="https://img.shields.io/badge/python-3.10+-blue.svg" alt="Python 3.10+"/>
  <img src="https://img.shields.io/badge/FastAPI-0.115+-green.svg" alt="FastAPI"/>
  <img src="https://img.shields.io/badge/agents-3-orange.svg" alt="3 Agents"/>
  <img src="https://img.shields.io/badge/skills-16-purple.svg" alt="16 Skills"/>
  <img src="https://img.shields.io/badge/status-stable-brightgreen.svg" alt="Status: Stable"/>
  <a href="https://dev.to/mihir_nmodi_14a06a4019e1/i-built-an-open-source-agent-os-2h30"><img src="https://img.shields.io/badge/dev.to-article-blue.svg" alt="dev.to article"/></a>
  <br/><br/>
</div>

# Agentic OS 🧠 — Multi-Agent Orchestration Platform

A locally-hosted operating system for AI agents that coordinates **opencode**, **Hermes Agent**, and **Gemini CLI** into a unified dashboard with persistent memory, cron scheduling, skill execution, cost analytics, and disaster recovery.

> **Why Agentic OS?** Most agent tools work in isolation — a terminal for coding, a separate chat for research, another for memory. Agentic OS is the **control plane** that unifies them: one dashboard, one memory layer, one scheduler, one skill hub. Three agents, infinite capabilities.

---

## ✨ Features

| Category | Features |
|----------|----------|
| **🤖 3-Agent Engine** | opencode (code/DevOps), Hermes (memory/scheduling), Gemini (research/analysis) with intelligent routing |
| **🧩 16+ Skills** | Executable skill packs with eval scoring, learnings, and score history per run |
| **🧠 Persistent Memory** | SQLite FTS5 + `brain/` folder — shared context read by all agents at session start |
| **⏱ Cron Scheduler** | APScheduler-powered jobs — heartbeat, memory consolidation, daily standup, DevOps audit |
| **💰 Cost Analytics** | Track spending per provider, model, agent. Free-tier alerts prevent surprise bills |
| **📋 Audit Trail** | Every action logged — chat, skill runs, settings changes, backups |
| **💾 One-Click Backup** | Full tar.gz snapshot of all configs, skills, brain, agents, prompts |
| **📝 Prompt Library** | 10 reusable templates — code review, system audit, project plan, brainstorm, and more |
| **📐 Standards System** | Discover and inject coding conventions across your project |
| **🔌 Plugin Registry** | Marketplace-style plugin management (extensible via skills) |
| **🎨 Dark/Light Theme** | GitHub-style dark mode + clean light theme, toggle from sidebar |
| **⚡ Zero API Costs** | Built for free tiers — Gemini Flash, OpenRouter free models, local opencode |

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    AGENTIC OS DASHBOARD                      │
│                    FastAPI + Tailwind SPA                    │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────-┐  ┌──────────────┐  ┌──────────────────┐   |
│  │   opencode    │  │    Hermes    │  │   Gemini CLI     │   │
│  │  (Code/DevOps)│  │ (Memory/Sched│  │ (Research/Analy) │   │
│  │  File Ops)    │  │  /Channels)  │  │                  │   │
│  └──────────────-┘  └──────────────┘  └──────────────────┘   |
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              7 CORE LAYERS (Stacked)                 │    │
│  │  Layer 7: Identity / Persona / Constitution          │    │
│  │  Layer 6: Self-Evolution + Capability Manager        │    │
│  │  Layer 5: Scheduler + Awareness + Health Guardian    │    │
│  │  Layer 4: Memory Graph + Memory Consolidation        │    │
│  │  Layer 3: Skills Hub + Eval + Learnings Loop         │    │
│  │  Layer 2: Business Brain + Context Folders           │    │
│  │  Layer 1: Agent Router + Standards + Profiles        │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Agent Responsibilities

| Agent | Role | Default Model | Provider | Cost |
|-------|------|---------------|----------|------|
| **opencode** | Code generation, DevOps, file operations | deepseek-v4-flash-free | opencode-zen | **$0** |
| **Hermes Agent** | Persistent memory, scheduling, messaging | Owl Alpha (1M ctx) | OpenRouter | **$0** |
| **Gemini CLI** | Web research, multi-modal analysis | gemini-2.5-flash | Google OAuth | **$0** |

### Routing Rules

- **Code/DevOps task?** → opencode
- **Memory/Channel/Schedule?** → Hermes Agent
- **Research/Analysis?** → Gemini CLI
- **Complex multi-step?** → Chain: Gemini researches → opencode implements → Hermes monitors/schedules

---

## 🚀 Quick Start

```bash
git clone https://github.com/modimihir07/agentic-os.git
cd agentic-os
chmod +x install.sh && ./install.sh
./start.sh
# Open http://127.0.0.1:8080
```

---

## 📋 Prerequisites

| Tool | Required? | Install |
|------|-----------|---------|
| Python 3.10+ | ✅ Required | `sudo apt install python3 python3-pip` |
| Node.js 18+ | ⚠ For opencode | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo bash - && sudo apt install -y nodejs` |
| opencode | ⚠ For code tasks | `npm install -g @opencode/cli` |
| Hermes Agent | ⚠ For memory/scheduling | `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \| bash` |
| Gemini CLI | ⚠ For Google AI | `npm install -g @google/gemini-cli` |

> ⚠ = Optional — the dashboard works with any subset of installed agents.

---

## 🔧 Configuration

### Hermes (OpenRouter)
```bash
# Set your OpenRouter API key
echo 'OPENROUTER_API_KEY=sk-or-v1-your-key-here' > ~/.hermes/.env
```

### Gemini CLI (Google OAuth)
```bash
gemini auth login
# Complete OAuth in browser — tokens saved to ~/.gemini/oauth_creds.json
```

### Dashboard Settings
Edit `data/settings.json`:
```json
{
  "dashboard": { "port": 8080 },
  "theme": "dark",
  "agents": { "opencode": true, "hermes": true, "gemini": true }
}
```

---

## 📁 Project Structure

```
agentic-os/
├── server.py              # FastAPI backend (REST API)
├── requirements.txt       # Python dependencies
├── install.sh             # One-command installer
├── start.sh               # Launch dashboard
├── backup.sh / restore.sh # Disaster recovery
│
├── dashboard/             # Web frontend (SPA)
│   ├── index.html         # Entry point + sidebar
│   ├── app.js             # SPA router + theme/sidebar toggle
│   ├── api.js             # API client (all endpoints)
│   ├── styles.css         # Full dark/light theme CSS
│   ├── utils.js           # Shared utilities
│   └── pages/             # 13 page modules
│       ├── dashboard.js   # Overview with stats
│       ├── skills.js      # Skill grid/list/detail
│       ├── memory.js      # Brain file editor
│       ├── chat.js        # Multi-agent chat
│       ├── scheduler.js   # Cron job manager
│       ├── audit.js       # Activity trail
│       ├── cost.js        # Cost analytics charts
│       ├── plugins.js     # Plugin marketplace
│       ├── backups.js     # Backup/restore UI
│       ├── prompts.js     # Template library
│       ├── standards.js   # Code conventions
│       ├── settings.js    # Config editor
│       └── setup-wizard.js  # Guided setup
│
├── brain/                 # Shared context (all agents read)
│   ├── business-brain.md  # Current project context
│   ├── memory.md          # Accumulated knowledge
│   ├── recent-decisions.md
│   ├── active-projects.md
│   ├── identity.md
│   └── constitution.md
│
├── skills/                # 16 executable skills
│   ├── devops-audit/      # GCP/CloudMart infra audit
│   ├── heartbeat/         # 5-min health check
│   ├── content-draft/     # Blog/newsletter writing
│   ├── code-review/       # PR review checklist
│   ├── research-synthesis/ # Gemini research aggregator
│   ├── daily-standup/     # Morning briefing
│   ├── meeting-minutes/   # Notes processor
│   ├── project-planner/   # Step-by-step plans
│   ├── brainstorming/     # Socratic design
│   ├── systematic-debug/  # 4-phase root cause
│   ├── memory-consolidation/ # Weekly synthesis
│   ├── backup-skill/      # Snapshot creator
│   ├── cost-analytics/    # Multi-provider cost
│   ├── tdd-cycle/         # Red-green-refactor
│   ├── goal-planner/      # Goal → steps
│   └── _template/         # Starter template
│
├── agents/                # Per-agent configs
├── scheduler/jobs/        # Cron job definitions
├── registry/              # Plugin marketplace
├── standards/             # Discover/inject conventions
├── prompts/               # 10 reusable templates
├── data/                  # Runtime data (agent-routes.json tracked; settings/cost/chat gitignored)
├── audit/                 # Activity log (gitignored)
└── backups/               # Snapshots (gitignored)
```

---

## 🎮 Usage

### AI Chat
Select an agent from the sidebar → type your message → get response.

| Agent | Best for | Example |
|-------|----------|---------|
| **opencode** | "Check system status", "Deploy to GKE" | Code + terminal automation |
| **Hermes** | "What did I work on recently?", "Schedule a daily backup" | Memory recall, scheduling |
| **Gemini** | "Research latest AI agent trends", "Analyze this image" | Web research, multi-modal |

### Skills
Browse 16 skills from Skills Hub → click Run → monitor eval scores over time.

### Scheduler
Create cron jobs: heartbeat (5 min), memory consolidation (weekly), daily standup, DevOps audit.

### Cost Analytics
Track spending per provider/model/agent. Free-tier alerts warn when nearing limits.

---

## 📊 Comparison: Agentic OS vs Claude Agent OS (Julian Goldie)

| Feature | Claude Agent OS (Video) | Agentic OS (This Project) |
|---------|------------------------|---------------------------|
| **Core Agents** | Claude + OpenClaw + Hermes | opencode + Hermes + Gemini CLI |
| **Cost** | $20/mo (Claude subscription) | **$0 — all free tiers** |
| **Stack** | Next.js + Tailwind | FastAPI + vanilla JS SPA |
| **Architecture** | 4 layers | **7 layers** |
| **Skills System** | Plugin marketplace (2,000+ from Hermes) | 16 curated skills + eval scoring + learnings |
| **Memory** | Obsidian vault (external) | Built-in brain/ + SQLite FTS5 |
| **Scheduler** | Not shown | APScheduler cron jobs |
| **Cost Tracking** | Not shown | Built-in per-provider analytics |
| **Backup/Restore** | Not shown | One-click tar.gz snapshots |
| **Audit Trail** | Not shown | Full activity log |
| **Standards System** | Not shown | Discover/inject conventions |
| **Client Timeout** | Not shown | 200s AbortController |
| **Kanban Board** | Yes | No (not needed for agent OS) |
| **Open Source** | No (tutorial only) | **MIT License** |

---

## 🧪 Tested On

- **OS**: Linux (Ubuntu 22.04+), macOS
- **Python**: 3.10, 3.11, 3.12
- **Browsers**: Chrome, Firefox, Edge
- **Agents**: opencode v0.8+, Hermes Agent v1.0+, Gemini CLI v1.0+

---

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push (`git push origin feature/amazing-feature`)
5. Open a Pull Request

See `data/agent-routes.json` for routing rules and `skills/_template/` for creating new skills.

---

## 📄 License

MIT License — free to use, modify, and distribute.

---

<div align="center">
  <p><strong>Agentic OS</strong> — Built with ❤️ by <a href="https://github.com/modimihir07">Mihir Modi</a></p>
  <p>
    <a href="https://dev.to/mihir_nmodi_14a06a4019e1/i-built-an-open-source-agent-os-2h30">📖 Read the dev.to article</a>
    ·
    <a href="https://github.com/modimihir07/agentic-os/issues">Report Bug</a>
    ·
    <a href="https://github.com/modimihir07/agentic-os/discussions">Discussions</a>
    ·
    <a href="https://github.com/modimihir07/agentic-os">GitHub</a>
  </p>
</div>
