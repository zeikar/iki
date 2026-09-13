#!/usr/bin/env node
// decode-renders.cjs — decode a `{ pose: dataUrl }` capture into PNG files.
//
// The turn pair is captured via `canvas.toDataURL("image/png")` from
// `window.__iki`, not a screenshot: a screenshot carries the page under the
// canvas, and `measure_turn_reference` needs the render's OWN transparency
// to tell foreground from background. The `browser_evaluate` call that
// produces this JSON writes its result file to the CURRENT WORKING
// DIRECTORY (the repo root when the loop runs from a checkout), not
// `.playwright-mcp/` — move it here first. The value can also be
// double-encoded (a JSON string containing the real JSON); this script
// unwraps that automatically.
//
// Usage: node decode-renders.cjs <captures.json> <outDir>
// Writes <outDir>/<pose>.png for each key and prints each path written.

const fs = require("node:fs");
const path = require("node:path");

const die = (msg) => {
  console.error(`[error] ${msg}`);
  process.exit(1);
};

const [file, outDir] = process.argv.slice(2);
if (!file || !outDir) {
  console.error("usage: node decode-renders.cjs <captures.json> <outDir>");
  process.exit(1);
}

try {
  let captures = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof captures === "string") captures = JSON.parse(captures);

  fs.mkdirSync(outDir, { recursive: true });

  for (const [pose, dataUrl] of Object.entries(captures)) {
    const match =
      typeof dataUrl === "string" &&
      dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!match) {
      console.error(`${pose}: not a PNG data URL`);
      process.exit(1);
    }
    const outPath = path.join(outDir, `${pose}.png`);
    fs.writeFileSync(outPath, Buffer.from(match[1], "base64"));
    console.log(outPath);
  }
} catch (err) {
  die(err.message);
}
