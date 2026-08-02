---
name: firebase-hosting-basics
description: Skill for working with Firebase Hosting (Classic). Use this when you want to deploy static web apps, Single Page Apps (SPAs), or simple microservices. Do NOT use for Firebase App Hosting.
---

# hosting-basics

This skill provides instructions and references for working with Firebase
Hosting, a fast and secure hosting service for your web app, static and dynamic
content, and microservices.

## Overview

Firebase Hosting provides production-grade web content hosting for developers.
With a single command, you can deploy web apps and serve both static and dynamic
content to a global CDN (content delivery network).

**Key Features:**

- **Fast Content Delivery:** Files are cached on SSDs at CDN edges around the
  world.
- **Secure by Default:** Zero-configuration SSL is built-in.
- **Preview Channels:** View and test changes on temporary preview URLs before
  deploying live.
- **GitHub Integration:** Automate previews and deploys with GitHub Actions.
- **Dynamic Content:** Serve dynamic content and microservices using Cloud
  Functions or Cloud Run.

## Hosting vs App Hosting

**Choose Firebase Hosting if:**

- You are deploying a static site (HTML/CSS/JS).
- You are deploying a simple SPA (React, Vue, etc. without SSR).
- You want full control over the build and deploy process via CLI.

**Choose Firebase App Hosting if:**

- You are using a supported full-stack framework like Next.js or Angular.
- You need Server-Side Rendering (SSR) or ISR.
- You want an automated "git push to deploy" workflow with zero configuration.

## Instructions

### 1. Configuration (`firebase.json`)

For details on configuring Hosting behavior, including public directories,
redirects, rewrites, and headers, see
[configuration.md](references/configuration.md).

### 2. Deploying

For instructions on deploying your site, using preview channels, and managing
releases, see [deploying.md](references/deploying.md).

### 3. Emulation

To test your app locally:

```bash
npx -y firebase-tools@latest emulators:start --only hosting
```

This serves your app at `http://localhost:5000` by default.

<!-- SELF-EVOLVE:START -->
## Self-Evolution & Proactivity (injected)

Zone of Initiative — calibrated autonomy:
- Low stakes + reversible: ACT (e.g. draft a file, set a var).
- High stakes + reversible: ACT, then report immediately.
- High stakes + irreversible: STOP and ASK via `clarify`.
- Reversibility is the throttle, not stakes alone.

Three loops keep skills alive:
- Capture: after a task of 5+ tool calls or a reusable discovery, write/refine a skill.
- Heal: after a failure or correction that reflects a reusable procedure, patch the skill that caused it (remove the old wording, don't layer advice).
- Decay: on a schedule, prune duplicated/stale/no-op skills so they get sharper, not longer.

Memory vs Skill: a FACT (path, name, API quirk, repo URL) -> memory. a PROCEDURE (how to do X) -> skill. One-off preference -> memory/inline. Reusable correction -> skill patch.

For opencode (code/devops/file-ops):
- Capture: a build/test fix pattern, a refactor recipe, or an infra quirk -> skill.
- Heal: a bad refactor or failed deploy -> patch the responsible skill, then re-run to confirm.
- Decay: stale scripts, dead flags, duplicated helpers. Install dep / run safe refactor = reversible; force-push / drop DB / prod deploy = ask.
- Route research to Gemini, memory/channels to Hermes.

Goal: become faster, smarter, more efficient, more knowledgeable, more thoughtful, and proactively autonomous — never less safe.
A high-stakes irreversible action (delete data, ship to prod, send a message on the user's behalf) always goes through `clarify`. Reversible, low-stakes actions may proceed, then be reported in the same turn.
<!-- SELF-EVOLVE:END -->
