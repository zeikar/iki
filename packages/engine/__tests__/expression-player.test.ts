import { describe, expect, it } from "vitest";
import {
  DEFAULT_FADE_SECONDS,
  type IkiExpression,
  type IkiExpressionBlend,
  type IkiParameter,
} from "@ikijs/format";
import { ExpressionPlayer } from "../src/expression-player";
import { smoothstep } from "../src/math";

// --- Test harness ------------------------------------------------------------
// Times are dyadic fractions (1/16, 1/64, ...) so every eased fade weight (a
// smoothstep of a dyadic fraction), and every value built from it, is exact
// and can be compared with `toBe`.

function param(id: string, min = -100, max = 100, def = 0): IkiParameter {
  return { id, min, max, default: def };
}

/** Explicit zero fades: the expression switches on and off at once. */
const CUT = { fadeIn: 0, fadeOut: 0 };

/**
 * A bare number is an add with `blend` omitted, and a fade left out of `fades`
 * is omitted from the expression, as the validator emits them.
 */
function expr(
  id: string,
  parameters: Record<string, number | [number, IkiExpressionBlend]>,
  fades: { fadeIn?: number; fadeOut?: number } = {},
): IkiExpression {
  return {
    id,
    description: "test expression",
    ...fades,
    parameters: Object.entries(parameters).map(([parameter, v]) =>
      typeof v === "number"
        ? { parameter, value: v }
        : { parameter, value: v[0], blend: v[1] },
    ),
  };
}

/**
 * Stands in for IkiMotion's frame: each step builds a fresh frame (pre-filled
 * with any upstream values), applies the player, and mirrors the writes into a
 * `displayed` store that starts at rest, clamps like ParameterStore and holds
 * unwritten ids.
 */
function makeStage(
  expressions: IkiExpression[] | undefined,
  params: IkiParameter[],
) {
  const player = new ExpressionPlayer(expressions);
  const byId = new Map(params.map((p) => [p.id, p]));
  const clampTo = (id: string, v: number) => {
    const p = byId.get(id)!;
    return Math.min(p.max, Math.max(p.min, v));
  };
  const rest = (id: string) => clampTo(id, byId.get(id)!.default);
  const displayed = new Map(params.map((p) => [p.id, rest(p.id)]));
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

// --- Surface -----------------------------------------------------------------

describe("ExpressionPlayer surface", () => {
  it("reports every expression parameter once, in insertion order", () => {
    const player = new ExpressionPlayer([
      expr("A", { X: 1, Y: [2, "multiply"] }),
      expr("B", { Y: 1, Z: [0, "overwrite"], W: 1 }),
    ]);
    expect(player.parameterIds).toEqual(["X", "Y", "Z", "W"]);
    expect(new ExpressionPlayer(undefined).parameterIds).toEqual([]);
  });

  it("writes nothing while no expression is held", () => {
    const { player, step } = makeStage([expr("A", { X: 1 })], [param("X")]);
    expect(step(1 / 16).size).toBe(0);
    player.stop();
    expect(step(1 / 16).size).toBe(0);
  });
});

// --- Blends ------------------------------------------------------------------

describe("ExpressionPlayer blends", () => {
  it("adds, multiplies and overwrites at w = 0.5 and w = 1, over rest and over a frame base", () => {
    const { player, step } = makeStage(
      [
        expr(
          "Smile",
          { X: 3, Y: [2, "multiply"], Z: [7, "overwrite"] },
          { fadeIn: 1 },
        ),
      ],
      [
        param("X", -100, 100, 1),
        param("Y", -100, 100, 2),
        param("Z", -100, 100, 3),
      ],
    );
    const upstream = { X: 2, Y: -4, Z: 1 };
    player.play("Smile");

    // result = base + (blended - base) * w, with w = s(0.5) = 0.5 here; a
    // zero-dt step re-samples the same weight over the other base.
    expect(Object.fromEntries(step(0.5))).toEqual({ X: 2.5, Y: 3, Z: 5 });
    expect(Object.fromEntries(step(0, upstream))).toEqual({
      X: 3.5,
      Y: -6,
      Z: 4,
    });
    expect(Object.fromEntries(step(0.5))).toEqual({ X: 4, Y: 4, Z: 7 });
    expect(Object.fromEntries(step(0, upstream))).toEqual({
      X: 5,
      Y: -8,
      Z: 7,
    });
    // The base is re-read every frame, so a held add does not accumulate.
    expect(Object.fromEntries(step(0.5))).toEqual({ X: 4, Y: 4, Z: 7 });
  });
});

// --- Fades -------------------------------------------------------------------

describe("ExpressionPlayer fades", () => {
  it("eases in: 5/32 weight a quarter into fadeIn, half at half, 27/32 at three quarters", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 0.5 })],
      [param("X")],
    );
    player.play("A");
    expect(step(0).get("X")).toBe(0);
    expect(run(2, 1 / 16).get("X")).toBe(8 * (5 / 32)); // t = 0.125
    expect(run(2, 1 / 16).get("X")).toBe(4); // t = 0.25: half weight
    expect(run(2, 1 / 16).get("X")).toBe(8 * (27 / 32)); // t = 0.375
    expect(run(2, 1 / 16).get("X")).toBe(8); // t = 0.5: full
    expect(run(4, 1 / 16).get("X")).toBe(8); // held
  });

  it("eases a stop at weight 0.5 out from 0.5 over the whole fadeOut", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 1, fadeOut: 1 })],
      [param("X", -100, 100, 1)],
    );
    player.play("A");
    expect(run(8, 1 / 16).get("X")).toBe(5); // half into fadeIn: w = 0.5
    player.stop();
    expect(step(0).get("X")).toBe(5);
    // X = 1 + 8w, w = 0.5 · (1 - s(elapsed / 1 s)).
    expect(run(4, 1 / 16).get("X")).toBe(1 + 8 * (27 / 64)); // 0.25 s
    expect(run(4, 1 / 16).get("X")).toBe(3); // 0.5 s: w = 0.25
    expect(run(7, 1 / 16).get("X")).toBe(1 + 8 * (23 / 4096)); // 0.9375 s, not yet 0
    expect(step(1 / 16).get("X")).toBe(1); // 1 s: base, its last write
    expect(step(1 / 16).has("X")).toBe(false);
  });

  it("reads an absent fadeIn and fadeOut as DEFAULT_FADE_SECONDS", () => {
    const d = DEFAULT_FADE_SECONDS;
    const { player, step } = makeStage(
      [expr("A", { X: 8 })],
      [param("X", -100, 100, 1)],
    );
    player.play("A");
    expect(step(0).get("X")).toBe(1);
    expect(step(d / 2).get("X")).toBe(5); // half weight
    expect(step(d / 2).get("X")).toBe(9);
    player.stop();
    expect(step(d / 2).get("X")).toBe(5);
    expect(step(d / 2).get("X")).toBe(1); // base, its last write
    expect(step(d / 2).has("X")).toBe(false);
  });

  it("switches on and off in a single frame with zero fades", () => {
    const { player, step } = makeStage(
      [expr("A", { X: 5 }, CUT), expr("B", { Y: [3, "overwrite"] }, CUT)],
      [param("X", -100, 100, 1), param("Y", -100, 100, 2)],
    );
    player.play("A");
    expect(step(0).get("X")).toBe(6);

    player.play("B");
    let frame = step(1 / 16);
    expect(frame.get("X")).toBe(1); // A off: base, its last write
    expect(frame.get("Y")).toBe(3); // B on
    frame = step(1 / 16);
    expect(frame.has("X")).toBe(false);
    expect(frame.get("Y")).toBe(3);

    player.stop();
    expect(step(1 / 16).get("Y")).toBe(2);
    expect(step(1 / 16).size).toBe(0);
  });

  it("lands exactly on base, not a rounding away, when a stop or a replace lets go of an id", () => {
    // A plain lerp from 0.7 to 0.1 at weight 1 gives 0.09999999999999998.
    const expressions = [
      expr("A", { M: [0.7, "overwrite"] }, CUT),
      expr("B", { N: 1 }, CUT),
    ];
    const params = [param("M", 0, 1, 0.1), param("N")];
    const letGo = [
      (p: ExpressionPlayer) => p.stop(),
      (p: ExpressionPlayer) => p.play("B"),
    ];
    for (const release of letGo) {
      const { player, step, displayed } = makeStage(expressions, params);
      player.play("A");
      expect(step(1 / 16).get("M")).toBe(0.7);
      release(player);
      expect(step(1 / 16).get("M")).toBe(0.1);
      expect(step(1 / 16).has("M")).toBe(false);
      expect(displayed.get("M")).toBe(0.1);
    }
  });
});

// --- Replace -----------------------------------------------------------------

describe("ExpressionPlayer replace", () => {
  it("moves the mouth from surprised's 0.7 to laugh's 0.6 over laugh's fadeIn, never dipping toward base", () => {
    const dt = 1 / 64;
    const { player, step, run } = makeStage(
      [
        expr(
          "surprised",
          { MouthOpen: [0.7, "overwrite"] },
          { fadeIn: 0.25, fadeOut: 0.5 },
        ),
        expr(
          "laugh",
          { MouthOpen: [0.6, "overwrite"] },
          { fadeIn: 0.5, fadeOut: 0.5 },
        ),
      ],
      [param("MouthOpen", 0, 1, 0)],
    );
    player.play("surprised");
    expect(run(32, dt).get("MouthOpen")).toBe(0.7);

    player.play("laugh");
    expect(step(0).get("MouthOpen")).toBe(0.7);
    // Fading surprised out toward 0 while laugh faded in over the result
    // half-closed the mouth: 0.475 halfway, then back up to 0.6.
    let prev = 0.7;
    for (let k = 1; k <= 32; k++) {
      const mouth = step(dt).get("MouthOpen")!;
      expect(mouth).toBeCloseTo(0.7 - 0.1 * smoothstep(k / 32), 15);
      expect(mouth).toBeLessThanOrEqual(prev);
      expect(mouth).toBeGreaterThanOrEqual(0.6);
      prev = mouth;
    }
    expect(prev).toBe(0.6); // laugh's 0.5 s fadeIn is over
    expect(run(16, dt).get("MouthOpen")).toBe(0.6);
  });

  it("takes an id only the replaced expression drove to base over the newcomer's fadeIn, writes it there once, then leaves it alone", () => {
    // A and B share X; only A drives Y. A's 1 s fadeOut plays no part.
    const expressions = [
      expr("A", { X: 4, Y: [6, "overwrite"] }, { fadeIn: 0, fadeOut: 1 }),
      expr("B", { X: 1 }, { fadeIn: 0.25 }),
    ];
    const params = [param("X", -100, 100, 1), param("Y", -100, 100, 2)];

    const fromRest = makeStage(expressions, params);
    fromRest.player.play("A");
    expect(fromRest.step(1 / 16).get("Y")).toBe(6);
    fromRest.player.play("B");
    let frame = fromRest.run(3, 1 / 16); // B at w = s(0.75) = 27/32
    expect(frame.get("X")).toBe(5 - 3 * (27 / 32));
    expect(frame.get("Y")).toBe(6 - 4 * (27 / 32));
    frame = fromRest.step(1 / 16); // B's fadeIn is over
    expect(frame.get("X")).toBe(2); // B's add alone
    expect(frame.get("Y")).toBe(2); // base, its last write
    for (let k = 0; k < 16; k++) {
      frame = fromRest.step(1 / 16);
      expect(frame.has("Y")).toBe(false);
      expect(frame.get("X")).toBe(2);
    }
    expect(fromRest.displayed.get("Y")).toBe(2);

    // The base Y lands on is the frame's, when an earlier stage wrote it.
    const upstream = makeStage(expressions, params);
    const up = { Y: -3 };
    upstream.player.play("A");
    expect(upstream.step(1 / 16, up).get("Y")).toBe(6);
    upstream.player.play("B");
    for (let k = 0; k < 3; k++) upstream.step(1 / 16, up);
    expect(upstream.step(1 / 16, up).get("Y")).toBe(-3);
  });

  it("switches from A to B continuously, each frame's step within B's fade slope", () => {
    const dt = 1 / 64;
    const ids = ["X", "Y", "Z"];
    const { player, step, displayed } = makeStage(
      [
        expr("A", { X: 8, Y: [6, "overwrite"] }, { fadeIn: 0.5, fadeOut: 0.5 }),
        expr(
          "B",
          { X: [-4, "overwrite"], Z: 4 },
          { fadeIn: 0.25, fadeOut: 0.25 },
        ),
      ],
      ids.map((id) => param(id)),
    );
    // One fade runs at a time, and none moves a value by more than 8 (A's X
    // from 0 to 8, B's from 4 to -4). An eased weight moves at most
    // 1.5 · dt / fade per frame, and B's 0.25 s is the shorter fade.
    const bound = (dt * 8 * 1.5) / 0.25;
    const series = new Map(ids.map((id) => [id, [displayed.get(id)!]]));
    const record = (frameDt: number) => {
      const frame = step(frameDt);
      for (const id of ids) series.get(id)!.push(displayed.get(id)!);
      return frame;
    };

    player.play("A");
    record(0);
    for (let k = 0; k < 16; k++) record(dt); // A at half weight
    expect(displayed.get("X")).toBe(4);
    expect(displayed.get("Y")).toBe(3);

    player.play("B");
    let frame = record(0);
    for (let k = 0; k < 16; k++) frame = record(dt);
    // B's 0.25 s fadeIn, not A's 0.5 s fadeOut, decides when A is gone.
    expect(frame.get("X")).toBe(-4);
    expect(frame.get("Y")).toBe(0);
    expect(frame.get("Z")).toBe(4);
    frame = record(dt);
    expect(frame.has("Y")).toBe(false);

    for (const values of series.values()) {
      for (let i = 1; i < values.length; i++) {
        expect(Math.abs(values[i] - values[i - 1])).toBeLessThanOrEqual(bound);
      }
    }
  });

  it("replaces an expression still fading in from where its fade got to, which holds there", () => {
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 8 }, { fadeIn: 1 }),
        expr("B", { Y: 4 }, { fadeIn: 0.5 }),
      ],
      [param("X"), param("Y")],
    );
    player.play("A");
    expect(run(8, 1 / 16).get("X")).toBe(4); // A at w = 0.5

    player.play("B");
    let frame = step(0);
    expect(frame.get("X")).toBe(4);
    expect(frame.get("Y")).toBe(0);
    // A stays at 0.5 under B. Were its fade-in still running, X would climb
    // first: A's weight rises fastest at 0.5, B's slowest at 0.
    for (let k = 1; k <= 8; k++) {
      frame = step(1 / 16);
      expect(frame.get("X")).toBe(4 - 4 * smoothstep(k / 8));
      expect(frame.get("Y")).toBe(4 * smoothstep(k / 8));
    }
    frame = step(1 / 16);
    expect(frame.has("X")).toBe(false);
    expect(frame.get("Y")).toBe(4);
  });

  it("fades in from a stop still fading out, continuously, to the new target", () => {
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 8 }, { fadeIn: 0, fadeOut: 0.5 }),
        expr("B", { X: [-4, "overwrite"], Y: 4 }, { fadeIn: 0.5 }),
      ],
      [param("X"), param("Y")],
    );
    player.play("A");
    expect(step(1 / 16).get("X")).toBe(8);
    player.stop();
    expect(run(4, 1 / 16).get("X")).toBe(4); // halfway back to base

    player.play("B");
    let frame = step(0);
    expect(frame.get("X")).toBe(4);
    expect(frame.get("Y")).toBe(0);
    for (let k = 1; k <= 8; k++) {
      frame = step(1 / 16);
      expect(frame.get("X")).toBe(4 - 8 * smoothstep(k / 8));
      expect(frame.get("Y")).toBe(4 * smoothstep(k / 8));
    }
    // B holds; the stop never finished.
    for (let k = 0; k < 8; k++) {
      frame = step(1 / 16);
      expect(frame.get("X")).toBe(-4);
      expect(frame.get("Y")).toBe(4);
    }
  });

  it("never takes an add of 1 past base + 1 through A, B, A, however fast the plays come", () => {
    const dt = 1 / 64;
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 1 }, { fadeIn: 0.5, fadeOut: 0.5 }),
        expr("B", { Y: 1 }, { fadeIn: 0.5, fadeOut: 0.5 }),
      ],
      [param("X", -100, 100, 2), param("Y")],
    );
    player.play("A");
    expect(run(32, dt).get("X")).toBe(3);

    player.play("B");
    let frame = run(16, dt); // B at w = 0.5
    expect(frame.get("X")).toBe(2.5);
    expect(frame.get("Y")).toBe(0.5);

    // A comes back from the 2.5 on screen; A again over the A still showing
    // would head for 4.
    expect(player.play("A")).toBe(true);
    for (let k = 1; k <= 32; k++) {
      frame = step(dt);
      expect(frame.get("X")).toBe(2.5 + 0.5 * smoothstep(k / 32));
      expect(frame.get("Y")).toBe(0.5 - 0.5 * smoothstep(k / 32));
    }
    frame = step(dt);
    expect(frame.get("X")).toBe(3);
    expect(frame.has("Y")).toBe(false);

    // A switch every frame, so no fade ever finishes.
    for (let k = 0; k < 256; k++) {
      player.play(k % 2 === 0 ? "B" : "A");
      expect(step(dt).get("X")).toBeLessThanOrEqual(3);
    }
    frame = run(32, dt); // A, the last played, finishes
    expect(frame.get("X")).toBe(3);
    expect(frame.has("Y")).toBe(false);
  });

  it("keeps a multiply on EyeOpen following the blink before, during and after a replace", () => {
    const dt = 1 / 64;
    // EyeOpen's base is what idle's blink wrote: a new value every frame.
    const blink = [1, 0.75, 0.5, 0.25, 0, 0.25, 0.5, 0.75];
    const { player, step } = makeStage(
      [
        expr("A", { E: [0.5, "multiply"] }, { fadeIn: 0 }),
        expr("B", { E: [0.25, "multiply"] }, { fadeIn: 0.5 }),
        expr("C", { W: 1 }, { fadeIn: 0.5 }),
      ],
      [param("E", 0, 1, 1), param("W")],
    );
    let n = 0;
    /** One frame under the blink: its base and the EyeOpen written over it. */
    const eye = (): [number, number] => {
      const base = blink[n++ % blink.length];
      return [base, step(dt, { E: base }).get("E")!];
    };

    player.play("A");
    for (let k = 0; k < 16; k++) {
      const [b, e] = eye();
      expect(e).toBe(0.5 * b);
    }
    player.play("B");
    for (let k = 1; k <= 32; k++) {
      const [b, e] = eye();
      expect(e).toBe(b * (0.5 - 0.25 * smoothstep(k / 32)));
    }
    for (let k = 0; k < 16; k++) {
      const [b, e] = eye();
      expect(e).toBe(0.25 * b);
    }

    // C leaves E alone, so E eases back to the blink itself, and then the
    // player stops writing it.
    player.play("C");
    for (let k = 1; k <= 32; k++) {
      const [b, e] = eye();
      expect(e).toBe(b * (0.25 + 0.75 * smoothstep(k / 32)));
    }
    expect(step(dt).has("E")).toBe(false);
  });

  it("chains replaces mid-fade as nested lerps over the live base, each covered fade holding where it got to", () => {
    const { player, step } = makeStage(
      [
        expr("A", { X: [9, "overwrite"] }, { fadeIn: 0.5 }),
        expr("B", { X: [0.5, "multiply"] }, { fadeIn: 0.5 }),
        expr("C", { X: [2, "multiply"] }, { fadeIn: 0.5 }),
        expr("D", { X: 1 }, { fadeIn: 0.5 }),
      ],
      [param("X", -100, 100, 1)],
    );
    for (const id of ["A", "B", "C", "D"]) {
      player.play(id);
      step(0.25); // at w = 0.5 when the next one comes
    }
    // Over base 1: A takes 1 halfway to 9 (5), B that halfway to 0.5 (2.75),
    // C halfway to 2 (2.375), D halfway to 2 (2.1875).
    expect(step(0).get("X")).toBe(2.1875);
    // The same weights over base 2: 5.5, 3.25, 3.625, 3.3125.
    expect(step(0, { X: 2 }).get("X")).toBe(3.3125);

    // B again: from that pose, halfway to 0.5, then all the way.
    expect(player.play("B")).toBe(true);
    expect(step(0).get("X")).toBe(2.1875);
    expect(step(0.25).get("X")).toBe(1.34375);
    expect(step(0.25).get("X")).toBe(0.5);
  });
});

// --- Stop --------------------------------------------------------------------

describe("ExpressionPlayer stop", () => {
  it("fades back over the playing expression's fadeOut, not the replaced one's, and a second stop changes nothing", () => {
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 8 }, { fadeIn: 0, fadeOut: 1 }),
        expr("B", { Y: 4 }, { fadeIn: 0.25, fadeOut: 0.25 }),
      ],
      [param("X"), param("Y")],
    );
    player.play("A");
    step(1 / 16);
    player.play("B");
    let frame = run(2, 1 / 16); // B at w = 0.5
    expect(frame.get("X")).toBe(4);
    expect(frame.get("Y")).toBe(2);

    player.stop();
    frame = run(2, 1 / 16); // halfway through B's 0.25 s fadeOut
    expect(frame.get("X")).toBe(2);
    expect(frame.get("Y")).toBe(1);
    // Already fading out: restarting from here would leave X at 1 below.
    player.stop();
    frame = run(2, 1 / 16);
    expect(frame.get("X")).toBe(0);
    expect(frame.get("Y")).toBe(0);
    expect(step(1 / 16).size).toBe(0);
  });

  it("fades an add of 1 replayed mid-stop back in from where the stop got to, never past base + 1", () => {
    const dt = 1 / 64;
    const { player, step, run } = makeStage(
      [expr("A", { X: 1 }, { fadeIn: 0.5, fadeOut: 0.5 })],
      [param("X", -100, 100, 2)],
    );
    const xs: number[] = [];
    const record = (frameDt: number) => {
      const x = step(frameDt).get("X")!;
      xs.push(x);
      return x;
    };

    player.play("A");
    record(0);
    for (let k = 0; k < 40; k++) record(dt);
    expect(xs.at(-1)).toBe(3);

    player.stop();
    for (let k = 1; k <= 16; k++) {
      expect(record(dt)).toBe(3 - smoothstep(k / 32));
    }

    // w = 0.5, a quarter second into the fade-out.
    expect(player.play("A")).toBe(true);
    expect(record(0)).toBe(2.5);
    for (let k = 1; k <= 32; k++) {
      expect(record(dt)).toBe(2.5 + 0.5 * smoothstep(k / 32));
    }
    for (let k = 0; k < 16; k++) expect(record(dt)).toBe(3);

    // An eased weight moves at most 1.5 · dt / fade per frame.
    for (let i = 0; i < xs.length; i++) {
      expect(xs[i]).toBeLessThanOrEqual(3);
      if (i > 0) {
        expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThanOrEqual(
          (1.5 * dt) / 0.5,
        );
      }
    }

    // Nothing of the first A is left: a stop now fades from full to base
    // over exactly fadeOut, then nothing writes X.
    player.stop();
    expect(run(31, dt).get("X")).toBe(3 - smoothstep(31 / 32)); // not yet 2
    expect(step(dt).get("X")).toBe(2);
    expect(step(dt).size).toBe(0);
  });

  it("still shows a zero-fadeIn expression stopped before the next update, fading it out from full", () => {
    // A zero fadeIn is full weight the moment play returns, so a stop in the
    // same tick releases it from full over its fadeOut. With a zero fadeOut
    // as well it never shows: X is written once at base.
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 8 }, { fadeIn: 0, fadeOut: 0.25 }),
        expr("B", { X: 8 }, CUT),
      ],
      [param("X")],
    );
    player.play("A");
    player.stop();
    expect(step(0).get("X")).toBe(8);
    expect(run(2, 1 / 16).get("X")).toBe(4);
    expect(run(2, 1 / 16).get("X")).toBe(0);
    expect(step(1 / 16).size).toBe(0);

    player.play("B");
    player.stop();
    expect(step(0).get("X")).toBe(0);
    expect(step(1 / 16).size).toBe(0);
  });
});

// --- Play --------------------------------------------------------------------

describe("ExpressionPlayer play", () => {
  it("returns false for an undeclared id and changes nothing", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 4 }, { fadeIn: 0.25, fadeOut: 0.25 })],
      [param("X")],
    );
    expect(player.play("B")).toBe(false);
    expect(player.play("toString")).toBe(false);
    expect(step(1 / 16).size).toBe(0);

    player.play("A");
    expect(run(4, 1 / 16).get("X")).toBe(4);
    expect(player.play("B")).toBe(false);
    for (let k = 0; k < 8; k++) expect(step(1 / 16).get("X")).toBe(4);
  });

  it("does nothing when the expression fading in or held is played again", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 0.5, fadeOut: 0.5 })],
      [param("X")],
    );
    player.play("A");
    expect(run(2, 1 / 16).get("X")).toBe(1.25); // t = 0.125: w = s(0.25) = 5/32
    expect(player.play("A")).toBe(true);
    // The fade-in runs on: restarting it from 5/32 would give 2.3046875 here.
    expect(run(2, 1 / 16).get("X")).toBe(4);
    expect(run(4, 1 / 16).get("X")).toBe(8);

    expect(player.play("A")).toBe(true);
    for (let k = 0; k < 8; k++) expect(step(1 / 16).get("X")).toBe(8);
  });
});
