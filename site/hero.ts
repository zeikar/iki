/**
 * The landing page's live hero: the model the playground opens, played by the
 * engine over the still render. The eyes go to the mouse and the head follows
 * through the engine's idle (setGazeTarget). The still stays whenever this
 * cannot run — reduced motion, no WebGL2, a failed fetch or texture — so the
 * page never shows an empty frame.
 */
import { IkiMotion, IkiPlayer } from "@ikijs/engine";
import { parseIkiModel, type IkiParameter } from "@ikijs/format";

// Where the face sits in the model canvas, as fractions of its size. The
// pointer is measured from here, so the character looks at the cursor rather
// than at the canvas centre.
const FACE = { x: 0.5, y: 0.44 };

interface Gaze {
  x: number;
  y: number;
}

/** One row of the parameter panel under the hero, and the still's value in it. */
interface ParamRow {
  el: HTMLElement;
  val: Element;
  param: IkiParameter;
  stillP: string;
  stillText: string;
}

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const figure = document.querySelector<HTMLElement>(".hero figure");
if (figure) {
  const launch = (): void => {
    start(figure).catch((err: unknown) => {
      console.error("Iki: the live hero failed, keeping the still", err);
    });
  };
  if (!reducedMotion.matches) launch();
  else {
    // Nothing is fetched under reduced motion until the visitor turns it off.
    const onChange = (): void => {
      if (reducedMotion.matches) return;
      reducedMotion.removeEventListener("change", onChange);
      launch();
    };
    reducedMotion.addEventListener("change", onChange);
  }
}

async function start(figure: HTMLElement): Promise<void> {
  const canvas = document.createElement("canvas");
  // The still's alt text already describes the character.
  canvas.setAttribute("aria-hidden", "true");
  figure.append(canvas);
  try {
    await play(figure, canvas);
  } catch (err) {
    canvas.remove();
    throw err;
  }
}

async function play(
  figure: HTMLElement,
  canvas: HTMLCanvasElement,
): Promise<void> {
  // The playground build serves the hero model beside its own page.
  const res = await fetch("playground/hero.iki");
  if (!res.ok) throw new Error(`hero.iki: HTTP ${res.status}`);
  const model = parseIkiModel(await res.json());
  const player = new IkiPlayer(canvas);
  try {
    const { failedTextures } = await player.load(model);
    // A partly textured character is worse than the still it would replace.
    if (failedTextures.length > 0) {
      throw new Error(`${failedTextures.length} texture(s) failed to load`);
    }
  } catch (err) {
    player.destroy();
    throw err;
  }

  let pointer: { x: number; y: number } | undefined;
  document.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse") pointer = { x: e.clientX, y: e.clientY };
  });
  document.documentElement.addEventListener("mouseleave", () => {
    pointer = undefined;
  });

  // Recomputed every frame from the canvas's current box, so scrolling keeps
  // the gaze on a cursor that has not moved.
  function gazeAt(p: { x: number; y: number }): Gaze {
    const rect = canvas.getBoundingClientRect();
    const dx = p.x - (rect.left + rect.width * FACE.x);
    const dy = rect.top + rect.height * FACE.y - p.y;
    return {
      x: clamp(dx / (innerWidth / 2)),
      y: clamp(dy / (innerHeight / 2)),
    };
  }

  const motion = new IkiMotion(
    model,
    (id) => player.getParameter(id),
    (id, value) => player.setParameter(id, value),
  );

  // The panel under the hero says its values produced the frame above, so it
  // reads the live pose while the live hero shows; the still brings back its own.
  const rows = paramRows(model.parameters);

  let rafId = 0;
  function frame(now: number): void {
    if (pointer) {
      const g = gazeAt(pointer);
      motion.setGazeTarget(g.x, g.y);
    } else motion.clearGazeTarget();
    motion.update(now);
    // From the moment the canvas starts fading in over the still.
    if (figure.classList.contains("is-live")) {
      for (const row of rows) showValue(row, player.getParameter(row.param.id));
    }
    rafId = requestAnimationFrame(frame);
  }

  function resume(): void {
    // Registered before start() so each pose lands in the frame it is computed.
    rafId = requestAnimationFrame(frame);
    player.start();
    // Reveal once a frame has painted, so the swap never shows a blank canvas.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!reducedMotion.matches) figure.classList.add("is-live");
      }),
    );
  }

  function pause(): void {
    cancelAnimationFrame(rafId);
    player.stop();
    figure.classList.remove("is-live");
    for (const row of rows) {
      row.el.style.setProperty("--p", row.stillP);
      row.val.textContent = row.stillText;
    }
  }

  // Reduced motion turned on mid-visit hands the frame back to the still.
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) pause();
    else resume();
  });
  if (!reducedMotion.matches) resume();
}

function paramRows(params: readonly IkiParameter[]): ParamRow[] {
  const byId = new Map(params.map((p) => [p.id, p]));
  const rows: ParamRow[] = [];
  for (const el of document.querySelectorAll<HTMLElement>(".param")) {
    const param = byId.get(el.querySelector(".id")?.textContent ?? "");
    const val = el.querySelector(".val");
    // A row the model does not declare keeps the still's value.
    if (!param || !val) continue;
    rows.push({
      el,
      val,
      param,
      stillP: el.style.getPropertyValue("--p"),
      stillText: val.textContent ?? "",
    });
  }
  return rows;
}

function showValue(row: ParamRow, value: number): void {
  const { min, max } = row.param;
  const p = ((value - min) / (max - min)) * 100;
  row.el.style.setProperty("--p", `${p.toFixed(1)}%`);
  // Two decimals with a true minus sign, as the page's still values are set.
  const digits = Math.abs(value).toFixed(2);
  row.val.textContent = value < 0 && digits !== "0.00" ? `−${digits}` : digits;
}

function clamp(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
