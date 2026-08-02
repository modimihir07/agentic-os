---
name: research-synthesis
description: Web research and synthesis using Gemini CLI
version: 1.0.0
author: Agentic OS
tags: [research, analysis, web, synthesis]
---

# Research Synthesis

## Description
Performs multi-source web research on a topic, synthesizes findings into a structured report with citations, key insights, and actionable recommendations.

## When to Use
- Investigating a new technology
- Competitive analysis
- Learning a new topic
- Market research
- Technical deep-dive

## Process
1. Define research scope and questions
2. Search web via Gemini CLI for multiple sources
3. Extract key findings per source
4. Cross-reference and validate
5. Synthesize into structured report
6. Add citations and source metadata

## Output
Research report with sections: summary, findings, sources, recommendations

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

For Gemini (research/analysis/multi-modal):
- Capture: a research recipe, source-selection rule, or doc-analysis pattern -> skill.
- Heal: a wrong source or a weak synthesis -> patch the skill so it doesn't repeat.
- Decay: outdated findings, dead reference links, duplicate research skills. Publish or post an external result = ask.
- Route coding to opencode, memory to Hermes.

Goal: become faster, smarter, more efficient, more knowledgeable, more thoughtful, and proactively autonomous — never less safe.
A high-stakes irreversible action (delete data, ship to prod, send a message on the user's behalf) always goes through `clarify`. Reversible, low-stakes actions may proceed, then be reported in the same turn.
<!-- SELF-EVOLVE:END -->

## Agent Assignment
- Primary: gemini
- Fallback: opencode (for formatting only)
