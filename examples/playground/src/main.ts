import { IdleMotion, IkiPlayer } from "@iki/engine";
import { parseIkiModel } from "@iki/format";
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

// Single mirror path: writes the value to the player AND syncs slider + readout.
// Used by both the idle loop and the dev setParam API.
function mirrorParam(id: string, value: number): void {
  player.setParameter(id, value);
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

    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = param.name ?? param.id;
    const readout = document.createElement("span");
    readout.textContent = param.default.toFixed(2);
    label.append(name, readout);

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = String(param.min);
    slider.max = String(param.max);
    slider.step = String((param.max - param.min) / 100);
    slider.value = String(param.default);
    slider.addEventListener("input", () => {
      const value = Number(slider.value);
      player.setParameter(param.id, value);
      readout.textContent = value.toFixed(2);
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

  // Construct a fresh instance each start so the first update always
  // establishes a clean time base (no leftover prevNowMs from a prior run).
  const idle = new IdleMotion(mirrorParam);

  function frame(): void {
    idle.update(performance.now());
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
  window.__iki = {
    player,
    getParams: () => player.getParameters(),
    setParam: mirrorParam,
    reset: () => {
      for (const param of player.getParameters())
        mirrorParam(param.id, param.default);
    },
    load: (rawModel: unknown) => loadModel(rawModel),
    nextFrame: () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  };
}
