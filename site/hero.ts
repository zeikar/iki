/**
 * The landing page's live hero: the model the playground opens, played by the
 * engine over the still render, its head and eyes following the mouse. The
 * still stays whenever this cannot run — reduced motion, no WebGL2, a failed
 * fetch or texture — so the page never shows an empty frame.
 */
import { IkiMotion, IkiPlayer } from "@ikijs/engine";
import {
  StandardParameter,
  parseIkiModel,
  type IkiParameter,
} from "@ikijs/format";

// Full pointer deflection turns the head this many degrees. Short of the ±30
// limit so the idle sway still shows on top — Charivo's render-iki host uses
// the same headroom.
const HEAD_RANGE_DEG = 26;
// Where the face sits in the model canvas, as fractions of its size. The
// pointer is measured from here, so the character looks at the cursor rather
// than at the canvas centre.
const FACE = { x: 0.5, y: 0.44 };
// Seconds to cover ~63% of the way to a new target: the eyes snap to the
// cursor and the head follows, which is what reads as looking at it.
const EYE_EASE_S = 0.08;
const HEAD_EASE_S = 0.3;

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

  // Eased toward the pointer while it is on the page and back to rest when it
  // leaves; `eyeWeight` hands the eyes from the idle drift to the cursor.
  const head: Gaze = { x: 0, y: 0 };
  const eyes: Gaze = { x: 0, y: 0 };
  let eyeWeight = 0;

  // The blend runs in the sink, before the player, so the hair springs lag
  // the turned head rather than the idle one.
  const motion = new IkiMotion(
    model,
    (id) => player.getParameter(id),
    (id, value) => player.setParameter(id, blend(id, value)),
  );
  function blend(id: string, value: number): number {
    switch (id) {
      case StandardParameter.AngleX:
        return value + HEAD_RANGE_DEG * head.x;
      case StandardParameter.AngleY:
        return value + HEAD_RANGE_DEG * head.y;
      case StandardParameter.EyeballX:
        return value + (eyes.x - value) * eyeWeight;
      case StandardParameter.EyeballY:
        return value + (eyes.y - value) * eyeWeight;
      default:
        return value;
    }
  }

  // The panel under the hero says its values produced the frame above, so it
  // reads the live pose while the live hero shows; the still brings back its own.
  const rows = paramRows(model.parameters);

  let last = performance.now();
  let rafId = 0;
  function frame(now: number): void {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const target = pointer ? gazeAt(pointer) : { x: 0, y: 0 };
    ease(head, target, HEAD_EASE_S, dt);
    ease(eyes, target, EYE_EASE_S, dt);
    eyeWeight += ((pointer ? 1 : 0) - eyeWeight) * easeStep(EYE_EASE_S, dt);
    motion.update(now);
    for (const row of rows) showValue(row, player.getParameter(row.param.id));
    rafId = requestAnimationFrame(frame);
  }

  function resume(): void {
    last = performance.now();
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

function ease(value: Gaze, target: Gaze, seconds: number, dt: number): void {
  const k = easeStep(seconds, dt);
  value.x += (target.x - value.x) * k;
  value.y += (target.y - value.y) * k;
}

function easeStep(seconds: number, dt: number): number {
  return 1 - Math.exp(-dt / seconds);
}

function clamp(v: number): number {
  return Math.min(1, Math.max(-1, v));
}
