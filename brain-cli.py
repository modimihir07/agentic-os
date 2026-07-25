#!/usr/bin/env python3
"""CLI for the Agentic OS centralized brain.

Usage:
  python brain-cli.py ingest                 # (re)build the unified index
  python brain-cli.py stats                 # show per-source doc counts
  python brain-cli.py search "your query"   # full-text search
  python brain-cli.py search "query" --source chat --limit 5

The index lives at brain-core/brain_index.db (SQLite + FTS5, no deps).
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "brain-core"))
import brain_index as bi


def main():
    p = argparse.ArgumentParser(description="Agentic OS centralized brain CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("ingest", help="(re)build the unified index from all sources")
    sub.add_parser("stats", help="show per-source document counts")

    sp = sub.add_parser("search", help="full-text search the brain")
    sp.add_argument("query", help="search terms")
    sp.add_argument("--source", help="filter: brain | skill-learning | chat")
    sp.add_argument("--limit", type=int, default=20)

    args = p.parse_args()
    conn = bi.get_conn()

    if args.cmd == "ingest":
        summary = bi.ingest_all(conn)
        conn.commit()
        print("Ingested:", summary)
        print("Total docs:", bi.stats(conn)["total"])
    elif args.cmd == "stats":
        print(bi.stats(conn))
    elif args.cmd == "search":
        hits = bi.search(conn, args.query, limit=args.limit, source=args.source)
        if not hits:
            print("No results.")
            return
        for h in hits:
            src = h["source"]
            agent = f" (agent={h['agent']})" if h.get("agent") else ""
            print(f"[{src}]{agent} {h['title']}")
            print("   ", h["snippet"][:200])
        print(f"\n{len(hits)} result(s).")


if __name__ == "__main__":
    main()
