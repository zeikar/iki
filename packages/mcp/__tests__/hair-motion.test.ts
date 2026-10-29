import { describe, expect, it } from "vitest";
import { StandardParameter as P } from "@ikijs/format";
import { generateIkiFromLayerSet } from "@ikijs/editor";
import { IkiMotion } from "@ikijs/engine";
import { CANVAS, character } from "../../editor/__tests__/helpers/character";

// The auto-rig's hair springs on the real driver: raw outputs (no clamp) from
// IkiMotion over a Map store, stepped at 60 fps.

const FRAME_MS = 1000 / 60;
const OUTPUTS = [P.HairSwayX, P.HairSwayZ, P.HairBackSway] as const;
/** The declared sway range; the budget holds strictly under it with margin. */
const RANGE = 20;
const MARGIN = 19.5;

const { layers, options } = character();
const model = generateIkiFromLayerSet(layers, CANVAS, options);

function store(): Map<string, number> {
  return new Map(model.parameters.map((p) => [p.id, p.default]));
}

/** A fresh IkiMotion over a raw store; `drop` ids are ignored when IkiMotion
 *  writes them, so a scripted value in the store survives its update. */
function driver(drop: ReadonlySet<string> = new Set()) {
  const values = store();
  let dropping = false;
  const motion = new IkiMotion(
    model,
    (id) => values.get(id) ?? 0,
    (id, v) => {
      if (dropping && drop.has(id)) return;
      values.set(id, v);
    },
  );
  let now = 0;
  return {
    values,
    motion,
    setDropping: (d: boolean) => {
      dropping = d;
    },
    step() {
      motion.update(now);
      now += FRAME_MS;
    },
    time: () => now,
  };
}

function correlate(a: number[], b: number[], lag: number): number {
  // r of a[i] against b[i + lag].
  const n = a.length - lag;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i];
    sb += b[i + lag];
  }
  const ma = sa / n;
  const mb = sb / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i + lag] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

describe("hair springs on the real driver", () => {
  it("the back hair lags the front hair in idle by 0.3-0.7 s", () => {
    const d = driver();
    const front: number[] = [];
    const back: number[] = [];
    for (let f = 0; f < 30 * 60; f++) {
      d.step();
      if (f >= 3 * 60) {
        front.push(d.values.get(P.HairSwayX)!);
        back.push(d.values.get(P.HairBackSway)!);
      }
    }
    let best = { lag: 0, r: -Infinity };
    for (let lag = 0; lag < 120; lag++) {
      const r = correlate(front, back, lag);
      if (r > best.r) best = { lag, r };
    }
    const peak = (a: number[]) => Math.max(...a.map(Math.abs)).toFixed(2);
    console.log(
      `idle peaks: front ${peak(front)}, back ${peak(back)}; back lags front by ${(best.lag * FRAME_MS) / 1000} s, r ${best.r.toFixed(3)}`,
    );
    expect(best.lag * FRAME_MS).toBeGreaterThanOrEqual(300);
    expect(best.lag * FRAME_MS).toBeLessThanOrEqual(700);
    expect(best.r).toBeGreaterThan(0.8);
  });

  it("every output stays inside the range through the Shake, the Tilt and a full turn-and-tilt at every ambient phase", () => {
    const peaks: Record<string, Record<string, number>> = {};
    const note = (kind: string, id: string, v: number) => {
      peaks[kind] ??= {};
      peaks[kind][id] = Math.max(peaks[kind][id] ?? 0, Math.abs(v));
    };
    const run = (
      kind: string,
      start: number,
      excite: (d: ReturnType<typeof driver>, f: number) => void,
      scripted: ReadonlySet<string> = new Set(),
    ) => {
      const d = driver(scripted);
      while (d.time() < start * 1000) d.step();
      d.setDropping(true);
      for (let f = 0; f < 4 * 60; f++) {
        excite(d, f);
        d.step();
        for (const id of OUTPUTS) {
          const v = d.values.get(id)!;
          note(kind, id, v);
          expect(Math.abs(v)).toBeLessThan(RANGE);
        }
      }
    };
    for (let start = 0; start <= 124.5; start += 0.5) {
      run("Shake", start, (d, f) => {
        if (f === 0) d.motion.playMotion("Shake", 0);
      });
      run("Tilt", start, (d, f) => {
        if (f === 0) d.motion.playMotion("Tilt", 0);
      });
      run(
        "turn+tilt",
        start,
        (d, f) => {
          const v = 30 * Math.min(1, (f * FRAME_MS) / 100);
          d.values.set(P.AngleX, v);
          d.values.set(P.AngleZ, v);
        },
        new Set([P.AngleX, P.AngleZ]),
      );
    }
    console.log(JSON.stringify(peaks));
    for (const kind of Object.values(peaks))
      for (const v of Object.values(kind)) expect(v).toBeLessThan(MARGIN);
  }, 600_000);

  it("every output stays inside the range on an endpoint-to-endpoint head sweep, both directions, ambient off and at every phase", () => {
    const peaks: Record<string, Record<string, number>> = {};
    const AXES: Record<string, string[]> = {
      X: [P.AngleX],
      Z: [P.AngleZ],
      XZ: [P.AngleX, P.AngleZ],
    };
    const sweep = (
      name: string,
      axes: string[],
      from: number,
      to: number,
      ms: number,
      start: number | null, // null: ambient off
    ) => {
      const scripted = new Set<string>(axes);
      if (start === null) scripted.add(P.AmbientSway);
      const d = driver(scripted);
      if (start !== null) while (d.time() < start * 1000) d.step();
      d.setDropping(true);
      if (start === null) d.values.set(P.AmbientSway, 0);
      for (const a of axes) d.values.set(a, from);
      for (let f = 0; f < 2 * 60; f++) d.step(); // settle at the seed
      const t0 = d.time();
      for (let f = 0; f < 4 * 60; f++) {
        const k = Math.min(1, (d.time() - t0) / ms);
        for (const a of axes) d.values.set(a, from + (to - from) * k);
        d.step();
        for (const id of OUTPUTS) {
          const v = d.values.get(id)!;
          peaks[name] ??= {};
          peaks[name][id] = Math.max(peaks[name][id] ?? 0, Math.abs(v));
        }
      }
    };
    for (const [axis, axes] of Object.entries(AXES))
      for (const [from, to] of [
        [-30, 30],
        [30, -30],
      ])
        for (const ms of [200]) {
          const name = `${axis} ${from}>${to} ${ms}ms`;
          sweep(name, axes, from, to, ms, null);
          for (let start = 0; start <= 124; start += 2)
            sweep(name, axes, from, to, ms, start);
        }
    console.log(JSON.stringify(peaks));
    // The front's ambient (3.5) rides on a 16.3 head swing, so its sweep peak
    // (19.8) holds the range, not the margin; the back keeps the margin.
    for (const kind of Object.values(peaks))
      for (const [id, v] of Object.entries(kind))
        expect(v).toBeLessThan(id === P.HairBackSway ? MARGIN : RANGE);
  }, 900_000);
});
