import { describe, expect, it } from "vitest";
import { validateLandmarks } from "../src/illustration-landmarks";
import { AutoRigInputError } from "../src/limits";

const CANVAS = { width: 1100, height: 1100 };

/** A complete set, every optional key given, on a 1100 x 1100 canvas. */
function full(): Record<string, any> {
  return {
    samples: {
      hair: {
        base: [[550, 100]],
        shadow: [[400, 250]],
        highlight: [[600, 80]],
      },
      skin: { base: [[450, 540]], shadow: [[550, 640]] },
    },
    eyes: {
      L: {
        box: [603, 344, 747, 472],
        iris: { cx: 659, cy: 418, rx: 38, ry: 47 },
      },
      R: {
        box: [354, 344, 500, 472],
        iris: { cx: 442, cy: 418, rx: 38, ry: 47 },
      },
    },
    brows: {
      L: {
        line: [
          [753, 321],
          [656, 301],
          [609, 306],
        ],
        halfWidth: 6,
        tailHalfWidth: 4,
      },
      R: {
        line: [
          [348, 321],
          [445, 301],
          [492, 306],
        ],
      },
    },
    nose: { box: [536, 472, 564, 508] },
    mouth: {
      box: [496, 546, 606, 586],
      cornerL: [505, 557],
      cornerR: [598, 557],
    },
    frontHair: [
      [545, 30],
      [338, 400],
      [762, 400],
    ],
    skull: [
      [345, 400],
      [550, 168],
      [755, 400],
    ],
    shellLower: [
      [296, 380],
      [550, 548],
      [804, 380],
    ],
    skinSeeds: [
      [450, 540],
      [650, 540],
    ],
    bodySeeds: [[550, 900]],
    backgroundSeeds: [[200, 1000]],
    paintSeeds: [[210, 990]],
    neckTopY: 520,
    bodyOnly: [
      [
        [380, 880],
        [720, 880],
        [760, 1099],
        [340, 1099],
      ],
    ],
    customParts: [
      {
        id: "tail_R",
        tie: [292, 115],
        side: "left",
        line: [
          [302, 90],
          [262, 250],
          [283, 420],
        ],
        below: 400,
        ribbonBox: [255, 55, 325, 135],
      },
      {
        id: "tail_L",
        tie: [806, 112],
        polygon: [
          [798, 90],
          [840, 260],
          [818, 420],
        ],
      },
    ],
  };
}

/** `full()` with every optional key left out. */
function minimal(): Record<string, any> {
  const lm = full();
  delete lm.samples.hair.shadow;
  delete lm.samples.hair.highlight;
  delete lm.samples.skin.shadow;
  delete lm.brows;
  delete lm.nose;
  delete lm.backgroundSeeds;
  delete lm.paintSeeds;
  delete lm.bodyOnly;
  delete lm.customParts;
  return lm;
}

/** `n` distinct points, row by row from the canvas's top-left. */
const points = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => [i % 1100, 10 + Math.floor(i / 1100)]);

/** `n` polygon cuts with distinct ids. */
const polygonCuts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `part${i}`,
    tie: [10, 10],
    polygon: [
      [0, 0],
      [20, 0],
      [0, 20],
    ],
  }));

function messageOf(input: unknown): string {
  try {
    validateLandmarks(input, CANVAS);
  } catch (e) {
    expect(e).toBeInstanceOf(AutoRigInputError);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("validateLandmarks", () => {
  it("returns a complete set as given, the brow defaults filled in", () => {
    const input = full();
    const out = validateLandmarks(input, CANVAS);
    const expected = full();
    expected.brows.R.halfWidth = 8;
    expected.brows.R.tailHalfWidth = 5;
    expect(out).toEqual(expected);
    // The input is left as the caller wrote it.
    expect(input).toEqual(full());
  });

  it("fills in the empty lists for the keys left out", () => {
    const out = validateLandmarks(minimal(), CANVAS);
    expect(out.backgroundSeeds).toEqual([]);
    expect(out.paintSeeds).toEqual([]);
    expect(out.bodyOnly).toEqual([]);
    expect(out.customParts).toEqual([]);
    expect(out).not.toHaveProperty("brows");
    expect(out).not.toHaveProperty("nose");
    expect(out.samples).toEqual({
      hair: { base: [[550, 100]] },
      skin: { base: [[450, 540]] },
    });
  });

  it("keeps a side cut without a ribbon box and a brows object with one side", () => {
    const lm = minimal();
    lm.brows = {
      L: {
        line: [
          [753, 321],
          [609, 306],
        ],
      },
    };
    lm.customParts = [
      {
        id: "tail",
        tie: [292, 115],
        side: "right",
        line: [
          [302, 90],
          [283, 420],
        ],
        below: 0,
      },
    ];
    const out = validateLandmarks(lm, CANVAS);
    expect(out.brows).toEqual({
      L: {
        line: [
          [753, 321],
          [609, 306],
        ],
        halfWidth: 8,
        tailHalfWidth: 5,
      },
    });
    expect(out.customParts[0]).not.toHaveProperty("ribbonBox");
  });

  it("accepts the last row and column, the list caps, and the editor's id rule", () => {
    const lm = full();
    lm.skinSeeds.push([1099, 1099]);
    lm.customParts[0].ribbonBox = [1000, 1000, 1099, 1099];
    lm.customParts[0].id = "_tail";
    lm.frontHair = points(2000);
    const out = validateLandmarks(lm, CANVAS);
    expect(out.skinSeeds.at(-1)).toEqual([1099, 1099]);
    expect(out.frontHair).toHaveLength(2000);
    expect(out.customParts[0]).toMatchObject({
      id: "_tail",
      ribbonBox: [1000, 1000, 1099, 1099],
    });
    const many = full();
    many.customParts = polygonCuts(16);
    expect(validateLandmarks(many, CANVAS).customParts).toHaveLength(16);
  });

  it("lists the keys there are when it refuses an unknown one", () => {
    const lm = full();
    lm.eyes.L.iris.r = 5;
    expect(messageOf(lm)).toBe(
      "landmarks.eyes.L.iris.r is not one of cx, cy, rx, ry",
    );
    const top = full();
    top.mouthBox = [0, 0, 1, 1];
    expect(messageOf(top)).toBe(
      "landmarks.mouthBox is not one of samples, eyes, brows, nose, mouth, frontHair, skull, shellLower, skinSeeds, bodySeeds, backgroundSeeds, paintSeeds, neckTopY, bodyOnly, customParts",
    );
  });

  /** [what, how the full set is broken, the message's start]. */
  const refusals: [string, (lm: Record<string, any>) => unknown, string][] = [
    // the shape of the record
    ["a non-object", () => null, "landmarks must be a plain object"],
    ["an array", () => [], "landmarks must be a plain object"],
    [
      "a non-object group",
      (lm) => void (lm.samples = 3),
      "landmarks.samples must be a plain object",
    ],
    [
      "a non-array custom list",
      (lm) => void (lm.customParts = {}),
      "landmarks.customParts must be an array",
    ],
    [
      "a null custom list",
      (lm) => void (lm.customParts = null),
      "landmarks.customParts must be an array, got null",
    ],

    // list caps
    [
      "an outsized polygon",
      (lm) => void (lm.frontHair = points(2001)),
      "landmarks.frontHair has 2001 points, over the 2000 a landmark list may hold",
    ],
    [
      "an outsized sample list",
      (lm) => void (lm.samples.hair.base = points(2001)),
      "landmarks.samples.hair.base has 2001 points, over the 2000",
    ],
    [
      "too many custom parts",
      (lm) => void (lm.customParts = polygonCuts(17)),
      "landmarks.customParts has 17 entries, over the 16 custom parts one picture may cut",
    ],

    // holes, and values JSON cannot hold
    [
      "a hole in a point list",
      (lm) => void (lm.skinSeeds = [[450, 540], , [650, 540]]),
      "landmarks.skinSeeds[1] must be an [x, y] pair of finite numbers, got undefined",
    ],
    [
      "a hole in a point",
      (lm) => void (lm.skinSeeds[0] = [, 540]),
      "landmarks.skinSeeds[0] must be an [x, y] pair of finite numbers, got [null,540]",
    ],
    [
      "a hole in a box",
      (lm) => void (lm.nose.box = [536, , 564, 508]),
      "landmarks.nose.box must be [x0, y0, x1, y1], four finite numbers, got [536,null,564,508]",
    ],
    [
      "a hole in the custom list",
      (lm) => void (lm.customParts = [, lm.customParts[1]]),
      "landmarks.customParts[0] must be a plain object, got undefined",
    ],
    [
      "a BigInt row",
      (lm) => void (lm.neckTopY = BigInt(520)),
      "landmarks.neckTopY must be a finite number, got 520n",
    ],
    [
      "a BigInt in a point",
      (lm) => void (lm.skinSeeds[0] = [BigInt(450), 540]),
      'landmarks.skinSeeds[0] must be an [x, y] pair of finite numbers, got ["450n",540]',
    ],

    // required keys
    ...(
      [
        "samples",
        "eyes",
        "mouth",
        "frontHair",
        "skull",
        "shellLower",
        "skinSeeds",
        "bodySeeds",
        "neckTopY",
      ] as const
    ).map((key): [string, (lm: Record<string, any>) => unknown, string] => [
      `no ${key}`,
      (lm) => void delete lm[key],
      `landmarks.${key} is missing`,
    ]),
    [
      "no hair samples",
      (lm) => void delete lm.samples.hair,
      "landmarks.samples.hair is missing",
    ],
    [
      "no skin base",
      (lm) => void delete lm.samples.skin.base,
      "landmarks.samples.skin.base is missing",
    ],
    [
      "no left eye",
      (lm) => void delete lm.eyes.L,
      "landmarks.eyes.L is missing",
    ],
    [
      "no iris",
      (lm) => void delete lm.eyes.R.iris,
      "landmarks.eyes.R.iris is missing",
    ],
    [
      "no iris cy",
      (lm) => void delete lm.eyes.R.iris.cy,
      "landmarks.eyes.R.iris.cy is missing",
    ],
    [
      "no brow line",
      (lm) => void delete lm.brows.L.line,
      "landmarks.brows.L.line is missing",
    ],
    [
      "no nose box",
      (lm) => void delete lm.nose.box,
      "landmarks.nose.box is missing",
    ],
    [
      "no mouth corner",
      (lm) => void delete lm.mouth.cornerR,
      "landmarks.mouth.cornerR is missing",
    ],
    [
      "no custom id",
      (lm) => void delete lm.customParts[1].id,
      "landmarks.customParts[1].id is missing",
    ],
    [
      "no custom tie",
      (lm) => void delete lm.customParts[1].tie,
      "landmarks.customParts[1].tie is missing",
    ],
    [
      "no side-cut below",
      (lm) => void delete lm.customParts[0].below,
      "landmarks.customParts[0].below is missing",
    ],
    [
      "no side-cut side",
      (lm) => void delete lm.customParts[0].side,
      "landmarks.customParts[0].side is missing",
    ],

    // unknown keys at every level
    [
      "an unknown sample group",
      (lm) => void (lm.samples.ink = [[1, 1]]),
      "landmarks.samples.ink is not one of hair, skin",
    ],
    [
      "an unknown hair tone",
      (lm) => void (lm.samples.hair.mid = [[1, 1]]),
      "landmarks.samples.hair.mid is not one of base, shadow, highlight",
    ],
    [
      "an unknown skin tone",
      (lm) => void (lm.samples.skin.highlight = [[1, 1]]),
      "landmarks.samples.skin.highlight is not one of base, shadow",
    ],
    [
      "an unknown eye side",
      (lm) => void (lm.eyes.C = lm.eyes.L),
      "landmarks.eyes.C is not one of L, R",
    ],
    [
      "an unknown eye key",
      (lm) => void (lm.eyes.L.outer = "right"),
      "landmarks.eyes.L.outer is not one of box, iris",
    ],
    [
      "an unknown brow side",
      (lm) => void (lm.brows.left = lm.brows.L),
      "landmarks.brows.left is not one of L, R",
    ],
    [
      "an unknown brow key",
      (lm) => void (lm.brows.R.width = 3),
      "landmarks.brows.R.width is not one of line, halfWidth, tailHalfWidth",
    ],
    [
      "an unknown nose key",
      (lm) => void (lm.nose.tip = [1, 1]),
      "landmarks.nose.tip is not one of box",
    ],
    [
      "an unknown mouth key",
      (lm) => void (lm.mouth.center = [1, 1]),
      "landmarks.mouth.center is not one of box, cornerL, cornerR",
    ],
    [
      "an unknown custom key",
      (lm) => void (lm.customParts[1].ribbon = [1, 1, 2, 2]),
      "landmarks.customParts[1].ribbon is not one of id, tie, polygon, side, line, below, ribbonBox",
    ],

    // finite numbers
    [
      "a NaN iris centre",
      (lm) => void (lm.eyes.L.iris.cx = NaN),
      "landmarks.eyes.L.iris.cx must be a finite number",
    ],
    [
      "a string iris centre",
      (lm) => void (lm.eyes.L.iris.cy = "418"),
      "landmarks.eyes.L.iris.cy must be a finite number",
    ],
    [
      "an infinite neck row",
      (lm) => void (lm.neckTopY = Infinity),
      "landmarks.neckTopY must be a finite number",
    ],
    [
      "a string below",
      (lm) => void (lm.customParts[0].below = "400"),
      "landmarks.customParts[0].below must be a finite number",
    ],
    [
      "a point of strings",
      (lm) => void (lm.skinSeeds[1] = ["650", "540"]),
      "landmarks.skinSeeds[1] must be an [x, y] pair of finite numbers",
    ],
    [
      "a three-number point",
      (lm) => void (lm.mouth.cornerL = [505, 557, 0]),
      "landmarks.mouth.cornerL must be an [x, y] pair of finite numbers",
    ],
    [
      "a non-array point list",
      (lm) => void (lm.bodySeeds = [550, 900]),
      "landmarks.bodySeeds[0] must be an [x, y] pair",
    ],
    [
      "a point list that is no array",
      (lm) => void (lm.skull = "round"),
      "landmarks.skull must be an array of [x, y] points",
    ],
    [
      "a three-number box",
      (lm) => void (lm.nose.box = [536, 472, 564]),
      "landmarks.nose.box must be [x0, y0, x1, y1], four finite numbers",
    ],
    [
      "a box with a NaN",
      (lm) => void (lm.mouth.box[2] = NaN),
      "landmarks.mouth.box must be [x0, y0, x1, y1], four finite numbers",
    ],

    // inside the canvas
    [
      "a seed off the right edge",
      (lm) => void (lm.skinSeeds[1] = [1100, 540]),
      "landmarks.skinSeeds[1] [1100,540] is outside the 1100x1100 canvas",
    ],
    [
      "a sample above the top",
      (lm) => void (lm.samples.hair.base[0] = [550, -1]),
      "landmarks.samples.hair.base[0] [550,-1] is outside the 1100x1100 canvas",
    ],
    [
      "a polygon point off the canvas",
      (lm) => void (lm.frontHair[2] = [762, 1200]),
      "landmarks.frontHair[2] [762,1200] is outside",
    ],
    [
      "a background seed off the canvas",
      (lm) => void (lm.backgroundSeeds[0] = [-5, 10]),
      "landmarks.backgroundSeeds[0] [-5,10] is outside",
    ],
    [
      "a tie off the canvas",
      (lm) => void (lm.customParts[1].tie = [1100, 0]),
      "landmarks.customParts[1].tie [1100,0] is outside",
    ],
    [
      "a custom line point off the canvas",
      (lm) => void (lm.customParts[0].line[0] = [302, -3]),
      "landmarks.customParts[0].line[0] [302,-3] is outside",
    ],
    [
      "an eye box past the right edge",
      (lm) => void (lm.eyes.L.box = [603, 344, 1100, 472]),
      "landmarks.eyes.L.box [603,344,1100,472] reaches outside the 1100x1100 canvas",
    ],
    [
      "a ribbon box past the top",
      (lm) => void (lm.customParts[0].ribbonBox = [255, -1, 325, 135]),
      "landmarks.customParts[0].ribbonBox [255,-1,325,135] reaches outside",
    ],
    [
      "a neck row below the canvas",
      (lm) => void (lm.neckTopY = 1100),
      "landmarks.neckTopY 1100 must be a row of the canvas, 0 <= y < 1100",
    ],
    [
      "a negative neck row",
      (lm) => void (lm.neckTopY = -1),
      "landmarks.neckTopY -1 must be a row of the canvas",
    ],
    [
      "a below past the canvas",
      (lm) => void (lm.customParts[0].below = 1100),
      "landmarks.customParts[0].below 1100 must be a column of the canvas, 0 <= x < 1100",
    ],
    [
      "a negative below",
      (lm) => void (lm.customParts[0].below = -1),
      "landmarks.customParts[0].below -1 must be a column of the canvas, 0 <= x < 1100",
    ],
    [
      "a box past the left edge",
      (lm) => void (lm.nose.box = [-1, 472, 564, 508]),
      "landmarks.nose.box [-1,472,564,508] reaches outside the 1100x1100 canvas",
    ],
    [
      "a box past the bottom",
      (lm) => void (lm.mouth.box = [496, 546, 606, 1100]),
      "landmarks.mouth.box [496,546,606,1100] reaches outside the 1100x1100 canvas",
    ],

    // box sizes
    [
      "a box with no width",
      (lm) => void (lm.nose.box = [536, 472, 536, 508]),
      "landmarks.nose.box [536,472,536,508] must span at least two columns and two rows, x1 > x0 and y1 > y0",
    ],
    [
      "a box upside down",
      (lm) => void (lm.mouth.box = [496, 586, 606, 546]),
      "landmarks.mouth.box [496,586,606,546] must span at least two columns and two rows, x1 > x0 and y1 > y0",
    ],
    [
      "a ribbon box with no height",
      (lm) => void (lm.customParts[0].ribbonBox = [255, 55, 325, 55]),
      "landmarks.customParts[0].ribbonBox [255,55,325,55] must span at least two columns and two rows, x1 > x0 and y1 > y0",
    ],

    // point counts
    [
      "a two-point front hair",
      (lm) => void lm.frontHair.pop(),
      "landmarks.frontHair must have 3 or more points, got 2",
    ],
    [
      "a two-point skull",
      (lm) => void lm.skull.pop(),
      "landmarks.skull must have 3 or more points, got 2",
    ],
    [
      "a two-point custom polygon",
      (lm) => void lm.customParts[1].polygon.pop(),
      "landmarks.customParts[1].polygon must have 3 or more points, got 2",
    ],
    [
      "a one-point shell edge",
      (lm) => void (lm.shellLower = [[296, 380]]),
      "landmarks.shellLower must have 2 or more points, got 1",
    ],
    [
      "a one-point brow",
      (lm) => void (lm.brows.R.line = [[348, 321]]),
      "landmarks.brows.R.line must have 2 or more points, got 1",
    ],
    [
      "a one-point custom line",
      (lm) => void (lm.customParts[0].line = [[302, 90]]),
      "landmarks.customParts[0].line must have 2 or more points, got 1",
    ],
    [
      "no skin seeds",
      (lm) => void (lm.skinSeeds = []),
      "landmarks.skinSeeds must have 1 or more point, got 0",
    ],
    [
      "no body seeds",
      (lm) => void (lm.bodySeeds = []),
      "landmarks.bodySeeds must have 1 or more point, got 0",
    ],
    [
      "no hair base samples",
      (lm) => void (lm.samples.hair.base = []),
      "landmarks.samples.hair.base must have 1 or more point, got 0",
    ],
    [
      "an empty hair shadow list",
      (lm) => void (lm.samples.hair.shadow = []),
      "landmarks.samples.hair.shadow must have 1 or more point, got 0",
    ],
    [
      "an empty hair highlight list",
      (lm) => void (lm.samples.hair.highlight = []),
      "landmarks.samples.hair.highlight must have 1 or more point, got 0",
    ],
    [
      "an empty skin shadow list",
      (lm) => void (lm.samples.skin.shadow = []),
      "landmarks.samples.skin.shadow must have 1 or more point, got 0",
    ],

    // eyes
    [
      "a negative iris radius",
      (lm) => void (lm.eyes.L.iris.rx = -3),
      "landmarks.eyes.L.iris.rx must be a positive number, got -3",
    ],
    [
      "a zero iris radius",
      (lm) => void (lm.eyes.R.iris.ry = 0),
      "landmarks.eyes.R.iris.ry must be a positive number, got 0",
    ],
    [
      "an iris centre outside its box",
      (lm) => void (lm.eyes.L.iris.cx = 442),
      "landmarks.eyes.L.iris centre [442, 418] is outside landmarks.eyes.L.box [603,344,747,472]",
    ],
    [
      "an iris centre below its box",
      (lm) => void (lm.eyes.R.iris.cy = 473),
      "landmarks.eyes.R.iris centre [442, 473] is outside landmarks.eyes.R.box [354,344,500,472]",
    ],
    [
      "a swapped pair of eyes",
      (lm) => void ([lm.eyes.L, lm.eyes.R] = [lm.eyes.R, lm.eyes.L]),
      "landmarks.eyes.L.box centre x 427 is not right of landmarks.eyes.R.box centre x 675: L is the character's left eye, on the viewer's right",
    ],

    // brows
    [
      "a zero brow half-width",
      (lm) => void (lm.brows.L.halfWidth = 0),
      "landmarks.brows.L.halfWidth must be a positive number, got 0",
    ],
    [
      "a negative tail half-width",
      (lm) => void (lm.brows.L.tailHalfWidth = -1),
      "landmarks.brows.L.tailHalfWidth must be a positive number, got -1",
    ],

    // mouth
    [
      "mouth corners the wrong way round",
      (lm) =>
        void ([lm.mouth.cornerL, lm.mouth.cornerR] = [
          lm.mouth.cornerR,
          lm.mouth.cornerL,
        ]),
      "landmarks.mouth.cornerL x 598 must be left of landmarks.mouth.cornerR x 505: cornerL is the viewer's left end",
    ],
    [
      "mouth corners at one x",
      (lm) => void (lm.mouth.cornerR = [505, 570]),
      "landmarks.mouth.cornerL x 505 must be left of landmarks.mouth.cornerR x 505",
    ],
    [
      "a left corner outside the mouth box",
      (lm) => void (lm.mouth.cornerL = [490, 557]),
      "landmarks.mouth.cornerL [490,557] is outside landmarks.mouth.box [496,546,606,586]",
    ],
    [
      "a right corner outside the mouth box",
      (lm) => void (lm.mouth.cornerR = [598, 600]),
      "landmarks.mouth.cornerR [598,600] is outside landmarks.mouth.box",
    ],

    // orderings
    [
      "a shell edge doubling back",
      (lm) => void (lm.shellLower[2] = [550, 380]),
      "landmarks.shellLower[2] x 550 must be greater than landmarks.shellLower[1] x 550: the points run with x strictly ascending",
    ],
    [
      "a custom line running up",
      (lm) => void (lm.customParts[0].line[2] = [283, 200]),
      "landmarks.customParts[0].line[2] y 200 must be greater than landmarks.customParts[0].line[1] y 250: the points run with y strictly ascending",
    ],

    [
      "too many samples in one set",
      (lm) => void (lm.samples.skin.shadow = points(32)),
      "landmarks.samples.skin has 33 points, over the 32 one set may hold",
    ],

    [
      "a paint seed off the canvas",
      (lm) => void (lm.paintSeeds = [[5, 1100]]),
      "landmarks.paintSeeds[0] [5,1100] is outside",
    ],

    // bodyOnly
    [
      "a bodyOnly that is not a list",
      (lm) => void (lm.bodyOnly = { a: 1 }),
      'landmarks.bodyOnly must be an array of polygons, got {"a":1}',
    ],
    [
      "a bodyOnly polygon of two points",
      (lm) =>
        void (lm.bodyOnly[0] = [
          [0, 0],
          [5, 5],
        ]),
      "landmarks.bodyOnly[0] must have 3 or more points, got 2",
    ],
    [
      "a bodyOnly point off the canvas",
      (lm) => void (lm.bodyOnly[0][3] = [340, 1100]),
      "landmarks.bodyOnly[0][3] [340,1100] is outside",
    ],
    [
      "too many bodyOnly polygons",
      (lm) =>
        void (lm.bodyOnly = Array.from({ length: 17 }, () => lm.bodyOnly[0])),
      "landmarks.bodyOnly has 17 polygons, over the 16 one picture may hold",
    ],

    // custom parts
    [
      "an id starting with a digit",
      (lm) => void (lm.customParts[0].id = "1tail"),
      'landmarks.customParts[0].id must be a plain identifier (letters, digits, underscore; not starting with a digit), got "1tail"',
    ],
    [
      "an id with a hyphen",
      (lm) => void (lm.customParts[0].id = "tail-R"),
      "landmarks.customParts[0].id must be a plain identifier",
    ],
    [
      "a non-string id",
      (lm) => void (lm.customParts[0].id = 7),
      "landmarks.customParts[0].id must be a plain identifier (letters, digits, underscore; not starting with a digit), got 7",
    ],
    [
      "a role's name as an id",
      (lm) => void (lm.customParts[1].id = "hair_back"),
      'landmarks.customParts[1].id "hair_back" is a role\'s name',
    ],
    [
      "a side role's name as an id",
      (lm) => void (lm.customParts[0].id = "hair_side_L"),
      'landmarks.customParts[0].id "hair_side_L" is a role\'s name',
    ],
    [
      "a repeated id",
      (lm) => void (lm.customParts[1].id = "tail_R"),
      'landmarks.customParts[1].id "tail_R" repeats an earlier entry\'s id',
    ],
    [
      "both cut forms",
      (lm) => void (lm.customParts[1].below = 700),
      "landmarks.customParts[1] carries both polygon and below: give either polygon, or side, line and below",
    ],
    [
      "neither cut form",
      (lm) => void delete lm.customParts[1].polygon,
      "landmarks.customParts[1] must carry either polygon, or side, line and below",
    ],
    [
      "a side that is no side",
      (lm) => void (lm.customParts[0].side = "up"),
      'landmarks.customParts[0].side must be "left" or "right", got "up"',
    ],
  ];

  it.each(refusals)("refuses %s", (_what, breakIt, start) => {
    const lm = full();
    const replaced = breakIt(lm);
    const message = messageOf(replaced === undefined ? lm : replaced);
    expect(
      message.startsWith(start),
      `${message}\n  should start with\n${start}`,
    ).toBe(true);
  });
});
