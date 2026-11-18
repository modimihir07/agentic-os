#!/usr/bin/env node
// Frees dev ports before Vite starts (vite.config.ts uses strictPort: true, so an
// orphaned Vite/node process on 1420 would otherwise make `npm run dev` and
// `tauri dev` fail with "Port 1420 is already in use").
//
// Usage: node scripts/kill-port.mjs [port ...]   (default: 1420)
// Node built-ins only. Never kills its own pid or its parent's. Always exits 0.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_PORTS = [1420];
// Windows pseudo-processes that can show up as owners of a socket; never touch them.
const PROTECTED_PIDS = new Set([0, 4]);

/** Parse CLI args into a de-duplicated list of valid TCP ports. */
export function parsePorts(args) {
  const ports = [];
  for (const a of args) {
    const n = Number(String(a).trim());
    if (Number.isInteger(n) && n > 0 && n < 65536 && !ports.includes(n)) ports.push(n);
  }
  return ports.length ? ports : [...DEFAULT_PORTS];
}

/**
 * From `netstat -ano` output (Windows), return the PIDs of TCP / TCPv6 sockets
 * LISTENING on `port`. The local address must end in `:<port>` exactly (so
 * 14200 never matches 1420). The state column is localised on non-English
 * Windows, so a row whose foreign address is the wildcard `*:0` also counts.
 */
export function parseNetstatListeners(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    const [, local, foreign, state, pidCol] = cols;
    if (!local.endsWith(`:${port}`)) continue;
    const listening = state.toUpperCase() === "LISTENING" || /^(0\.0\.0\.0|\[::\]|\*):0$/.test(foreign);
    if (!listening) continue;
    const pid = Number(pidCol);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Parse `lsof -t` output (one pid per line). */
export function parseLsofPids(output) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (line.trim() && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** Drop pids that must never be killed: this script, its parent, OS pseudo-processes. */
export function killablePids(pids, self = process.pid, parent = process.ppid) {
  return pids.filter((p) => p !== self && p !== parent && !PROTECTED_PIDS.has(p));
}

function run(file, args) {
  try {
    return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  } catch (e) {
    // lsof exits 1 when nothing matches; its stdout (if any) is still useful.
    return typeof e?.stdout === "string" ? e.stdout : "";
  }
}

function listeners(port) {
  if (process.platform === "win32") return parseNetstatListeners(run("netstat", ["-ano"]), port);
  return parseLsofPids(run("lsof", ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]));
}

function kill(pid) {
  if (process.platform === "win32") {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    process.kill(pid, "SIGKILL");
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const ports = parsePorts(process.argv.slice(2));
  for (const port of ports) {
    const found = listeners(port);
    const targets = killablePids(found);
    if (!found.length) continue;
    if (!targets.length) {
      console.log(`[kill-port] port ${port} is held by this process tree or a system process; leaving it alone`);
      continue;
    }
    for (const pid of targets) {
      try {
        kill(pid);
        console.log(`[kill-port] killed pid ${pid} listening on port ${port}`);
      } catch (e) {
        console.log(`[kill-port] could not kill pid ${pid} on port ${port}: ${e?.message ?? e}`);
      }
    }
    // Give the OS a moment to release the socket so Vite's strictPort check passes.
    for (let i = 0; i < 20 && killablePids(listeners(port)).length; i++) await sleep(100);
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main()
    .catch((e) => console.log(`[kill-port] skipped: ${e?.message ?? e}`))
    .finally(() => process.exit(0));
}
