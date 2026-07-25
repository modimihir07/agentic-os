# Active Projects

## Agentic OS (Current)
- Status: Building Phase 1
- Priority: HIGH
- Building complete agent orchestration platform
- 8 phases planned

## Kitchen-Inventory (Active)
- Status: In development — catering kitchen management system
- Deployed on antigravity (server/host)
- Key features: invoice scanner (AI vision), barcode scanner, shelf life tracker, vendor invoice parsing
- Pipeline: Invoice image → pre-process → Gemini vision (primary) → GPT-5.5 (backup) → vendor detection → Claude (text→JSON) → math audit → Firebase write
- Vendor invoices: Sysco, Vern's, US Foods (each with custom prompts)
- Shelf scans: photo → Gemini → JSON array of items
- Code under review: geminiService.ts has 18 issues (4 critical) — wrong shelf prompt in GPT fallback, analyzeImage ignores prompt, no shelf retries, bad model names, bare catches

## Pendelton-comms-live (Active)
- Status: In development — real-time voice communication app for catering events
- Purpose: Walkie talkie for employees spread out at big catering events
- GitHub: https://github.com/Linecheck-store/Pendelton-comms-live (private)
- Last worked on: 2026-02-28
- Tech: Node.js + Express + Socket.IO signaling, React + TypeScript frontend
- Audio: WebRTC peer-to-peer, STUN/TURN configured
- Deployed on Railway
- Known issues: audio cutting out on mobile Safari, reconnection logic needs improvement

- [Ship Agentic OS v1](goal:c24b3d85) — Complete audit and fix all issues

- [Push everything in the Kanban board down the line](goal:2c4b22ac) — It involves different skills to get different things done.
