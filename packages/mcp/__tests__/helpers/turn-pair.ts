import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { headHalfOf } from "../../src/measure-turn";

/**
 * Synthetic front/turned image pairs for the head-turn measurement: real
 * painted pixels, because every step of the detector (the iris hue window, the
 * blob close, the two foreground modes) is an assertion about pixels.
 *
 * A view is a skin ellipse head with two iris ellipses on it, so its geometry
 * is known in advance from the {@link ViewSpec} that produced it and a test can
 * predict every ratio. {@link SKEWED_FRONT}/{@link SKEWED_TURNED} deliberately
 * make all three ratios non-degenerate — the front has a resting iris asymmetry
 * and an off-centre pair, the turned head is genuinely narrower — so a
 * measurement that dropped the front normalisation or flipped an operand would
 * come out with different numbers instead of the same ones.
 *
 * It lives in helpers/ so server.test.ts can drive the same pair through the
 * MCP server, the way helpers/parts.ts serves the composer tests.
 */

type RGB = [number, number, number];
type SetPixel = (x: number, y: number, rgb: RGB) => void;

/** The flat backdrop of the reference art: hue 240, low sat, bright. */
const LAVENDER: RGB = [226, 226, 240];
/** Hue 25, sat 0.25 — outside both iris windows below. */
const SKIN: RGB = [240, 205, 180];
/** Inside the default iris window: hue 253, sat 0.70, v 0.78. */
const VIOLET: RGB = [90, 60, 200];
/** Hue 38, sat 0.83 — the default window misses it entirely. */
const AMBER: RGB = [230, 160, 40];
/** Near-black: v 0.02, under the keyed mode's black floor. */
const INK: RGB = [5, 5, 6];

/** The window `amberIrises` needs; its satMin also keeps the skin out. */
export const AMBER_IRIS = { hueMin: 20, hueMax: 60, satMin: 0.5 };

const SIZE = 400;
const HEAD_CX = 200;
const HEAD_CY = 200;
const HEAD_H = 300;
/** The head both views of the plain pair share. */
const HEAD_W = 240;
const EYE_ROW = 170;
/** Half the iris separation, so a pair sits dx=80 apart (20% of SIZE). */
const EYE_DX = 40;
const IRIS_H = 30;
export const IRIS_W = 30;
/** The turned far eye of the plain pair, narrowed the way a real one is. */
export const FAR_IRIS_W = 20;
/** Plain-pair slide: 0.22 of the head half-width, the reference's eyeShift. */
export const PAIR_SHIFT = 26;
/** Near-black hair straddling the head edges, at the eye row. */
export const HAIR_LEFT = 60;
export const HAIR_RIGHT = 339;

/** One painted view: a head of `headW`, sitting `headOffset` px off the image
 *  centre, with two irises `pairOffset` px off THAT head's centre (negative =
 *  toward the image's left). */
export interface ViewSpec {
  headW: number;
  headOffset: number;
  /** Iris widths, image-left then image-right. */
  irisLW: number;
  irisRW: number;
  pairOffset: number;
  /** Iris height, both eyes. Defaults to `IRIS_H` — set it to paint a view at
   *  a different scale than its pair, since a yaw never changes this. */
  irisH?: number;
}

export const PLAIN_FRONT: ViewSpec = {
  headW: HEAD_W,
  headOffset: 0,
  irisLW: IRIS_W,
  irisRW: IRIS_W,
  pairOffset: 0,
};
const PLAIN_TURNED: ViewSpec = {
  headW: HEAD_W,
  headOffset: 0,
  irisLW: FAR_IRIS_W,
  irisRW: IRIS_W,
  pairOffset: -PAIR_SHIFT,
};

/** A resting asymmetry (the left iris is half again the right one) and a pair
 *  that already sits right of the head's centre. */
export const SKEWED_FRONT: ViewSpec = {
  headW: 240,
  headOffset: 0,
  irisLW: 36,
  irisRW: 24,
  pairOffset: 12,
};
/** Turned left: the left (far) iris narrows, the head narrows too — and the
 *  whole head sits left of where the front one did, so a shift measured
 *  against the FRONT head's centre reads differently from one measured against
 *  each image's own. */
export const SKEWED_TURNED: ViewSpec = {
  headW: 200,
  headOffset: -10,
  irisLW: 18,
  irisRW: 24,
  pairOffset: -30,
};

/**
 * The head span the detector's eye-row band measures for `spec`'s head. The
 * band is ±10 rows around the eye row, which sits ABOVE the ellipse's centre,
 * so its widest row is the lowest one.
 */
export function headSpanFor(spec: ViewSpec): {
  left: number;
  right: number;
  half: number;
} {
  const v = (EYE_ROW + 10 + 0.5 - HEAD_CY) / (HEAD_H / 2);
  const halfWidth = (spec.headW / 2) * Math.sqrt(1 - v * v);
  const cx = HEAD_CX + spec.headOffset;
  // A pixel is painted when its centre is inside the ellipse.
  const left = Math.ceil(cx - halfWidth - 0.5);
  const right = Math.floor(cx + halfWidth - 0.5);
  // Halved through the measurement's own helper, so the expectation follows the
  // span convention rather than restating it.
  return { left, right, half: headHalfOf({ left, right }) };
}

export interface TurnPairOptions {
  /** Engine-render mode: a transparent backdrop instead of the flat lavender. */
  transparent?: boolean;
  /** Near-black hair blocks straddling the head edges at the eye row. */
  hair?: boolean;
  /** Near-black frame around the whole image — the keyed mode must drop it. */
  border?: boolean;
  /** Leave the irises out, so no pair can be found. */
  noIrises?: boolean;
  /** Paint the irises amber, which only a custom `iris` window finds. */
  amberIrises?: boolean;
  /** Plain white backdrop instead of the flat lavender the keyed rule looks
   *  for — an un-keyed (or wrongly keyed) reference, not an engine render. */
  wrongBackdrop?: boolean;
}

function ellipse(
  set: SetPixel,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rgb: RGB,
): void {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const u = (x + 0.5 - cx) / (w / 2);
      const v = (y + 0.5 - cy) / (h / 2);
      if (u * u + v * v <= 1) set(x, y, rgb);
    }
  }
}

function rect(
  set: SetPixel,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: RGB,
): void {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) set(x, y, rgb);
}

/** Paint one view and write it as a PNG: RGBA (alpha backdrop) when
 *  `transparent`, plain RGB on lavender otherwise (so the file carries no
 *  alpha channel at all, which is what picks the keyed foreground mode). */
async function writeView(
  filePath: string,
  spec: ViewSpec,
  opts: TurnPairOptions,
): Promise<void> {
  const channels = opts.transparent ? 4 : 3;
  const buf = Buffer.alloc(SIZE * SIZE * channels);
  if (!opts.transparent) {
    const bg: RGB = opts.wrongBackdrop === true ? [255, 255, 255] : LAVENDER;
    for (let i = 0; i < SIZE * SIZE; i++) {
      buf[i * 3] = bg[0];
      buf[i * 3 + 1] = bg[1];
      buf[i * 3 + 2] = bg[2];
    }
  }
  const set: SetPixel = (x, y, rgb) => {
    const i = (y * SIZE + x) * channels;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    if (channels === 4) buf[i + 3] = 255;
  };

  const headCx = HEAD_CX + spec.headOffset;
  ellipse(set, headCx, HEAD_CY, spec.headW, HEAD_H, SKIN);
  if (opts.hair === true) {
    rect(set, HAIR_LEFT, EYE_ROW - 15, 30, 30, INK);
    rect(set, HAIR_RIGHT - 29, EYE_ROW - 15, 30, 30, INK);
  }
  if (opts.noIrises !== true) {
    const colour = opts.amberIrises === true ? AMBER : VIOLET;
    const cx = headCx + spec.pairOffset;
    const irisH = spec.irisH ?? IRIS_H;
    ellipse(set, cx - EYE_DX, EYE_ROW, spec.irisLW, irisH, colour);
    ellipse(set, cx + EYE_DX, EYE_ROW, spec.irisRW, irisH, colour);
  }
  if (opts.border === true) {
    rect(set, 0, 0, SIZE, 8, INK);
    rect(set, 0, SIZE - 8, SIZE, 8, INK);
    rect(set, 0, 0, 8, SIZE, INK);
    rect(set, SIZE - 8, 0, 8, SIZE, INK);
  }

  await sharp(buf, { raw: { width: SIZE, height: SIZE, channels } })
    .png()
    .toFile(filePath);
}

async function writePair(
  dir: string,
  front: ViewSpec,
  turned: ViewSpec,
  opts: TurnPairOptions,
): Promise<{ front: string; turned: string }> {
  fs.mkdirSync(dir, { recursive: true });
  const frontPath = path.join(dir, "front.png");
  const turnedPath = path.join(dir, "turned.png");
  await writeView(frontPath, front, opts);
  await writeView(turnedPath, turned, opts);
  return { front: frontPath, turned: turnedPath };
}

/** `front.png` + `turned.png`: one head, a symmetric resting pair, and a
 *  turned view that only slides the pair and narrows the far iris. */
export function writeTurnPair(
  dir: string,
  opts: TurnPairOptions = {},
): Promise<{ front: string; turned: string }> {
  return writePair(dir, PLAIN_FRONT, PLAIN_TURNED, opts);
}

/** The same, from the SKEWED specs: nothing about it is symmetric. */
export function writeSkewedTurnPair(
  dir: string,
): Promise<{ front: string; turned: string }> {
  return writePair(dir, SKEWED_FRONT, SKEWED_TURNED, {});
}

/** An UNTURNED pair — same head, same pair offset, nothing moved — but the
 *  "turned" view's head and irises (width AND height) redrawn at `scale`
 *  times the front's, as a differently-scaled character would come out rather
 *  than a turned one. Exercises the same-scale precondition: a real yaw would
 *  leave iris height where it was. */
export function writeScaledTurnPair(
  dir: string,
  scale: number,
): Promise<{ front: string; turned: string }> {
  const scaled: ViewSpec = {
    ...PLAIN_FRONT,
    headW: PLAIN_FRONT.headW * scale,
    irisLW: PLAIN_FRONT.irisLW * scale,
    irisRW: PLAIN_FRONT.irisRW * scale,
    irisH: IRIS_H * scale,
  };
  return writePair(dir, PLAIN_FRONT, scaled, {});
}
