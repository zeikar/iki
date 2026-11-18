/**
 * `view_illustration_grid`: a picture on the layer canvas as an agent reads
 * coordinates off it — a crop at an integer zoom, nearest-neighbour so the
 * pixels stay readable, with a grid every `step` canvas px labelled along the
 * top and left edges, and optionally landmarks drawn over it.
 *
 * Frame: canvas px of the CANVAS-wide canvas `loadIllustration` produces,
 * origin top-left, x right, y down. A grid line labelled `v` sits on the left
 * (top) edge of canvas pixel `v`; a landmark coordinate `v` names that pixel,
 * so landmarks are drawn through pixel centres, half a pixel past the line.
 * The picture is shown as given, its opaque backdrop included; only real
 * transparency shows the view's own backdrop.
 *
 * Labels are drawn from a small built-in bitmap font rather than SVG text,
 * whose glyphs come from whatever fonts the host has installed: a server in
 * a container without fonts would draw a grid with no numbers on it.
 */

import sharp from "sharp";
import { readPictureOnCanvas } from "./illustration";
import {
  AutoRigInputError,
  resolveOutputPath,
  writeFileAtomic,
} from "./limits";

export interface GridCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewIllustrationGridInput {
  /** The picture (PNG, JPEG or WebP), resolved against cwd. */
  imagePath: string;
  /** A `.png` under the working directory, its folder existing. */
  outputPath: string;
  /** Canvas px; the whole canvas when omitted, clamped to it otherwise. */
  crop?: GridCrop;
  /** Integer 1..8; 1 when omitted. */
  zoom?: number;
  /** Grid spacing in canvas px, an integer of at least 5; 50 when omitted. */
  step?: number;
  /** Drawn generically by shape, each labelled with its key path. */
  landmarks?: Record<string, unknown>;
}

export type ViewIllustrationGridResult =
  | {
      ok: true;
      path: string;
      crop: GridCrop;
      zoom: number;
      step: number;
      canvas: { width: number; height: number };
    }
  | { ok: false; error: string };

const DEFAULT_ZOOM = 1;
const MAX_ZOOM = 8;
const DEFAULT_STEP = 50;
/** Under this, labels every step would overrun each other at zoom 1. */
const MIN_STEP = 5;
/** An agent reads the view back as an image; a bigger one is downscaled on
 *  the way and its grid stops being legible, long before this. */
const MAX_OUTPUT_PIXELS = 4096 * 4096;

type RGB = [number, number, number];
/** What a transparent part of the picture shows. A mid green, rare in skin
 *  and hair, so the figure's edge reads against it. */
const VIEW_BACKDROP: RGB = [64, 160, 96];
const GRID_COLOR: RGB = [0, 255, 255];
const GRID_OPACITY = 0.45;
const LABEL_COLOR: RGB = [255, 255, 0];
const LABEL_BOX_OPACITY = 0.6;
/** One colour per top-level landmark key, in order, cycling. */
const LANDMARK_COLORS: RGB[] = [
  [255, 64, 64],
  [64, 255, 64],
  [255, 64, 255],
  [255, 160, 0],
  [80, 160, 255],
  [255, 255, 255],
  [160, 96, 255],
];
/** Polylines under these keys close back to their first point. */
const CLOSED_KEYS = new Set(["frontHair", "skull", "polygon"]);
/** Deeper than any landmark set nests; a cyclic object stops here. */
const MAX_DEPTH = 16;

// ---- bitmap font ----

/** Glyphs 5 px wide and 8 tall (row 6 the baseline, row 7 descenders). Each
 *  glyph is 8 base-32 digits, one per row, the row's 5 bits leftmost-high. */
const FONT_CHARS =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._[]-?";
const FONT_ROWS =
  "ehjlphe0 4c4444e0 eh1248v0 v2421he0 26aiv220 vgu11he0 68guhhe0 v1248880 " +
  "ehhehhe0 ehhf12c0 ehhvhhh0 uhhuhhu0 ehggghe0 sihhhis0 vgguggv0 vgguggg0 " +
  "ehgnhhf0 hhhvhhh0 e44444e0 72222ic0 hikokih0 ggggggv0 hrllhhh0 hhpljhh0 " +
  "ehhhhhe0 uhhuggg0 ehhhlid0 uhhukih0 fgge11u0 v4444440 hhhhhhe0 hhhhha40 " +
  "hhhllla0 hha4ahh0 hha44440 v1248gv0 00e1fhf0 ggmphhu0 00egghe0 11djhhf0 " +
  "00ehvge0 698s8880 00fhhf1e ggmphhh0 40c444e0 206222ic ggikoki0 c44444e0 " +
  "00qllhh0 00mphhh0 00ehhhe0 00uhhugg 00fhhf11 00mpggg0 00fge1u0 88s88960 " +
  "00hhhjd0 00hhha40 00hhlla0 00ha4ah0 00hhhf1e 00v248v0 00000cc0 0000000v " +
  "e88888e0 e22222e0 000v0000 eh124040";
const GLYPH_W = 5;
const GLYPH_H = 8;
/** Each font pixel drawn as a TEXT_SCALE square, so labels survive the
 *  downscale an image takes on its way to an agent. */
const TEXT_SCALE = 2;
const TEXT_PAD = 2;

const GLYPHS = (() => {
  const rows = FONT_ROWS.split(" ");
  const map = new Map<string, number[]>();
  [...FONT_CHARS].forEach((ch, i) =>
    map.set(
      ch,
      [...rows[i]].map((d) => parseInt(d, 32)),
    ),
  );
  return map;
})();

/** A label's size in output px, its padded box included. */
function textSize(text: string): { w: number; h: number } {
  return {
    w: text.length * (GLYPH_W + 1) * TEXT_SCALE - TEXT_SCALE + 2 * TEXT_PAD,
    h: GLYPH_H * TEXT_SCALE + 2 * TEXT_PAD,
  };
}

// ---- drawing on an RGB buffer ----

interface Image {
  width: number;
  height: number;
  rgb: Buffer;
}

function blend(img: Image, x: number, y: number, c: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 3;
  for (let k = 0; k < 3; k++) {
    img.rgb[i + k] = Math.round(img.rgb[i + k] * (1 - a) + c[k] * a);
  }
}

/** (x, y) in continuous output px: the pixel holding it. */
function plot(img: Image, x: number, y: number, c: RGB): void {
  blend(img, Math.floor(x), Math.floor(y), c, 1);
}

/** A segment in output px, clipped to the image first (Liang-Barsky), so a
 *  landmark far off the crop costs nothing. */
function drawSegment(
  img: Image,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  c: RGB,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  let t0 = 0;
  let t1 = 1;
  const edges: [number, number][] = [
    [-dx, ax + 1],
    [dx, img.width - ax],
    [-dy, ay + 1],
    [dy, img.height - ay],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return;
      continue;
    }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return;
  }
  const x0 = ax + t0 * dx;
  const y0 = ay + t0 * dy;
  const x1 = ax + t1 * dx;
  const y1 = ay + t1 * dy;
  const n = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))),
  );
  for (let k = 0; k <= n; k++) {
    plot(img, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, c);
  }
}

function drawText(
  img: Image,
  left: number,
  top: number,
  text: string,
  c: RGB,
): void {
  const { w, h } = textSize(text);
  for (let y = top; y < top + h; y++) {
    for (let x = left; x < left + w; x++) {
      blend(img, x, y, [0, 0, 0], LABEL_BOX_OPACITY);
    }
  }
  [...text].forEach((ch, k) => {
    const rows = GLYPHS.get(ch) ?? GLYPHS.get("?")!;
    const gx = left + TEXT_PAD + k * (GLYPH_W + 1) * TEXT_SCALE;
    rows.forEach((bits, row) => {
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(bits & (1 << (GLYPH_W - 1 - col)))) continue;
        for (let sy = 0; sy < TEXT_SCALE; sy++) {
          for (let sx = 0; sx < TEXT_SCALE; sx++) {
            blend(
              img,
              gx + col * TEXT_SCALE + sx,
              top + TEXT_PAD + row * TEXT_SCALE + sy,
              c,
              1,
            );
          }
        }
      }
    });
  });
}

/** Output-px bounds `[x0, y0, x1, y1]` of a drawn shape. */
type Bounds = [number, number, number, number];

function boundsOf(xs: number[], ys: number[]): Bounds {
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** A label near (x, y), moved inside the image, for a shape any of which is
 *  in view; none for a shape wholly off it. */
function drawLabel(
  img: Image,
  shape: Bounds,
  x: number,
  y: number,
  text: string,
  c: RGB,
) {
  const [x0, y0, x1, y1] = shape;
  if (x1 < 0 || y1 < 0 || x0 >= img.width || y0 >= img.height) return;
  const { w, h } = textSize(text);
  const left = Math.max(0, Math.min(img.width - w, Math.round(x)));
  const top = Math.max(0, Math.min(img.height - h, Math.round(y)));
  drawText(img, left, top, text, c);
}

// ---- landmarks ----

type Shape =
  | { kind: "box"; box: number[] }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "line"; points: number[][]; closed: boolean }
  | { kind: "points"; points: number[][] };

interface LabelledShape {
  label: string;
  color: RGB;
  shape: Shape;
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isPair = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && v.every(isNum);

/**
 * Every shape the landmarks hold, by shape alone: a 4-number array is a box,
 * `{ cx, cy, rx, ry }` an ellipse, a list of `[x, y]` a polyline (closed
 * under CLOSED_KEYS), points under a key ending in `Seeds` or anywhere under
 * `samples` markers, a lone `[x, y]` a marker. Anything else is walked into,
 * or skipped.
 */
function collectShapes(landmarks: Record<string, unknown>): LabelledShape[] {
  const out: LabelledShape[] = [];
  const walk = (
    v: unknown,
    path: string,
    key: string,
    inSamples: boolean,
    color: RGB,
    depth: number,
  ): void => {
    if (depth > MAX_DEPTH) return;
    const add = (shape: Shape): void => {
      out.push({ label: path, color, shape });
    };
    if (isPair(v)) return add({ kind: "points", points: [v] });
    if (Array.isArray(v) && v.length === 4 && v.every(isNum)) {
      return add({ kind: "box", box: v });
    }
    if (Array.isArray(v) && v.length > 0 && v.every(isPair)) {
      if (inSamples || key.endsWith("Seeds")) {
        return add({ kind: "points", points: v });
      }
      if (v.length < 2) return;
      return add({ kind: "line", points: v, closed: CLOSED_KEYS.has(key) });
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        walk(item, `${path}[${i}]`, key, inSamples, color, depth + 1),
      );
      return;
    }
    if (typeof v !== "object" || v === null) return;
    const o = v as Record<string, unknown>;
    if (isNum(o.cx) && isNum(o.cy) && isNum(o.rx) && isNum(o.ry)) {
      return add({ kind: "ellipse", cx: o.cx, cy: o.cy, rx: o.rx, ry: o.ry });
    }
    for (const [k, child] of Object.entries(o)) {
      walk(
        child,
        `${path}.${k}`,
        k,
        inSamples || k === "samples",
        color,
        depth + 1,
      );
    }
  };
  Object.entries(landmarks).forEach(([k, v], i) =>
    walk(
      v,
      k,
      k,
      k === "samples",
      LANDMARK_COLORS[i % LANDMARK_COLORS.length],
      0,
    ),
  );
  return out;
}

/** Marker half-size in output px. */
const MARKER = 3;

function drawShapes(
  img: Image,
  shapes: LabelledShape[],
  toX: (x: number) => number,
  toY: (y: number) => number,
  zoom: number,
): void {
  const labels: [Bounds, number, number, string, RGB][] = [];
  for (const { label, color, shape } of shapes) {
    if (shape.kind === "box") {
      const [x0, y0, x1, y1] = shape.box.map((v, k) =>
        k % 2 === 0 ? toX(v) : toY(v),
      );
      drawSegment(img, x0, y0, x1, y0, color);
      drawSegment(img, x1, y0, x1, y1, color);
      drawSegment(img, x1, y1, x0, y1, color);
      drawSegment(img, x0, y1, x0, y0, color);
      const at = boundsOf([x0, x1], [y0, y1]);
      labels.push([at, at[0], at[1] - textSize(label).h, label, color]);
    } else if (shape.kind === "ellipse") {
      const { cx, cy, rx, ry } = shape;
      // Enough sides that each is a few output px, bounded either way.
      const n = Math.min(
        1024,
        Math.max(16, Math.ceil((Math.PI * 2 * Math.max(rx, ry) * zoom) / 4)),
      );
      for (let k = 0; k < n; k++) {
        const a = (Math.PI * 2 * k) / n;
        const b = (Math.PI * 2 * (k + 1)) / n;
        drawSegment(
          img,
          toX(cx + rx * Math.cos(a)),
          toY(cy + ry * Math.sin(a)),
          toX(cx + rx * Math.cos(b)),
          toY(cy + ry * Math.sin(b)),
          color,
        );
      }
      const at = boundsOf(
        [toX(cx - rx), toX(cx + rx)],
        [toY(cy - ry), toY(cy + ry)],
      );
      labels.push([at, at[2] + 2, at[1], label, color]);
    } else if (shape.kind === "line") {
      const pts = shape.points;
      const last = shape.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < last; k++) {
        const [ax, ay] = pts[k];
        const [bx, by] = pts[(k + 1) % pts.length];
        drawSegment(img, toX(ax), toY(ay), toX(bx), toY(by), color);
      }
      const at = boundsOf(
        pts.map((p) => toX(p[0])),
        pts.map((p) => toY(p[1])),
      );
      labels.push([at, toX(pts[0][0]) + 2, toY(pts[0][1]) + 2, label, color]);
    } else {
      shape.points.forEach(([px, py], k) => {
        const x = Math.floor(toX(px));
        const y = Math.floor(toY(py));
        for (let d = -MARKER; d <= MARKER; d++) {
          blend(img, x + d, y, color, 1);
          blend(img, x, y + d, color, 1);
        }
        const text = shape.points.length > 1 ? `${label}[${k}]` : label;
        const at: Bounds = [x - MARKER, y - MARKER, x + MARKER, y + MARKER];
        labels.push([at, x + MARKER + 2, y + MARKER + 2, text, color]);
      });
    }
  }
  // After every shape, so no outline is drawn over a label.
  for (const [at, x, y, text, color] of labels) {
    drawLabel(img, at, x, y, text, color);
  }
}

// ---- the tool ----

function checkInt(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AutoRigInputError(
      `${name} must be an integer ${max === Infinity ? `of at least ${min}` : `in ${min}..${max}`}, not ${value}`,
    );
  }
  return value;
}

/** The crop's pixel rectangle on the canvas: grown out to whole pixels and
 *  clamped to the canvas. */
function clampCrop(
  crop: GridCrop | undefined,
  width: number,
  height: number,
): GridCrop {
  if (crop === undefined) return { x: 0, y: 0, w: width, h: height };
  for (const k of ["x", "y", "w", "h"] as const) {
    if (!isNum(crop[k])) {
      throw new AutoRigInputError(`crop.${k} must be a finite number`);
    }
  }
  if (crop.w <= 0 || crop.h <= 0) {
    throw new AutoRigInputError(
      `crop must have a positive size, not ${crop.w}x${crop.h}`,
    );
  }
  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(width, Math.ceil(crop.x + crop.w));
  const y1 = Math.min(height, Math.ceil(crop.y + crop.h));
  if (x1 <= x0 || y1 <= y0) {
    throw new AutoRigInputError(
      `crop { x: ${crop.x}, y: ${crop.y}, w: ${crop.w}, h: ${crop.h} } misses the ${width}x${height} canvas`,
    );
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Write the gridded view. Only caller-input failures (`AutoRigInputError`)
 * come back as `{ ok: false, error }`; any refusal writes nothing.
 */
export async function viewIllustrationGrid(
  input: ViewIllustrationGridInput,
): Promise<ViewIllustrationGridResult> {
  try {
    // First, so a refused path costs no decode.
    const outFile = resolveOutputPath(input.outputPath, ".png");
    const zoom = checkInt(input.zoom ?? DEFAULT_ZOOM, "zoom", 1, MAX_ZOOM);
    const step = checkInt(
      input.step ?? DEFAULT_STEP,
      "step",
      MIN_STEP,
      Infinity,
    );
    const landmarks = input.landmarks;
    if (
      landmarks !== undefined &&
      (typeof landmarks !== "object" ||
        landmarks === null ||
        Array.isArray(landmarks))
    ) {
      throw new AutoRigInputError("landmarks must be an object");
    }

    const pic = await readPictureOnCanvas(input.imagePath);
    const crop = clampCrop(input.crop, pic.width, pic.height);
    const ow = crop.w * zoom;
    const oh = crop.h * zoom;
    if (ow * oh > MAX_OUTPUT_PIXELS) {
      throw new AutoRigInputError(
        `the view would be ${ow}x${oh} = ${ow * oh} px, over ${MAX_OUTPUT_PIXELS}; take a smaller crop or zoom`,
      );
    }

    const img: Image = {
      width: ow,
      height: oh,
      rgb: Buffer.alloc(ow * oh * 3),
    };
    for (let oy = 0; oy < oh; oy++) {
      const sy = crop.y + Math.floor(oy / zoom);
      for (let ox = 0; ox < ow; ox++) {
        const s = (sy * pic.width + crop.x + Math.floor(ox / zoom)) * 4;
        const a = pic.rgba[s + 3] / 255;
        const o = (oy * ow + ox) * 3;
        for (let c = 0; c < 3; c++) {
          img.rgb[o + c] = Math.round(
            pic.rgba[s + c] * a + VIEW_BACKDROP[c] * (1 - a),
          );
        }
      }
    }

    const toX = (x: number) => (x - crop.x) * zoom;
    const toY = (y: number) => (y - crop.y) * zoom;
    const first = (from: number) => Math.ceil(from / step) * step;
    const columns: number[] = [];
    const rows: number[] = [];
    for (let gx = first(crop.x); gx < crop.x + crop.w; gx += step)
      columns.push(gx);
    for (let gy = first(crop.y); gy < crop.y + crop.h; gy += step)
      rows.push(gy);
    for (const gx of columns) {
      for (let y = 0; y < oh; y++)
        blend(img, toX(gx), y, GRID_COLOR, GRID_OPACITY);
    }
    for (const gy of rows) {
      for (let x = 0; x < ow; x++)
        blend(img, x, toY(gy), GRID_COLOR, GRID_OPACITY);
    }

    if (landmarks !== undefined) {
      // A landmark names a pixel: drawn through its centre.
      const centreX = (x: number) => (x + 0.5 - crop.x) * zoom;
      const centreY = (y: number) => (y + 0.5 - crop.y) * zoom;
      drawShapes(img, collectShapes(landmarks), centreX, centreY, zoom);
    }

    // Last, so the coordinates stay readable over everything. A label that
    // would overrun the one before it is left out (their boxes may touch: the
    // padding keeps them apart); the left column starts under the top row's.
    const band = textSize("0").h;
    let nextFree = 0;
    for (const gx of columns) {
      const x = toX(gx) + 2;
      if (x < nextFree) continue;
      drawText(img, x, 0, String(gx), LABEL_COLOR);
      nextFree = x + textSize(String(gx)).w;
    }
    nextFree = band + 2;
    for (const gy of rows) {
      const y = toY(gy) + 2;
      if (y < nextFree) continue;
      drawText(img, 0, y, String(gy), LABEL_COLOR);
      nextFree = y + band;
    }

    const png = await sharp(img.rgb, {
      raw: { width: ow, height: oh, channels: 3 },
    })
      .png()
      .toBuffer();
    writeFileAtomic(outFile, png);
    return {
      ok: true,
      path: outFile,
      crop,
      zoom,
      step,
      canvas: { width: pic.width, height: pic.height },
    };
  } catch (e) {
    if (e instanceof AutoRigInputError) return { ok: false, error: e.message };
    throw e;
  }
}
