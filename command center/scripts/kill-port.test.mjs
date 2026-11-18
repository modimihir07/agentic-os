// Run: node --test scripts/   (or: npm run test:scripts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorts, parseNetstatListeners, parseLsofPids, killablePids } from "./kill-port.mjs";

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100
  TCP    127.0.0.1:1420         0.0.0.0:0              LISTENING       5001
  TCP    127.0.0.1:1420         127.0.0.1:53000        ESTABLISHED     5001
  TCP    127.0.0.1:53000        127.0.0.1:1420         ESTABLISHED     7777
  TCP    0.0.0.0:14200          0.0.0.0:0              LISTENING       6000
  TCP    [::1]:1420             [::]:0                 LISTENING       5002
  TCP    [::]:1421              [::]:0                 ABHÖREN         5003
  TCP    0.0.0.0:1421           0.0.0.0:0              LISTENING       0
  UDP    0.0.0.0:1420           *:*                                    9999
`;

test("netstat: LISTENING tcp + tcpv6 rows on the exact port", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 1420).sort(), [5001, 5002]);
});

test("netstat: localised state recognised via wildcard foreign address; pid 0 dropped", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 1421), [5003]);
});

test("netstat: no match for free port and suffix collisions", () => {
  assert.deepEqual(parseNetstatListeners(NETSTAT, 420), []);
  assert.deepEqual(parseNetstatListeners("", 1420), []);
});

test("lsof pid parsing", () => {
  assert.deepEqual(parseLsofPids("123\n456\n123\n\n"), [123, 456]);
  assert.deepEqual(parseLsofPids(""), []);
});

test("never kills self, parent, or system pids", () => {
  assert.deepEqual(killablePids([4, 10, 11, 12, 0], 10, 11), [12]);
});

test("port args", () => {
  assert.deepEqual(parsePorts([]), [1420]);
  assert.deepEqual(parsePorts(["1420", "1421", "1420", "abc", "70000"]), [1420, 1421]);
});
