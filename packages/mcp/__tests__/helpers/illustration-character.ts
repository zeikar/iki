import sharp from "sharp";
import { dilate, type Mask } from "../../src/illustration";

/**
 * A synthetic bust drawn the way a finished character picture is: flat
 * colours with dark outlines on a flat backdrop. Back hair behind the head,
 * two tails hanging from a knot each, ears, a face with two drawn eyes (a
 * white, an iris disc with a pupil and a highlight, a winged upper lash, a
 * lower lid line and a crease above), two brows, a nose and a mouth mark, a
 * hair cap with a sawtooth fringe over the forehead and one strand hanging
 * from it through the right brow, a neck and a torso.
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
  iris: RGB;
  pupil: RGB;
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
  iris: [70, 130, 180],
  pupil: [35, 50, 80],
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
  iris: [60, 140, 110],
  pupil: [30, 60, 45],
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
  iris: [150, 90, 60],
  pupil: [70, 35, 25],
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

/** |u|^4 + |v|^4 <= 1: a disc squarer than the ellipse of its width and
 *  height. */
const superellipse =
  (cx: number, cy: number, rx: number, ry: number): Inside =>
  (x, y) =>
    ((x - cx) / rx) ** 4 + ((y - cy) / ry) ** 4 <= 1;

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

/** The sclera's colour, in every colouring. */
export const WHITE: RGB = [255, 255, 255];

/** The eyes' shapes, about each eye's centre column `cx`. */
export const EYE = {
  R: { cx: 470, outer: -1 },
  L: { cx: 630, outer: 1 },
  /** The white. */
  white: { cy: 432, rx: 24, ry: 19 },
  /** The iris disc, its top under the lash. */
  iris: { cy: 432, rx: 13, ry: 17 },
  pupil: { cy: 436, rx: 5, ry: 8 },
  /** A highlight whose top is under the lash, `dx` from the centre. */
  highlight: { dx: 4, cy: 421, r: 4 },
  /** The upper lash: the outer ellipse less the inner, rows to `bottom`. */
  lashOuter: { cy: 433, rx: 27, ry: 24 },
  lashInner: { cy: 442, rx: 25, ry: 22 },
  lashBottom: 432,
  /** The lower lid's line: rows y0..y1, `half` either side of the centre,
   *  across the iris's bottom and on past the disc both ways. */
  lower: { y0: 446, y1: 449, half: 20 },
  /** A short lower lid within the disc's columns, merging with the disc's
   *  bottom outline and running on under it ("darkIris"). */
  lowerShort: { y0: 448, y1: 451, half: 8 },
  /** "darkIris": the disc as dark as the lash above this row, and an
   *  outline of that ink this thick round its bottom below `outlineFrom`. */
  darkTopTo: 426,
  outline: 2.5,
  outlineFrom: 438,
  /** "greyWhite": a white of warm grey. */
  greyWhite: [228, 222, 222] as RGB,
  /** "bigIris": an iris disc covering most of the white. */
  bigIris: { rx: 23, ry: 19 },
  /** "lidBand": a pale band of lid this many px over the lash's top. */
  lidBand: 3,
  /** "closed": the closed lid's line, the outer ellipse less the inner,
   *  rows from `from`. */
  closedOuter: { cy: 424, rx: 27, ry: 14 },
  closedInner: { cy: 419, rx: 27, ry: 14 },
  closedFrom: 424,
  /** "squareIris": the disc's outline, this many px thick. */
  squareOutline: 2.5,
  /** "shadedWhite": the shade under the lash, this many px thick. */
  shade: 5,
  /** The crease: a thin arc detached above the lash. */
  creaseOuter: { cy: 425, rx: 26, ry: 28 },
  creaseInner: { cy: 429, rx: 26, ry: 28 },
  creaseBottom: 404,
} as const;

/** Inside the upper lash of the eye about `cx` (its wing included). */
export function inLash(cx: number, outer: number, x: number, y: number) {
  const o = EYE.lashOuter;
  const n = EYE.lashInner;
  const crescent =
    y <= EYE.lashBottom &&
    ellipse(cx, o.cy, o.rx, o.ry)(x, y) &&
    !ellipse(cx, n.cy, n.rx, n.ry)(x, y);
  const wing = polygon([
    [cx + outer * 22, 418],
    [cx + outer * 34, 410],
    [cx + outer * 26, 428],
  ]);
  return crescent || wing(x, y);
}

/** A strand hanging from the fringe through the right brow. */
export const STRAND = { x0: 450, x1: 462, y0: 300, y1: 388 };

/** The brows' centrelines, tail first, and their half-width. */
export const BROWS = {
  R: [
    [440, 378],
    [462, 370],
    [486, 367],
    [504, 369],
  ] as [number, number][],
  L: [
    [660, 378],
    [638, 370],
    [614, 367],
    [596, 369],
  ] as [number, number][],
  half: 4,
  /** The left brow's tail, x past this, is drawn pale, half skin. */
  paleTailFrom: 645,
};

/** Within `half` of a polyline. */
function thickLine(pts: [number, number][], half: number): Inside {
  return (x, y) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2),
      );
      if (Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= half) {
        return true;
      }
    }
    return false;
  };
}

/** Inside the brow drawn on `side`. */
export function inBrow(side: "L" | "R", x: number, y: number): boolean {
  return thickLine(BROWS[side], BROWS.half)(x, y);
}

const mix = (a: RGB, b: RGB, t: number): RGB =>
  a.map((v, k) => Math.round(v * (1 - t) + b[k] * t)) as RGB;

/** How an eye is drawn: `open` (white, iris with pupil and highlight,
 *  winged lash, a lower lid across the iris's bottom, a crease above);
 *  `squareIris` (open, the disc squarer than an ellipse, |u|^4 + |v|^4 <= 1,
 *  outlined in a dark shade of the iris's own colour, so its corners pass
 *  an ellipse of the same width and height); `shadedWhite` (open, a grey
 *  shade on the white under the lash, SHADE px thick);
 *  `lidBand` (open, a pale lid band over the lash instead of the crease);
 *  `darkIris` (open, the disc as dark as the lash at its top and outlined in
 *  that ink at its bottom, a short lower lid joining the outline);
 *  `greyWhite` (open, a warm grey white); `bigIris` (open, an iris covering
 *  most of the white); `closed` (one curved line). */
export type EyeStyle =
  | "open"
  | "squareIris"
  | "shadedWhite"
  | "lidBand"
  | "darkIris"
  | "greyWhite"
  | "bigIris"
  | "closed";

/** One eye about `cx`, its outer corner toward `outer`, back to front. */
function eyeShapes(
  c: CharacterColours,
  cx: number,
  outer: number,
  style: EyeStyle,
): [Inside, RGB, boolean][] {
  if (style === "closed") {
    const o = EYE.closedOuter;
    const n = EYE.closedInner;
    return [
      [
        (x, y) =>
          y >= EYE.closedFrom &&
          ellipse(cx, o.cy, o.rx, o.ry)(x, y) &&
          !ellipse(cx, n.cy, n.rx, n.ry)(x, y),
        c.ink,
        false,
      ],
    ];
  }
  const w = EYE.white;
  const ir = EYE.iris;
  const p = EYE.pupil;
  const h = EYE.highlight;
  const o = EYE.creaseOuter;
  const n = EYE.creaseInner;
  const lo = style === "darkIris" ? EYE.lowerShort : EYE.lower;
  const size = style === "bigIris" ? EYE.bigIris : ir;
  const disc =
    style === "squareIris"
      ? superellipse(cx, ir.cy, size.rx, size.ry)
      : ellipse(cx, ir.cy, size.rx, size.ry);
  const sclera = style === "greyWhite" ? EYE.greyWhite : WHITE;
  const out: [Inside, RGB, boolean][] = [
    [ellipse(cx, w.cy, w.rx, w.ry), sclera, false],
    [disc, c.iris, false],
  ];
  if (style === "shadedWhite") {
    const n = EYE.lashInner;
    out.push([
      (x, y) =>
        ellipse(cx, w.cy, w.rx, w.ry)(x, y) &&
        ellipse(cx, n.cy, n.rx, n.ry)(x, y) &&
        !ellipse(cx, n.cy + EYE.shade, n.rx, n.ry)(x, y),
      mix(WHITE, c.ink, 0.45),
      false,
    ]);
  }
  if (style === "squareIris") {
    const t = EYE.squareOutline;
    const inner = superellipse(cx, ir.cy, ir.rx - t, ir.ry - t);
    out.push([
      (x, y) => disc(x, y) && !inner(x, y),
      mix(c.iris, [0, 0, 0], 0.6),
      false,
    ]);
  }
  if (style === "darkIris") {
    const inner = ellipse(cx, ir.cy, ir.rx - EYE.outline, ir.ry - EYE.outline);
    out.push(
      [(x, y) => disc(x, y) && y < EYE.darkTopTo, c.ink, false],
      [
        (x, y) => disc(x, y) && !inner(x, y) && y > EYE.outlineFrom,
        c.ink,
        false,
      ],
    );
  }
  out.push(
    [ellipse(cx, p.cy, p.rx, p.ry), c.pupil, false],
    [ellipse(cx + h.dx, h.cy, h.r, h.r), WHITE, false],
    [(x, y) => inLash(cx, outer, x, y), c.ink, false],
    [rect(cx - lo.half, lo.y0, cx + lo.half, lo.y1), c.ink, false],
  );
  if (style === "lidBand") {
    const l = EYE.lashOuter;
    const band = ellipse(cx, l.cy, l.rx + 1, l.ry + EYE.lidBand);
    out.push([
      (x, y) =>
        y <= EYE.lashBottom &&
        band(x, y) &&
        !ellipse(cx, l.cy, l.rx, l.ry)(x, y),
      mix(c.skin, c.ink, 0.2),
      false,
    ]);
  } else {
    out.push([
      (x, y) =>
        y <= EYE.creaseBottom &&
        ellipse(cx, o.cy, o.rx, o.ry)(x, y) &&
        !ellipse(cx, n.cy, n.rx, n.ry)(x, y),
      c.ink,
      false,
    ]);
  }
  return out;
}

/** The features drawn over the face, back to front. */
function features(
  c: CharacterColours,
  eyes: { L?: EyeStyle; R?: EyeStyle },
): [Inside, RGB, boolean][] {
  const out: [Inside, RGB, boolean][] = [
    ...eyeShapes(c, EYE.R.cx, EYE.R.outer, eyes.R ?? "open"),
    ...eyeShapes(c, EYE.L.cx, EYE.L.outer, eyes.L ?? "open"),
  ];
  const inStrand = rect(STRAND.x0, STRAND.y0, STRAND.x1, STRAND.y1);
  const browR = thickLine(BROWS.R, BROWS.half);
  const browL = thickLine(BROWS.L, BROWS.half);
  out.push(
    [ellipse(550, 490, 5, 5), c.ink, false],
    [rect(520, 557, 580, 563), c.ink, false],
  );
  return out.concat([
    [(x, y) => browR(x, y) && !inStrand(x, y), c.ink, false],
    [(x, y) => browL(x, y) && x <= BROWS.paleTailFrom, c.ink, false],
    [
      (x, y) => browL(x, y) && x > BROWS.paleTailFrom,
      mix(c.ink, c.skin, 0.5),
      false,
    ],
  ]);
}

/** The strand and the pale brow drawn over it, after the cap. */
function strand(c: CharacterColours): [Inside, RGB, boolean][] {
  const inStrand = rect(STRAND.x0, STRAND.y0, STRAND.x1, STRAND.y1);
  const browR = thickLine(BROWS.R, BROWS.half);
  return [
    [inStrand, c.hair, false],
    [(x, y) => browR(x, y) && inStrand(x, y), mix(c.ink, c.hair, 0.5), false],
  ];
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
/** Two short strand tips hanging under the jaw over each side of the neck,
 *  outlined: hair too small to be anything but specks among the face's and
 *  the neck's paint, which the labels give to the body. */
export const NECK_TIPS: [number, number][][] = [
  [
    [496, 645],
    [514, 645],
    [505, 680],
  ],
  [
    [586, 645],
    [604, 645],
    [595, 680],
  ],
];
/** The chin's shadow cast on the neck: rows under the jaw this many px
 *  deep, a dark shade of the neck's skin. */
export const CHIN_SHADOW = 10;
/** A lock of the back hair swept across the temple from behind the head,
 *  over the left brow's tail (drawn over it), ending at `x0`; it covers the
 *  brow's tail from `x0` on. */
export const TEMPLE_LOCK = {
  x0: 652,
  polygon: [
    [652, 368],
    [652, 384],
    [770, 348],
    [770, 332],
  ] as [number, number][],
};
/** A side lock on the viewer's left (the character's right, `hair_side_R`),
 *  hanging from under the fringe in front of the ear and the cheek's edge,
 *  outlined, in the hair's main colour; `SIDE_LOCKS` draws it and its mirror
 *  about x = 550. Its top lies under the cap, which hides it down to the
 *  fringe. `overEye` is a lobe off its inner edge over the right eye's outer
 *  corner, the white's outer end under it; `nearEye` a lobe that ends in
 *  the right eye box's spare, short of the eye. `short` is a lock drawn instead
 *  that ends on the cheek, inside the face's outline: the face and the
 *  fringe close it in. `outer` is a strand drawn instead, hanging beside
 *  the ear's outer edge and on below the lobe, over the back hair. */
export const SIDE_LOCK = {
  R: [
    [345, 300],
    [395, 300],
    [394, 480],
    [388, 580],
    [368, 625],
    [346, 570],
  ] as [number, number][],
  overEye: [
    [390, 418],
    [456, 418],
    [456, 446],
    [390, 446],
  ] as [number, number][],
  nearEye: [
    [390, 418],
    [432, 418],
    [432, 446],
    [390, 446],
  ] as [number, number][],
  outer: [
    [298, 380],
    [308, 380],
    [308, 560],
    [298, 560],
  ] as [number, number][],
  short: [
    [375, 300],
    [400, 300],
    [399, 470],
    [388, 490],
    [376, 470],
  ] as [number, number][],
};

/** A thin dark stroke (a strand's line) crossing the right eye box's
 *  lower-left corner from inside it and running far on down the cheek,
 *  dashed as an antialiased thin stroke breaks into pieces: `dash` px of
 *  ink every `period` px, `half` px either side of its line. */
export const EYE_STROKE = {
  line: [
    [449, 457],
    [380, 482],
  ] as [number, number][],
  half: 1.5,
  dash: 8,
  period: 11,
  /** "joined": solid, from the lower lid's end: one piece with the eye. */
  joined: [
    [450, 447],
    [380, 482],
  ] as [number, number][],
};

/** What `writeCharacter` draws past the bust itself. */
export interface CharacterOptions {
  /** On no backdrop at all. */
  transparent?: boolean;
  pocket?: boolean;
  gap?: boolean;
  ornament?: boolean;
  eyes?: { L?: EyeStyle; R?: EyeStyle };
  /** NECK_TIPS. */
  neckTips?: boolean;
  /** CHIN_SHADOW. */
  chinShadow?: boolean;
  /** TEMPLE_LOCK. */
  templeLock?: boolean;
  /** SIDE_LOCK on each side; "overEye" or "nearEye" with that lobe off the
   *  right one; "short" or "outer" that one on each side instead. */
  sideLocks?: boolean | "overEye" | "nearEye" | "short" | "outer";
  /** EYE_STROKE: "dashed", or "joined" to the lower lid. */
  eyeStroke?: "dashed" | "joined";
  /** The torso's outline inked in this colour instead of the ink along
   *  BODY_INK_DASH of every BODY_INK_PERIOD degrees round it: one near the
   *  hair's reads as hair, in long pieces apart from each other and from
   *  the hair, as an antialiased outline whose colour sits between the two
   *  breaks up. */
  bodyInk?: RGB;
}

/** Within `half` of a polyline, on its dashes: `dash` px of every
 *  `period` along it. */
function dashedLine(
  pts: [number, number][],
  half: number,
  dash: number,
  period: number,
): Inside {
  return (x, y) => {
    let along = 0;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k];
      const [bx, by] = pts[k + 1];
      const len = Math.hypot(bx - ax, by - ay);
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len ** 2),
      );
      const d = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
      if (d <= half && (along + t * len) % period < dash) return true;
      along += len;
    }
    return false;
  };
}

/** The torso, whose outline `bodyInk` recolours. */
const TORSO = ellipse(550, 1000, 260, 230);
/** `bodyInk`'s dashes round the torso, degrees: each about 130 canvas px
 *  long, past the speck rule's size. */
export const BODY_INK_PERIOD = 36;
export const BODY_INK_DASH = 30;
/** Whether (x, y) on the torso's outline lies on a `bodyInk` dash. */
export function onBodyInkDash(x: number, y: number): boolean {
  const deg = (Math.atan2(y - 1000, x - 550) * 180) / Math.PI + 360;
  return deg % BODY_INK_PERIOD < BODY_INK_DASH;
}

/** The jaw's lowest row at column x: the face ellipse's bottom. */
const jawAt = (x: number) =>
  430 + 230 * Math.sqrt(Math.max(0, 1 - ((x - 550) / 200) ** 2));

/** Shapes back to front: each drawn as its outline ring, then its fill. */
function shapes(
  c: CharacterColours,
  o: CharacterOptions,
): [Inside, RGB, boolean][] {
  const { pocket = false, gap = false, ornament = false, eyes = {} } = o;
  const lock =
    o.sideLocks === "short"
      ? SIDE_LOCK.short
      : o.sideLocks === "outer"
        ? SIDE_LOCK.outer
        : SIDE_LOCK.R;
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
    ...(o.chinShadow
      ? [
          [
            (x: number, y: number) =>
              x > 499 && x < 601 && y < jawAt(x) + CHIN_SHADOW,
            mix(c.skinShadow, c.ink, 0.5),
            false,
          ] as [Inside, RGB, boolean],
        ]
      : []),
    ...(o.neckTips
      ? NECK_TIPS.map(
          (t) => [polygon(t), c.hair, true] as [Inside, RGB, boolean],
        )
      : []),
    [TORSO, c.torso, true],
    [ellipse(345, 450, 32, 48), c.skin, true],
    [ellipse(755, 450, 32, 48), c.skin, true],
    [ellipse(550, 430, 200, 230), c.skin, true],
    ...features(c, eyes),
    ...(o.templeLock
      ? [[polygon(TEMPLE_LOCK.polygon), c.hair, true] as [Inside, RGB, boolean]]
      : []),
    ...(o.sideLocks
      ? [
          [polygon(lock), c.hair, true] as [Inside, RGB, boolean],
          [polygon(mirror(lock)), c.hair, true] as [Inside, RGB, boolean],
        ]
      : []),
    ...(o.sideLocks === "overEye" || o.sideLocks === "nearEye"
      ? [
          [
            (x: number, y: number) =>
              polygon(SIDE_LOCK.R)(x, y) ||
              polygon(SIDE_LOCK[o.sideLocks as "overEye" | "nearEye"])(x, y),
            c.hair,
            true,
          ] as [Inside, RGB, boolean],
        ]
      : []),
    ...(o.eyeStroke
      ? [
          [
            o.eyeStroke === "dashed"
              ? dashedLine(
                  EYE_STROKE.line,
                  EYE_STROKE.half,
                  EYE_STROKE.dash,
                  EYE_STROKE.period,
                )
              : thickLine(EYE_STROKE.joined, EYE_STROKE.half),
            c.ink,
            false,
          ] as [Inside, RGB, boolean],
        ]
      : []),
    [capInside, c.hair, true],
    [highlightBand, c.hairHighlight, false],
    ...strand(c),
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

/** Write the character, coloured by `colours`, as a PNG at `file`, with
 *  what `options` asks for drawn. */
export async function writeCharacter(
  file: string,
  colours: CharacterColours,
  options: CharacterOptions = {},
): Promise<void> {
  const { transparent = false } = options;
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
  for (const [inside, colour, outlined] of shapes(colours, options)) {
    const m: Mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = inside(...at(i)) ? 1 : 0;
    const ring = outlined ? dilate(size, m, OUTLINE) : m;
    const recolour = options.bodyInk && inside === TORSO;
    for (let i = 0; i < n; i++) {
      if (ring[i]) {
        buf.set(
          recolour && onBodyInkDash(...at(i)) ? options.bodyInk! : colours.ink,
          i * 3,
        );
      }
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
 *  row, and round the strand: what an agent traces as `frontHair`. */
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
  // Down round the strand hanging through the right brow.
  pts.push(
    [STRAND.x1 + 6, 345],
    [STRAND.x1 + 6, STRAND.y1 + 4],
    [STRAND.x0 - 6, STRAND.y1 + 4],
    [STRAND.x0 - 6, 345],
  );
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
        box: [592, 392, 668, 466],
        iris: { cx: 630, cy: 432, rx: 13, ry: 17 },
      },
      R: {
        box: [432, 392, 508, 466],
        iris: { cx: 470, cy: 432, rx: 13, ry: 17 },
      },
    },
    brows: {
      L: { line: BROWS.L.map((p) => [...p]) },
      R: { line: BROWS.R.map((p) => [...p]) },
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

/** `sideHair` round each SIDE_LOCK, 5 px out past its outline, from up
 *  inside the front hair; a fresh copy. */
export function sideLockLandmarks(): {
  sideHair: { L: [number, number][]; R: [number, number][] };
} {
  const R: [number, number][] = [
    [340, 330],
    [400, 330],
    [399, 480],
    [393, 582],
    [369, 632],
    [340, 572],
  ];
  return { sideHair: { L: mirror(R), R } };
}

/** A polygon over the torso, for a picture whose torso reads as hair. */
export const TORSO_BODY_ONLY: [number, number][] = [
  [270, 760],
  [830, 760],
  [830, 1099],
  [270, 1099],
];
