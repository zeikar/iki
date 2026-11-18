import { describe, expect, it } from "vitest";
import type { CanvasSize, Mask } from "../src/illustration";
import { hairRungPockets } from "../src/illustration-cut";
import { HAIR, NEITHER, SKIN } from "../src/illustration-colour";
import {
  dropSpecks,
  hairThroughBox,
  joinInk,
  LABEL_BODY,
  LABEL_FACE,
  LABEL_HAIR,
  releaseLines,
  spreadLabels,
  strandsThrough,
  type IllustrationLabels,
} from "../src/illustration-labels";

/** A mask from rows of characters: `on` marks the set pixels. */
function art(rows: string[], on = "#"): { size: CanvasSize; m: Mask } {
  const size = { width: rows[0].length, height: rows.length };
  const m = new Uint8Array(size.width * size.height);
  rows.forEach((r, y) =>
    [...r].forEach(
      (ch, x) => (m[y * size.width + x] = on.includes(ch) ? 1 : 0),
    ),
  );
  return { size, m };
}

const rowsOf = (size: CanvasSize, m: ArrayLike<number>, ch = "#") => {
  const out: string[] = [];
  for (let y = 0; y < size.height; y++) {
    let r = "";
    for (let x = 0; x < size.width; x++) r += m[y * size.width + x] ? ch : ".";
    out.push(r);
  }
  return out;
};

describe("dropSpecks", () => {
  it("drops a hair speck ringed by other paint and keeps one on the backdrop or beside hair", () => {
    // `h` hair, `p` other paint, `.` backdrop. A speck inside the paint
    // block, a speck alone on the backdrop, a speck next to a big piece.
    const rows = [
      "ppppppp.........................",
      "ppppppp.........................",
      "pp hpp ....h....................",
      "pp hpp .........................",
      "ppppppp.........................",
      "ppppppp.........................",
      "................................",
    ].map((r) => r.replace(/ /g, "p"));
    const hair = art(rows, "h");
    const solid = art(rows, "hp");
    // A big piece (over 400 px) at the bottom right, a speck beside it.
    const size = { width: 32, height: 40 };
    const big = new Uint8Array(size.width * size.height);
    const paint = new Uint8Array(size.width * size.height);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 32; x++) {
        big[y * 32 + x] = hair.m[y * 32 + x];
        paint[y * 32 + x] = solid.m[y * 32 + x];
      }
    }
    for (let y = 10; y < 40; y++) {
      for (let x = 10; x < 30; x++) big[y * 32 + x] = paint[y * 32 + x] = 1;
    }
    big[25 * 32 + 8] = paint[25 * 32 + 8] = 1; // beside the big piece
    const out = dropSpecks(size, big, paint);
    expect(out[2 * 32 + 3]).toBe(0); // ringed by paint: gone
    expect(out[2 * 32 + 11]).toBe(1); // alone on the backdrop: kept
    expect(out[25 * 32 + 8]).toBe(1); // its ring is mostly hair: kept
    expect(out[20 * 32 + 20]).toBe(1); // the big piece
  });
});

describe("spreadLabels", () => {
  it("spreads along paint first, then across the backdrop to paint nothing touches", () => {
    const { size, m: fg } = art([
      "FF##.....##",
      "FF##.....BB",
      "...........",
      ".......#...",
    ]);
    const label = new Uint8Array(size.width * size.height);
    label[0] = label[1] = label[11] = label[12] = LABEL_FACE;
    label[20] = label[21] = LABEL_BODY;
    for (const i of [0, 1, 11, 12]) fg[i] = 1;
    fg[20] = fg[21] = 1;
    spreadLabels(size, label, fg, new Uint8Array(fg.length));
    const at = (x: number, y: number) => label[y * size.width + x];
    expect(at(3, 0)).toBe(LABEL_FACE); // along paint from the face
    expect(at(9, 0)).toBe(LABEL_BODY); // along paint from the body
    // A lone speck no labelled paint touches: across the backdrop.
    expect(at(7, 3)).toBe(LABEL_BODY);
    expect(at(5, 2)).toBe(0); // backdrop stays unlabelled
  });

  it("never spreads hair into a never-hair region", () => {
    const { size, m: fg } = art(["#####"]);
    const label = new Uint8Array(5);
    label[0] = LABEL_HAIR;
    label[4] = LABEL_FACE;
    const noHair = new Uint8Array([0, 1, 1, 0, 0]);
    spreadLabels(size, label, fg, noHair);
    expect([...label]).toEqual([
      LABEL_HAIR,
      LABEL_FACE,
      LABEL_FACE,
      LABEL_FACE,
      LABEL_FACE,
    ]);
  });
});

describe("joinInk", () => {
  it("gives the hair ink beside it and a line joined to it, along the line only so far", () => {
    // Hair on the left; a one-pixel line leaving it, 14 px long; a block of
    // cloth touching the hair.
    const rows = [
      "hhhh...............",
      "hhhhLLLLLLLLLLLLLL.",
      "hhhh...............",
      "hhhhCCCCCCCC.......",
      "....CCCCCCCC.......",
      "....CCCCCCCC.......",
      "....CCCCCCCC.......",
      "....CCCCCCCC.......",
      "....CCCCCCCC.......",
      "....CCCCCCCC.......",
    ];
    const { size, m: hair } = art(rows, "h");
    const ink = art(rows, "LC").m;
    const out = joinInk(size, hair, ink);
    const at = (x: number, y: number) => out[y * size.width + x];
    // The line: within reach along it, not past.
    expect(at(4 + 7, 1)).toBe(1);
    expect(at(4 + 9, 1)).toBe(0);
    // The cloth: only a rim of INK_REACH px.
    expect(at(6, 6)).toBe(1);
    expect(at(10, 8)).toBe(0);
  });
});

describe("releaseLines", () => {
  it("lets a thin hair-coloured line that touches skin go, and keeps a wisp the backdrop separates", () => {
    // `s` skin, `l` a thin hair-coloured line on the skin's edge, `w` a
    // thin wisp across a gap of backdrop, `H` a thick lock.
    const rows = [
      "ssssssssss..........",
      "ssssssssss..........",
      "llllllllll..........",
      "....................",
      "wwwwwwwwww.HHHHHHHH.",
      "...........HHHHHHHH.",
      "...........HHHHHHHH.",
      "...........HHHHHHHH.",
      "...........HHHHHHHH.",
    ];
    const { size, m: hair } = art(rows, "lwH");
    const skin = art(rows, "s").m;
    const solid = art(rows, "slwH").m;
    const out = releaseLines(
      size,
      hair,
      skin,
      solid,
      new Uint8Array(hair.length),
    );
    expect(rowsOf(size, out)).toEqual([
      "....................",
      "....................",
      "....................",
      "....................",
      "##########.########.",
      "...........########.",
      "...........########.",
      "...........########.",
      "...........########.",
    ]);
  });
});

describe("hairRungPockets", () => {
  it("keys a small hair-rung pocket and leaves one over the size cap", () => {
    // 200 x 200 of hair on a flat backdrop, two squares of backdrop colour
    // in it: 16 x 16 (256 px, under the cap of 1 % = 400 px) and 30 x 30.
    const width = 200;
    const height = 200;
    const n = width * height;
    const BACK: [number, number, number] = [240, 240, 240];
    const rgb = new Float32Array(n * 3);
    const label = new Uint8Array(n).fill(LABEL_HAIR);
    const square = (x0: number, y0: number, side: number) => {
      for (let y = y0; y < y0 + side; y++) {
        for (let x = x0; x < x0 + side; x++) {
          rgb.set(BACK, (y * width + x) * 3);
          label[y * width + x] = LABEL_BODY;
        }
      }
    };
    for (let i = 0; i < n; i++) rgb.set([240, 150, 175], i * 3);
    square(30, 30, 16);
    square(110, 110, 30);
    const pic = {
      width,
      height,
      rgb,
      alpha: new Float32Array(n).fill(1),
      background: "flat" as const,
      backdrop: BACK,
    };
    const labels = {
      label,
      fg: new Uint8Array(n).fill(1),
    } as unknown as IllustrationLabels;
    // The picture at the canvas's own size: a seed reads the same colour.
    const rgba = Buffer.alloc(n * 4, 255);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = rgb[i * 3 + c];
    }
    const source = { width, height, rgba, source: { width, height, rgba } };
    const keyed = hairRungPockets(pic, labels, [], source);
    expect(keyed).toHaveLength(1);
    const [x, y] = keyed[0];
    expect(x >= 30 && x < 46 && y >= 30 && y < 46).toBe(true);
    // A paint seed inside it stops it too.
    expect(hairRungPockets(pic, labels, [[38, 38]], source)).toEqual([]);
  });
});

describe("strandsThrough", () => {
  it("carries a slanted strand and a straight one through a brow band, not the brow beside them", () => {
    // A band on rows 6..9 (its zone, grown by 4, rows 2..13); a strand
    // leaning half a px across per px down, a straight one, and a brow on
    // rows 7..8 across the whole width, drawn over both.
    const size = { width: 24, height: 16 };
    const n = size.width * size.height;
    const at = (x: number, y: number) => y * size.width + x;
    const bands = new Uint8Array(n);
    const strands = new Uint8Array(n);
    const brow = new Uint8Array(n);
    for (let y = 0; y < size.height; y++) {
      for (let x = 0; x < size.width; x++) {
        const lean = Math.floor(2 + y / 2);
        if (y >= 6 && y <= 9) bands[at(x, y)] = 1;
        if ((x >= lean && x <= lean + 2) || (x >= 18 && x <= 20)) {
          strands[at(x, y)] = 1;
        }
        if (y === 7 || y === 8) brow[at(x, y)] = 1;
      }
    }
    const through = strands.map((v, i) => (v || brow[i] ? 1 : 0));
    const out = strandsThrough(size, bands, strands, through);
    for (let y = 2; y <= 13; y++) {
      expect(out[at(Math.floor(2 + y / 2) + 1, y)], `lean row ${y}`).toBe(1);
      for (const x of [18, 19, 20])
        expect(out[at(x, y)], `straight ${x},${y}`).toBe(1);
    }
    // The brow off the strands, and the skin, stay out.
    for (const x of [0, 9, 10, 11, 12, 13, 14, 15, 23]) {
      for (const y of [6, 7, 8, 9]) expect(out[at(x, y)], `${x},${y}`).toBe(0);
    }
  });
});

describe("hairThroughBox", () => {
  // A 30 px square of skin; an eye box [10, 10, 20, 20]; a pale strand
  // crossing its right edge and running on past it; a dark lash and a pale
  // hair-coloured mark inside it, joined to nothing outside.
  const size = { width: 30, height: 30 };
  const n = size.width * size.height;
  const at = (x: number, y: number) => y * size.width + x;
  function picture(lashClass: number) {
    const rgb = new Float32Array(n * 3);
    const classes = new Uint8Array(n).fill(SKIN);
    for (let i = 0; i < n; i++) rgb.set([250, 220, 200], i * 3);
    for (let y = 0; y < 30; y++) {
      for (let x = 18; x <= 21; x++) {
        rgb.set([240, 150, 175], at(x, y) * 3);
        classes[at(x, y)] = HAIR;
      }
    }
    for (let x = 11; x <= 16; x++) {
      for (const y of [12, 13]) {
        rgb.set([40, 25, 30], at(x, y) * 3);
        classes[at(x, y)] = lashClass;
      }
    }
    for (const [x, y] of [
      [12, 16],
      [13, 16],
      [12, 17],
      [13, 17],
    ]) {
      rgb.set([240, 150, 175], at(x, y) * 3);
      classes[at(x, y)] = HAIR;
    }
    const pic = {
      ...size,
      rgb,
      alpha: new Float32Array(n).fill(1),
      background: "transparent" as const,
    };
    return { pic, classes };
  }

  it("keeps the strand crossing the box as hair when the lash's ink is not hair-coloured", () => {
    const { pic, classes } = picture(NEITHER);
    const hair = hairThroughBox(pic, [10, 10, 20, 20], classes);
    for (let y = 10; y <= 20; y++) {
      for (const x of [18, 19, 20]) expect(hair[at(x, y)], `${x},${y}`).toBe(1);
    }
    expect(hair[at(21, 15)]).toBe(0); // outside the box
    expect(hair[at(12, 16)]).toBe(0); // joined to nothing outside
    expect(hair[at(12, 12)]).toBe(0); // the lash
  });

  it("gives everything in the box to the eye when the lash's ink is hair-coloured", () => {
    const { pic, classes } = picture(HAIR);
    expect([...hairThroughBox(pic, [10, 10, 20, 20], classes)]).toEqual(
      new Array(n).fill(0),
    );
  });
});
