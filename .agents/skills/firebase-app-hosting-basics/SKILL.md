---
name: firebase-app-hosting-basics
description: Deploy and manage web apps with Firebase App Hosting. Use this skill when deploying Next.js/Angular apps with backends.
---

# App Hosting Basics

## Description

This skill enables the agent to deploy and manage modern, full-stack web
applications (Next.js, Angular, etc.) using Firebase App Hosting.

**Important**: In order to use App Hosting, your Firebase project must be on the
Blaze pricing plan. Direct the user to
https://console.firebase.google.com/project/_/overview?purchaseBillingPlan=metered
to upgrade their plan.

## Hosting vs App Hosting

**Choose Firebase Hosting if:**

- You are deploying a static site (HTML/CSS/JS).
- You are deploying a simple SPA (React, Vue, etc. without SSR).
- You want full control over the build and deploy process via CLI.

**Choose Firebase App Hosting if:**

- You are using a supported full-stack framework like Next.js or Angular.
- You need Server-Side Rendering (SSR) or ISR.
- You want an automated "git push to deploy" workflow with zero configuration.

## Deploying to App Hosting

### Deploy from Source

This is the recommended flow for most users.

1. Configure `firebase.json` with an `apphosting` block.
   ```json
   {
     "apphosting": {
       "backendId": "my-app-id",
       "rootDir": "/",
       "ignore": [
         "node_modules",
         ".git",
         "firebase-debug.log",
         "firebase-debug.*.log",
         "functions"
       ]
     }
   }
   ```
1. Create or edit `apphosting.yaml`- see
   [Configuration](references/configuration.md) for more information on how to
   do so.
1. If the app needs safe access to sensitive keys, use
   `npx -y firebase-tools@latest apphosting:secrets` commands to set and grant
   access to secrets.
1. Run `npx -y firebase-tools@latest deploy` when you are ready to deploy.

### Automated deployment via GitHub (CI/CD)

Alternatively, set up a backend connected to a GitHub repository for automated
deployments "git push" deployments. This is only recommended for more advanced
users, and is not required to use App Hosting. See
[CLI Commands](references/cli_commands.md) for more information on how to set
this up using CLI commands.

## Emulation

See [Emulation](references/emulation.md) for more information on how to test
your app locally using the Firebase Local Emulator Suite.

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
