/**
 * Re-rigs the character corpus, run by `pnpm corpus` (update) and
 * `pnpm corpus:check` (check).
 *
 * Each directory under `corpus/` with a `layers/` folder is one character,
 * rigged with the options the plugin's character artist rigs with:
 * `quantizeColors` 256, `rig-plan.json` verbatim, the whole `patches.json` list,
 * the `custom-parts.json` entries (their layers under the character's
 * `custom/`), `bakes.json` and no `turnTargets`. A directory with a
 * `picture.png` instead is one finished picture: it is cut first, with
 * `cutLayersFromIllustration` and its `landmarks.json` (and the lip set's
 * `mouth_keyed.png` and `mouth_interior.png`), into `.corpus-check/cut/<name>/`,
 * and the cut's layers are rigged with the custom parts its landmarks declare
 * and the bakes `pictureBakes` computes. A custom-part gate line that fails
 * fails the run unless the character's `accept-gate.json` names it, with the
 * reason. Update mode writes the model to
 * `examples/playground/public/<name>.iki` (twin-tails' to `hero.iki`: it is
 * the site's hero) and its metrics to
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
import {
  autoRigFromLayers,
  cutLayersFromIllustration,
  formatCustomGate,
  probeRig,
} from "../packages/mcp/dist/index.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
// The rig tool refuses an output path outside the working directory, so the
// relative paths below (and check mode's scratch dir) are against the root.
process.chdir(rootDir);

const corpusDir = "corpus";
const demoDir = path.join("examples", "playground", "public");
// A character whose playground model goes by another name: twin-tails is the
// hero the landing page and the README GIF show.
const demoFiles = { "twin-tails": "hero.iki" };
const checkDir = ".corpus-check";
// Where a picture entry's cut and bare rig go, in both modes: scratch, never
// committed.
const cutDir = path.join(checkDir, "cut");
// The gate's limited lines, the ones an entry's `accept-gate.json` may name.
const gateLines = ["FOLDS", "TIE", "SLIDE", "EXPOSED", "RIGID"];

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
  const demoName = demoFiles[name] ?? `${name}.iki`;
  const outputPath = path.join(
    mode === "update" ? demoDir : checkDir,
    demoName,
  );
  const { metrics, modelFile, gate, acceptGate } = await rig(name, outputPath);
  const metricsPath = path.join(corpusDir, name, "metrics.json");
  // A custom part the gate refuses is a rig the loop would not accept; the
  // files are still written (update) or compared (check) so the numbers show.
  // A line the entry's `accept-gate.json` names is reported, not failed.
  if (gate !== undefined && !gate.ok) {
    console.log(`${name}: ${formatCustomGate(gate).slice(-1)[0]}`);
    // `failed` holds `<part> <LINE>` per failing line, or `gate error: …`,
    // which is never accepted.
    const lines = gate.failed.map((f) => /^\S+ (\S+)$/.exec(f)?.[1]);
    for (const [line, why] of Object.entries(acceptGate)) {
      if (lines.includes(line)) {
        console.log(`  ${line} accepted: ${why}`);
      }
    }
    failed ||= lines.some((line) => !Object.hasOwn(acceptGate, line ?? ""));
  }
  // An acceptance that nothing needs any more is noise that would hide the
  // next failure of that line: say so, so the file is trimmed.
  const failing = new Set(
    (gate?.failed ?? []).map((f) => /^\S+ (\S+)$/.exec(f)?.[1]),
  );
  for (const line of Object.keys(acceptGate)) {
    if (!failing.has(line)) {
      console.log(
        `${name}: accept-gate.json accepts ${line}, which no part fails now: remove it`,
      );
    }
  }

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
  const demoFile = await readIfExists(path.join(demoDir, demoName));
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
      `${demoDir}/${demoName} is ${demoFile === null ? "missing" : "stale"}, run pnpm corpus`,
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
      ((await isDirectory(path.join(corpusDir, entry.name, "layers"))) ||
        (await isFile(path.join(corpusDir, entry.name, "picture.png"))))
    ) {
      names.push(entry.name);
    }
  }
  return names.sort();
}

async function rig(name, outputPath) {
  const characterDir = path.join(corpusDir, name);
  const rigPlan = JSON.parse(
    await readFile(path.join(characterDir, "rig-plan.json"), "utf8"),
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

  const acceptFile = await readIfExists(
    path.join(characterDir, "accept-gate.json"),
  );
  const acceptGate =
    acceptFile === null ? {} : JSON.parse(acceptFile.toString()).acceptGate;
  // A misspelt line would accept nothing and fail the run; an empty reason
  // would accept a failure no one explained.
  if (
    acceptFile !== null &&
    (acceptGate === null ||
      typeof acceptGate !== "object" ||
      Array.isArray(acceptGate) ||
      !Object.entries(acceptGate).every(
        ([line, why]) =>
          gateLines.includes(line) && typeof why === "string" && why !== "",
      ))
  ) {
    throw new Error(
      `corpus/${name}/accept-gate.json: expected { "acceptGate": { <${gateLines.join("|")}>: "<why>" } }`,
    );
  }

  const picture = path.join(characterDir, "picture.png");
  const { layers, customParts, bakes, cut } = (await isFile(picture))
    ? await pictureInputs(name, characterDir, picture, rigPlan)
    : await layeredInputs(name, characterDir);

  const result = await autoRigFromLayers({
    layers,
    outputPath,
    quantizeColors: 256,
    rigPlan,
    ...(patches === undefined ? {} : { patches }),
    ...(customParts === undefined ? {} : { customParts }),
    ...(bakes === undefined ? {} : { bakes }),
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
            // Absent, not null, without a side lock: the other characters'
            // metrics stay as committed. Report-only numbers, tracked so a
            // later slice can design bounds from them.
            ...(result.turn.hairSide === undefined
              ? {}
              : { hairSide: result.turn.hairSide }),
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
    // Only a character with custom parts has the key, so the others' metrics
    // stay as committed.
    ...(result.customParts === undefined
      ? {}
      : { customParts: customPartMetrics(result.customParts.gate) }),
    // Only a picture entry has the key: what guards the cut on real art.
    ...(cut === undefined ? {} : { cut: cutMetrics(cut) }),
  };
  return { metrics, modelFile, gate: result.customParts?.gate, acceptGate };
}

/** A layered entry's rig inputs: its committed layers, custom parts and bakes. */
async function layeredInputs(name, characterDir) {
  const layersDir = path.join(characterDir, "layers");
  const layers = (await readdir(layersDir))
    .filter((file) => file.endsWith(".png"))
    .sort()
    .map((file) => ({ path: path.join(layersDir, file) }));
  const customFile = await readIfExists(
    path.join(characterDir, "custom-parts.json"),
  );
  const customEntries =
    customFile === null
      ? undefined
      : JSON.parse(customFile.toString()).customParts;
  if (
    customFile !== null &&
    (!Array.isArray(customEntries) ||
      !customEntries.every(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.file === "string",
      ))
  ) {
    throw new Error(
      `corpus/${name}/custom-parts.json: expected { "customParts": [{ "file": ..., ...}] }`,
    );
  }
  const customParts = customEntries?.map(({ file, ...entry }) => ({
    ...entry,
    path: path.join(characterDir, "custom", file),
  }));
  const bakesFile = await readIfExists(path.join(characterDir, "bakes.json"));
  const bakes =
    bakesFile === null ? undefined : JSON.parse(bakesFile.toString()).bakes;
  if (
    bakesFile !== null &&
    (bakes === null || typeof bakes !== "object" || Array.isArray(bakes))
  ) {
    throw new Error(`corpus/${name}/bakes.json: expected { "bakes": {...} }`);
  }

  return { layers, customParts, bakes };
}

/**
 * A picture entry's rig inputs: the picture cut into layers in place, the
 * custom parts its landmarks declare (each hung from `hair_back` at its tie),
 * and their bakes from `pictureBakes`. A cut that fails stops the run: there
 * is nothing to rig. `part.box` is `[x0, y0, x1, y1]`, both corners inside.
 */
async function pictureInputs(name, characterDir, picture, rigPlan) {
  const scratch = path.join(cutDir, name);
  await mkdir(scratch, { recursive: true });
  const mouth = {};
  for (const [key, file] of [
    ["mouthKeyed", "mouth_keyed.png"],
    ["mouthInterior", "mouth_interior.png"],
  ]) {
    if (await isFile(path.join(characterDir, file))) {
      mouth[key] = path.join(characterDir, file);
    }
  }
  const cut = await cutLayersFromIllustration({
    imagePath: picture,
    landmarks: JSON.parse(
      await readFile(path.join(characterDir, "landmarks.json"), "utf8"),
    ),
    outputDir: scratch,
    ...mouth,
  });
  if (!cut.ok) {
    console.error(`${name}: ${cut.error}`);
    process.exit(1);
  }
  if (!cut.passed) {
    console.error(
      `${name}: cut failed: ${cut.checks
        .filter((c) => !c.pass && c.level === "fail")
        .map((c) => c.id)
        .join(", ")}`,
    );
    process.exit(1);
  }
  const layers = cut.layers.map((layer) => ({ path: layer.path }));
  const customParts = cut.customParts.map((part) => ({
    id: part.id,
    path: part.path,
    anchor: "hair_back",
    tie: part.tie,
    after: "hair_back",
  }));
  const bakes =
    customParts.length === 0
      ? undefined
      : await pictureBakes(
          name,
          path.join(scratch, "bare.iki"),
          { layers, quantizeColors: 256, rigPlan, customParts },
          cut.customParts.map((part) => part.box[3] - part.box[1] + 1),
        );
  return { layers, customParts, bakes, cut };
}

/**
 * The tails' bakes, computed rather than kept as data: the recipe is a few
 * lines and the picture is the input. Each part hangs from its knot: on every
 * ParamAngleX, ParamAngleY and ParamAngleZ stop, all 14 points of its 1x6
 * lattice take `hair_back`'s displacement at its tie, read with `probeRig` on
 * a bare rig (so it stays plumb on a roll); on ParamHairBackSway it takes the
 * same plus a sideways swing growing with the square of the row's depth, a
 * thirtieth of the part's height at the tip. This is the bake the plugin's
 * `iki-import-illustration` skill gives users (its Step 8, "The bake").
 */
async function pictureBakes(name, barePath, rigInput, heights) {
  const parts = rigInput.customParts;
  const bare = await autoRigFromLayers({ ...rigInput, outputPath: barePath });
  if (!bare.ok) {
    console.error(`${name}: bare rig: ${bare.error}`);
    process.exit(1);
  }
  const stops = [
    ["ParamAngleX", [-30, -15, 15, 30]],
    ["ParamAngleY", [-30, -15, 15, 30]],
    ["ParamAngleZ", [-30, -20, -10, 10, 20, 30]],
    ["ParamHairBackSway", [-20, 20]],
  ];
  const queries = stops.flatMap(([param, values]) =>
    values.map((value) => ({
      op: "displacement",
      part: "hair_back",
      points: parts.map((part) => part.tie),
      pose: { [param]: value },
    })),
  );
  const probe = await probeRig({ modelPath: barePath, queries });
  if (!probe.ok) {
    console.error(`${name}: probe: ${probe.error}`);
    process.exit(1);
  }
  const rows = 6;
  const targets = [];
  let q = 0;
  for (const [param, values] of stops) {
    const atStop = values.map(() => probe.results[q++].points);
    parts.forEach((part, k) => {
      const lattice = (value, [dx, dy]) =>
        Array.from({ length: 2 * (rows + 1) }, (_, i) => {
          const depth = Math.floor(i / 2) / rows;
          const swing =
            param === "ParamHairBackSway"
              ? (value / 20) * (heights[k] / 30) * depth ** 2
              : 0;
          return [Math.round((dx + swing) * 1000) / 1000, dy];
        });
      targets.push({
        id: `${part.id}-${param}`,
        param,
        parts: [part.id],
        grid: { cols: 1, rows },
        stops: Object.fromEntries(
          values.map((value, v) => {
            const at = atStop[v][k];
            if (at === null) {
              throw new Error(
                `corpus/${name}: ${part.id}'s tie is off hair_back at ${param} ${value}`,
              );
            }
            return [String(value), lattice(value, at)];
          }),
        ),
      });
    });
  }
  return { targets };
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
  return value === null ? null : Math.round(value * 1000) / 1000;
}

/** The cut's verdict and each check by its id (so a diff names the check),
 *  values to four significant digits: they run from fractions of a percent
 *  to pixel counts. */
function cutMetrics(cut) {
  return {
    passed: cut.passed,
    checks: Object.fromEntries(
      cut.checks.map((check) => [
        check.id,
        {
          level: check.level,
          pass: check.pass,
          value:
            check.value === null ? null : Number(check.value.toPrecision(4)),
        },
      ]),
    ),
  };
}

/** The gate's verdict and each part's worst readings, rounded like the physics numbers. */
function customPartMetrics(gate) {
  return {
    ok: gate.ok,
    poses: gate.poses,
    parts: gate.parts.map((part) => ({
      id: part.id,
      ok: part.ok,
      folds: { ratio: round3(part.folds.ratio), pose: part.folds.pose },
      tiePx: round3(part.tie.px),
      slide: {
        px: round3(part.slide.slide.px),
        onAnchorPx: round3(part.slide.onAnchor.px),
      },
      exposed: {
        hiddenPx: part.exposed.hiddenPx,
        noTurnPx2: round3(part.exposed.noTurn.px2),
        turningPx2: round3(part.exposed.turning?.px2 ?? null),
      },
      ...(part.rigid === undefined ? {} : { rigidPx: round3(part.rigid.px) }),
      ...(part.hidden === undefined
        ? {}
        : {
            hidden: {
              atRest: round3(part.hidden.atRest),
              leftOut: part.hidden.leftOut,
            },
          }),
      tip: part.tip.map((tip) => ({
        param: tip.param,
        fromBare: tip.ends.map((end) => round3(end.fromBare)),
        travel: round3(tip.travel),
      })),
    })),
  };
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

async function isFile(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
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
