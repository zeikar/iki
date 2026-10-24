import type {
  IkiModel,
  IkiParameter,
  IkiPhysics,
  IkiPhysicsChain,
} from "@ikijs/format";
import { resolveDeformers } from "./deform";
import { FIXED_DT_S } from "./frame-clock";
import { HairChainMotion } from "./hair-chain-motion";
import { IdleMotion } from "./idle-motion";
import { clamp } from "./math";
import { ParameterStore } from "./parameter-store";
import { PhysicsMotion } from "./physics-motion";

// The excitation runs behind `checkPhysics`: the real drivers on a synthetic
// 60 Hz clock, never a re-implemented integrator.

/**
 * A hair over one sub-step: at exactly 1000/60 ms, float rounding leaves the
 * drivers' accumulator just short or just over, so about one frame in three
 * runs no sub-step (re-emitting the last value) and about as many run two
 * (emitting only the second) — and a skipped sub-step can be the peak.
 */
const FRAME_MS = FIXED_DT_S * 1000 * (1 + 1e-9);
/** Frames after the seed frame: 5 s of step (the defaults settle in ~2 s), 30 s of idle. */
const STEP_FRAMES = 300;
const IDLE_FRAMES = 1800;
/** Any constant keeps two checks equal; it only matters for a gaze- or eye-driven rig. */
const IDLE_SEED = 1;
/** An anchor turn, or a lead over another, under this many radians is float noise (a uniform scale over a rotated anchor). */
const MIN_TURN = 1e-9;

/** What a driver handed its sink for one output, read against the output's range and resting value. */
export interface Reading {
  /** The largest signed displacement of the clamped value from rest, and when, seconds in. */
  peak: number;
  at: number;
  /** The clamped value at the window's end. */
  final: number;
  /** Every distinct clamped value emitted except the resting one. */
  values: number[];
  /** The least and greatest clamped values emitted. */
  lo: number;
  hi: number;
  /** The longest run of frames with the raw value outside the range, and the bound it began past. */
  pinned: { frames: number; end: "min" | "max" };
  /** The driver's finiteness-guard activations for the output. */
  resets: number;
}

/**
 * Runs a `PhysicsMotion` over `rigs` and a `HairChainMotion` over `chains`,
 * both reading and writing `store`, for the seed frame and `frames` more —
 * one FIXED_DT_S sub-step each — calling `excite` ahead of them every frame;
 * reads what they hand the sink, per output.
 */
function run(
  model: IkiModel,
  store: ParameterStore,
  rigs: IkiPhysics[],
  chains: IkiPhysicsChain[],
  frames: number,
  excite: (frame: number, nowMs: number) => void,
): Map<string, Reading> {
  const raw = new Map<string, number[]>();
  const read = (id: string) => store.get(id);
  const sink = (id: string, value: number) => {
    let trace = raw.get(id);
    if (trace === undefined) raw.set(id, (trace = []));
    trace.push(value);
    store.set(id, value);
  };
  const { parameters } = model;
  const drivers = [
    new PhysicsMotion(rigs, parameters, read, sink),
    new HairChainMotion(chains, parameters, model.deformers ?? [], read, sink),
  ];
  for (let frame = 0; frame <= frames; frame++) {
    const nowMs = frame * FRAME_MS;
    excite(frame, nowMs);
    for (const driver of drivers) driver.update(nowMs);
  }
  const readings = new Map<string, Reading>();
  for (const driver of drivers) {
    driver.drivenParameterIds.forEach((id, i) => {
      const param = parameters.find((p) => p.id === id)!;
      readings.set(id, readTrace(raw.get(id)!, param, driver.resets[i]));
    });
  }
  return readings;
}

/** Reads `raw`, one sink value per frame from the seed frame on, against `param`. */
function readTrace(
  raw: number[],
  param: IkiParameter,
  resets: number,
): Reading {
  const rest = clamp(param.default, param.min, param.max);
  const reading: Reading = {
    peak: 0,
    at: 0,
    final: rest,
    values: [],
    lo: rest,
    hi: rest,
    pinned: { frames: 0, end: "max" },
    resets,
  };
  const seen = new Set([rest]);
  let outside = 0;
  let end: Reading["pinned"]["end"] = "max";
  raw.forEach((value, frame) => {
    const held = clamp(value, param.min, param.max);
    if (Math.abs(held - rest) > Math.abs(reading.peak)) {
      reading.peak = held - rest;
      reading.at = frame * FIXED_DT_S;
    }
    if (!seen.has(held)) {
      seen.add(held);
      reading.values.push(held);
    }
    reading.lo = Math.min(reading.lo, held);
    reading.hi = Math.max(reading.hi, held);
    reading.final = held;
    if (value >= param.min && value <= param.max) {
      outside = 0;
      return;
    }
    const side = value < param.min ? "min" : "max";
    // Crossing to the other bound ends the run: a swing between the two is
    // not pinning.
    if (outside === 0 || side !== end) {
      outside = 0;
      end = side;
    }
    outside++;
    if (outside > reading.pinned.frames) {
      reading.pinned = { frames: outside, end };
    }
  });
  return reading;
}

/**
 * The end farther from the clamped default — the one `signedNormalized`
 * takes as its unit, `max` on a tie — or `undefined` for a zero-width range.
 */
export function farEnd(param: IkiParameter): number | undefined {
  if (param.min === param.max) return undefined;
  const rest = clamp(param.default, param.min, param.max);
  return param.max - rest >= rest - param.min ? param.max : param.min;
}

/**
 * The step run: `rigs` and `chains` from rest, `values` set after the seed
 * frame and held for the window, every other parameter resting.
 */
export function stepRun(
  model: IkiModel,
  rigs: IkiPhysics[],
  chains: IkiPhysicsChain[],
  values: Record<string, number>,
): Map<string, Reading> {
  const store = new ParameterStore(model.parameters);
  return run(model, store, rigs, chains, STEP_FRAMES, (frame) => {
    if (frame !== 1) return;
    for (const [id, v] of Object.entries(values)) store.set(id, v);
  });
}

/**
 * The idle run: every rig and chain together behind the procedural
 * `IdleMotion` on a seeded rng, stepped idle → physics → chains each frame as
 * `IkiMotion` orders them. A declared `Idle` group is not played.
 */
export function idleRun(model: IkiModel): Map<string, Reading> {
  const store = new ParameterStore(model.parameters);
  const idle = new IdleMotion((id, v) => store.set(id, v), {
    rng: lcg(IDLE_SEED),
  });
  return run(
    model,
    store,
    model.physics ?? [],
    model.physicsChains ?? [],
    IDLE_FRAMES,
    (_, nowMs) => idle.update(nowMs),
  );
}

/** Numerical Recipes' 32-bit LCG, in [0, 1). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A parameter that turns a chain's anchor, at the probe value that turns it most. */
export interface Candidate {
  parameter: string;
  value: number;
}

/**
 * Every parameter that alone changes `chain`'s anchor world rotation at one
 * of its probe values — its `max`, its `min` and every keyform stop of a warp
 * deformer keyed on it, all but the resting value — in model order. Both
 * ends and the stops, since a warp parent can turn the anchor at one end
 * alone or at an interior stop while its other end matches rest. A probe
 * turning it no more than `MIN_TURN` past an earlier one does not replace it,
 * so a symmetric rig steps to `max`, as `farEnd` does, and float noise never
 * decides a near-tie.
 */
export function anchorInputs(
  model: IkiModel,
  chain: IkiPhysicsChain,
): Candidate[] {
  const store = new ParameterStore(model.parameters);
  const angle = () => {
    const { worlds } = resolveDeformers(model.deformers ?? [], store);
    const world = worlds.get(chain.anchorDeformer)!;
    return Math.atan2(world[1], world[0]);
  };
  const rest = angle();
  const found: Candidate[] = [];
  for (const p of model.parameters) {
    const probes = new Set(
      [p.max, p.min, ...stopsOf(model, p.id)].map((v) =>
        clamp(v, p.min, p.max),
      ),
    );
    probes.delete(store.get(p.id));
    let most = 0;
    let best: Candidate | undefined;
    for (const value of probes) {
      store.set(p.id, value);
      const d = angle() - rest;
      const turn = Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
      if (turn <= most + MIN_TURN) continue;
      [most, best] = [turn, { parameter: p.id, value }];
    }
    store.reset();
    if (best) found.push(best);
  }
  return found;
}

/** The sorted distinct keyform values of every deformer warp and `warp2d` axis keyed on `parameter`. */
function stopsOf(model: IkiModel, parameter: string): number[] {
  const stops = new Set<number>();
  for (const d of model.deformers ?? []) {
    if (d.kind !== "warp") continue;
    for (const w of d.warps ?? []) {
      if (w.parameter !== parameter) continue;
      for (const k of w.keyforms) stops.add(k.value);
    }
    const { warp2d } = d;
    if (warp2d?.parameter === parameter) {
      for (const v of warp2d.valuesX) stops.add(v);
    }
    if (warp2d?.parameterY === parameter) {
      for (const v of warp2d.valuesY) stops.add(v);
    }
  }
  return [...stops].sort((a, b) => a - b);
}
