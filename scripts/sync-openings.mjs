// Regenerates src/openings-data.js from the web repo's lib/openings/eco-top50.ts
// so the bundled opening data never drifts. Run: npm run sync-openings
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, "../../../lib/openings/eco-top50.ts");
const { ECO_TOP_50 } = await import(source);

const rows = ECO_TOP_50.map((o) => ({
  eco: o.eco,
  name: o.name,
  slug: o.slug,
  moves: o.moves,
  startingFen: o.startingFen,
  description: o.description,
}));

const header =
  "// GENERATED from lib/openings/eco-top50.ts by scripts/sync-openings.mjs — do not edit by hand.\n";
const out = path.join(here, "../src/openings-data.js");
fs.writeFileSync(out, header + "export const OPENINGS = " + JSON.stringify(rows, null, 1) + ";\n");
console.log("wrote", rows.length, "openings to", path.relative(process.cwd(), out));
