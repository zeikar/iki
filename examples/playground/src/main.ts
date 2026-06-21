import { IdleMotion, IkiPlayer, PhysicsMotion } from "@iki/engine";
import { parseIkiModel } from "@iki/format";
import { sampleModel } from "./sample-model";

const canvas = document.getElementById("iki") as HTMLCanvasElement;
const controls = document.getElementById("controls") as HTMLDivElement;
const panel = controls.parentElement!;

// Engine-effective default: ParameterStore clamps an out-of-range default into
// range, and PhysicsMotion rests around that same clamped value — so the host
// mirror + sliders must use it too, not the raw declared default.
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const effectiveDefault = (p: { min: number; max: number; default: number }) =>
  clamp(p.default, p.min, p.max);

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

// Host-side mirror of the current value of every parameter. PhysicsMotion reads
// its input from here (it has no access to the player's private ParameterStore),
// so EVERY write must flow through mirrorParam to keep this fresh.
const current: Record<string, number> = {};

// The most recently loaded parsed model — startIdle reads its `physics` rigs and
// `parameters` (descriptors) to construct the PhysicsMotion driver.
let parsedModel: ReturnType<typeof parseIkiModel> | undefined;

// Single mirror path: writes the value to the player AND syncs slider + readout
// AND the host-side `current` mirror. Used by the slider handlers, the idle
// loop, the physics loop, and the dev setParam API.
function mirrorParam(id: string, value: number): void {
  player.setParameter(id, value);
  current[id] = value;
  const ui = slidersById.get(id);
  if (ui) {
    // Clamp to the slider's range exactly as the <input> clamps it.
    ui.slider.value = String(value);
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

    const def = effectiveDefault(param);
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
      // Route through mirrorParam so `current` stays fresh — otherwise the
      // physics driver never sees a ParamAngleX drag and the hair won't sway.
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
  // a peer driver of IdleMotion: it reads its input from the host-side `current`
  // mirror and writes its output through the same mirrorParam sink. An empty rig
  // list (model without physics) is a harmless no-op.
  const idle = new IdleMotion(mirrorParam);
  const physics = new PhysicsMotion(
    parsedModel?.physics ?? [],
    parsedModel?.parameters ?? [],
    (id) => current[id] ?? 0,
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

// Validate the model through the format parser — a real host does this for any
// untrusted .iki source. IkiFormatError is thrown here if the model is malformed.
// load() resolves to a report of any textures that failed to decode/upload; the
// rest of the model still renders. Controls are rebuilt against whatever
// parameters the loaded model declares.
async function loadModel(rawModel: unknown): Promise<void> {
  const parsed = parseIkiModel(rawModel);
  parsedModel = parsed;
  // Seed the host-side current-value mirror from the engine-effective (clamped)
  // defaults so the physics driver reads the same rest values ParameterStore
  // holds — before the first slider/idle write.
  for (const p of parsed.parameters) current[p.id] = effectiveDefault(p);
  const { failedTextures } = await player.load(parsed);
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
