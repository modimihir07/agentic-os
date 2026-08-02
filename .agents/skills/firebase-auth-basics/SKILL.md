---
name: firebase-auth-basics
description: Guide for setting up and using Firebase Authentication. Use this skill when the user's app requires user sign-in, user management, or secure data access using auth rules.
compatibility: This skill is best used with the Firebase CLI, but does not require it. Firebase CLI can be accessed through `npx -y firebase-tools@latest`.
---

## Prerequisites

- **Firebase Project**: Created via
  `npx -y firebase-tools@latest projects:create` (see `firebase-basics`).
- **Firebase CLI**: Installed and logged in (see `firebase-basics`).

## Core Concepts

Firebase Authentication provides backend services, easy-to-use SDKs, and
ready-made UI libraries to authenticate users to your app.

### Users

A user is an entity that can sign in to your app. Each user is identified by a
unique ID (`uid`) which is guaranteed to be unique across all providers. User
properties include:

- `uid`: Unique identifier.
- `email`: User's email address (if available).
- `displayName`: User's display name (if available).
- `photoURL`: URL to user's photo (if available).
- `emailVerified`: Boolean indicating if the email is verified.

### Identity Providers

Firebase Auth supports multiple ways to sign in:

- **Email/Password**: Basic email and password authentication.
- **Federated Identity Providers**: Google, Facebook, Twitter, GitHub,
  Microsoft, Apple, etc.
- **Phone Number**: SMS-based authentication.
- **Anonymous**: Temporary guest accounts that can be linked to permanent
  accounts later.
- **Custom Auth**: Integrate with your existing auth system.

Google Sign In is recommended as a good and secure default provider.

### Tokens

When a user signs in, they receive an ID Token (JWT). This token is used to
identify the user when making requests to Firebase services (Realtime Database,
Cloud Storage, Firestore) or your own backend.

- **ID Token**: Short-lived (1 hour), verifies identity.
- **Refresh Token**: Long-lived, used to get new ID tokens.

## Workflow

### 1. Provisioning

#### Option 1. Enabling Authentication via CLI

Only Google Sign In, anonymous auth, and email/password auth can be enabled via
CLI. For other providers, use the Firebase Console.

Configure Firebase Authentication in `firebase.json` by adding an 'auth' block:

```
{
  "auth": {
    "providers": {
      "anonymous": true,
      "emailPassword": true,
      "googleSignIn": {
        "oAuthBrandDisplayName": "Your Brand Name",
        "supportEmail": "support@example.com",
        "authorizedRedirectUris": ["https://example.com", "http://localhost"]
      }
    }
  }
}
```

> [!NOTE] If the Google Sign-In popup opens and immediately closes with the
> error `[firebase_auth/unauthorized-domain]`, it means the domain is not
> authorized. For local development, ensure `localhost` is included in the
> **Authorized Domains** list in the Firebase Console or via the
> `authorizedDomains` field in `firebase.json`. **CRITICAL**: Do NOT include the
> protocol or port number in the Authorized Domains list (e.g., use `localhost`,
> NOT `http://localhost:9090`).

**CRITICAL**: After configuring `firebase.json`, you MUST deploy the auth
configuration to the Firebase backend for the changes to take effect. This is
essential for auth providers like Google Sign-In, email/password, etc. to
auto-generate the necessary OAuth clients for your app platforms. Run:

```bash
npx -y firebase-tools@latest deploy --only auth
```

#### Option 2. Enabling Authentication in Console

Enable other providers in the Firebase Console.

1. Go to the
   https://console.firebase.google.com/project/_/authentication/providers
1. Select your project.
1. Enable the desired Sign-in providers (e.g., Email/Password, Google).

### 2. Client Setup & Usage

**Web** See [references/client_sdk_web.md](references/client_sdk_web.md).

**Flutter** See [references/flutter_setup.md](references/flutter_setup.md).
**Android (Kotlin)** See
[references/client_sdk_android.md](references/client_sdk_android.md).

### 3. Security Rules

Secure your data using `request.auth` in Firestore/Storage rules.

See [references/security_rules.md](references/security_rules.md).

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
