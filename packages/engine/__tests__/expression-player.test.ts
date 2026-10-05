import { describe, expect, it } from "vitest";
import type {
  IkiExpression,
  IkiExpressionBlend,
  IkiParameter,
} from "@ikijs/format";
import { ExpressionPlayer } from "../src/expression-player";

// --- Test harness ------------------------------------------------------------
// Times are dyadic fractions (1/16, 1/64, ...) so every fade weight, and every
// value built from it, is exact and can be compared with `toBe`.

function param(id: string, min = -100, max = 100, def = 0): IkiParameter {
  return { id, min, max, default: def };
}

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

    // result = base + (blended - base) * w; a zero-dt step re-samples the same
    // weight over the other base.
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

  it("chains released entries oldest first, then the active one", () => {
    const { player, step } = makeStage(
      [
        expr("A", { X: 2 }, { fadeOut: 1 }),
        expr("B", { X: [3, "multiply"] }, { fadeOut: 1 }),
        expr("C", { X: [5, "overwrite"] }, { fadeIn: 1 }),
      ],
      [param("X", -100, 100, 1)],
    );
    player.play("A");
    player.play("B");
    player.play("C");
    // All three at w = 0.5: A takes 1 to 2, B takes 2 to 4, C takes 4 to 4.5.
    // Any other order gives something else (B, A, C gives 4).
    expect(step(0.5).get("X")).toBe(4.5);
  });
});

// --- Fades -------------------------------------------------------------------

describe("ExpressionPlayer fades", () => {
  it("reaches half weight at half of fadeIn", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 0.5 })],
      [param("X")],
    );
    player.play("A");
    expect(step(0).get("X")).toBe(0);
    expect(run(2, 1 / 16).get("X")).toBe(2); // t = 0.125
    expect(run(2, 1 / 16).get("X")).toBe(4); // t = 0.25: half weight
    expect(run(4, 1 / 16).get("X")).toBe(8); // t = 0.5: full
    expect(run(4, 1 / 16).get("X")).toBe(8); // held
  });

  it("fades a stop at weight 0.25 linearly from 0.25 over the whole fadeOut", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 1, fadeOut: 1 })],
      [param("X", -100, 100, 1)],
    );
    player.play("A");
    expect(run(4, 1 / 16).get("X")).toBe(3); // a quarter into fadeIn: w = 0.25
    player.stop();
    expect(step(0).get("X")).toBe(3);
    expect(run(4, 1 / 16).get("X")).toBe(2.5); // 0.25 s: w = 0.1875, not yet 0
    expect(run(4, 1 / 16).get("X")).toBe(2); // 0.5 s: w = 0.125
    expect(run(7, 1 / 16).get("X")).toBe(1.125); // 0.9375 s: w = 1/64
    expect(step(1 / 16).get("X")).toBe(1); // 1 s: base, its last write
    expect(step(1 / 16).has("X")).toBe(false);
  });

  it("switches from A to B continuously, each frame's step within the fade slopes", () => {
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
    // No entry moves a value by more than 12 (B overwriting A's 8 with -4),
    // and a weight moves at most dt / fade per frame.
    const bound = dt * 12 * (1 / 0.5 + 1 / 0.25);
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
    for (let k = 0; k < 32; k++) frame = record(dt);
    // A released at 0.5 still takes its whole 0.5 s fadeOut.
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

  it("switches on and off in a single frame with zero fades", () => {
    const { player, step } = makeStage(
      [expr("A", { X: 5 }), expr("B", { Y: [3, "overwrite"] })],
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
});

// --- The slot ----------------------------------------------------------------

describe("ExpressionPlayer slot", () => {
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

  it("does nothing when the active id is played again", () => {
    const { player, step, run } = makeStage(
      [expr("A", { X: 8 }, { fadeIn: 0.5, fadeOut: 0.5 })],
      [param("X")],
    );
    player.play("A");
    expect(run(2, 1 / 16).get("X")).toBe(2); // t = 0.125: w = 0.25
    expect(player.play("A")).toBe(true);
    // The fade-in runs on: restarting it from 0.25 would give 3.5 here.
    expect(run(2, 1 / 16).get("X")).toBe(4);
    expect(run(4, 1 / 16).get("X")).toBe(8);

    expect(player.play("A")).toBe(true);
    for (let k = 0; k < 8; k++) expect(step(1 / 16).get("X")).toBe(8);
  });

  it("brings an add of 1 replayed mid-fade-out back from its weight, never past base + 1, in one entry", () => {
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
    for (let k = 1; k <= 16; k++) expect(record(dt)).toBe(3 - k / 32);

    // w = 0.5, a quarter second into the fade-out.
    expect(player.play("A")).toBe(true);
    expect(record(0)).toBe(2.5);
    for (let k = 1; k <= 32; k++) expect(record(dt)).toBe(2.5 + (0.5 * k) / 32);
    for (let k = 0; k < 16; k++) expect(record(dt)).toBe(3);

    for (let i = 0; i < xs.length; i++) {
      expect(xs[i]).toBeLessThanOrEqual(3);
      if (i > 0) {
        expect(Math.abs(xs[i] - xs[i - 1])).toBeLessThanOrEqual(dt / 0.5);
      }
    }

    // A single entry: a stop now fades from full to base over exactly
    // fadeOut, then nothing writes X.
    player.stop();
    expect(run(31, dt).get("X")).toBe(2 + 1 / 32);
    expect(step(dt).get("X")).toBe(2);
    expect(step(dt).size).toBe(0);
  });

  it("keeps one entry per id through A, then B, then A while A still fades out", () => {
    const { player, step, run } = makeStage(
      [
        expr("A", { X: 4 }, { fadeIn: 0.5, fadeOut: 0.5 }),
        expr("B", { Y: 4 }, { fadeIn: 0.5, fadeOut: 0.5 }),
      ],
      [param("X"), param("Y")],
    );
    player.play("A");
    expect(run(8, 1 / 16).get("X")).toBe(4);

    player.play("B");
    const mid = run(4, 1 / 16); // A and B both at w = 0.5
    expect(mid.get("X")).toBe(2);
    expect(mid.get("Y")).toBe(2);

    player.play("A");
    for (let k = 1; k <= 8; k++) {
      const frame = step(1 / 16);
      expect(frame.get("X")).toBe(2 + (2 * k) / 8);
      expect(frame.get("Y")).toBe(2 - (2 * k) / 8);
    }
    const after = step(1 / 16);
    expect(after.get("X")).toBe(4);
    expect(after.has("Y")).toBe(false);

    // Only A's one entry is left: once it fades out, nothing is written.
    player.stop();
    expect(run(8, 1 / 16).get("X")).toBe(0);
    expect(step(1 / 16).size).toBe(0);
  });

  it("revives an expression from the middle of the released list, the others keeping their order", () => {
    const { player, step } = makeStage(
      [
        expr("A", { X: [9, "overwrite"] }, { fadeOut: 1 }),
        expr("B", { X: [0.5, "multiply"] }, { fadeOut: 1 }),
        expr("C", { X: [2, "multiply"] }, { fadeOut: 1 }),
        expr("D", { X: 1 }, { fadeOut: 1 }),
      ],
      [param("X", -100, 100, 1)],
    );
    for (const id of ["A", "B", "C", "D"]) {
      player.play(id);
      step(0.25);
    }
    // Released A, B, C; B is in the middle at w = 0.5. Reviving it leaves A,
    // C, then the newly released D, with B active over them.
    expect(player.play("B")).toBe(true);
    // A at 0.25 takes 1 to 3, C at 0.75 takes 3 to 5.25, D at 1 to 6.25, and
    // B at 1 halves that. B left in its old place would give 3.625; C before
    // A, 2.28125.
    expect(step(0).get("X")).toBe(3.125);
    // A reaches 0 and writes its base; C at 0.5 takes 1 to 1.5, D at 0.75 to
    // 2.25, and B halves that.
    expect(step(0.25).get("X")).toBe(1.125);
  });

  it("writes a completed release's parameters at base once, then leaves them alone", () => {
    // A and B share X; only A holds Y.
    const expressions = [
      expr("A", { X: 4, Y: [6, "overwrite"] }, { fadeOut: 0.25 }),
      expr("B", { X: 1 }, { fadeIn: 0.25 }),
    ];
    const params = [param("X", -100, 100, 1), param("Y", -100, 100, 2)];

    const fromRest = makeStage(expressions, params);
    fromRest.player.play("A");
    expect(fromRest.step(1 / 16).get("Y")).toBe(6);
    fromRest.player.play("B");
    expect(fromRest.run(3, 1 / 16).get("Y")).toBe(3); // w = 0.25
    let frame = fromRest.step(1 / 16); // A's release completes
    expect(frame.get("Y")).toBe(2);
    expect(frame.get("X")).toBe(2); // B's add, the only one left on X
    for (let k = 0; k < 8; k++) {
      frame = fromRest.step(1 / 16);
      expect(frame.has("Y")).toBe(false);
      expect(frame.get("X")).toBe(2);
    }

    const upstream = makeStage(expressions, params);
    const up = { Y: -3 };
    upstream.player.play("A");
    expect(upstream.step(1 / 16, up).get("Y")).toBe(6);
    upstream.player.play("B");
    for (let k = 0; k < 3; k++) upstream.step(1 / 16, up);
    expect(upstream.step(1 / 16, up).get("Y")).toBe(-3);
  });
});
