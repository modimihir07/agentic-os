#!/usr/bin/env python3
"""
Agentic-OS :: Agent Time Analyzer
-----------------------------------
Derives total time AI agents spent on the project from event logs.

The agentic-os project does NOT store explicit per-session durations,
so we estimate total agent time with a session-gap model:

  * Every logged event (audit.log line, chat message, cost entry) is a
    timestamped touch by an agent.
  * A "session" for an agent = a maximal run of touches where each touch
    is within GAP seconds of the previous one.
  * Session duration = (last touch - first touch) + TAIL.
    TAIL accounts for the agent working after its last logged event
    (e.g. finishing a task, writing files, thinking).

This is an ESTIMATE, clearly labeled as such in the dashboard.

Tunable: GAP (default 30 min), TAIL (default 2 min).
"""
import json
import os
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIT_LOG = os.path.join(ROOT, "audit", "audit.log")
CHAT_HISTORY = os.path.join(ROOT, "data", "chat-history.json")
COST_HISTORY = os.path.join(ROOT, "data", "cost-history.json")
OUT = os.path.join(ROOT, "data", "agent-time.json")

GAP_SECONDS = int(os.environ.get("AGENT_TIME_GAP", "1800"))      # 30 min
TAIL_SECONDS = int(os.environ.get("AGENT_TIME_TAIL", "120"))    # 2 min


def parse_ts(s):
    if not s:
        return None
    try:
        # normalize Z -> +00:00
        s = s.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def load_audit_events():
    """Read audit.log (JSON lines). Returns list of (ts, agent)."""
    events = []
    if not os.path.exists(AUDIT_LOG):
        return events
    with open(AUDIT_LOG, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            ts = parse_ts(rec.get("timestamp"))
            if ts is None:
                continue
            agent = rec.get("agent") or "system"
            events.append((ts, agent))
    return events


def load_json_file(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def load_chat_events():
    events = []
    data = load_json_file(CHAT_HISTORY)
    if not data:
        return events
    for m in data.get("messages", []):
        ts = parse_ts(m.get("timestamp"))
        if ts is None:
            continue
        agent = m.get("agent") or "unknown"
        events.append((ts, agent))
    return events


def load_cost_events():
    events = []
    data = load_json_file(COST_HISTORY)
    if not data:
        return events
    for e in data.get("entries", []):
        ts = parse_ts(e.get("timestamp"))
        if ts is None:
            continue
        agent = e.get("agent") or "unknown"
        events.append((ts, agent))
    return events


def compute_sessions(events):
    """Group (ts, agent) events into per-agent sessions via gap model."""
    by_agent = {}
    for ts, agent in events:
        by_agent.setdefault(agent, []).append(ts)

    per_agent = {}
    for agent, times in by_agent.items():
        times.sort()
        sessions = []
        cur_start = times[0]
        cur_last = times[0]
        for t in times[1:]:
            if (t - cur_last).total_seconds() <= GAP_SECONDS:
                cur_last = t
            else:
                sessions.append((cur_start, cur_last))
                cur_start = t
                cur_last = t
        sessions.append((cur_start, cur_last))
        total = sum(((last - start).total_seconds() + TAIL_SECONDS) for start, last in sessions)
        per_agent[agent] = {
            "sessions": len(sessions),
            "touches": len(times),
            "total_seconds": int(total),
            "first_seen": times[0].isoformat(),
            "last_seen": times[-1].isoformat(),
        }
    return per_agent


def fmt_hms(seconds):
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h}h {m}m {s}s"


def main():
    events = []
    events += load_audit_events()
    events += load_chat_events()
    events += load_cost_events()

    if not events:
        print("No events found.", file=sys.stderr)
        out = {
            "project": "agentic-os",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "method": "session-gap estimate",
            "gap_seconds": GAP_SECONDS,
            "tail_seconds": TAIL_SECONDS,
            "total_seconds": 0,
            "total_human": "0h 0m 0s",
            "agents": {},
            "event_count": 0,
            "first_seen": None,
            "last_seen": None,
        }
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2)
        print(json.dumps(out, indent=2))
        return

    events.sort(key=lambda x: x[0])
    per_agent = compute_sessions(events)
    total = sum(a["total_seconds"] for a in per_agent.values())

    # graphify metadata (best-effort)
    graph_meta = {}
    gpath = os.path.join(ROOT, "graphify-out", "graph.json")
    if os.path.exists(gpath):
        try:
            with open(gpath, "r", encoding="utf-8") as f:
                gj = json.load(f)
            nodes = gj.get("nodes", [])
            edges = gj.get("links", []) or gj.get("edges", [])
            graph_meta = {
                "nodes": len(nodes) if hasattr(nodes, "__len__") else "?",
                "edges": len(edges) if hasattr(edges, "__len__") else "?",
            }
            # count communities
            comms = set()
            for n in nodes:
                c = n.get("community")
                if c is not None:
                    comms.add(c)
            graph_meta["communities"] = len(comms)
            graph_meta["file"] = "graphify-out/graph.json"
        except Exception:
            pass

    out = {
        "project": "agentic-os",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "method": "session-gap estimate (GAP=%ds, TAIL=%ds)" % (GAP_SECONDS, TAIL_SECONDS),
        "graph": graph_meta,
        "gap_seconds": GAP_SECONDS,
        "tail_seconds": TAIL_SECONDS,
        "total_seconds": total,
        "total_human": fmt_hms(total),
        "agents": per_agent,
        "event_count": len(events),
        "first_seen": events[0][0].isoformat(),
        "last_seen": events[-1][0].isoformat(),
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)
    print("Wrote", OUT)
    print("TOTAL:", out["total_human"], "across", len(per_agent), "agents,", len(events), "events")
    for agent, a in sorted(per_agent.items(), key=lambda kv: -kv[1]["total_seconds"]):
        print(f"  {agent:12s} {fmt_hms(a['total_seconds']):>14s}  sessions={a['sessions']:<4d} touches={a['touches']}")


if __name__ == "__main__":
    main()
