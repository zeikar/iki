import { IkiPlayer } from "@iki/engine";
import { sampleModel } from "./sample-model";

const canvas = document.getElementById("iki") as HTMLCanvasElement;
const controls = document.getElementById("controls") as HTMLDivElement;

const player = new IkiPlayer(canvas);
// start() may be called any time, but nothing renders until the first load()
// resolves. load() swaps the model atomically — you never see a partial frame.
player.start();
// load() resolves to a report of any textures that failed to decode/upload;
// the rest of the model still renders. A real host would surface this.
const { failedTextures } = await player.load(sampleModel);
if (failedTextures.length > 0) {
  console.warn(
    `Iki: ${failedTextures.length} texture(s) failed to load`,
    failedTextures,
  );
}

// Build one slider per parameter. A real host (Charivo's render adapter) drives
// these same ids from lip-sync RMS, gaze, blink timers, and expressions.
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
}
