import { it } from "vitest";
import * as B from "./e46-body";
import * as H from "./holo-geometry";
const f3 = (n: number) => n.toFixed(3);
it("probe", () => {
  const xs = [-2.17, -2.1, -2.0, -1.9, -1.8, -1.6, -1.0, 0, 0.3, 0.6, 1.0, 1.4, 1.7, 1.8, 2.1, 2.15];
  console.log("crown", xs.map((x) => `${x}:${f3(B.crownY(x))}`).join(" "));
  console.log("a", xs.map((x) => `${x}:${f3(B.frameAt(x).a)}`).join(" "));
  console.log("rearX", [0.3, 0.5, 0.6, 0.7, 0.81, 0.86, 0.91, 0.98, 1.03, 1.1, 1.2, 1.29, 1.365].map((y) => `${y}:${f3(B.faceProfileX("rear", y))}`).join(" "));
  const cap = B.frameAt(B.X_TAIL);
  console.log("cap rear", f3(cap.yTop), f3(cap.yEdge), f3(cap.a), "front", JSON.stringify(B.frameAt(B.X_NOSE)));
  const g = B.sideGlass();
  console.log("quarter", JSON.stringify(g.quarter.slice(-6).map(([x, y]) => [f3(x), f3(y)])));
  console.log("plate", JSON.stringify(H.rearPlate()));
  console.log("gateHW", [-2.17, -2.1, -2.0, -1.9, -1.87].map((x) => f3(B.gateHW(x))).join(" "));
  for (const v of H.ZONE_VOLUMES) console.log(v.zone, B.insideBody(v.anchor), f3(B.crownY(v.anchor[0])));
  const w = H.e46Wireframe();
  let my = 0, mr = 0;
  for (const L of [w.base, w.cyan, w.amber, w.halo ?? []]) for (let i = 0; i < L.length; i += 3) { my = Math.max(my, L[i + 1]); mr = Math.max(mr, Math.hypot(L[i], L[i + 2])); }
  console.log("maxY", f3(my), "maxR", f3(mr));
});
