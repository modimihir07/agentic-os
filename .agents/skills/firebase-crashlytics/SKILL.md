---
name: firebase-crashlytics
description: Comprehensive guide for Firebase Crashlytics, including provisioning and SDK usage. Use this skill when the user needs help setting up Crashlytics, adding crash reporting, or using the Crashlytics SDK in their application.
compatibility: This skill is best used with the Firebase CLI, but does not require it. Firebase CLI can be accessed through `npx -y firebase-tools@latest`.
---

# Crashlytics

This skill provides a complete guide for getting started with Crashlytics on
Android or iOS. Crash data collected from client applications can be read using
the MCP server in the Firebase CLI.

## Prerequisites

Provisioning Crashlytics requires both a Firebase project and a Firebase app,
either Android or iOS. To read the data collected by Crashlytics, install the
MCP server in the Firebase CLI. See the `firebase-basics` skill for references.

## SDK Setup

To learn how to setup Crashlytics in your application code, choose your
platform:

- **Android**: [android_setup.md](references/android_setup.md)
- **iOS**: [ios_setup.md](references/ios_setup.md)

## SDK Usage

The SDK provides a number of features to make crash reports more actionable.

- Add custom keys
- Add custom logs
- Set user identifiers
- Report non-fatal exceptions

To learn how to customize crash reports and add additional debugging data,
consult the documentation for your platform.

- **Android**:
  [Customize Crash Reports for Android](https://firebase.google.com/docs/crashlytics/android/customize-crash-reports.md)
- **iOS**:
  [Customize Crash Reports for Apple Platforms](https://firebase.google.com/docs/crashlytics/ios/customize-crash-reports.md)

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
