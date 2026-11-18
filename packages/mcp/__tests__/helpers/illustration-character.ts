import sharp from "sharp";
import { dilate, type Mask } from "../../src/illustration";

/**
 * A synthetic bust drawn the way a finished character picture is: flat
 * colours with dark outlines on a flat backdrop. Back hair behind the head,
 * two tails hanging from a knot each, ears, a face with an eye, nose and
 * mouth mark, a hair cap with a sawtooth fringe over the forehead, a neck
 * and a torso.
 *
 * Drawn at half size (550 px) so the loader scales it to the 1100 canvas
 * with soft edges, as a real picture arrives. Shapes are given in canvas px
 * so the landmarks below read straight off them.
 */

type RGB = [number, number, number];

export interface CharacterColours {
  backdrop: RGB;
  ink: RGB;
  hair: RGB;
  hairShadow: RGB;
  hairHighlight: RGB;
  skin: RGB;
  skinShadow: RGB;
  torso: RGB;
  ribbon: RGB;
}

export const PINK_ON_PEACH: CharacterColours = {
  backdrop: [235, 240, 250],
  ink: [70, 40, 50],
  hair: [240, 150, 175],
  hairShadow: [205, 115, 145],
  hairHighlight: [255, 200, 215],
  skin: [255, 232, 215],
  skinShadow: [240, 205, 190],
  torso: [80, 90, 160],
  ribbon: [210, 40, 60],
};

/** Hair and skin close in hue: the case one colour test cannot split. */
export const ORANGE_ON_WARM: CharacterColours = {
  backdrop: [240, 240, 235],
  ink: [90, 45, 30],
  hair: [230, 130, 60],
  hairShadow: [195, 100, 45],
  hairHighlight: [250, 175, 100],
  skin: [250, 205, 170],
  skinShadow: [230, 180, 145],
  torso: [70, 120, 90],
  ribbon: [60, 90, 200],
};

/** Near-black hair over a dark torso and ink: colour cannot tell them
 *  apart, the landmark regions must. */
export const BLACK_ON_PEACH: CharacterColours = {
  backdrop: [245, 245, 245],
  ink: [25, 20, 30],
  hair: [40, 35, 45],
  hairShadow: [25, 22, 30],
  hairHighlight: [85, 85, 105],
  skin: [255, 232, 215],
  skinShadow: [240, 205, 190],
  torso: [45, 45, 60],
  ribbon: [200, 40, 50],
};

const SOURCE = 550;
const SCALE = 1100 / SOURCE;
/** Outline width in source px (4 canvas px). */
const OUTLINE = 2;

type Inside = (x: number, y: number) => boolean;

const ellipse =
  (cx: number, cy: number, rx: number, ry: number): Inside =>
  (x, y) =>
    ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const rect =
  (x0: number, y0: number, x1: number, y1: number): Inside =>
  (x, y) =>
    x >= x0 && x <= x1 && y >= y0 && y <= y1;

function polygon(pts: [number, number][]): Inside {
  return (x, y) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
}

/** The fringe's lower edge: teeth 55 canvas px apart hanging 290..335. */
const fringeEdge = (x: number) => {
  const t = ((((x - 330) / 55) % 1) + 1) % 1;
  return 290 + 45 * (1 - Math.abs(2 * t - 1));
};

const CAP = ellipse(550, 400, 225, 270);
const capInside: Inside = (x, y) => CAP(x, y) && y <= fringeEdge(x);
const highlightBand: Inside = (x, y) => {
  const r = ((x - 550) / 170) ** 2 + ((y - 400) / 220) ** 2;
  return capInside(x, y) && y < 260 && r >= 1 && r <= 1.15;
};

/** The knots' and the tails' shapes, viewer-left first; the right ones
 *  mirror them about x = 550. */
const TAIL_LEFT: [number, number][] = [
  [245, 280],
  [275, 300],
  [250, 500],
  [230, 700],
  [190, 780],
  [150, 700],
  [160, 500],
  [200, 330],
];
const mirror = (pts: [number, number][]): [number, number][] =>
  pts.map(([x, y]) => [1100 - x, y]);

/** A thin wisp of hair beside the neck, two picture pixels wide, with two
 *  of backdrop between it and the neck's line. */
export const WISP = { x0: 482, x1: 485, y0: 715, y1: 760 };
/** Two strands hanging from the back hair onto the torso, with a gap of
 *  backdrop between them that the torso closes off at the bottom. */
export const GAP = { cx: 710, cy: 740 };
/** An outlined disc of backdrop colour inside the back hair: a pale hair
 *  ornament, paint the hair rings. */
export const ORNAMENT = { cx: 318, cy: 262, r: 14 };
/** An outlined disc of backdrop colour on the torso: backdrop the figure
 *  encloses, which no flood from the border reaches. */
export const POCKET = { cx: 420, cy: 950, r: 30 };

/** Shapes back to front: each drawn as its outline ring, then its fill. */
function shapes(
  c: CharacterColours,
  pocket: boolean,
  gap: boolean,
  ornament: boolean,
): [Inside, RGB, boolean][] {
  const strands: [Inside, RGB, boolean][] = gap
    ? [
        [rect(676, 640, 692, 840), c.hair, true],
        [rect(728, 640, 744, 840), c.hair, true],
      ]
    : [];
  return [
    [ellipse(550, 400, 290, 310), c.hairShadow, true],
    ...strands,
    [polygon(TAIL_LEFT), c.hair, true],
    [polygon(mirror(TAIL_LEFT)), c.hair, true],
    [ellipse(262, 280, 30, 30), c.ribbon, true],
    [ellipse(838, 280, 30, 30), c.ribbon, true],
    [rect(495, 560, 605, 800), c.skinShadow, true],
    [ellipse(550, 1000, 260, 230), c.torso, true],
    [ellipse(345, 450, 32, 48), c.skin, true],
    [ellipse(755, 450, 32, 48), c.skin, true],
    [ellipse(550, 430, 200, 230), c.skin, true],
    [ellipse(470, 430, 18, 26), c.ink, false],
    [ellipse(630, 430, 18, 26), c.ink, false],
    [ellipse(550, 490, 5, 5), c.ink, false],
    [rect(520, 557, 580, 563), c.ink, false],
    [capInside, c.hair, true],
    [highlightBand, c.hairHighlight, false],
    [rect(WISP.x0, WISP.y0, WISP.x1 + 0.9, WISP.y1), c.hair, false],
    ...(ornament
      ? [
          [
            ellipse(ORNAMENT.cx, ORNAMENT.cy, ORNAMENT.r, ORNAMENT.r),
            c.backdrop,
            true,
          ] as [Inside, RGB, boolean],
        ]
      : []),
    ...(pocket
      ? [
          [
            ellipse(POCKET.cx, POCKET.cy, POCKET.r, POCKET.r),
            c.backdrop,
            true,
          ] as [Inside, RGB, boolean],
        ]
      : []),
  ];
}

/** Write the character, coloured by `colours`, as a PNG at `file`; with
 *  `transparent`, on no backdrop at all; with `pocket` and `gap`, the
 *  POCKET and the GAP drawn. */
export async function writeCharacter(
  file: string,
  colours: CharacterColours,
  { transparent = false, pocket = false, gap = false, ornament = false } = {},
): Promise<void> {
  const size = { width: SOURCE, height: SOURCE };
  const n = SOURCE * SOURCE;
  const buf = Buffer.alloc(n * 3);
  const painted = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf.set(colours.backdrop, i * 3);
  // A source pixel's centre in canvas px.
  const at = (i: number): [number, number] => [
    ((i % SOURCE) + 0.5) * SCALE,
    (Math.floor(i / SOURCE) + 0.5) * SCALE,
  ];
  for (const [inside, colour, outlined] of shapes(
    colours,
    pocket,
    gap,
    ornament,
  )) {
    const m: Mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = inside(...at(i)) ? 1 : 0;
    const ring = outlined ? dilate(size, m, OUTLINE) : m;
    for (let i = 0; i < n; i++) {
      if (ring[i]) buf.set(colours.ink, i * 3);
      if (m[i]) buf.set(colour, i * 3);
      if (ring[i]) painted[i] = 1;
    }
  }
  if (!transparent) {
    await sharp(buf, { raw: { width: SOURCE, height: SOURCE, channels: 3 } })
      .png()
      .toFile(file);
    return;
  }
  const rgba = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    if (!painted[i]) continue;
    rgba.set(buf.subarray(i * 3, i * 3 + 3), i * 4);
    rgba[i * 4 + 3] = 255;
  }
  await sharp(rgba, { raw: { width: SOURCE, height: SOURCE, channels: 4 } })
    .png()
    .toFile(file);
}

/** The cap's outline, 4 px out for its line, down to the fringe's lowest
 *  row: what an agent traces as `frontHair`. */
function capOutline(): [number, number][] {
  const pts: [number, number][] = [];
  const top = Math.asin(55 / 274);
  for (let k = 0; k <= 16; k++) {
    const a = top + ((Math.PI - 2 * top) * k) / 16;
    pts.push([
      Math.round(550 - 229 * Math.cos(a)),
      Math.round(400 - 274 * Math.sin(a)),
    ]);
  }
  return pts;
}

/** Landmarks for the character, read off its shapes; a fresh copy. */
export function characterLandmarks(): Record<string, any> {
  return {
    samples: {
      hair: {
        base: [
          [550, 230],
          [480, 215],
        ],
        shadow: [[340, 600]],
        highlight: [[550, 172]],
      },
      skin: {
        base: [
          [550, 400],
          [450, 560],
        ],
        shadow: [[550, 720]],
      },
    },
    eyes: {
      L: {
        box: [600, 392, 660, 468],
        iris: { cx: 630, cy: 430, rx: 18, ry: 24 },
      },
      R: {
        box: [440, 392, 500, 468],
        iris: { cx: 470, cy: 430, rx: 18, ry: 24 },
      },
    },
    nose: { box: [540, 480, 560, 500] },
    mouth: {
      box: [508, 548, 592, 572],
      cornerL: [520, 560],
      cornerR: [580, 560],
    },
    frontHair: capOutline(),
    skull: [
      [355, 420],
      [360, 300],
      [400, 220],
      [470, 185],
      [550, 178],
      [630, 185],
      [700, 220],
      [740, 300],
      [745, 420],
    ],
    shellLower: [
      [300, 420],
      [330, 560],
      [420, 640],
      [550, 660],
      [680, 640],
      [770, 560],
      [800, 420],
    ],
    skinSeeds: [
      [550, 380],
      [420, 520],
      [680, 520],
      [330, 460],
      [770, 460],
    ],
    bodySeeds: [
      [550, 700],
      [550, 900],
    ],
    neckTopY: 540,
    customParts: [
      {
        id: "tail_R",
        tie: [262, 280],
        side: "left",
        line: [
          [290, 200],
          [284, 330],
          [270, 500],
        ],
        below: 262,
        ribbonBox: [228, 246, 296, 314],
      },
      {
        id: "tail_L",
        tie: [838, 280],
        polygon: [
          [806, 200],
          [1099, 200],
          [1099, 850],
          [800, 850],
          [830, 500],
          [812, 330],
        ],
      },
    ],
  };
}

/** A polygon over the torso, for a picture whose torso reads as hair. */
export const TORSO_BODY_ONLY: [number, number][] = [
  [270, 760],
  [830, 760],
  [830, 1099],
  [270, 1099],
];
