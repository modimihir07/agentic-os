import { it } from "vitest";
import { writeFileSync } from "node:fs";
import * as H from "./holo-geometry";
import * as B from "./e46-body";

it("dump", () => {
  const w = H.e46Wireframe();
  writeFileSync(
    "C:/Users/nicho/AppData/Local/Temp/claude/5c24697b0373cc22/9d6851da-3c2b-4105-8776-21872b819875/scratchpad/e46_wire.json",
    JSON.stringify({ base: w.base, cyan: w.cyan, amber: w.amber, halo: w.halo, inner: w.inner, outline: B.sideOutline(), glass: B.sideGlass() }),
  );
});
