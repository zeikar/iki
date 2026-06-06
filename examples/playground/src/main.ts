import { IkiPlayer } from "@iki/engine";
import { parseIkiModel } from "@iki/format";
import { sampleModel } from "./sample-model";

const canvas = document.getElementById("iki") as HTMLCanvasElement;
const controls = document.getElementById("controls") as HTMLDivElement;

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

// Dev-only injection API for Playwright visual tests (see
// .claude/skills/iki-visual-test). Stripped from production builds: in a vite
// build `import.meta.env.DEV` is false, so window.__iki is never attached.
if (import.meta.env.DEV) {
  const setParam = (id: string, value: number): void => {
    player.setParameter(id, value);
    const ui = slidersById.get(id);
    if (ui) {
      // Mirror into the slider so the UI (and screenshots) reflect the value,
      // clamped to the slider's range exactly as the <input> clamps it.
      ui.slider.value = String(value);
      ui.readout.textContent = Number(ui.slider.value).toFixed(2);
    }
  };
  window.__iki = {
    player,
    getParams: () => player.getParameters(),
    setParam,
    reset: () => {
      for (const param of player.getParameters())
        setParam(param.id, param.default);
    },
    load: (rawModel: unknown) => loadModel(rawModel),
    nextFrame: () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  };
}
