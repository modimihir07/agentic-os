# Operational Notes

## Server Debugging
- Logs: `tail -f /tmp/agentic-os.log`
- If browser shows blank dashboard, check for a single failing API endpoint crashing the SPA
- Malformed JSON in `audit.log` can crash `/api/audit` — the server skips bad lines but check if it's persistent

## WSL → Windows Browser
- Server-side 500 errors can look like connection failures from Windows browser
- WSL2 loopback and Windows loopback are separate interfaces — use `127.0.0.1` from WSL, not `localhost` from Windows

## Hermes Config
- Config: `~/.hermes/config.yaml`
- API keys: `~/.hermes/.env`
- Current model: `qwen/qwen3-next-80b-a3b-instruct:free` (OpenRouter)
- Fallbacks: gpt-oss-120b:free → gemma-4-31b-it:free → nemotron-3-super-120b:free
- Change model: `hermes config set model.default <model-id>`

## Agentic OS Docs
- Full docs: `docs/README.md`
- Changelog: `CHANGELOG.md`
- After API changes: `python3 scripts/update-api-docs.py`
- Skill: `software-development/agentic-os-docs`

## Brain Guardian Cron
- Job ID: `68221afb4d45`
- Runs every 2h via Hermes cron
- Outputs: brain/health-report.md, brain/skill-usage.md, brain/github-activity.md
