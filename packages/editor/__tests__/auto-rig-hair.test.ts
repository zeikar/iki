// The head turn and the nod as the hair takes them; the rest of the turn is
// in `auto-rig-turn.test.ts`.

import { describe, expect, it } from "vitest";
import { StandardParameter as P, type IkiModel } from "@ikijs/format";
import { generateIkiFromLayerSet, type LayerInput } from "@ikijs/editor";
import { NOD, TURN } from "../src/auto-rig/profile";
import { CANVAS, character, type CharacterOptions } from "./helpers/character";
import { type ParamValues } from "./helpers/render-oracle";
import {
  landVertices,
  landedXAt,
  landedYAt,
  landerFor,
  rig,
  ALL_RUNS,
  EYE_Y,
  HH,
  X30,
} from "./helpers/head-rig";

const hero = rig();
const fullBack = rig({ fullBack: true });
const tuft = rig({ tuft: true });
const wideBack = rig({ wideBack: true });
const crownGap = rig({ crownGap: true });
const faceGap = rig({ faceGap: true });
const besideFaceGap = rig({ besideFaceGap: true });
const tightLock = rig({ tightLock: true });

describe("the head turn", () => {
  const { model } = hero;

  describe("with back hair painted behind the bangs' outer edge", () => {
    const { model: full } = fullBack;
    /** The same set without its runs: today's hold. */
    const today = rig({ fullBack: true }, {}, { drop: ALL_RUNS }).model;
    /** Model y of canvas row k's centre. */
    const rowY = (k: number) => 500 - k - 0.5;
    const DRIFT = -TURN.hairBack * HH;
    /** The face's follow at the edge below the eye band, hh at ±30. */
    const CORE = TURN.hairFollow * TURN.face;
    const edge = (
      m: IkiModel,
      role: string,
      x: number,
      y: number,
      ax: number,
    ) => landedXAt(m, role, x, y, X30(ax));
    /** How far the front hair's rest point moves along the turn, hh. */
    const shift = (m: IkiModel, x: number, y: number, ax: number) =>
      (Math.sign(ax) * (edge(m, "hair_front", x, y, ax) - x)) / HH;
    /** The `character(opts)` layer of a role. */
    const layerOf = (opts: CharacterOptions, role: string) =>
      character(opts).layers.find((l) => l.role === role)!;
    /** The front hair's vertex rows `ys`, model y top to bottom; the cap's
     *  last, `last`: the last that pairs, with the row above it, to form a
     *  cell whose rows both lie at least 1.5 eye heights above the eye row;
     *  `zero`, the first under it at or below the eyes' top, or the row above
     *  that while it lies under the irises' top; and the face
     *  plate's top, at or below which a row is the front hair's own, no
     *  crown — read off the eye and face boxes and the front hair's mesh. */
    const capRows = (m: IkiModel) => {
      const part = (id: string) => m.parts.find((p) => p.id === id)!;
      const eyes = [part("eye_L"), part("eye_R")];
      const eyeY = (eyes[0].transform.y + eyes[1].transform.y) / 2;
      const eyeH = (eyes[0].height + eyes[1].height) / 2;
      const front = part("hair_front");
      const v = front.mesh!.vertices;
      const ys = [...new Set(v.filter((_, i) => i % 2 === 1))]
        .map((u) => front.transform.y + u * front.height)
        .sort((a, b) => b - a);
      let last = -1;
      for (let r = 1; r < ys.length; r++)
        if (ys[r] >= eyeY + 1.5 * eyeH) last = r;
      let zero = last + 1;
      while (zero < ys.length && ys[zero] > eyeY + eyeH / 2) zero++;
      // ... stepped back up while it lies under the irises' top.
      const irisTop = Math.max(
        ...["iris_L", "iris_R"].map(
          (id) => part(id).transform.y + part(id).height / 2,
        ),
      );
      while (zero > last + 1 && zero < ys.length && ys[zero] < irisTop - 0.5)
        zero--;
      const face = part("face");
      return { ys, last, zero, plateTop: face.transform.y + face.height / 2 };
    };
    /** Canvas row of the cap's last vertex row (`capRows`). */
    const capBottom = (m: IkiModel) => {
      const { ys, last } = capRows(m);
      return Math.round(500 - ys[last]);
    };
    /** Model y of the cap's top row, which every crown row turns as: the
     *  first vertex row at or below the plate's top. */
    const capTopY = (m: IkiModel) => {
      const { ys, plateTop } = capRows(m);
      return ys.find((y) => y <= plateTop)!;
    };
    /**
     * The back hair's rest point under a landed point at `pose`, as a canvas
     * column and row. Above the chin the back hair lands affinely at every
     * turn, nod and roll — its turn and shell terms linear in x, its nod
     * uniform, the roll a rotation about the chin, its hang weight 0, sway at
     * rest — so three of its rest points on the cap's rows fix the map, and
     * its inverse reads any landed point back.
     */
    const backRest = (m: IkiModel, pose: ParamValues) => {
      const rest = [
        [-200, rowY(50)],
        [200, rowY(50)],
        [0, rowY(250)],
      ];
      const land = landerFor(m, "hair_back", pose);
      const [p0, p1, p2] = rest.map(([x, y]) => {
        const p = land(x, y);
        return [p.x, p.y];
      });
      const u = [p1[0] - p0[0], p1[1] - p0[1]];
      const v = [p2[0] - p0[0], p2[1] - p0[1]];
      const det = u[0] * v[1] - v[0] * u[1];
      return (x: number, y: number) => {
        const [dx, dy] = [x - p0[0], y - p0[1]];
        const a = (dx * v[1] - v[0] * dy) / det;
        const b = (u[0] * dy - dx * u[1]) / det;
        const at = (i: 0 | 1) =>
          rest[0][i] +
          a * (rest[1][i] - rest[0][i]) +
          b * (rest[2][i] - rest[0][i]);
        return { col: at(0) + 500, row: Math.floor(500 - at(1)) };
      };
    };
    /** How far the pixel just inside a boundary at canvas column `c` on
     *  `side` would have to move to lie in one of the back hair's runs on
     *  canvas row `row`: 0 where it does; undefined off the back hair's
     *  crop, where there is no back hair to step past. */
    const stepPast = (
      back: LayerInput,
      row: number,
      c: number,
      side: number,
    ) => {
      const runs = back.rowRuns![row - back.bbox.y];
      if (runs === undefined) return undefined;
      const px = side > 0 ? c - 1 : c;
      let step = Infinity;
      for (let i = 0; i < runs.length; i += 2)
        step = Math.min(step, Math.max(0, runs[i] - px, px + 1 - runs[i + 1]));
      return step;
    };
    /** Where on the back hair the front's outermost pixel on canvas row `k`,
     *  its boundary at canvas column `ce`, lands (`front` lands the bangs at
     *  the pose `toBack` reads), and its step past the back hair there. */
    const landedOnBack = (
      back: LayerInput,
      front: ReturnType<typeof landerFor>,
      toBack: ReturnType<typeof backRest>,
      k: number,
      ce: number,
      side: number,
    ) => {
      const p = front(ce - 500, rowY(k));
      const at = toBack(p.x, p.y);
      return { ...at, step: stepPast(back, at.row, at.col, side) };
    };
    /** The back hair's outer end on the canvas row a landed boundary sits
     *  over, less where it lands, on `side`: how far inside it the boundary
     *  lies; undefined off the back hair's crop. */
    const insideRun = (
      back: LayerInput,
      at: { row: number; col: number },
      side: number,
    ) => {
      const runs = back.rowRuns![at.row - back.bbox.y];
      if (runs === undefined) return undefined;
      return side > 0 ? runs[runs.length - 1] - at.col : at.col - runs[0];
    };
    /** Whether the back hair paints canvas columns [c0, c1) on row k. */
    const backPaints = (
      back: LayerInput,
      k: number,
      c0: number,
      c1: number,
    ) => {
      const runs = back.rowRuns![k - back.bbox.y] ?? [];
      for (let i = 0; i < runs.length; i += 2)
        if (runs[i] <= c0 && c1 <= runs[i + 1]) return true;
      return false;
    };
    /** The keyforms round each offset to 1e-4 of its part's width (0.07 px
     *  on the bangs, 0.08 px on the back hair): a landed step may read up to
     *  both past the nod's. */
    const ROUNDING = 0.15;

    it("rides the edge with the face where the back reaches past it and far inside it", () => {
      // Under the eyes, the back solid to ±310 over every row the edge passes
      // over on the nod (42 px down to 23 px up, one mesh row either side):
      // 48 px past the edge less the 3.1 px drift, and far inside it, both
      // more than the face's 31.2 px follow, so both edges may ride it whole.
      // The mesh carries the ride's kink at the edge between two columns, so
      // the edge lands a little short of it (today's hold is 0.041 hh).
      const y = rowY(530);
      for (const ax of [-30, 30]) {
        const s = Math.sign(ax);
        for (const x of [-262, 262]) {
          const ride = (s * (edge(full, "hair_front", x, y, ax) - x)) / HH;
          expect(ride, `x ${x}, AngleX ${ax}`).toBeLessThanOrEqual(CORE + 1e-3);
          expect(ride, `x ${x}, AngleX ${ax}`).toBeGreaterThan(0.9 * CORE);
        }
      }
    });

    it("holds the edge as today where the back hair is not behind it, but on the cap's ramp eases it toward the back hair's motion", () => {
      // Past the cap's ramp, under the eyes' top: a sliver outside the edge,
      // nothing until 8 px inside it.
      const gap = rowY(680);
      // On the cap, under its first vertex row below the plate's top (row
      // 210), which moves with the back hair: the back's outer end 5 px
      // inside the bangs' edge. Nothing bounds this edge, but the cap's blend
      // ramps out across it.
      const temple = rowY(270);
      for (const ax of [-30, -15, 15, 30]) {
        const s = Math.sign(ax);
        for (const x of [-262, 262]) {
          const label = `x ${x}, AngleX ${ax}`;
          expect(edge(full, "hair_front", x, gap, ax), `gap, ${label}`).toBe(
            edge(today, "hair_front", x, gap, ax),
          );
          // Today's hold turns further than the back hair, and the ramp
          // leaves the edge between the two, off today's.
          const held = edge(today, "hair_front", x, temple, ax);
          const back = edge(full, "hair_back", x, temple, ax);
          const ramped = edge(full, "hair_front", x, temple, ax);
          expect(s * (back - held), `temple, ${label}`).toBeLessThan(-1);
          expect(s * (ramped - held), `temple, ${label}`).toBeLessThan(-1);
          expect(s * (ramped - back), `temple, ${label}`).toBeGreaterThan(
            -ROUNDING,
          );
        }
      }
    });

    it("rides the far edge only over the back's run past it, not out to a stroke beyond a gap", () => {
      // The back solid from inside the edge to 20 px past it (±282), then
      // 30 px empty, then a 4 px stroke, over every row the edge passes over
      // on the nod.
      const y = rowY(830);
      for (const ax of [-30, -22.5, -15, 15, 22.5, 30]) {
        const s = Math.sign(ax);
        const a = Math.abs(ax) / 30;
        const far = edge(full, "hair_front", 262 * s, y, ax);
        const runEnd = edge(full, "hair_back", 282 * s, y, ax);
        // At most the keyforms' rounding (1e-4 of a part's width) past it.
        expect(s * (far - runEnd), `AngleX ${ax}`).toBeLessThan(0.1);
        expect(s * (far - 262 * s), `AngleX ${ax}`).toBeCloseTo(
          a * (20 - DRIFT),
          0,
        );
        // The near edge, over the run's 544 px inside it, rides the face's
        // follow — short of it by the mesh's columns, as above.
        const near =
          (s * (edge(full, "hair_front", -262 * s, y, ax) + 262 * s)) / HH;
        expect(near, `AngleX ${ax}`).toBeLessThanOrEqual(a * CORE + 1e-3);
        expect(near, `AngleX ${ax}`).toBeGreaterThan(0.9 * a * CORE);
      }
    });

    it("keeps the far edge over the back hair when a narrower shell is fitted", () => {
      const { model, report } = rig(
        { fullBack: true },
        { silhouetteRatio: 0.95 },
      );
      expect(report!.achieved.silhouetteRatio).toBeCloseTo(0.95, 2);
      for (const y of [EYE_Y, rowY(560)]) {
        for (const ax of [-30, 30]) {
          const s = Math.sign(ax);
          const back = edge(model, "hair_back", 310 * s, y, ax);
          // The shell is narrower than at rest ...
          expect(s * back).toBeLessThan(310 - DRIFT);
          // ... and the far edge stays inside it.
          expect(
            s * (edge(model, "hair_front", 262 * s, y, ax) - back),
            `y ${y}, AngleX ${ax}`,
          ).toBeLessThan(0);
        }
      }
    });

    /**
     * On every other bangs row from the bangs' top down to the cap's last
     * vertex row (the rows whose centres lie on or above it), on both sides,
     * at each [AngleX, AngleY, AngleZ] pose: the outermost pixel's step past
     * the back hair is at most its step at the nod alone (AngleX 0, the same
     * AngleY and AngleZ), never negative, so how far inside the edge sits
     * does not count; and on the rows `inside` names, the back hair paints
     * every pixel between the edge's own pixel and where it lands. A row
     * whose back hair at rest leaves the edge's own pixel bare is the outline
     * the front draws itself, which the bound leaves alone (fullBack's
     * temple band). From canvas row `from` (the bangs' top by default):
     * a crown whose back hair is thinner than its slide draws the head's top
     * outline itself. Returns the edges checked and the rows' sides.
     */
    const expectCapBound = (
      name: string,
      opts: CharacterOptions,
      m: IkiModel,
      poses: number[][],
      inside: (k: number) => boolean = () => false,
      from?: number,
    ) => {
      const front = layerOf(opts, "hair_front");
      const back = layerOf(opts, "hair_back");
      const edges: { k: number; side: number; ce: number }[] = [];
      const bottom = capBottom(m);
      let sides = 0;
      for (let k = from ?? front.bbox.y; k + 0.5 <= bottom; k += 2) {
        const runs = front.rowRuns![k - front.bbox.y];
        for (const side of [-1, 1]) {
          sides++;
          const ce = side > 0 ? runs[runs.length - 1] : runs[0];
          if (stepPast(back, k, ce, side) === 0) edges.push({ k, side, ce });
        }
      }
      const nods = new Map<string, number[]>();
      for (const [ax, ay, az] of poses) {
        const nod = { [P.AngleY]: ay, [P.AngleZ]: az };
        let base = nods.get(`${ay} ${az}`);
        if (base === undefined) {
          const toBack = backRest(m, nod);
          const land = landerFor(m, "hair_front", nod);
          base = edges.map(({ k, side, ce }) => {
            const { step } = landedOnBack(back, land, toBack, k, ce, side);
            // The nod alone keeps every edge over the back hair's crop, so
            // no step below is compared with none.
            expect(
              step,
              `${name}, row ${k}, side ${side}, AngleY ${ay}, AngleZ ${az}`,
            ).toBeDefined();
            return step!;
          });
          nods.set(`${ay} ${az}`, base);
        }
        const pose = { [P.AngleX]: ax, ...nod };
        const toBack = backRest(m, pose);
        const land = landerFor(m, "hair_front", pose);
        edges.forEach(({ k, side, ce }, i) => {
          const label = `${name}, row ${k}, side ${side}, AngleX ${ax}, AngleY ${ay}, AngleZ ${az}`;
          const at = landedOnBack(back, land, toBack, k, ce, side);
          expect(at.step ?? Infinity, label).toBeLessThanOrEqual(
            base[i] + ROUNDING,
          );
          if (!inside(k)) return;
          // From the edge's own pixel to where it lands (going out), or
          // across the strip it leaves (coming in), less the rounding.
          const cb = at.col;
          const [c0, c1] =
            side > 0
              ? [Math.min(ce - 1, cb + 0.1), Math.max(ce, cb - 0.1)]
              : [Math.min(ce, cb + 0.1), Math.max(ce + 1, cb - 0.1)];
          expect(
            backPaints(back, at.row, Math.floor(c0), Math.ceil(c1)),
            label,
          ).toBe(true);
        });
      }
      return { edges: edges.length, sides };
    };

    it("keeps every cap edge no further outside the back hair than the nod alone puts it", () => {
      // The bangs nod further than the back hair, so a row's edge lands over
      // the back's rows under it looking down, over it looking up. The crown
      // turns as the cap's top row: over a back hair backing it to the plate
      // (wideBack) it rides, and where the rows under it pass over the
      // unbacked temple (fullBack) its sides hold with that row's.
      const poses = [
        [-30, -30],
        [-30, 30],
        [30, -30],
        [30, 30],
        [-15, -15],
        [-15, 15],
        [15, -15],
        [15, 15],
      ].map(([ax, ay]) => [ax, ay, 0]);
      for (const [name, opts, m] of [
        ["fullBack", { fullBack: true }, full],
        ["wideBack", { wideBack: true }, wideBack.model],
      ] as const) {
        const { edges } = expectCapBound(name, opts, m, poses);
        expect(edges, name).toBeGreaterThan(0);
      }
    });

    it("never turns the cap's outer edge further outside the back hair than the nod alone puts it, following less where the back hair reaches less", () => {
      // The bangs' dome lies inside the eyes' outer corners, over a back-hair
      // dome only 45 px wider down to row 179: looking up, a row's edge meets
      // back rows that reach about 37 px past it, more than the bangs' motion
      // against the back hair at the profile's follow (34 px), less than at
      // hairFollow 2 (65 px). The nod alone keeps every edge inside. The
      // dome's top rows turn as the cap's top row: at hairFollow 2 they slide
      // further than the back hair above them reaches and draw the head's top
      // outline themselves, so the bound reads the cap from the plate's top
      // (row 200) down; at the profile's follow, from the bangs' top.
      const opts = { narrowCap: true };
      const poses: number[][] = [];
      for (const ax of [-30, -15, 15, 30])
        for (const ay of [-30, -15, 0, 15, 30])
          for (const az of [-30, 0, 30]) poses.push([ax, ay, az]);
      for (const plan of [
        {},
        { hair: { follow: 2 } },
        { hair: { follow: 2 }, turn: { amount: 1.25 } },
      ]) {
        const { model: m } = rig(opts, {}, { rigPlan: plan });
        expect(capBottom(m)).toBe(330);
        const { edges, sides } = expectCapBound(
          `narrowCap ${JSON.stringify(plan)}`,
          opts,
          m,
          poses,
          (k) => k < 210,
          plan.hair === undefined ? undefined : 200,
        );
        // Every row's edge is backed at rest.
        expect(edges).toBe(sides);
      }
    });

    it("turns the crown as the cap's top row, inside its back hair where that back hair leaves it room", () => {
      // Every crown row turns as the cap's top row, at every column: the
      // dome moves with the cap, one piece. At the profile's follow this back
      // hair leaves the dome room: looking up and turned, every dome row's far
      // edge stays inside its back run, and the crown rides as far as without
      // runs. At hairFollow 2 the cap's top row holds its far side, and the
      // crown's middle rides less far than without runs.
      const opts = { narrowCap: true };
      const back = layerOf(opts, "hair_back");
      const front = layerOf(opts, "hair_front");
      for (const plan of [
        {},
        { hair: { follow: 2 } },
        { hair: { follow: 2 }, turn: { amount: 1.25 } },
      ]) {
        const { model: m } = rig(opts, {}, { rigPlan: plan });
        const held = rig(opts, {}, { rigPlan: plan, drop: ALL_RUNS }).model;
        const turn = plan.turn?.amount ?? 1;
        const binds = plan.hair?.follow !== undefined;
        for (const ax of [-30, 30]) {
          const label = `${JSON.stringify(plan)}, AngleX ${ax}`;
          // A dome row's bangs (canvas row 130) across it.
          const y = 370;
          for (const x of [-100, 0, 100])
            expect(shift(m, x, y, ax), `${label}, x ${x}`).toBeCloseTo(
              shift(m, x, capTopY(m), ax),
              4,
            );
          expect(shift(m, 0, y, ax), label).toBeGreaterThan(
            TURN.hairBack * turn + 0.01,
          );
          if (binds) {
            expect(shift(m, 0, y, ax), label).toBeLessThan(
              shift(held, 0, y, ax) - 0.005,
            );
            continue;
          }
          expect(shift(m, 0, y, ax), label).toBeGreaterThan(
            shift(held, 0, y, ax) - 0.005,
          );
          const pose = { [P.AngleX]: ax, [P.AngleY]: 30 };
          const toBack = backRest(m, pose);
          const land = landerFor(m, "hair_front", pose);
          const side = Math.sign(ax);
          let tightest = Infinity;
          for (let k = front.bbox.y; k < 210; k += 2) {
            const runs = front.rowRuns![k - front.bbox.y];
            const ce = side > 0 ? runs[runs.length - 1] : runs[0];
            const at = landedOnBack(back, land, toBack, k, ce, side);
            const inside = insideRun(back, at, side);
            expect(inside, `${label}, row ${k}`).toBeDefined();
            tightest = Math.min(tightest, inside!);
          }
          expect(tightest, label).toBeGreaterThan(-ROUNDING);
        }
      }
    });

    it("cuts a cap row under the plate's top out toward its edge, keeping the axis's follow and three quarters of each cell", () => {
      // At hairFollow 2 the temple's edges outrun the solid band's back hair
      // under them looking down (48 px past them): their rows give up a cut
      // that grows out from the axis's cell, and blend not at all. Inside
      // the eyes' outer corners today's follow is the same in every column,
      // so a cell's width at a full turn is its rest width there.
      const opts = { narrowCap: true };
      const rigPlan = { hair: { follow: 2 } };
      const { model: m } = rig(opts, {}, { rigPlan });
      const held = rig(opts, {}, { rigPlan, drop: ALL_RUNS }).model;
      const part = m.parts.find((p) => p.id === "hair_front")!;
      const columns = new Set(part.mesh!.vertices.filter((_, i) => i % 2 === 0))
        .size;
      const rest = landVertices(m, "hair_front");
      for (const ax of [-30, 30]) {
        const turned = landVertices(m, "hair_front", X30(ax));
        let narrowest = Infinity;
        for (const k of [290, 330]) {
          const label = `row ${k}, AngleX ${ax}`;
          expect(
            Math.abs(shift(m, 0, 500 - k, ax) - shift(held, 0, 500 - k, ax)),
            label,
          ).toBeLessThan(0.002);
          for (let i = 0; i + 1 < rest.length / 2; i++) {
            const [x0, x1] = [rest[i * 2], rest[(i + 1) * 2]];
            if (i % columns === columns - 1) continue;
            if (Math.round(500 - rest[i * 2 + 1]) !== k) continue;
            if (Math.abs(x0) > 170 || Math.abs(x1) > 170) continue;
            const width = (turned[(i + 1) * 2] - turned[i * 2]) / (x1 - x0);
            expect(width, `${label}, cell at x ${x0}`).toBeGreaterThan(
              0.75 - 1e-3,
            );
            narrowest = Math.min(narrowest, width);
          }
        }
        // The cut narrows the far side's cells: it acts here.
        expect(narrowest, `AngleX ${ax}`).toBeLessThan(0.99);
      }
    });

    it("leaves the rows beside the eyes as today, however little back hair is behind them", () => {
      // Under the eyes' top the front hair keeps today's motion: at the eye
      // row each lock's outer edge (±200) has back hair only 2 px past it.
      const held = rig({ tightLock: true }, {}, { drop: ALL_RUNS }).model;
      for (const ax of [-30, -15, 15, 30]) {
        // The far lock's outer edge: column 701 turning toward +x, 300
        // toward −x.
        const x = (ax > 0 ? 701 : 300) - 500;
        expect(
          edge(tightLock.model, "hair_front", x, EYE_Y, ax),
          `AngleX ${ax}`,
        ).toBe(edge(held, "hair_front", x, EYE_Y, ax));
      }
    });

    /** The cap's blend toward the back hair's motion on each vertex row `ys`
     *  turning by AngleX `ax`, read at model x `x` (the axis by default): how
     *  far short of the same set without runs (`held`) the front hair turns
     *  there, over how far that lies from the back hair's motion. Exact where
     *  the ride lifts nothing and the cap cuts nothing, or where the blend is
     *  whole. */
    const blends = (
      m: IkiModel,
      held: IkiModel,
      ys: number[],
      ax: number,
      x = 0,
    ) =>
      ys.map((y) => {
        const h = shift(held, x, y, ax);
        return (h - shift(m, x, y, ax)) / (h + DRIFT / HH);
      });
    /** Turning toward −x, a vertex column on these sets' caps' far side, 26
     *  px inside the bangs' widest (−262): where the far edge holds wholly
     *  to the back hair, and nothing lifts the ramp's rows. */
    const HELD_X = -236;
    /** The columns `HELD_X` reads at AngleX `ax`: it, turning toward −x. */
    const heldAt = (ax: number) => (ax < 0 ? [HELD_X] : []);
    /** `tuckedTemple` at hairFollow 2. On the cap row at the plate's top
     *  (canvas row 210) the back hair reaches 58 px past the bangs' edges;
     *  on the turn the row's edges would run past that, and a cut alone
     *  brings them back in, so on its own the row blends next to nothing —
     *  as silver-hood's cap row at y 0.333 did. The cap rows under it pass
     *  over the tucked rows looking down and blend wholly. */
    const tucked = (drop?: typeof ALL_RUNS) =>
      rig(
        { tuckedTemple: true },
        {},
        { rigPlan: { hair: { follow: 2 } }, drop },
      ).model;
    const tuckedModel = tucked();
    const tuckedHeld = tucked(ALL_RUNS);

    it("ramps the cap's held edges out evenly below the cap, to nothing at the eyes' top, the bangs over the face riding it", () => {
      // Under each cap row at or below the plate's top the blend falls,
      // column by column, no faster than evenly in distance, to nothing at
      // the first vertex row at or below the eyes' top (`zero`): each row
      // blends the most of those rows' blends so scaled, or its own where
      // that is more. Read at the cap's far held edge (`HELD_X`): a row that
      // binds nothing of its own takes the ramp exactly — fullBack's and the
      // tuft's unbound temple (canvas rows 250–330, under the plate's top
      // row, whose edges move with the back hair) and every row past the
      // cap. tuckedTemple's cap rows' edges all blend wholly, and the rows
      // past them ramp out from the cap's last. At the axis the bangs over
      // the face blend little: they ride the face.
      const cases: [string, IkiModel, IkiModel, number[]][] = [
        ["fullBack", full, today, [250, 290, 330]],
        [
          "tuft",
          tuft.model,
          rig({ tuft: true }, {}, { drop: ALL_RUNS }).model,
          [250, 290, 330],
        ],
        ["tuckedTemple", tuckedModel, tuckedHeld, []],
      ];
      for (const [name, m, held, unbound] of cases) {
        const { ys, last, zero, plateTop } = capRows(m);
        const row = (r: number) => Math.round(500 - ys[r]);
        expect(row(zero), name).toBe(383);
        // The ramp's sources.
        const sources = ys
          .map((_, q) => q)
          .filter((q) => q <= last && ys[q] <= plateTop);
        for (const ax of [-30, 30]) {
          for (const x of heldAt(ax)) {
            const label = `${name}, x ${x}, AngleX ${ax}`;
            const b = blends(m, held, ys, ax, x);
            expect(
              Math.max(...sources.map((q) => b[q])),
              label,
            ).toBeGreaterThan(0.99);
            for (let r = sources[0] + 1; r < zero; r++) {
              const ramp = Math.max(
                ...sources
                  .filter((q) => q < r)
                  .map((q) => (b[q] * (ys[r] - ys[zero])) / (ys[q] - ys[zero])),
              );
              const at = `${label}, row ${row(r)}`;
              expect(b[r], at).toBeGreaterThan(ramp - 0.01);
              if (r > last || unbound.includes(row(r)))
                expect(b[r], at).toBeLessThan(ramp + 0.01);
            }
          }
          const label = `${name}, AngleX ${ax}`;
          const axis = blends(m, held, ys, ax);
          for (let r = sources[0]; r < zero; r++)
            expect(axis[r], `${label}, axis, row ${row(r)}`).toBeLessThan(0.15);
          // From `zero` down, today's motion.
          for (let r = zero; r < ys.length; r++) {
            expect(
              Math.abs(shift(m, 0, ys[r], ax) - shift(held, 0, ys[r], ax)),
              `${label}, row ${row(r)}`,
            ).toBeLessThan(1e-3);
          }
        }
      }
    });

    it("leaves the turn alone when shallow eyes put the eyes' top under the irises", () => {
      // 30 px eyes put the first vertex row at or below their top (row 418)
      // under the irises' top (row 396): the ramp ends at the row above it
      // instead, so none of it falls over an iris row. The span between the
      // cap and the irises is 7.5 px, too thin to take a row, so the ramp is
      // as short as the existing rows allow. The turn keeps the eyes' shift
      // (0.1943, as without the ramp; 0.1379 with it ended below the irises)
      // and no iris under a strand.
      const { report, model } = rig({ fullBack: true, shallowEyes: true });
      const { ys, last } = capRows(model);
      expect(Math.round(500 - ys[last])).toBe(370);
      expect(report!.achieved.eyeShift).toBeGreaterThan(0.19);
      expect(report!.strandOverlap).toBeUndefined();
      // No vertex row at or below the irises' top pixel row's centre blends.
      const held = rig(
        { fullBack: true, shallowEyes: true },
        {},
        { drop: ALL_RUNS },
      ).model;
      for (const ax of [-30, 30]) {
        const b = blends(model, held, ys, ax);
        ys.forEach((y, r) => {
          if (y <= 500 - 396 - 0.5)
            expect(
              b[r],
              `AngleX ${ax}, row ${Math.round(500 - y)}`,
            ).toBeCloseTo(0, 2);
        });
      }
    });

    it("spreads the cap's blend over rows between the cap and the irises", () => {
      // The ramp needs rows to fall over: tuckedTemple at hairFollow 2 has the
      // front hair's cap edges riding with the back hair at -3 px where the
      // face's follow would take them 62 px, and one 40 px cell between the
      // cap's last row and the irises' top would jump all 65 px in it. With
      // the mesh refined to three rows there, no adjacent pair of vertex rows
      // at the cap's held edges steps over 0.45 of that (the widest is 26 px,
      // into the first row the ride lifts); nor, from the plate's top down,
      // at the axis, where the bangs ride the face.
      const JUMP = 0.45 * 65;
      for (const [name, opts, rigPlan] of [
        ["tuckedTemple", { tuckedTemple: true }, { hair: { follow: 2 } }],
      ] as const) {
        const { model } = rig(opts, {}, { rigPlan });
        const { ys, last } = capRows(model);
        const irisTop = Math.max(
          ...["iris_L", "iris_R"].map((id) => {
            const p = model.parts.find((q) => q.id === id)!;
            return p.transform.y + p.height / 2;
          }),
        );
        const between = ys.filter((y, r) => r > last && y > irisTop);
        expect(between.length, name).toBeGreaterThanOrEqual(3);
        const { plateTop } = capRows(model);
        for (const ax of [-30, 30]) {
          for (const x of [...heldAt(ax), 0]) {
            let widest = 0;
            for (let r = 1; r < ys.length; r++) {
              if (x === 0 && ys[r - 1] > plateTop) continue;
              const dx =
                edge(model, "hair_front", x, ys[r], ax) -
                edge(model, "hair_front", x, ys[r - 1], ax);
              widest = Math.max(widest, Math.abs(dx));
            }
            expect(widest, `${name}, x ${x}, AngleX ${ax}`).toBeLessThan(JUMP);
          }
        }
      }
    });

    it("falls evenly in distance over the ramp's cells, whatever their heights", () => {
      // The refined rows split a cell unevenly (the cap's last row to the
      // first new one is wider than the new ones): a blend even per row would
      // pack its fall into the narrow cells. At the cap's held edges, where
      // the cap's last row blends wholly, each row between it and the ramp's
      // end blends its share of the distance to that end (a blend even per
      // row would give 2/3 and 1/3).
      for (const [name, opts, rigPlan] of [
        ["tuckedTemple", { tuckedTemple: true }, { hair: { follow: 2 } }],
      ] as const) {
        const { model } = rig(opts, {}, { rigPlan });
        const held = rig(opts, {}, { rigPlan, drop: ALL_RUNS }).model;
        const { ys, last, zero } = capRows(model);
        expect(zero - last, name).toBeGreaterThanOrEqual(3);
        for (const ax of [-30, 30]) {
          for (const x of heldAt(ax)) {
            const label = `${name}, x ${x}, AngleX ${ax}`;
            const b = blends(model, held, ys, ax, x);
            expect(b[last], label).toBeGreaterThan(0.99);
            for (let r = last + 1; r < zero; r++)
              expect(b[r], `${label}, row ${r}`).toBeCloseTo(
                (ys[r] - ys[zero]) / (ys[last] - ys[zero]),
                2,
              );
          }
        }
      }
    });

    it("adds no row outside the front hair's box to cropped bangs, and ramps them to a finite end", () => {
      // shortFringe's bangs end above the eyes' rows, so the span between the
      // cap's limit and the irises lies under their box: its mesh rows stay
      // the box's even ones, from its top (model y 350) to its bottom (170).
      const m = rig({ shortFringe: true }).model;
      const part = m.parts.find((p) => p.id === "hair_front")!;
      const ys = [...new Set(part.mesh!.vertices.filter((_, i) => i % 2))]
        .map((u) => part.transform.y + u * part.height)
        .sort((a, b) => b - a);
      expect(ys[0]).toBeCloseTo(350, 3);
      expect(ys[ys.length - 1]).toBeCloseTo(170, 3);
      const step = (ys[0] - ys[ys.length - 1]) / (ys.length - 1);
      ys.forEach((y, r) =>
        expect(y, `row ${r}`).toBeCloseTo(350 - r * step, 2),
      );

      // With measured runs the hair's whole mesh lies above the eyes' top, so
      // the ramp has no vertex row to end at: it ends at the row that vertex
      // would sit on, the eyes' top, finite and under every mesh row.
      const st = {};
      const withRuns = rig({ shortFringeRuns: true }, {}, st).model;
      const held = rig(
        { shortFringeRuns: true },
        {},
        { ...st, drop: ALL_RUNS },
      ).model;
      const { ys: rows, last } = capRows(withRuns);
      for (const p of withRuns.parts)
        for (const w of p.warps ?? [])
          for (const k of w.keyforms)
            for (const o of k.offsets)
              expect(Number.isFinite(o), `${p.id} ${w.parameter}`).toBe(true);
      const partOf = (id: string) => withRuns.parts.find((q) => q.id === id)!;
      const eyeTop = Math.max(
        ...["eye_L", "eye_R"].map(
          (id) => partOf(id).transform.y + partOf(id).height / 2,
        ),
      );
      const irisTop = Math.max(
        ...["iris_L", "iris_R"].map(
          (id) => partOf(id).transform.y + partOf(id).height / 2,
        ),
      );
      const end = Math.min(
        Math.max(eyeTop, irisTop - 0.5),
        rows[rows.length - 1] - 1,
      );
      expect(last, "the cap's last row is not the mesh's").toBeLessThan(
        rows.length - 1,
      );
      for (const ax of [-30, 30]) {
        const b = blends(withRuns, held, rows, ax);
        const sources = rows
          .map((_, q) => q)
          .filter((q) => q <= last && rows[q] <= capRows(withRuns).plateTop);
        for (let r = 1; r < rows.length; r++) {
          const ramp = Math.max(
            0,
            ...sources
              .filter((q) => q < r)
              .map((q) => (b[q] * (rows[r] - end)) / (rows[q] - end)),
          );
          expect(b[r], `AngleX ${ax}, row ${r}`).toBeGreaterThan(ramp - 0.01);
        }
      }
    });

    it("blends no cap row less than the one under it", () => {
      // tuckedTemple's row at the plate's top would blend next to nothing,
      // over rows whose edges blend wholly: at those edges it takes their
      // blend, so the cap's outline does not shear between a row turning
      // with the face and the rows under it holding to the back hair.
      const { ys, zero, plateTop } = capRows(tuckedModel);
      const first = ys.findIndex((y) => y <= plateTop);
      for (const ax of [-30, 30])
        for (const x of heldAt(ax)) {
          const label = `x ${x}, AngleX ${ax}`;
          const b = blends(tuckedModel, tuckedHeld, ys, ax, x);
          expect(b[first + 1], label).toBeGreaterThan(0.5);
          // The row at the plate's top is raised with it.
          expect(b[first], label).toBeGreaterThan(0.5);
          // From the cap's top row under the plate down to `zero`.
          for (let r = first + 1; r <= zero; r++) {
            expect(
              b[r - 1],
              `${label}, row ${Math.round(500 - ys[r - 1])}`,
            ).toBeGreaterThan(b[r] - 0.01);
          }
        }
    });

    it("turns the bangs over the face with the face plate where a wide back hair holds only the cap's edges", () => {
      // tuckedTemple: a back hair ±320 behind the bangs' ±262 — the
      // silhouette, wider than the head — tucked in 5 px inside their edges on
      // the temple's last 30 rows. Looking down, the cap rows from 258 pass
      // over the tucked rows, so on the turn their edges move with the back
      // hair: the outline holds. That holds the edges only — a twin-tail
      // back hair binds its cap rows the same way — so from the plate's top
      // to the bangs' tips the bangs at the axis turn with the face plate
      // (they once held all the way across with the back hair, then lagged
      // the face down to the eyes' top), and the crown above the plate turns
      // with them, as the cap's top row: one piece, nothing leaning between
      // them (it once eased to the back hair: 34 px over 40 rows at the axis).
      const m = rig({ tuckedTemple: true }).model;
      const { ys, last, zero, plateTop } = capRows(m);
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        for (const y of ys.filter((y) => y <= plateTop && y > ys[zero])) {
          const label = `row ${Math.round(500 - y)}, AngleX ${ax}`;
          const plate =
            (Math.sign(ax) * (landedXAt(m, "face", 0, y, X30(ax)) - 0)) / HH;
          expect(plate, label).toBeCloseTo(a * TURN.face, 3);
          expect(shift(m, 0, y, ax) / plate, label).toBeGreaterThan(0.9);
        }
        // The cap's far edge holds to the back hair down to its last row.
        for (const x of heldAt(ax))
          for (const y of ys.filter((y) => y <= plateTop && y >= ys[last]))
            expect(
              shift(m, x, y, ax),
              `x ${x}, row ${Math.round(500 - y)}, AngleX ${ax}`,
            ).toBeCloseTo(TURN.hairBack * a, 3);
        // The crown turns as the cap's top row, at every column.
        for (const y of [489, 450, 410, 370, 330])
          for (const x of [-200, -100, 0, 100, 200])
            expect(
              shift(m, x, y, ax),
              `crown (${x}, ${y}), AngleX ${ax}`,
            ).toBeCloseTo(shift(m, x, capTopY(m), ax), 4);
        expect(
          shift(m, 0, 489, ax) /
            ((Math.sign(ax) * landedXAt(m, "face", 0, plateTop - 1, X30(ax))) /
              HH),
          `crown's top, AngleX ${ax}`,
        ).toBeGreaterThan(0.9);
      }
    });

    it("keeps the cell across the axis within a quarter of its width on the turn when no vertex column lies on the axis", () => {
      // tuckedTemple's front hair has its vertex columns either side of the
      // axis (±16), none on it. At hairFollow 2 and twice the turn its cap's
      // held edges spread their blend in to both of those columns, and the
      // cell between them keeps the allowance every other cell does: the cut
      // and the blend each change its width at a full turn by at most a
      // quarter of its rest width (it once stretched from 31 px to 82 px).
      const rigPlan = { hair: { follow: 2 }, turn: { amount: 2 } };
      const { model: m } = rig({ tuckedTemple: true }, {}, { rigPlan });
      const part = m.parts.find((p) => p.id === "hair_front")!;
      const columns = new Set(part.mesh!.vertices.filter((_, i) => i % 2 === 0))
        .size;
      const rest = landVertices(m, "hair_front");
      const bottom = capBottom(m);
      let cells = 0;
      for (const ax of [-30, 30]) {
        const turned = landVertices(m, "hair_front", X30(ax));
        for (let i = 0; i + 1 < rest.length / 2; i++) {
          if (i % columns === columns - 1) continue;
          const [x0, x1] = [rest[i * 2], rest[(i + 1) * 2]];
          if (!(x0 < 0.5 && 0.5 < x1)) continue;
          if (500 - rest[i * 2 + 1] > bottom + 0.5) continue;
          cells++;
          const width = (turned[(i + 1) * 2] - turned[i * 2]) / (x1 - x0);
          expect(
            Math.abs(width - 1),
            `row ${Math.round(500 - rest[i * 2 + 1])}, AngleX ${ax}`,
          ).toBeLessThanOrEqual(0.5 + 1e-3);
        }
      }
      expect(cells).toBeGreaterThan(0);
    });

    it("keeps a cap edge just under the plate's top inside the back hair as the crown row above reads it", () => {
      // plateTopStep: the bangs' rows 200–202, just under the plate's top,
      // reach ±262; from row 203 they step in to columns 300–700, over a back
      // hair tucked in to columns 243–757 on rows 240–247. Rows 200–202 lie
      // between the crown's last vertex row and the cap's top row, so the
      // render reads both for them: the crown row turns as the cap's top row,
      // so both reads bind that row's motion. At hairFollow 2 the turn with
      // the nod puts no edge there further outside the back hair than the nod
      // alone does (reading only the cap's own row let one out 1.8 px).
      const opts = { plateTopStep: true };
      const { model: m } = rig(opts, {}, { rigPlan: { hair: { follow: 2 } } });
      const poses: number[][] = [];
      for (const ax of [-30, -15, 15, 30])
        for (const ay of [-30, 0, 30]) poses.push([ax, ay, 0]);
      const { edges } = expectCapBound(
        "plateTopStep",
        opts,
        m,
        poses,
        () => false,
        200,
      );
      expect(edges).toBeGreaterThan(0);
    });

    it("rides the crown whole with the cap, its top rows included", () => {
      // The back hair reaches 58 px past the bangs' edges on every crown and
      // temple row: the crown moves with the fringe, one cap. It starts only
      // 10 px above the bangs' top, which rise further than that over it
      // looking up; the crown's top rows ride all the same, drawing the
      // head's top outline there themselves.
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        for (const y of [250, 400, 489]) {
          expect(
            shift(wideBack.model, 0, y, ax),
            `y ${y}, AngleX ${ax}`,
          ).toBeCloseTo(a * CORE, 2);
        }
      }
    });

    it("turns the crown as the cap's top row where the rows under it pass over the unbacked temple on the nod: its far side holds, its middle rides", () => {
      // The temple band's back hair ends 5 px inside the bangs' edges, and
      // the cap's top row (y 290) passes over it on the nod: the nod alone
      // shows its edges outside the back hair, so its far side moves with it
      // on the turn, while the bangs over the face on it ride. The crown
      // above turns as that row, column by column: nothing leans between
      // them.
      const top = capTopY(full);
      expect(Math.round(500 - top)).toBe(210);
      for (const ax of [-30, -15, 15, 30]) {
        const a = Math.abs(ax) / 30;
        for (const y of [300, 340, 400, 450, 489]) {
          for (const x of [-236, -100, 0, 100, 236])
            expect(
              shift(full, x, y, ax),
              `(${x}, ${y}), AngleX ${ax}`,
            ).toBeCloseTo(shift(full, x, top, ax), 4);
        }
        expect(shift(full, 0, 489, ax), `AngleX ${ax}`).toBeGreaterThan(
          0.9 * shift(today, 0, 489, ax),
        );
        expect(
          shift(full, 236 * Math.sign(ax), 489, ax),
          `far side, AngleX ${ax}`,
        ).toBeCloseTo(TURN.hairBack * a, 3);
      }
    });

    it("turns the crown as the cap's top row over a tuft, and as today over a parting and a gap over the face", () => {
      // A tuft: the back hair's top 40 px under the bangs' beside it. The
      // crown turns as the cap's top row at each column regardless, drawing
      // the head's top outline itself where the tuft leaves it bare. A
      // parting: a gap in the bangs over a hole in the back hair, which turns
      // with the crown as wideBack's does. A gap just under the plate's top,
      // over solid back hair: back hair alone would let it ride, but the face
      // lies in front of it. With the face's runs left out, its crop stands
      // in.
      const faceless = (opts: CharacterOptions) =>
        rig(opts, {}, { drop: (role) => role === "face" }).model;
      for (const [label, rigged] of [
        ["tuft", tuft.model],
        ["tuft, the face's runs left out", faceless({ tuft: true })],
      ] as const) {
        for (const ax of [-30, -15, 15, 30]) {
          const a = Math.abs(ax) / 30;
          for (const [x, y] of [
            [0, 489],
            [-150, 450],
            [150, 450],
            [-190, 400],
            [190, 400],
          ]) {
            expect(
              shift(rigged, x, y, ax),
              `${label}, (${x}, ${y}), AngleX ${ax}`,
            ).toBeCloseTo(shift(rigged, x, capTopY(rigged), ax), 4);
          }
          expect(shift(rigged, 0, 489, ax), label).toBeGreaterThan(
            0.9 * a * CORE,
          );
        }
      }
      const across = (y: number) => [-100, 0, 100].map((x) => [x, y] as const);
      // The parting's row lands within a hundredth of a pixel of where the
      // rig without runs lands it; the gap over the face, exactly there.
      for (const [name, opts, m, points, exact] of [
        ["crownGap", { crownGap: true }, crownGap.model, across(410), false],
        ["faceGap", { faceGap: true }, faceGap.model, across(rowY(205)), true],
      ] as const) {
        const held = rig(opts, {}, { drop: ALL_RUNS }).model;
        for (const [label, rigged] of [
          [name, m],
          [`${name}, the face's runs left out`, faceless(opts)],
        ] as const) {
          for (const ax of [-30, -15, 15, 30]) {
            for (const [x, y] of points) {
              const landed = expect(
                edge(rigged, "hair_front", x, y, ax),
                `${label}, (${x}, ${y}), AngleX ${ax}`,
              );
              const want = edge(held, "hair_front", x, y, ax);
              if (exact) landed.toBe(want);
              else landed.toBeCloseTo(want, 2);
            }
          }
        }
      }
    });

    it("holds the crown over a gap just above the plate's top, through the nod", () => {
      // Looking down, the bangs on rows 197–199 drop as far as the face's top,
      // the gap just above it: the crown row whose window reaches the gap
      // holds, the face's runs read or its crop standing in.
      const opts = { plateTopGap: true };
      const held = rig(opts, {}, { drop: ALL_RUNS }).model;
      for (const [label, drop] of [
        ["runs", () => false],
        ["the face's runs left out", (role: string) => role === "face"],
      ] as const) {
        const { model: m } = rig(opts, {}, { drop });
        for (const ax of [-30, -15, 15, 30]) {
          for (const x of [-100, 0, 100]) {
            expect(
              edge(m, "hair_front", x, rowY(198), ax),
              `${label}, x ${x}, AngleX ${ax}`,
            ).toBe(edge(held, "hair_front", x, rowY(198), ax));
          }
        }
      }
    });

    describe("over a gap beside the face", () => {
      // A 6 px gap in the bangs 9 px outside the face's runs, on rows just
      // under the plate's top, over solid back hair. Its crown rows hold only
      // in the turns where the face and the gap meet at the same angle.
      const opts = { besideFaceGap: true };
      /** Whether the crown holds over the gap: its points there land where
       *  the same rig without runs lands them. */
      const expectHeld = (m: IkiModel, held: IkiModel, ax: number) => {
        for (const x of [120, 135, 145]) {
          expect(
            edge(m, "hair_front", x, rowY(205), ax),
            `x ${x}, AngleX ${ax}`,
          ).toBe(edge(held, "hair_front", x, rowY(205), ax));
        }
      };

      it("holds as the face slides under it, and rides as the face turns away", () => {
        const held = rig(opts, {}, { drop: ALL_RUNS }).model;
        // Turning toward +x the face's slide carries it under the gap
        // partway through the turn.
        for (const ax of [15, 30]) expectHeld(besideFaceGap.model, held, ax);
        // Turning toward −x the face turns away faster than the gap's left
        // end follows it: the two never meet, so the crown rides whole (but
        // for its top rows, which rise above the back hair looking up).
        expect(shift(besideFaceGap.model, 0, 400, -30)).toBeCloseTo(CORE, 2);
      });

      it("holds when the front hair barely moves and only the face's turn meets the gap", () => {
        const rigPlan = { hair: { follow: 0 } };
        const m = rig(opts, {}, { rigPlan }).model;
        const held = rig(opts, {}, { rigPlan, drop: ALL_RUNS }).model;
        for (const ax of [15, 30]) expectHeld(m, held, ax);
      });

      it("holds when a narrower shell pulls the gap in under a face it keeps pace with", () => {
        // Turning toward −x the front hair keeps pace with the face; the
        // shell term pulls the gap's left end 20 px in, and it meets the face
        // late in the turn.
        const rigPlan = { hair: { follow: 1 } };
        const targets = { silhouetteRatio: 0.85 };
        const { model: m, report } = rig(opts, targets, { rigPlan });
        expect(report!.achieved.silhouetteRatio).toBeCloseTo(0.85, 2);
        const held = rig(opts, targets, { rigPlan, drop: ALL_RUNS }).model;
        for (const ax of [-15, -30]) expectHeld(m, held, ax);
      });

      it("rides when the front hair keeps pace with the face and no shell term brings them together", () => {
        const m = rig(opts, {}, { rigPlan: { hair: { follow: 1 } } }).model;
        expect(shift(m, 0, 400, -30)).toBeCloseTo(TURN.face, 2);
      });
    });
  });

  describe("the hair on the nod", () => {
    /** How far a rest point drops on screen at AngleY `ay`, hh. */
    const drop = (m: IkiModel, id: string, x: number, y: number, ay: number) =>
      (y - landedYAt(m, id, x, y, { [P.AngleY]: ay })) / HH;

    it("nods the bangs and the back hair by the profile, whatever the crown", () => {
      for (const [name, m] of [
        ["default", model],
        ["fullBack", fullBack.model],
        ["tuft", tuft.model],
      ] as const) {
        expect(drop(m, "hair_front", 0, 150, -30), name).toBeCloseTo(
          NOD.hairFront.down,
          2,
        );
        expect(drop(m, "hair_front", 0, 150, 30), name).toBeCloseTo(
          NOD.hairFront.up,
          2,
        );
        expect(drop(m, "hair_back", -350, -300, -30), name).toBeCloseTo(
          NOD.hairBack.down,
          2,
        );
        expect(drop(m, "hair_back", -350, -300, 30), name).toBeCloseTo(
          NOD.hairBack.up,
          2,
        );
      }
    });

    it("slides the cap's top with the face over a back hair drawn up past it, today's without runs", () => {
      // Just under the bangs' top (490): looking down, the profile's cap top
      // over a back hair painted above it in every column, the back hair's
      // own nod with no runs to tell; looking up, the cap top's either way.
      for (const [name, m, down] of [
        ["fullBack", fullBack.model, NOD.hairFrontTop.down],
        ["default", model, NOD.hairBack.down],
      ] as const) {
        expect(drop(m, "hair_front", 0, 489, -30), name).toBeCloseTo(down, 2);
        expect(drop(m, "hair_front", 0, 489, 30), name).toBeCloseTo(
          NOD.hairFrontTop.up,
          2,
        );
      }
    });

    /**
     * Per crown column of the `character(opts)` set rigged as `m` — its top
     * above the plate's (row 200) — how many more of the rows the back hair
     * leaves empty at its own nod its top bares at AngleY −30, landed through
     * the mesh, than the same set without runs bares. A row is bared when its
     * centre lies between the top's rest and landed edges, and the back hair
     * fills it when its own pixel there, its nod further up, is opaque.
     */
    const crownLosses = (opts: CharacterOptions, m: IkiModel) => {
      const { layers, options } = character(opts);
      const today = generateIkiFromLayerSet(
        layers.map((l) => ({ ...l, rowRuns: undefined })),
        CANVAS,
        options,
      );
      const front = layers.find((l) => l.role === "hair_front")!;
      const back = layers.find((l) => l.role === "hair_back")!;
      const inRuns = (runs: number[], c: number) => {
        for (let k = 0; k < runs.length; k += 2)
          if (runs[k] <= c && c + 1 <= runs[k + 1]) return true;
        return false;
      };
      const down = { [P.AngleY]: -30 };
      const backNod = 400 - landedYAt(m, "hair_back", 0, 400, down);
      const bared = (
        rigged: IkiModel,
        c: number,
        top: number,
        slack: number,
      ) => {
        const y = 500 - top;
        const s = y - landedYAt(rigged, "hair_front", c + 0.5 - 500, y, down);
        let n = 0;
        for (let i = 0; i + 0.5 < s + slack; i++) {
          const row = Math.floor(top + i + 0.5 - backNod) - back.bbox.y;
          if (!inRuns(back.rowRuns![row], c)) n++;
        }
        return n;
      };
      // The keyforms round each offset to 1e-4 of the part's height: read
      // each drop through that rounding the way that cannot fail the bound
      // on it alone.
      const round = 1e-4 * front.bbox.h;
      const losses = new Map<number, number>();
      for (let c = front.bbox.x; c < front.bbox.x + front.bbox.w; c++) {
        const r = front.rowRuns!.findIndex((runs) => inRuns(runs, c));
        if (r < 0 || front.bbox.y + r >= 200) continue;
        const top = front.bbox.y + r;
        losses.set(c, bared(m, c, top, -round) - bared(today, c, top, round));
      }
      return losses;
    };

    /** Each column loses at most 0.01 hh; and when the bound holds the
     *  slide (`tight`), the worst loses all the whole rows that leaves: the
     *  slide is the largest the bound allows. */
    const expectBound = (losses: Map<number, number>, tight: boolean) => {
      for (const [c, loss] of losses) {
        expect(loss, `column ${c}`).toBeLessThanOrEqual(0.01 * HH);
      }
      if (tight) {
        expect(Math.max(...losses.values())).toBe(Math.floor(0.01 * HH));
      }
    };

    it("slides the whole cap's top as far as its least-covered crown column allows", () => {
      const m = tuft.model;
      // The columns beside the tuft, their back hair's top 40 px under the
      // bangs', let the top slide about 0.01 hh past today's, the back
      // hair's own nod (as many whole rows as that leaves), and the tuft
      // does not lift it: the axis column slides as they do.
      const d = drop(m, "hair_front", 0, 489, -30);
      expect(d).toBeCloseTo(NOD.hairBack.down + 0.01, 2);
      for (const x of [-100, 100]) {
        expect(drop(m, "hair_front", x, 489, -30), `x ${x}`).toBeCloseTo(d, 4);
      }
      const losses = crownLosses({ tuft: true }, m);
      // Every column of the bangs' dome, ±262 about the axis, tops out above
      // the plate.
      expect(losses.size).toBe(2 * 262);
      expectBound(losses, true);
    });

    it("holds the whole cap's top near the back hair's nod over a parting dip", () => {
      // A back hair over the whole crown but for a 4 px dip at the axis: the
      // dip alone, bared by the back hair's own nod, binds the one slide.
      const { model: m } = rig({ dip: true });
      const d = drop(m, "hair_front", 0, 489, -30);
      expect(d).toBeCloseTo(NOD.hairBack.down + 0.01, 2);
      expect(drop(m, "hair_front", -200, 489, -30)).toBeCloseTo(d, 4);
      expectBound(crownLosses({ dip: true }, m), true);
    });

    it("slides the cap's top the whole way past a dip the bangs' own nod mostly bares", () => {
      // The same 4 px dip on the dome's shoulder, where each column's top
      // sits lower, and the crown there takes enough of the bangs' nod to
      // bare all but two rows of it at the back hair's own slide: within
      // the 0.01 hh budget, so it holds nothing.
      const { model: m } = rig({ shoulderDip: true });
      expect(drop(m, "hair_front", 0, 489, -30)).toBeCloseTo(
        NOD.hairFrontTop.down,
        2,
      );
      expectBound(crownLosses({ shoulderDip: true }, m), false);
    });
  });
});
