import {
  HairChainMotion,
  IdleMotion,
  IkiPlayer,
  PhysicsMotion,
} from "@ikijs/engine";
import { parseIkiModel } from "@ikijs/format";
import { sampleModel } from "./sample-model";

const canvas = document.getElementById("iki") as HTMLCanvasElement;
const controls = document.getElementById("controls") as HTMLDivElement;
const panel = controls.parentElement!;

const player = new IkiPlayer(canvas);
// start() may be called any time, but nothing renders until the first load()
// resolves. load() swaps the model atomically — you never see a partial frame.
player.start();

// One slider per parameter, kept in a registry so the dev API can mirror
// programmatic parameter changes back into the UI.
const slidersById = new Map<
  string,
  { slider: HTMLInputElement; readout: HTMLSpanElement }
>();

// The most recently loaded parsed model — startIdle reads its `physics` rigs and
// `parameters` (descriptors) to construct the PhysicsMotion driver.
let parsedModel: ReturnType<typeof parseIkiModel> | undefined;

// Single write path: sets the value on the player, then syncs slider + readout
// from what the engine actually stored. Used by the slider handlers, the idle
// loop, the physics loop, and the dev setParam API.
function mirrorParam(id: string, value: number): void {
  player.setParameter(id, value);
  // Read back rather than re-deriving the clamp: the engine owns the range
  // (and drops non-finite writes), so this is the one value guaranteed in sync.
  const v = player.getParameter(id);
  const ui = slidersById.get(id);
  if (ui) {
    ui.slider.value = String(v);
    ui.readout.textContent = Number(ui.slider.value).toFixed(2);
  }
}

// Build one slider per parameter. A real host (Charivo's render adapter) drives
// these same ids from lip-sync RMS, gaze, blink timers, and expressions.
function buildControls(): void {
  controls.replaceChildren();
  slidersById.clear();
  for (const param of player.getParameters()) {
    const wrap = document.createElement("div");
    wrap.className = "control";

    const def = player.getParameter(param.id);
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = param.name ?? param.id;
    const readout = document.createElement("span");
    readout.textContent = def.toFixed(2);
    label.append(name, readout);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(param.min);
    slider.max = String(param.max);
    slider.step = String((param.max - param.min) / 100);
    slider.value = String(def);
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      // Route through mirrorParam so the readout tracks the engine's clamp.
      mirrorParam(param.id, value);
    });

    wrap.append(label, slider);
    controls.append(wrap);
    slidersById.set(param.id, { slider, readout });
  }
}

// --- Idle motion loop ----------------------------------------------------------

let idleRafId: number | undefined;

function startIdle(): void {
  // Idempotent: do nothing if already running.
  if (idleRafId !== undefined) return;

  // Construct fresh instances each start so the first update always establishes
  // a clean time base (no leftover prevNowMs from a prior run). PhysicsMotion is
  // a peer driver of IdleMotion: it reads the live pose straight off the player
  // and writes its output through the same mirrorParam sink. An empty rig list
  // (model without physics) is a harmless no-op.
  const idle = new IdleMotion(mirrorParam);
  const physics = new PhysicsMotion(
    parsedModel?.physics ?? [],
    parsedModel?.parameters ?? [],
    (id) => player.getParameter(id),
    mirrorParam,
  );
  // Peer driver for multi-segment hair chains: self-computes its anchor's world
  // rotation from the deformers + current params, so it only needs the same
  // read/sink. Empty physicsChains is a harmless no-op.
  const chains = new HairChainMotion(
    parsedModel?.physicsChains ?? [],
    parsedModel?.parameters ?? [],
    parsedModel?.deformers ?? [],
    (id) => player.getParameter(id),
    mirrorParam,
  );

  function frame(): void {
    // One clock read per frame keeps both drivers' dt in lockstep. Physics runs
    // right AFTER idle; both write params via mirrorParam, and the player renders
    // the updated params on its OWN render loop (drivers/rendering decoupled,
    // exactly like IdleMotion today — there is no same-frame render guarantee).
    const now = performance.now();
    idle.update(now);
    physics.update(now);
    chains.update(now);
    idleRafId = requestAnimationFrame(frame);
  }
  idleRafId = requestAnimationFrame(frame);
}

function stopIdle(): void {
  if (idleRafId !== undefined) {
    cancelAnimationFrame(idleRafId);
    idleRafId = undefined;
  }
}

// Build the "Idle" toggle once, outside buildControls(), so it survives every
// slider rebuild. Inserted as a sibling of #controls inside #panel.
const idleRow = document.createElement("div");
idleRow.className = "control";
const idleLabel = document.createElement("label");
const idleLabelText = document.createElement("span");
idleLabelText.textContent = "Idle";
const idleCheckbox = document.createElement("input");
idleCheckbox.type = "checkbox";
idleCheckbox.checked = true;
idleCheckbox.addEventListener("change", () => {
  if (idleCheckbox.checked) startIdle();
  else stopIdle();
});
idleLabel.append(idleLabelText, idleCheckbox);
idleRow.append(idleLabel);
panel.insertBefore(idleRow, controls);

// Model picker for the vector sample and generated characters in public/.
// Built once, like the Idle row, so it survives the per-model control rebuilds.
const modelRow = document.createElement("div");
modelRow.className = "control";
const modelLabel = document.createElement("label");
const modelLabelText = document.createElement("span");
modelLabelText.textContent = "Model";
const modelSelect = document.createElement("select");
for (const [value, text] of [
  ["vector", "Vector sample"],
  ["textured", "Textured sample"],
  ["hero", "Hero character"],
] as const) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = text;
  modelSelect.append(opt);
}
modelSelect.addEventListener("change", () => {
  void switchModel(modelSelect.value);
});
modelLabel.append(modelLabelText, modelSelect);
modelRow.append(modelLabel);
panel.insertBefore(modelRow, controls);

// Monotonic token so a slow fetch can't clobber a newer selection: only the
// most recent switchModel call is allowed to load and restart the drivers.
let modelSwitchSeq = 0;
// The picker value of the model actually loaded — the failure path rolls the
// select back to this so the UI never claims a model that didn't load.
let loadedModelValue = "vector";

async function switchModel(which: string): Promise<void> {
  const seq = ++modelSwitchSeq;
  try {
    let raw: unknown = sampleModel;
    if (which === "textured" || which === "hero") {
      // BASE_URL-relative: these live in public/, so under a GitHub Pages
      // sub-path build the fetch must carry the same base as the page.
      const res = await fetch(
        `${import.meta.env.BASE_URL}${
          which === "hero" ? "hero.iki" : "textured-sample.iki"
        }`,
      );
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      raw = await res.json();
    }
    if (seq !== modelSwitchSeq) return; // superseded while fetching
    await loadModel(raw);
    if (seq !== modelSwitchSeq) return; // superseded while loading
    loadedModelValue = which;
    // Reconstruct the idle/physics drivers against the new model's rigs.
    if (idleCheckbox.checked) {
      stopIdle();
      startIdle();
    }
  } catch (err) {
    // Keep the current model on a failed switch; the console explains why.
    console.error("Iki: model switch failed", err);
    if (seq === modelSwitchSeq) modelSelect.value = loadedModelValue;
  }
}

// Validate the model through the format parser — a real host does this for any
// untrusted .iki source. IkiFormatError is thrown here if the model is malformed.
// load() resolves to a report of any textures that failed to decode/upload; the
// rest of the model still renders. Controls are rebuilt against whatever
// parameters the loaded model declares.
async function loadModel(rawModel: unknown): Promise<void> {
  const parsed = parseIkiModel(rawModel);
  const { failedTextures, superseded } = await player.load(parsed);
  // A newer load() overtook this one, so the player never adopted `parsed`.
  // Adopting it here anyway would point the driver model at something that is
  // not on screen and rebuild the sliders from the wrong descriptors.
  if (superseded) return;
  parsedModel = parsed;
  buildControls();
  if (failedTextures.length > 0) {
    console.warn(
      `Iki: ${failedTextures.length} texture(s) failed to load`,
      failedTextures,
    );
  }
}

await loadModel(sampleModel);

// Checkbox is on by default; start the idle loop after the first model load.
startIdle();

// Dev-only injection API for Playwright visual tests (see
// .claude/skills/iki-visual-test). Stripped from production builds: in a vite
// build `import.meta.env.DEV` is false, so window.__iki is never attached.
if (import.meta.env.DEV) {
  // Stop the idle loop (and reflect that in the checkbox) so Playwright callers
  // get a deterministic frame — idle rAF would overwrite setParam/reset results
  // before nextFrame() settles. Human-facing default-on behavior is unchanged.
  function pauseIdleForDevOp(): void {
    stopIdle();
    idleCheckbox.checked = false;
  }

  window.__iki = {
    player,
    getParams: () => player.getParameters(),
    setParam: (id: string, value: number) => {
      pauseIdleForDevOp();
      mirrorParam(id, value);
    },
    reset: () => {
      pauseIdleForDevOp();
      for (const param of player.getParameters())
        mirrorParam(param.id, param.default);
    },
    load: (rawModel: unknown) => {
      pauseIdleForDevOp();
      return loadModel(rawModel);
    },
    nextFrame: () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  };
}
