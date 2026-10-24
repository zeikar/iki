/**
 * Re-rigs the character corpus, run by `pnpm corpus` (update) and
 * `pnpm corpus:check` (check).
 *
 * Each directory under `corpus/` with a `layers/` folder is one character,
 * rigged with the options the plugin's character artist rigs with:
 * `quantizeColors` 256, `style.json` verbatim, the whole `patches.json` list
 * and no `turnTargets`. Update mode writes the model to
 * `examples/playground/public/<name>.iki` and its metrics to
 * `corpus/<name>/metrics.json`; check mode rigs into `.corpus-check/` and
 * compares against those committed files. The rig is deterministic (two
 * processes give the same bytes), so the comparison is exact: the model by
 * hash, the metrics by deep equality.
 *
 * The rig comes from `@ikijs/mcp`'s built bundle, the same `autoRigFromLayers`
 * the `auto_rig_from_layers` tool calls. Both package commands run
 * `pnpm build` first, because that bundle inlines the engine and reads the
 * editor and format packages from their own `dist`: a stale build would rig
 * with the previous code.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { autoRigFromLayers } from "../packages/mcp/dist/index.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
// The rig tool refuses an output path outside the working directory, so the
// relative paths below (and check mode's scratch dir) are against the root.
process.chdir(rootDir);

const corpusDir = "corpus";
const demoDir = path.join("examples", "playground", "public");
const checkDir = ".corpus-check";

const mode = process.argv[2];
if (mode !== "update" && mode !== "check") {
  console.error("usage: node scripts/corpus.mjs <update|check>");
  process.exit(2);
}

const names = await characterNames();
if (mode === "check") {
  await mkdir(checkDir, { recursive: true });
}

let failed = false;

for (const name of names) {
  const outputPath = path.join(
    mode === "update" ? demoDir : checkDir,
    `${name}.iki`,
  );
  const { metrics, modelFile } = await rig(name, outputPath);
  const metricsPath = path.join(corpusDir, name, "metrics.json");

  if (mode === "update") {
    await writeFile(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    console.log(summary(name, metrics));
    continue;
  }

  const baselineFile = await readIfExists(metricsPath);
  if (baselineFile === null) {
    console.log(`${name}: CHANGED\n  no baseline, run pnpm corpus`);
    failed = true;
    continue;
  }
  const baseline = JSON.parse(baselineFile.toString());
  // Compared as update mode would write it, so an absent field and an
  // undefined one read the same.
  const now = JSON.parse(JSON.stringify(metrics));
  const demoFile = await readIfExists(path.join(demoDir, `${name}.iki`));
  const demoCurrent =
    demoFile !== null && sha256(demoFile) === baseline.modelSha256;

  const notes = diffLeaves(baseline, now, "");
  // Re-encoding the atlas (a sharp or palette change) moves the model's bytes
  // without touching the rig; the committed demo is the baseline's model.
  if (baseline.modelSha256 !== now.modelSha256 && demoCurrent) {
    notes.push(
      isDeepStrictEqual(withoutTextures(demoFile), withoutTextures(modelFile))
        ? "models equal with textures removed: an atlas-encoding drift"
        : "models differ with textures removed: a rig change",
    );
  }
  if (!demoCurrent) {
    notes.push(
      `${demoDir}/${name}.iki is ${demoFile === null ? "missing" : "stale"}, run pnpm corpus`,
    );
  }

  console.log(`${name}: ${notes.length > 0 ? "CHANGED" : "unchanged"}`);
  for (const note of notes) {
    console.log(`  ${note}`);
  }
  failed ||= notes.length > 0;
}

process.exit(failed ? 1 : 0);

async function characterNames() {
  const entries = await readdir(corpusDir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await isDirectory(path.join(corpusDir, entry.name, "layers")))
    ) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function rig(name, outputPath) {
  const characterDir = path.join(corpusDir, name);
  const layersDir = path.join(characterDir, "layers");
  const layers = (await readdir(layersDir))
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => ({ path: path.join(layersDir, file) }));
  const style = JSON.parse(
    await readFile(path.join(characterDir, "style.json"), "utf8"),
  );
  const patchesFile = await readIfExists(
    path.join(characterDir, "patches.json"),
  );
  const patches =
    patchesFile === null
      ? undefined
      : JSON.parse(patchesFile.toString()).patches;
  // A misshapen file would otherwise rig with no patches and quietly
  // re-baseline without them.
  if (patchesFile !== null && !Array.isArray(patches)) {
    throw new Error(
      `corpus/${name}/patches.json: expected { "patches": [...] }`,
    );
  }

  const result = await autoRigFromLayers({
    layers,
    outputPath,
    quantizeColors: 256,
    style,
    ...(patches === undefined ? {} : { patches }),
  });
  if (!result.ok) {
    console.error(`${name}: ${result.error}`);
    process.exit(1);
  }

  const modelFile = await readFile(result.path);
  const model = JSON.parse(modelFile.toString());
  const metrics = {
    canvas: result.canvas,
    partCount: result.partCount,
    parameterCount: model.parameters.length,
    atlasBytes: result.atlasBytes,
    modelBytes: modelFile.length,
    modelSha256: sha256(modelFile),
    turn:
      result.turn === undefined
        ? null
        : {
            achieved: result.turn.achieved,
            clamped: result.turn.clamped,
            strandOverlap: result.turn.strandOverlap ?? null,
          },
    patches: result.patches ?? null,
    folds: {
      poses: result.folds.poses,
      offenders: result.folds.offenders.map((offender) => ({
        id: offender.target.id,
        kind: offender.kind,
        ratio: offender.worst.ratio,
        pose: offender.worst.pose.name,
      })),
    },
    // Rounded so a last-ulp drift in the simulated runs cannot fail a check.
    // The idle's `at` is left out: a symmetric sway peaks equally both ways,
    // so which extreme it names is float noise.
    physics: result.physics.targets.map((target) => ({
      id:
        target.rig.kind === "chain"
          ? `${target.rig.id}/${target.rig.segment}`
          : target.rig.id,
      input: target.input,
      output: target.output,
      kind: target.kind,
      why: target.why ?? null,
      drives: target.drives.map((drive) => drive.id),
      step: {
        values: target.step.values,
        peak: round3(target.step.peak),
        at: round3(target.step.at),
        final: round3(target.step.final),
        displacementPx: round3(target.step.displacementPx),
      },
      idle: {
        peak: round3(target.idle.peak),
        displacementPx: round3(target.idle.displacementPx),
      },
    })),
    motions: Object.keys(model.motions ?? {}),
    expressions: (model.expressions ?? []).map((expression) => expression.id),
  };
  return { metrics, modelFile };
}

function summary(name, metrics) {
  const turn =
    metrics.turn === null
      ? "no turn"
      : `turn eyeShift ${metrics.turn.achieved.eyeShift.toFixed(3)} farEyeRatio ${metrics.turn.achieved.farEyeRatio.toFixed(4)} clamped ${JSON.stringify(metrics.turn.clamped)}`;
  return [
    `${name}: ${metrics.partCount} parts`,
    `${metrics.parameterCount} params`,
    `atlas ${metrics.atlasBytes} B`,
    `model ${metrics.modelBytes} B`,
    turn,
    `${metrics.patches?.length ?? 0} patches`,
    `${metrics.folds.offenders.length} fold offenders over ${metrics.folds.poses} poses`,
    `${metrics.physics.filter((target) => target.kind !== "ok").length} physics offenders of ${metrics.physics.length}`,
  ].join(", ");
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/** Every leaf that differs between `a` and `b`, as `<path>: <a> → <b>`. */
function diffLeaves(a, b, at) {
  const bothObjects =
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    Array.isArray(a) === Array.isArray(b);
  if (!bothObjects) {
    return isDeepStrictEqual(a, b)
      ? []
      : [`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`];
  }
  const keys = Array.isArray(a)
    ? Array.from({ length: Math.max(a.length, b.length) }, (_, i) => i)
    : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.flatMap((key) =>
    diffLeaves(
      a[key],
      b[key],
      Array.isArray(a) ? `${at}[${key}]` : at === "" ? key : `${at}.${key}`,
    ),
  );
}

function withoutTextures(modelFile) {
  const { textures: _textures, ...rest } = JSON.parse(modelFile.toString());
  return rest;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The file's bytes, or null when it does not exist. */
async function readIfExists(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function isDirectory(dir) {
  try {
    return (await stat(dir)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
