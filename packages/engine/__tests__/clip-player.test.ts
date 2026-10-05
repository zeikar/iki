import { describe, expect, it } from "vitest";
import {
  DEFAULT_FADE_SECONDS,
  type IkiMotionClip,
  type IkiMotionInterpolation,
  type IkiParameter,
} from "@ikijs/format";
import { ClipPlayer, fadeWeights } from "../src/clip-player";
import { smoothstep } from "../src/math";

// --- Test harness ------------------------------------------------------------
// Times are dyadic fractions (1/16, 1/64, ...) wherever a test lands on a fade
// edge or a clip end, so float accumulation cannot move a frame across it, and
// a smoothstep of a dyadic fraction is itself exact.

function param(id: string, min = -100, max = 100, def = 0): IkiParameter {
  return { id, min, max, default: def };
}

/** Explicit zero fades: the clip cuts in and out. */
const CUT = { fadeIn: 0, fadeOut: 0 };

/**
 * A fade left out of `opts` is omitted from the clip, as the validator emits
 * it, and so is `interpolation` (it applies to every curve when given).
 */
function clip(
  curves: Record<string, [number, number][]>,
  opts: {
    duration: number;
    fadeIn?: number;
    fadeOut?: number;
    interpolation?: IkiMotionInterpolation;
  },
): IkiMotionClip {
  const { duration, interpolation, ...fades } = opts;
  return {
    description: "test clip",
    duration,
    ...fades,
    curves: Object.entries(curves).map(([parameter, keys]) => ({
      parameter,
      keys,
      ...(interpolation ? { interpolation } : {}),
    })),
  };
}

/**
 * Stands in for IkiMotion's frame: each step builds a fresh frame (pre-filled
 * with any upstream values), applies the player, and mirrors the writes into a
 * `displayed` store that clamps like ParameterStore and holds unwritten ids.
 */
function makeStage(
  motions: Record<string, IkiMotionClip[]> | undefined,
  params: IkiParameter[],
) {
  const player = new ClipPlayer(motions, params);
  const byId = new Map(params.map((p) => [p.id, p]));
  const clampTo = (id: string, v: number) => {
    const p = byId.get(id)!;
    return Math.min(p.max, Math.max(p.min, v));
  };
  const rest = (id: string) => clampTo(id, byId.get(id)!.default);
  const displayed = new Map<string, number>();
  const step = (dtS: number, upstream: Record<string, number> = {}) => {
    const frame = new Map(Object.entries(upstream));
    player.apply(dtS, frame, rest);
    for (const [id, v] of frame) displayed.set(id, clampTo(id, v));
    return frame;
  };
  /** Apply `count` frames of `dtS` and return the last one. */
  const run = (count: number, dtS: number) => {
    let frame = new Map<string, number>();
    for (let i = 0; i < count; i++) frame = step(dtS);
    return frame;
  };
  return { player, step, run, displayed };
}

// --- fadeWeights -------------------------------------------------------------

describe("fadeWeights", () => {
  it("eases the fade-in from 0 to 1 over fadeIn", () => {
    const c = clip({ X: [[0, 1]] }, { duration: 2, fadeIn: 0.5, fadeOut: 0 });
    expect(fadeWeights(c, 0)).toEqual({ wIn: 0, wOut: 1 });
    expect(fadeWeights(c, 0.125)).toEqual({ wIn: 5 / 32, wOut: 1 });
    expect(fadeWeights(c, 0.25)).toEqual({ wIn: 0.5, wOut: 1 });
    expect(fadeWeights(c, 0.375)).toEqual({ wIn: 27 / 32, wOut: 1 });
    expect(fadeWeights(c, 0.5)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, 1)).toEqual({ wIn: 1, wOut: 1 });
  });

  it("eases the fade-out from 1 to 0 over the last fadeOut seconds", () => {
    const c = clip({ X: [[0, 1]] }, { duration: 2, fadeIn: 0, fadeOut: 0.5 });
    expect(fadeWeights(c, 1)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, 1.5)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, 1.625)).toEqual({ wIn: 1, wOut: 27 / 32 });
    expect(fadeWeights(c, 1.75)).toEqual({ wIn: 1, wOut: 0.5 });
    expect(fadeWeights(c, 1.875)).toEqual({ wIn: 1, wOut: 5 / 32 });
    expect(fadeWeights(c, 2)).toEqual({ wIn: 1, wOut: 0 });
  });

  it("clamps both weights outside [0, duration]", () => {
    const c = clip({ X: [[0, 1]] }, { duration: 2, fadeIn: 0.5, fadeOut: 0.5 });
    expect(fadeWeights(c, -1)).toEqual({ wIn: 0, wOut: 1 });
    expect(fadeWeights(c, 3)).toEqual({ wIn: 1, wOut: 0 });
  });

  it("gives 1 for a zero fade", () => {
    const c = clip({ X: [[0, 1]] }, { duration: 2, ...CUT });
    expect(fadeWeights(c, 0)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, 2)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, 3)).toEqual({ wIn: 1, wOut: 1 });
  });

  it("reads an absent fade as DEFAULT_FADE_SECONDS", () => {
    const d = DEFAULT_FADE_SECONDS;
    const duration = 4 * d;
    const c = clip({ X: [[0, 1]] }, { duration });
    expect(fadeWeights(c, 0)).toEqual({ wIn: 0, wOut: 1 });
    expect(fadeWeights(c, d / 2).wIn).toBe(0.5);
    expect(fadeWeights(c, d)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, duration - d)).toEqual({ wIn: 1, wOut: 1 });
    expect(fadeWeights(c, duration - d / 2).wOut).toBeCloseTo(0.5, 12);
    expect(fadeWeights(c, duration)).toEqual({ wIn: 1, wOut: 0 });
  });

  it("caps an absent fade at a shorter clip's duration, so the clip starts at full fade-out weight", () => {
    const duration = DEFAULT_FADE_SECONDS / 2;
    const c = clip({ X: [[0, 1]] }, { duration });
    // Both fades span the whole clip.
    expect(fadeWeights(c, 0)).toEqual({ wIn: 0, wOut: 1 });
    expect(fadeWeights(c, duration / 2)).toEqual({ wIn: 0.5, wOut: 0.5 });
    expect(fadeWeights(c, duration)).toEqual({ wIn: 1, wOut: 0 });
    // Either side alone absent takes the same cap.
    const fadeInOnly = clip({ X: [[0, 1]] }, { duration, fadeIn: 0 });
    expect(fadeWeights(fadeInOnly, duration / 2)).toEqual({
      wIn: 1,
      wOut: 0.5,
    });
  });
});

// --- ClipPlayer surface ------------------------------------------------------

describe("ClipPlayer surface", () => {
  const params = ["X", "Y", "Z", "W"].map((id) => param(id));

  it("reports the Idle loop and every curve parameter once, in insertion order", () => {
    const player = new ClipPlayer(
      {
        Idle: [clip({ X: [[0, 1]], Y: [[0, 1]] }, { duration: 1 })],
        Nod: [
          clip({ Y: [[0, 1]], Z: [[0, 1]] }, { duration: 1 }),
          clip({ X: [[0, 1]], W: [[0, 1]] }, { duration: 1 }),
        ],
      },
      params,
    );
    expect(player.hasIdleLoop).toBe(true);
    expect(player.parameterIds).toEqual(["X", "Y", "Z", "W"]);

    const noIdle = new ClipPlayer(
      { Nod: [clip({ Z: [[0, 1]] }, { duration: 1 })] },
      params,
    );
    expect(noIdle.hasIdleLoop).toBe(false);
    expect(noIdle.parameterIds).toEqual(["Z"]);

    const none = new ClipPlayer(undefined, params);
    expect(none.hasIdleLoop).toBe(false);
    expect(none.parameterIds).toEqual([]);
  });
});

// --- play --------------------------------------------------------------------

describe("ClipPlayer.play", () => {
  it("returns false for an undeclared group or a bad index, and starts nothing", () => {
    const { player, step } = makeStage(
      { Nod: [clip({ X: [[0, 5]] }, { duration: 1 })] },
      [param("X")],
    );
    expect(player.play("Shake", 0)).toBe(false);
    expect(player.play("toString", 0)).toBe(false);
    expect(player.play("Nod", -1)).toBe(false);
    expect(player.play("Nod", 1.5)).toBe(false);
    expect(player.play("Nod", 1)).toBe(false);
    expect(step(0.1).size).toBe(0);
  });

  it("returns true while another clip is running, and the new clip plays", () => {
    const { player, step } = makeStage(
      {
        Nod: [
          clip({ X: [[0, 5]] }, { duration: 1, ...CUT }),
          clip({ Z: [[0, 7]] }, { duration: 1, ...CUT }),
        ],
      },
      [param("X"), param("Z")],
    );
    expect(player.play("Nod", 0)).toBe(true);
    expect(step(0.25).get("X")).toBe(5);
    expect(player.play("Nod", 1)).toBe(true);
    expect(step(0.25).get("Z")).toBe(7);
  });
});

// --- One-shot and replace ----------------------------------------------------

describe("ClipPlayer one-shot", () => {
  it("(a) an id both clips hold at the same value stays put through the replace until the fade-out", () => {
    const { player, step, run } = makeStage(
      {
        Old: [
          clip({ X: [[0, 4]] }, { duration: 2, fadeIn: 0.25, fadeOut: 0.25 }),
        ],
        New: [
          clip({ X: [[0, 4]] }, { duration: 1, fadeIn: 0.25, fadeOut: 0.25 }),
        ],
      },
      [param("X", -10, 10, 1)],
    );
    player.play("Old", 0);
    step(0);
    expect(run(8, 1 / 16).get("X")).toBeCloseTo(4, 12);

    player.play("New", 0);
    expect(step(0).get("X")).toBeCloseTo(4, 12);
    // New's fade-out begins at t = 0.75.
    for (let k = 1; k <= 12; k++) {
      expect(step(1 / 16).get("X")).toBeCloseTo(4, 12);
    }
    // wOut = s(0.75), then s(0.5): eased, not 0.75 then 0.5 in a line.
    expect(step(1 / 16).get("X")).toBeCloseTo(1 + 3 * (27 / 32), 12); // t = 0.8125
    expect(step(1 / 16).get("X")).toBeCloseTo(1 + 3 * 0.5, 12); // t = 0.875
  });

  it("(b) a mid-clip replace keeps every frame-to-frame step within the slope and fade bound", () => {
    const dt = 1 / 64;
    const { player, step, displayed } = makeStage(
      {
        Old: [
          clip(
            {
              X: [
                [0, 0],
                [2, 8],
              ],
              Y: [[0, 6]],
            },
            { duration: 2, fadeIn: 0.5, fadeOut: 0.5 },
          ),
        ],
        New: [
          clip(
            {
              X: [
                [0, -8],
                [2, 0],
              ],
            },
            { duration: 2, fadeIn: 0.5, fadeOut: 0.5 },
          ),
        ],
      },
      [param("X", -8, 8), param("Y", -8, 8)],
    );
    // The eased two-key curve's steepest slope, 1.5 × 8/2 s, plus the whole
    // 16-wide value span over each 0.5 s fade at smoothstep's steepest, 1.5×.
    const bound = dt * (1.5 * 4 + (1.5 * 16) / 0.5 + (1.5 * 16) / 0.5) + 1e-9;
    const xs: number[] = [];
    const ys: number[] = [];
    const record = (frameDt: number) => {
      step(frameDt);
      xs.push(displayed.get("X")!);
      ys.push(displayed.get("Y")!);
    };

    player.play("Old", 0);
    record(0);
    for (let k = 0; k < 64; k++) record(dt); // Old at t = 1: X = 4, Y = 6
    expect(xs.at(-1)).toBeCloseTo(4, 12);
    player.play("New", 0);
    for (let k = 0; k < 160; k++) record(dt); // past New's end

    for (const series of [xs, ys]) {
      for (let i = 1; i < series.length; i++) {
        expect(Math.abs(series[i] - series[i - 1])).toBeLessThanOrEqual(bound);
      }
    }
    expect(xs.at(-1)).toBe(0);
    expect(ys.at(-1)).toBe(0);
  });

  it.each([
    ["short fades", { fadeIn: 0.125, fadeOut: 0.125 }],
    ["fadeOut == duration", { fadeIn: 0.25, fadeOut: 1 }],
    ["fadeIn == duration", { fadeIn: 1, fadeOut: 0.25 }],
    ["overlapping fades", { fadeIn: 0.75, fadeOut: 0.75 }],
    ["default fades", {}],
    // Both absent fades are capped at this clip's duration.
    [
      "default fades on a clip shorter than them",
      { duration: DEFAULT_FADE_SECONDS / 2 },
    ],
  ])(
    "a zero-dt apply right after a replace writes the old clip's displayed pose (%s)",
    (_, fades) => {
      const { player, step, run, displayed } = makeStage(
        {
          Old: [
            clip(
              {
                X: [
                  [0, 0],
                  [1, 8],
                ],
                Y: [[0, -5]],
              },
              { duration: 1, fadeIn: 0.25, fadeOut: 0.25 },
            ),
          ],
          New: [clip({ X: [[0, -6]], Z: [[0, 9]] }, { duration: 1, ...fades })],
        },
        [param("X", -10, 10), param("Y", -10, 10), param("Z", -10, 10, 3)],
      );
      player.play("Old", 0);
      step(0);
      run(6, 1 / 16); // t = 0.375: X = 8 · s(0.375) on the eased curve, Y = -5
      const oldX = 8 * smoothstep(0.375);
      expect(displayed.get("X")).toBeCloseTo(oldX, 12);
      expect(displayed.get("Y")).toBeCloseTo(-5, 12);

      player.play("New", 0);
      const frame = step(0);
      expect(frame.get("X")).toBeCloseTo(oldX, 12);
      expect(frame.get("Y")).toBeCloseTo(-5, 12);
      expect(frame.get("Z")).toBeCloseTo(3, 12); // New's own id starts at base
    },
  );

  it("(c) an id only the old clip animated eases to base over fadeIn, is written at base once, then never again", () => {
    const { player, step, run } = makeStage(
      {
        Old: [
          clip(
            { X: [[0, 2]], Y: [[0, 6]] },
            { duration: 4, fadeIn: 0.25, fadeOut: 0.25 },
          ),
        ],
        // fadeIn + fadeOut <= duration: the fades do not overlap.
        New: [
          clip({ X: [[0, -2]] }, { duration: 2, fadeIn: 0.5, fadeOut: 0.5 }),
        ],
      },
      [param("X", -10, 10), param("Y", -10, 10, 1)],
    );
    player.play("Old", 0);
    step(0);
    expect(run(16, 1 / 16).get("Y")).toBeCloseTo(6, 12);

    player.play("New", 0);
    for (let k = 0; k < 32; k++) {
      const t = k / 64;
      const frame = step(k === 0 ? 0 : 1 / 64);
      expect(frame.get("Y")).toBeCloseTo(
        1 + (6 - 1) * (1 - smoothstep(t / 0.5)),
        12,
      );
    }
    expect(step(1 / 64).get("Y")).toBeCloseTo(1, 12); // t = 0.5: base, once
    for (let k = 0; k < 120; k++) {
      expect(step(1 / 64).has("Y")).toBe(false); // through New's end and past it
    }
  });

  it("(d) an old-only output under a full-length fade-in falls continuously to base, with no jump at the end", () => {
    const dt = 1 / 64;
    const { player, step } = makeStage(
      {
        Old: [clip({ Y: [[0, 10]] }, { duration: 4, ...CUT })],
        New: [clip({ X: [[0, 5]] }, { duration: 1, fadeIn: 1, fadeOut: 0.5 })],
      },
      [param("X", -20, 20), param("Y", -20, 20)],
    );
    player.play("Old", 0);
    step(0);
    expect(step(1 / 16).get("Y")).toBe(10);

    player.play("New", 0);
    // Y = lerp(0, 10, (1 - wIn) * wOut); its steepest slope is just under
    // 20/s, near t = 0.59, where both eased weights fall at once.
    const bound = dt * 20 + 1e-9;
    let prev = 10;
    for (let k = 0; k < 64; k++) {
      const t = k * dt;
      const y = step(k === 0 ? 0 : dt).get("Y")!;
      expect(y).toBeCloseTo(
        10 * (1 - smoothstep(t)) * smoothstep((1 - t) / 0.5),
        12,
      );
      expect(Math.abs(y - prev)).toBeLessThanOrEqual(bound);
      prev = y;
    }
    const end = step(dt); // t = 1
    expect(end.get("Y")).toBe(0);
    expect(Math.abs(prev)).toBeLessThanOrEqual(bound);
    for (let k = 0; k < 10; k++) {
      const frame = step(dt);
      expect(frame.has("Y")).toBe(false);
      expect(frame.has("X")).toBe(false);
    }
  });

  it("(e) replaying the running clip restarts it from t = 0, continuously, in one slot", () => {
    const { player, step, run } = makeStage(
      {
        Nod: [
          clip(
            {
              X: [
                [0, 0],
                [2, 8],
              ],
            },
            { duration: 2, fadeIn: 0.5, fadeOut: 0.5 },
          ),
        ],
      },
      [param("X", -10, 10)],
    );
    player.play("Nod", 0);
    step(0);
    expect(run(16, 1 / 16).get("X")).toBeCloseTo(4, 12); // t = 1

    expect(player.play("Nod", 0)).toBe(true);
    expect(step(0).get("X")).toBeCloseTo(4, 12);
    // One copy from t = 0: lerp(0, lerp(4, sample, wIn), wOut) every frame. The
    // first play would have ended 1 s after the replay; this one runs 2 s.
    for (let k = 1; k < 32; k++) {
      const t = k / 16;
      const wIn = smoothstep(t / 0.5);
      const wOut = smoothstep((2 - t) / 0.5);
      const s = 8 * smoothstep(t / 2); // the eased two-key curve
      expect(step(1 / 16).get("X")).toBeCloseTo((4 + (s - 4) * wIn) * wOut, 12);
    }
    expect(step(1 / 16).get("X")).toBe(0); // t = 2: the end frame
    expect(step(1 / 16).has("X")).toBe(false);
  });

  it("(f) a plain one-shot writes lerp(base, sample, wIn * wOut), peaking below 1 when the fades overlap", () => {
    // fadeIn + fadeOut = 1.25 > duration: the clip never reaches full weight.
    const c = clip(
      {
        X: [[0, 10]],
        Y: [
          [0, -4],
          [1, 12],
        ],
      },
      { duration: 1, fadeIn: 0.625, fadeOut: 0.625 },
    );
    const { player, step } = makeStage({ Nod: [c] }, [
      param("X", -100, 100, 2),
      param("Y", -100, 100, 1),
    ]);
    player.play("Nod", 0);
    let peak = -Infinity;
    for (let k = 0; k < 16; k++) {
      const t = k / 16;
      const frame = step(k === 0 ? 0 : 1 / 16);
      const w = smoothstep(t / 0.625) * smoothstep((1 - t) / 0.625);
      const y = -4 + 16 * smoothstep(t); // the eased two-key curve
      expect(frame.get("X")).toBeCloseTo(2 + (10 - 2) * w, 12);
      expect(frame.get("Y")).toBeCloseTo(1 + (y - 1) * w, 12);
      peak = Math.max(peak, frame.get("X")!);
    }
    expect(peak).toBeLessThan(10);
  });

  it("fades a clip with absent fades in and out over DEFAULT_FADE_SECONDS", () => {
    const d = DEFAULT_FADE_SECONDS;
    const { player, step } = makeStage(
      { Nod: [clip({ X: [[0, 8]] }, { duration: 4 * d })] },
      [param("X")],
    );
    player.play("Nod", 0);
    expect(step(0).get("X")).toBe(0);
    expect(step(d / 2).get("X")).toBeCloseTo(4, 12); // half of the default
    expect(step(d / 2).get("X")).toBeCloseTo(8, 12);
    expect(step(2 * d).get("X")).toBeCloseTo(8, 12); // the fade-out starts
    expect(step(d / 2).get("X")).toBeCloseTo(4, 12);
    // Past the end (summed steps of a tuned default need not land on it
    // exactly): base, once, then nothing.
    expect(step(d).get("X")).toBe(0);
    expect(step(d).has("X")).toBe(false);
  });

  it("fades a replaced curve that overshot its max from the max, not the raw value", () => {
    const { player, step, run, displayed } = makeStage(
      {
        Old: [clip({ X: [[0, 15]] }, { duration: 4, ...CUT })],
        New: [
          clip({ X: [[0, 0]] }, { duration: 2, fadeIn: 0.5, fadeOut: 0.5 }),
        ],
      },
      [param("X", -10, 10)],
    );
    player.play("Old", 0);
    expect(step(0).get("X")).toBe(15);
    expect(displayed.get("X")).toBe(10);

    player.play("New", 0);
    expect(step(0).get("X")).toBe(10);
    expect(run(4, 1 / 16).get("X")).toBeCloseTo(5, 12); // t = 0.25: w = 0.5 of 10, not of 15
  });

  it("cuts to an incoming clip's own output on the next apply when its fadeIn is zero", () => {
    const { player, step } = makeStage(
      {
        Old: [clip({ X: [[0, 8]], Y: [[0, 6]] }, { duration: 4, ...CUT })],
        New: [clip({ X: [[0, -3]] }, { duration: 1, fadeIn: 0, fadeOut: 0.5 })],
      },
      [param("X", -10, 10), param("Y", -10, 10, 2)],
    );
    player.play("Old", 0);
    step(0);
    expect(step(1 / 16).get("X")).toBe(8);

    player.play("New", 0);
    const frame = step(1 / 16);
    expect(frame.get("X")).toBe(-3);
    expect(frame.get("Y")).toBeCloseTo(2, 12); // the old-only id, at base once
    expect(step(1 / 16).has("Y")).toBe(false);
  });

  it("cuts a clip's own ids to base on its end frame when its fadeOut is zero", () => {
    const { player, step, run } = makeStage(
      {
        Nod: [
          clip({ X: [[0, 8]] }, { duration: 0.5, fadeIn: 0.125, fadeOut: 0 }),
        ],
      },
      [param("X", -10, 10, 1)],
    );
    player.play("Nod", 0);
    step(0);
    expect(run(7, 1 / 16).get("X")).toBe(8); // t = 0.4375, full weight
    expect(step(1 / 16).get("X")).toBe(1); // t = 0.5
    expect(step(1 / 16).has("X")).toBe(false);
  });

  it("fades from the pose on screen when a second play lands before the next apply", () => {
    const { player, step, run } = makeStage(
      {
        Old: [clip({ Y: [[0, 6]] }, { duration: 4, ...CUT })],
        A: [clip({ X: [[0, 2]] }, { duration: 1, fadeIn: 0.5, fadeOut: 0 })],
        B: [clip({ X: [[0, -2]] }, { duration: 1, fadeIn: 0.5, fadeOut: 0 })],
      },
      [param("X", -10, 10), param("Y", -10, 10, 1)],
    );
    player.play("Old", 0);
    expect(step(0).get("Y")).toBe(6);

    // A never applies, so the screen still shows Old's Y when B starts.
    player.play("A", 0);
    player.play("B", 0);
    expect(step(0).get("Y")).toBeCloseTo(6, 12);
    expect(run(4, 1 / 16).get("Y")).toBeCloseTo(1 + 5 * 0.5, 12); // t = 0.25: s(0.5)
    expect(run(4, 1 / 16).get("Y")).toBeCloseTo(1, 12); // t = 0.5: base, once
    expect(step(1 / 16).has("Y")).toBe(false);
  });
});

// --- apply -------------------------------------------------------------------

describe("ClipPlayer.apply", () => {
  const motions = {
    Nod: [clip({ X: [[0, 10]] }, { duration: 4, fadeIn: 1, fadeOut: 1 })],
  };

  it("blends a one-shot from the frame value when one is present, else from rest", () => {
    const upstream = makeStage(motions, [param("X", -100, 100, 4)]);
    upstream.player.play("Nod", 0);
    expect(upstream.step(0.5, { X: 2 }).get("X")).toBe(6); // 2 + (10 - 2) * s(0.5)

    const fromRest = makeStage(motions, [param("X", -100, 100, 4)]);
    fromRest.player.play("Nod", 0);
    expect(fromRest.step(0.5).get("X")).toBe(7); // 4 + (10 - 4) * 0.5
  });

  it("writes base on the end frame and leaves the id alone afterwards", () => {
    const short = {
      Nod: [
        clip({ X: [[0, 10]] }, { duration: 0.5, fadeIn: 0.125, fadeOut: 0.25 }),
      ],
    };
    const fromRest = makeStage(short, [param("X", -100, 100, 3)]);
    fromRest.player.play("Nod", 0);
    fromRest.step(0);
    // t = 7/16: wOut = s(0.25) = 5/32, so 3 + (10 - 3) * 5/32.
    expect(fromRest.run(7, 1 / 16).get("X")).toBe(3 + 35 / 32);
    expect(fromRest.step(1 / 16).get("X")).toBe(3);
    for (let k = 0; k < 5; k++) {
      expect(fromRest.step(1 / 16).has("X")).toBe(false);
    }

    const upstream = makeStage(short, [param("X", -100, 100, 3)]);
    upstream.player.play("Nod", 0);
    upstream.step(0, { X: -2 });
    for (let k = 0; k < 6; k++) upstream.step(1 / 16, { X: -2 });
    expect(upstream.step(1 / 16, { X: -2 }).get("X")).toBe(-2 + 12 * (5 / 32));
    expect(upstream.step(1 / 16, { X: -2 }).get("X")).toBe(-2);
    for (let k = 0; k < 5; k++) {
      expect(upstream.step(1 / 16, { X: -2 }).get("X")).toBe(-2);
    }
  });

  it("samples a curve without interpolation smooth, and one marked linear in a straight line", () => {
    const keys: [number, number][] = [
      [0, 0],
      [1, 8],
    ];
    const { player, step, run } = makeStage(
      {
        Nod: [
          {
            description: "test clip",
            duration: 2,
            ...CUT,
            curves: [
              { parameter: "X", keys },
              { parameter: "Y", keys, interpolation: "linear" },
              { parameter: "Z", keys, interpolation: "smooth" },
            ],
          },
        ],
      },
      [param("X"), param("Y"), param("Z")],
    );
    player.play("Nod", 0);
    step(0);
    const quarter = run(4, 1 / 16); // t = 0.25
    expect(quarter.get("X")).toBe(8 * (5 / 32)); // 8 · s(0.25)
    expect(quarter.get("Y")).toBe(2);
    expect(quarter.get("Z")).toBe(8 * (5 / 32));
  });

  it("loops a two-clip Idle group clip 0 -> clip 1 -> clip 0, at full weight", () => {
    // The fades would start each clip at 0; the loop ignores them.
    const { step } = makeStage(
      {
        Idle: [
          clip({ X: [[0, 1]] }, { duration: 1, fadeIn: 0.5, fadeOut: 0.5 }),
          clip({ X: [[0, 2]] }, { duration: 1, fadeIn: 0.5, fadeOut: 0.5 }),
        ],
      },
      [param("X")],
    );
    const xs = [step(0).get("X")];
    for (let k = 0; k < 5; k++) xs.push(step(0.5).get("X"));
    expect(xs).toEqual([1, 1, 2, 2, 1, 1]);
  });

  it("lands every 100 ms update in the right one of two 30 ms Idle clips", () => {
    const { step } = makeStage(
      {
        Idle: [
          clip({ X: [[0, 1]] }, { duration: 0.03 }),
          clip({ X: [[0, 2]] }, { duration: 0.03 }),
        ],
      },
      [param("X")],
    );
    // Start 5 ms in so no update lands exactly on a clip edge, where float
    // rounding may pick either side.
    let elapsedMs = 5;
    const seen = new Set<number>();
    expect(step(0.005).get("X")).toBe(1);
    for (let k = 0; k < 30; k++) {
      elapsedMs += 100;
      const x = step(0.1).get("X")!;
      expect(x).toBe(elapsedMs % 60 < 30 ? 1 : 2);
      seen.add(x);
    }
    expect([...seen].sort()).toEqual([1, 2]);
  });

  it("samples the analytic phase of 1 µs Idle clips under 100 ms updates", () => {
    // 100 ms is 50 000 whole loops. The walk is capped at one pass, so without
    // the modulo the loop would land in the wrong clip at the wrong phase.
    const { step } = makeStage(
      {
        Idle: [
          clip(
            {
              X: [
                [0, 0],
                [1e-6, 1],
              ],
            },
            { duration: 1e-6, interpolation: "linear" },
          ),
          clip(
            {
              X: [
                [0, 2],
                [1e-6, 3],
              ],
            },
            { duration: 1e-6, interpolation: "linear" },
          ),
        ],
      },
      [param("X")],
    );
    let elapsedNs = 0;
    const expected = () => {
      const phase = elapsedNs % 2000;
      return phase < 1000 ? phase / 1000 : 2 + (phase - 1000) / 1000;
    };
    for (const dtNs of [250, 1e8, 1e8, 1e8 + 1500, 1e8, 1e8 + 500, 1e8 + 250]) {
      elapsedNs += dtNs;
      expect(step(dtNs / 1e9).get("X")).toBeCloseTo(expected(), 6);
    }
  });

  it("hands a one-shot over the Idle layer back to the loop after it ends", () => {
    const { player, step, run } = makeStage(
      {
        Idle: [
          clip(
            {
              X: [
                [0, 0],
                [1, 4],
              ],
            },
            { duration: 1, interpolation: "linear" },
          ),
        ],
        Wave: [
          clip(
            { X: [[0, 9]] },
            { duration: 0.5, fadeIn: 0.125, fadeOut: 0.125 },
          ),
        ],
      },
      [param("X")],
    );
    const idleX = (loopT: number) => 4 * (loopT % 1);
    step(0);
    expect(run(4, 1 / 16).get("X")).toBe(idleX(0.25));

    player.play("Wave", 0);
    let loopT = 0.25;
    for (let k = 1; k < 8; k++) {
      loopT += 1 / 16;
      const t = k / 16;
      const w = smoothstep(t / 0.125) * smoothstep((0.5 - t) / 0.125);
      const base = idleX(loopT);
      expect(step(1 / 16).get("X")).toBeCloseTo(base + (9 - base) * w, 12);
    }
    loopT += 1 / 16;
    expect(step(1 / 16).get("X")).toBe(idleX(loopT)); // the end frame
    for (let k = 0; k < 20; k++) {
      loopT += 1 / 16;
      expect(step(1 / 16).get("X")).toBe(idleX(loopT));
    }
  });

  it("plays the Idle group one-shot over its own running loop", () => {
    // The one-shot keeps its fades; the loop under it ignores them.
    const { player, step, run } = makeStage(
      {
        Idle: [
          clip(
            {
              X: [
                [0, 0],
                [1, 4],
              ],
            },
            { duration: 1, fadeIn: 0.25, fadeOut: 0.25 },
          ),
        ],
      },
      [param("X")],
    );
    // The curve is smooth (absent interpolation): an eased 0 -> 4 each pass.
    const curveX = (t: number) => 4 * smoothstep(t);
    const loopX = (loopT: number) => curveX(loopT % 1);
    step(0);
    expect(run(8, 1 / 16).get("X")).toBeCloseTo(loopX(0.5), 12);

    expect(player.play("Idle", 0)).toBe(true);
    for (let k = 1; k < 16; k++) {
      const t = k / 16;
      const w = smoothstep(t / 0.25) * smoothstep((1 - t) / 0.25);
      const base = loopX(0.5 + t);
      expect(step(1 / 16).get("X")).toBeCloseTo(
        base + (curveX(t) - base) * w,
        12,
      );
    }
    expect(step(1 / 16).get("X")).toBeCloseTo(loopX(1.5), 12); // the end frame
    expect(step(1 / 16).get("X")).toBeCloseTo(loopX(1.5625), 12); // the loop alone again
  });

  it("eases an id only the replaced clip held toward the Idle loop's moving base", () => {
    const dt = 1 / 64;
    const { player, step, run, displayed } = makeStage(
      {
        // Y climbs 4/s under everything.
        Idle: [
          clip(
            {
              Y: [
                [0, 0],
                [2, 8],
              ],
            },
            { duration: 2, interpolation: "linear" },
          ),
        ],
        Old: [clip({ Y: [[0, 10]] }, { duration: 4, ...CUT })],
        New: [
          clip({ X: [[0, 3]] }, { duration: 2, fadeIn: 0.5, fadeOut: 0.5 }),
        ],
      },
      [param("X", -20, 20), param("Y", -20, 20)],
    );
    const loopY = (loopT: number) => 4 * loopT; // loopT stays below 2
    step(0);
    player.play("Old", 0);
    expect(run(16, dt).get("Y")).toBe(10); // the loop is at 0.25

    player.play("New", 0);
    // Y = lerp(loop, 10, 1 - wIn): the loop's slope plus the 10-wide gap over
    // fadeIn at smoothstep's steepest, 1.5×.
    const bound = dt * (4 + (1.5 * 10) / 0.5) + 1e-9;
    let prev = displayed.get("Y")!;
    let loopT = 0.25;
    for (let k = 0; k <= 32; k++) {
      if (k > 0) loopT += dt;
      const t = k * dt;
      const y = step(k === 0 ? 0 : dt).get("Y")!;
      const base = loopY(loopT);
      expect(y).toBeCloseTo(base + (10 - base) * (1 - smoothstep(t / 0.5)), 12);
      expect(Math.abs(y - prev)).toBeLessThanOrEqual(bound);
      prev = y;
    }
    // At t = 0.5 Y meets the loop where it is now (3), not where it was (1).
    expect(prev).toBeCloseTo(3, 12);
    for (let k = 0; k < 64; k++) {
      loopT += dt;
      const y = step(dt).get("Y")!;
      expect(y).toBe(loopY(loopT));
      expect(Math.abs(y - prev)).toBeLessThanOrEqual(bound);
      prev = y;
    }
  });
});
