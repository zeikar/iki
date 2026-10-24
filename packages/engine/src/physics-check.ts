import {
  type IkiDeformer,
  type IkiModel,
  type IkiParameter,
  type IkiPart,
  type IkiPhysics,
  physicsInputs,
} from "@ikijs/format";
import { resolveDeformers } from "./deform";
import { FIXED_DT_S } from "./frame-clock";
import { landPart, landedPart, staticDeformers } from "./land";
import { ParameterStore } from "./parameter-store";
import {
  type Reading,
  anchorInputs,
  farEnd,
  idleRun,
  stepRun,
} from "./physics-runs";

/** How a driven output moves over one excitation window. */
export interface PhysicsResponse {
  /**
   * Its largest displacement from its resting value, as the store holds it
   * (clamped): signed in `step`, which has a direction; its size in `idle`,
   * whose sway goes both ways, so a sign there would carry nothing.
   */
  peak: number;
  /**
   * When it peaks, seconds into the window. Between two near-equal extremes
   * of the idle it may name either.
   */
  at: number;
  /**
   * The largest vertex move of any part, model px, with the output alone
   * (every other parameter resting) at the values the window reached.
   */
  displacementPx: number;
}

/** One output a physics rig drives: a spring's, or one chain segment's. */
export interface PhysicsTarget {
  rig:
    | { kind: "spring"; id: string }
    | { kind: "chain"; id: string; segment: number };
  /**
   * The spring's inputs, in rig order; for a chain, every parameter that turns
   * its anchor.
   */
  input: string[];
  /** The driven parameter. */
  output: string;
  /** What reads `output`: parts, then deformers, each in model order. */
  drives: { kind: "part" | "deformer"; id: string }[];
  kind: "ok" | "frozen" | "unstable";
  /** One phrase saying why, naming the window it came from; present when not `ok`. */
  why?: string;
  /**
   * An input stepped from rest to `values` and held: its displacement over
   * every value the run emitted, `final` the output at the window's end.
   */
  step: PhysicsResponse & { values: Record<string, number>; final: number };
  /** Every rig and chain together behind the procedural idle, displaced at every value it emitted. */
  idle: PhysicsResponse;
}

export interface PhysicsReport {
  thresholds: { displacementPx: 1; pinnedFrames: 60 };
  /** One per `model.physics` rig, then one per chain segment, each in model order. */
  targets: PhysicsTarget[];
  /** The targets that are not `ok`, unstable first. */
  offenders: PhysicsTarget[];
}

/** Under 1 model px is sub-pixel in every render the loop looks at (0.51 render px each). */
const DISPLACEMENT_PX = 1;
/** One second outside the range: longer than any transient overshoot clip. */
const PINNED_FRAMES = 60;
/** Slack on the spring's stability limits. */
const TOLERANCE = 1e-9;
/** The corners `createUnitQuad` uploads, which a part without a mesh draws. */
const UNIT_QUAD = [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5];

/** A run's reading of one output, the window `why` names it by, and how far it moves the parts. */
interface Excitation {
  name: string;
  reading: Reading;
  displacementPx: number;
}

/** A step excitation and the setting it held. */
interface StepExcitation extends Excitation {
  values: Record<string, number>;
}

/**
 * Excites every physics rig through the real drivers (`PhysicsMotion`,
 * `HairChainMotion`, `IdleMotion`) on a synthetic 60 Hz clock, one FIXED_DT_S
 * sub-step per frame, and reports per driven output whether it moves the
 * parts (`ok`), cannot (`frozen`) or runs away (`unstable`).
 *
 * Step: a fresh store and a driver holding only that rig, seeded at rest,
 * then an input set to its far end — the end farther from its clamped
 * default, `max` on a tie — and held for 5 s. A spring steps each input that
 * has a range alone, in its own run. A chain steps each parameter that alone
 * turns its anchor (probed at its max, min and every warp keyform stop) in
 * its own run, at the probe value that turned it most. Either reports the run
 * moving the parts most among the runs that are not unstable. A lag input's
 * step peaks at once at the bound `−scale·weight` (less one sub-step) and its
 * `final` reads rest: the bound is what a one-frame step shows, a gradual
 * turn swings less. Idle: every rig and chain together behind `IdleMotion`
 * (seeded) for 30 s.
 *
 * `displacementPx` is the largest vertex move of any part with the output
 * alone at every distinct value the run emitted, step or idle, against the
 * parts landed at rest. `frozen` when nothing reads the output, no input of a
 * spring has a range, nothing turns a chain's anchor, or the step moves the
 * parts under 1 model px. `unstable`, before frozen, when a
 * spring's one-sub-step map has a spectral radius over 1 or sits on its
 * undamped boundary (springs only: a chain's update is nonlinear), when a
 * driver's finiteness guard fires, or when the raw output stays outside its
 * range for 60 consecutive frames, in any run. Deferred by the user: a chain
 * that grows yet stays finite and inside its range trips none of these and
 * is not flagged. Idle amplitude never flags. Report-only: nothing is refused.
 */
export function checkPhysics(model: IkiModel): PhysicsReport {
  const idle = idleRun(model);
  const displace = displacer(model);
  const idleExcitation = (output: IkiParameter): Excitation => {
    const reading = idle.get(output.id)!;
    return {
      name: "the idle",
      reading,
      displacementPx: displace(output, reading.values),
    };
  };
  const param = (id: string) => model.parameters.find((p) => p.id === id)!;

  const springs = (model.physics ?? []).map((rig) => {
    const inputs = physicsInputs(rig).map((i) => param(i.parameter));
    const ids = inputs.map((p) => p.id);
    const output = param(rig.output.parameter);
    const ranged = inputs.flatMap((input) => {
      const far = farEnd(input);
      return far === undefined ? [] : [{ [input.id]: far }];
    });
    // One unexcited run when nothing has a range, so mostMoving has a run.
    const settings = ranged.length === 0 ? [{}] : ranged;
    const steps = settings.map((values): StepExcitation => {
      const reading = stepRun(model, [rig], [], values).get(output.id)!;
      // A one-input rig has one run, so naming its setting would add nothing.
      const setting =
        inputs.length === 1
          ? []
          : Object.entries(values).map(([id, v]) => `${id}=${v}`);
      return {
        name: ["the step", ...setting].join(" "),
        reading,
        displacementPx: displace(output, reading.values),
        values,
      };
    });
    const atIdle = idleExcitation(output);
    const clean = steps.filter((s) => !unstableWhy(output, [s]));
    return target(model, {
      rig: { kind: "spring", id: rig.id },
      input: ids,
      output,
      step: mostMoving(clean.length > 0 ? clean : steps),
      idle: atIdle,
      unstable: springWhy(rig) ?? unstableWhy(output, [...steps, atIdle]),
      inert:
        ranged.length === 0
          ? `${ids.join(", ")} ${ids.length === 1 ? "has" : "have"} no range`
          : undefined,
    });
  });

  const chains = (model.physicsChains ?? []).flatMap((chain) => {
    const candidates = anchorInputs(model, chain);
    const settings =
      candidates.length === 0
        ? [{}]
        : candidates.map((c) => ({ [c.parameter]: c.value }));
    const runs = settings.map((values) => ({
      values,
      readings: stepRun(model, [], [chain], values),
    }));
    return chain.segments.map((segment, i) => {
      const output = param(segment.output.parameter);
      const steps = runs.map(({ values, readings }): StepExcitation => {
        const reading = readings.get(output.id)!;
        const setting = Object.entries(values).map(([id, v]) => `${id}=${v}`);
        return {
          name: ["the step", ...setting].join(" "),
          reading,
          displacementPx: displace(output, reading.values),
          values,
        };
      });
      const atIdle = idleExcitation(output);
      const clean = steps.filter((s) => !unstableWhy(output, [s]));
      return target(model, {
        rig: { kind: "chain", id: chain.id, segment: i },
        input: candidates.map((c) => c.parameter),
        output,
        step: mostMoving(clean.length > 0 ? clean : steps),
        idle: atIdle,
        unstable: unstableWhy(output, [...steps, atIdle]),
        inert:
          candidates.length === 0
            ? `nothing turns anchor ${chain.anchorDeformer}`
            : undefined,
      });
    });
  });

  const targets = [...springs, ...chains];
  return {
    thresholds: {
      displacementPx: DISPLACEMENT_PX,
      pinnedFrames: PINNED_FRAMES,
    },
    targets,
    offenders: [
      ...targets.filter((t) => t.kind === "unstable"),
      ...targets.filter((t) => t.kind === "frozen"),
    ],
  };
}

/**
 * A target from its excitations: `unstable` with its reason, else `frozen`
 * when nothing reads the output, by the input-side reason `inert`, or under
 * 1 px.
 */
function target(
  model: IkiModel,
  t: {
    rig: PhysicsTarget["rig"];
    input: string[];
    output: IkiParameter;
    step: StepExcitation;
    idle: Excitation;
    unstable: string | undefined;
    inert: string | undefined;
  },
): PhysicsTarget {
  const { step, idle, output } = t;
  const drives = drivesOf(model, output.id);
  // Floored, so a frozen 0.96 px never reads as 1.0.
  const px = Math.floor(step.displacementPx * 10) / 10;
  const still =
    step.displacementPx < DISPLACEMENT_PX
      ? `moves ${px.toFixed(1)} model px over ${step.name}`
      : undefined;
  const frozen = drives.length === 0 ? "drives nothing" : (t.inert ?? still);
  const { peak, at, final } = step.reading;
  return {
    rig: t.rig,
    input: t.input,
    output: output.id,
    drives,
    kind: t.unstable ? "unstable" : frozen ? "frozen" : "ok",
    why: t.unstable ?? frozen,
    step: {
      values: step.values,
      peak,
      at,
      final,
      displacementPx: step.displacementPx,
    },
    idle: {
      peak: Math.abs(idle.reading.peak),
      at: idle.reading.at,
      displacementPx: idle.displacementPx,
    },
  };
}

/** The excitation moving the parts most, ties by `|peak|`, the first on a full tie. */
function mostMoving(steps: StepExcitation[]): StepExcitation {
  return steps.reduce((best, s) => {
    if (s.displacementPx !== best.displacementPx) {
      return s.displacementPx > best.displacementPx ? s : best;
    }
    return Math.abs(s.reading.peak) > Math.abs(best.reading.peak) ? s : best;
  });
}

/** The parts, then the deformers, that read `output`, each in model order. */
function drivesOf(model: IkiModel, output: string): PhysicsTarget["drives"] {
  const parts = model.parts.filter((p) =>
    [
      ...(p.bindings ?? []).map((b) => b.parameter),
      ...(p.warps ?? []).map((w) => w.parameter),
    ].includes(output),
  );
  const deformers = (model.deformers ?? []).filter((d) =>
    (d.kind === "warp"
      ? [
          ...(d.warps ?? []).map((w) => w.parameter),
          d.warp2d?.parameter,
          d.warp2d?.parameterY,
        ]
      : (d.bindings ?? []).map((b) => b.parameter)
    ).includes(output),
  );
  return [
    ...parts.map((p) => ({ kind: "part" as const, id: p.id })),
    ...deformers.map((d) => ({ kind: "deformer" as const, id: d.id })),
  ];
}

/**
 * The spectral radius of the map `PhysicsMotion.step` applies to the state
 * (x, v) each FIXED_DT_S sub-step — linear, constant coefficients:
 * `[[1 − h²k/m, h(1 − hc/m)], [−hk/m, 1 − hc/m]]` — by the closed form: a real
 * pair from trace and determinant, a complex pair's modulus `√det`. With it,
 * `k` = h²k/m, the term the undamped boundary reads.
 */
function springStepRadius({ mass, stiffness, damping }: IkiPhysics): {
  radius: number;
  k: number;
} {
  const k = (FIXED_DT_S * FIXED_DT_S * stiffness) / mass;
  const c = (FIXED_DT_S * damping) / mass;
  const trace = 2 - k - c;
  const det = 1 - c;
  const disc = trace * trace - 4 * det;
  const radius =
    disc >= 0 ? (Math.abs(trace) + Math.sqrt(disc)) / 2 : Math.sqrt(det);
  return { radius, k };
}

/**
 * Why a spring's constants make it unstable, if they do: a radius over 1, or
 * the undamped boundary `dt²k/m = 4`, where the radius is exactly 1 but the
 * matrix is defective (double eigenvalue −1) and the state grows linearly.
 */
function springWhy(rig: IkiPhysics): string | undefined {
  const { radius, k } = springStepRadius(rig);
  if (radius > 1 + TOLERANCE) {
    // As many decimals as it takes to print the radius over 1.
    let digits = 2;
    while (Number(radius.toFixed(digits)) <= 1) digits++;
    return `spring step map radius ${radius.toFixed(digits)} over 1 at 1/60 s`;
  }
  if (rig.damping === 0 && k >= 4 - TOLERANCE) {
    return `spring on its undamped boundary, dt²k/m ${k.toFixed(2)}`;
  }
  return undefined;
}

/** Why `output` is unstable over `excitations`, if it is: a guard activation in any, else a pin. */
function unstableWhy(
  output: IkiParameter,
  excitations: Excitation[],
): string | undefined {
  for (const { name, reading } of excitations) {
    const n = reading.resets;
    if (n === 0) continue;
    return `finiteness guard reset it ${n} time${n === 1 ? "" : "s"} in ${name}`;
  }
  for (const { name, reading } of excitations) {
    const { frames, end } = reading.pinned;
    if (frames < PINNED_FRAMES) continue;
    return `pinned at ${output.id} ${end} ${output[end]} for ${frames} frames of ${name}`;
  }
  return undefined;
}

/**
 * The largest vertex move, model px, of any part with an output alone at
 * each of a list of values (every other parameter resting), against every
 * part landed at the resting store through the live deformers resolved at
 * rest — so a binding or keyform away from zero at rest is not motion. Every
 * part lands, so a deformer- or chain-driven part counts by the same path.
 */
function displacer(
  model: IkiModel,
): (output: IkiParameter, values: number[]) => number {
  const deformers = model.deformers ?? [];
  const store = new ParameterStore(model.parameters);
  // Only `landedPart`'s `restPoints` (folds' baseline) reads the static
  // worlds; this check lands its own baseline below.
  const { worlds } = resolveDeformers(staticDeformers(model), store);
  const landings = model.parts.map((part) =>
    landedPart(
      part,
      part.mesh?.vertices ?? UNIT_QUAD,
      deformers,
      worlds,
      store,
    ),
  );
  const atRest = resolveDeformers(deformers, store);
  // Copied out: landPart returns the landing's shared scratch.
  const baselines = landings.map((l) =>
    Float32Array.from(landPart(l, store, atRest)),
  );
  return (output, values) => {
    let most = 0;
    const affected = affectedParts(model, output.id);
    for (const value of values) {
      store.set(output.id, value);
      const resolved = resolveDeformers(deformers, store);
      landings.forEach((landing, i) => {
        if (!affected.has(landing.part)) return;
        const landed = landPart(landing, store, resolved);
        const base = baselines[i];
        for (let j = 0; j < landed.length; j += 2) {
          const dx = landed[j] - base[j];
          const dy = landed[j + 1] - base[j + 1];
          most = Math.max(most, dx * dx + dy * dy);
        }
      });
    }
    store.reset();
    return Math.sqrt(most);
  };
}

/**
 * The parts whose geometry can depend on `output`: those that read it
 * themselves, or hang from a deformer that reads it or has an ancestor that
 * does. The rest land exactly at rest, so landing them adds nothing.
 */
function affectedParts(model: IkiModel, output: string): Set<IkiPart> {
  const deformers = new Map((model.deformers ?? []).map((d) => [d.id, d]));
  const reads = (d: IkiDeformer) =>
    (d.kind === "warp"
      ? [
          ...(d.warps ?? []).map((w) => w.parameter),
          d.warp2d?.parameter,
          d.warp2d?.parameterY,
        ]
      : (d.bindings ?? []).map((b) => b.parameter)
    ).includes(output);
  const hung = (id: string | undefined): boolean => {
    for (
      let d = id && deformers.get(id);
      d;
      d = d.parent && deformers.get(d.parent)
    ) {
      if (reads(d)) return true;
    }
    return false;
  };
  return new Set(
    model.parts.filter(
      (p) =>
        [
          ...(p.bindings ?? []).map((b) => b.parameter),
          ...(p.warps ?? []).map((w) => w.parameter),
        ].includes(output) || hung(p.deformer),
    ),
  );
}
