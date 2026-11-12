import { describe, expect, it } from "vitest";
import { StandardParameter as P, type IkiModel } from "@ikijs/format";
import { generateIkiFromLayerSet, type TurnSolveReport } from "@ikijs/editor";
import { AMPLITUDE, ROLL_DEG } from "../src/auto-rig/profile";
import { CANVAS, character } from "./helpers/character";
import { type ParamValues } from "./helpers/render-oracle";
import {
  landVertices,
  landerFor,
  rig,
  HH,
  CHIN_Y,
  withEars,
} from "./helpers/head-rig";

const hero = rig();
const sideLocks = rig({ sideLocks: true });

describe("the side locks", () => {
  const m = sideLocks.model;
  const LOCKS = ["hair_side_L", "hair_side_R"] as const;
  /** Where each lock first shows under the bangs: canvas row 330, the
   *  temple band's end (`sideLocks`). */
  const ROOT_END = 500 - 330;
  const BAND_END = ROOT_END - 0.2 * HH;
  /** The bangs' tip travel at full sway (`hairSway`): the profile's sway, hh. */
  const AMP = AMPLITUDE.sway * HH;

  /** A lock's rest vertices, model space, by row (top row first). */
  function lockRows(id: string): [number, number][][] {
    const v = landVertices(m, id);
    const rows = new Map<number, [number, number][]>();
    for (let i = 0; i < v.length; i += 2) {
      const y = Math.round(v[i + 1] * 1e3) / 1e3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push([v[i], v[i + 1]]);
    }
    return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, r]) => r);
  }

  it("the locks add two parts and change nothing else", () => {
    const ids = m.parts.map((p) => p.id);
    expect(
      ids.slice(ids.indexOf("brow_R"), ids.indexOf("hair_front") + 1),
    ).toEqual(["brow_R", ...LOCKS, "hair_front"]);
    for (const id of LOCKS) {
      const part = m.parts.find((p) => p.id === id)!;
      expect(part.mesh, id).toBeDefined();
      expect(part.deformer, id).toBe("headDeformer");
      expect(
        part.warps!.map((w) => w.parameter),
        id,
      ).toEqual([P.AngleX, P.AngleY, P.HairSwayX, P.HairSwayZ, P.AngleZ]);
      expect(part.bindings, id).toBeUndefined();
    }
    const { layers, options } = character({ sideLocks: true });
    const isLock = (role: string) => role.startsWith("hair_side_");
    const without = generateIkiFromLayerSet(
      layers.filter((l) => !isLock(l.role)),
      CANVAS,
      {
        ...options,
        headEdges: {
          left: options.headEdges!.left.filter((e) => !isLock(e.role)),
          right: options.headEdges!.right.filter((e) => !isLock(e.role)),
        },
      },
    );
    const strip = (model: IkiModel) =>
      model.parts.filter((p) => !isLock(p.id)).map(({ order: _, ...p }) => p);
    expect(strip(m)).toEqual(strip(without));
    for (const k of [
      "parameters",
      "deformers",
      "physics",
      "expressions",
      "motions",
    ] as const) {
      expect(m[k], k).toEqual(without[k]);
    }
  });

  it("the root band lands where the front hair lands", () => {
    // Every vertex at and above where the lock first shows, its edge columns
    // among them: they take the bangs' field and sway exactly. The bangs'
    // own mesh, 31 px columns, carries their follow on the turn to within
    // 1.4 px of that field there; their nod, sway and roll to within 0.1 px.
    const poses: [ParamValues, number][] = [];
    for (const v of [-30, 30]) {
      poses.push([{ [P.AngleX]: v }, 1.5], [{ [P.AngleY]: v }, 0.5]);
      poses.push([{ [P.AngleZ]: v }, 0.5]);
    }
    for (const v of [-20, 20]) {
      poses.push([{ [P.HairSwayX]: v }, 0.5], [{ [P.HairSwayZ]: v }, 0.5]);
    }
    for (const id of LOCKS) {
      const root = lockRows(id).filter(([[, y]]) => y >= ROOT_END);
      expect(root.length, id).toBeGreaterThan(0);
      const part = m.parts.find((p) => p.id === id)!;
      const edges = root.flat().map(([x]) => x);
      expect(Math.min(...edges), id).toBeCloseTo(
        part.transform.x - part.width / 2,
        6,
      );
      expect(Math.max(...edges), id).toBeCloseTo(
        part.transform.x + part.width / 2,
        6,
      );
      for (const [pose, tol] of poses) {
        const lock = landerFor(m, id, pose);
        const front = landerFor(m, "hair_front", pose);
        for (const [x, y] of root.flat()) {
          const a = lock(x, y);
          const b = front(x, y);
          const at = `${id} (${x}, ${y}) ${JSON.stringify(pose)}`;
          expect(Math.abs(a.x - b.x), at).toBeLessThan(tol);
          expect(Math.abs(a.y - b.y), at).toBeLessThan(tol);
        }
      }
    }
  });

  it("a long lock's coarse cells do not carry the face's blend into its hidden root", () => {
    // Locks 600 px tall (to row 899): even cells of 25 px would straddle the
    // row where they first show, and interpolate the face's motion into it.
    const { layers, options } = character({ sideLocks: true });
    const long = generateIkiFromLayerSet(
      layers.map((l) =>
        l.role.startsWith("hair_side_")
          ? {
              ...l,
              bbox: { ...l.bbox, h: 600 },
              cropH: 600,
              rowRuns: Array.from({ length: 600 }, () => l.rowRuns![0]),
            }
          : l,
      ),
      CANVAS,
      options,
    );
    for (const id of LOCKS) {
      const part = long.parts.find((p) => p.id === id)!;
      const x0 = part.transform.x - part.width / 2;
      for (const [pose, tol] of [
        [{ [P.AngleX]: 30 }, 1.5],
        [{ [P.AngleX]: -30 }, 1.5],
        [{ [P.HairSwayX]: 20 }, 0.5],
        [{ [P.HairSwayZ]: 20 }, 0.5],
      ] as [ParamValues, number][]) {
        const lock = landerFor(long, id, pose);
        const front = landerFor(long, "hair_front", pose);
        // Points between the vertices, at and just above the root's end.
        for (const y of [ROOT_END, ROOT_END + 3, ROOT_END + 11]) {
          for (const dx of [7, 23, 41, 58]) {
            const a = lock(x0 + dx, y);
            const b = front(x0 + dx, y);
            const at = `${id} (${dx}, ${y}) ${JSON.stringify(pose)}`;
            expect(Math.abs(a.x - b.x), at).toBeLessThan(tol);
            expect(Math.abs(a.y - b.y), at).toBeLessThan(tol);
          }
        }
      }
    }
  });

  it("the body moves with the face and keeps its width", () => {
    // The plate's field is a slide plus a width change about the axis, and
    // on this bust the fit keeps the plate's width: its axis on a row lands
    // as every column of that row's field does. Down to the chin, below
    // which the plate is the still neck; the plate's mesh carries the chin's
    // lead to within about a pixel between its rows.
    const axis = 0.5;
    for (const ax of [-30, 30]) {
      const pose = { [P.AngleX]: ax };
      const face = landerFor(m, "face", pose);
      const l = face(axis - 100, 0);
      const r = face(axis + 100, 0);
      expect(r.x - l.x, `plate ${ax}`).toBeCloseTo(200, 0);
    }
    for (const id of LOCKS) {
      const body = lockRows(id).filter(([[, y]]) => y <= BAND_END);
      expect(body.length, id).toBeGreaterThan(5);
      for (const pose of [-30, 30].flatMap((v): ParamValues[] => [
        { [P.AngleX]: v },
        { [P.AngleY]: v },
      ])) {
        const lock = landerFor(m, id, pose);
        const face = landerFor(m, "face", pose);
        for (const row of body) {
          const y = row[0][1];
          const at = `${id} y ${y} ${JSON.stringify(pose)}`;
          if (y >= CHIN_Y) {
            const f = face(axis, y);
            for (const [x] of row) {
              const a = lock(x, y);
              expect(Math.abs(a.x - x - (f.x - axis)), at).toBeLessThan(1.5);
              expect(Math.abs(a.y - f.y), at).toBeLessThan(1.5);
            }
          }
          const xs = row.map(([x]) => x);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          expect(
            Math.abs(lock(x1, y).x - lock(x0, y).x - (x1 - x0)),
            at,
          ).toBeLessThan(1);
        }
      }
    }
  });

  it("hangs from where it leaves the bangs under a roll, giving back 45 % of it", () => {
    // Under the bangs a lock rolls with the head. Past the root band it is
    // turned back about its root, so it keeps its length and its width, and
    // these locks, ending 7 px under the chin, hang as a longer one would.
    const tilt = (
      lock: ReturnType<typeof landerFor>,
      row: [number, number][],
    ) => {
      const xs = row.map(([x]) => x);
      const a = lock(Math.min(...xs), row[0][1]);
      const b = lock(Math.max(...xs), row[0][1]);
      return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    };
    for (const id of LOCKS) {
      const rows = lockRows(id);
      const xs = rows[0].map(([x]) => x);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
      const tipY = rows[rows.length - 1][0][1];
      for (const z of [-30, 30]) {
        const lock = landerFor(m, id, { [P.AngleZ]: z });
        const head = (-z / 30) * ROLL_DEG;
        for (const row of rows) {
          const y = row[0][1];
          if (y >= ROOT_END)
            expect(tilt(lock, row), `${id} y ${y}`).toBeCloseTo(head, 1);
          if (y <= BAND_END)
            expect(tilt(lock, row), `${id} y ${y}`).toBeCloseTo(0.55 * head, 1);
        }
        const root = lock(cx, ROOT_END);
        const tip = lock(cx, tipY);
        expect(
          Math.hypot(tip.x - root.x, tip.y - root.y),
          `${id} length at ${z}`,
        ).toBeCloseTo(ROOT_END - tipY, 1);
      }
    }
  });

  it("each tip sways the bangs' amplitude, however long", () => {
    // Below the band the lock's own root-pinned profile: its tip travels the
    // bangs' amplitude, however far below the bangs' share it hangs.
    for (const id of LOCKS) {
      const rows = lockRows(id);
      for (const s of [-20, 20]) {
        const lock = landerFor(m, id, { [P.HairSwayX]: s });
        const travel = (row: [number, number][]) =>
          Math.max(...row.map(([x, y]) => Math.abs(lock(x, y).x - x)));
        const tip = rows[rows.length - 1];
        expect(Math.abs(travel(tip) - AMP), `${id} tip ${s}`).toBeLessThan(1);
        for (const row of rows) {
          expect(travel(row), `${id} y ${row[0][1]} ${s}`).toBeLessThanOrEqual(
            AMP + 1e-3,
          );
        }
      }
    }
  });

  describe("the far-eye room report", () => {
    const report = sideLocks.report!;

    /** The set with every lock cut to its top `h` rows. */
    function cut(h: number) {
      const { layers, options } = character({ sideLocks: true });
      let r: TurnSolveReport | undefined;
      generateIkiFromLayerSet(
        layers.map((l) =>
          l.role.startsWith("hair_side_")
            ? {
                ...l,
                bbox: { ...l.bbox, h },
                cropH: h,
                rowRuns: l.rowRuns!.slice(0, h),
              }
            : l,
        ),
        CANVAS,
        { ...options, onTurnSolved: (x) => (r = x) },
      );
      return r!;
    }

    it("reads the lock covering the plate's edge and the eye's tail under it", () => {
      const { left, right } = report.hairSide!;
      expect(left!.role).toBe("hair_side_R");
      expect(right!.role).toBe("hair_side_L");
      for (const room of [left!, right!]) {
        expect(room.unavailable).toBeUndefined();
        expect(room.cover!.px).toBeGreaterThanOrEqual(0);
        // The far eye leads the plate past the lock's inner edge (the rest
        // gap is 10 to 11 px): a fraction of a pixel under it at the far
        // stop. The two-sided bound catches a flipped sign or a wrong
        // inner-edge coordinate.
        expect(room.tail!.eyeToLock).toBeLessThan(0);
        expect(room.tail!.eyeToLock).toBeGreaterThan(-1);
        expect(room.tail!.lashToLock).toBeDefined();
        expect(room.tail!.eyeToPlate).toBeGreaterThan(0);
      }
    });

    it("measures the cover against the head under an ear, not the ear", () => {
      // The ears (crop rows 170–260) stand 25 px past the head, whose edge
      // is 173 px from the axis there. The screen-left lock moved to 185 px
      // out covers the head and falls 13 px short of the ear.
      const { report: eared } = withEars({ sideLocks: true }, {}, (l) =>
        l.role === "hair_side_R"
          ? {
              ...l,
              bbox: { ...l.bbox, x: 315 },
              rowRuns: l.rowRuns!.map(() => [315, 385]),
            }
          : l,
      );
      const room = eared.hairSide!.left!;
      expect(room.cover!.px).toBeGreaterThan(0);
      // The far eye's corner sits past the head's edge under its ear, not
      // 14 px inside the ear's.
      expect(room.tail!.eyeToPlate).toBeLessThan(0);
    });

    it("keeps the head's edge on the rows just outside the ear band", () => {
      // A 20 px lock at column 322 covers the cheek; the smoothed plate
      // profile still carries the ear's width a few rows past the band.
      const { report: eared, frame } = withEars({ sideLocks: true }, {}, (l) =>
        l.role === "hair_side_R"
          ? {
              ...l,
              bbox: { ...l.bbox, x: 322, w: 20 },
              cropW: 20,
              rowRuns: l.rowRuns!.map(() => [322, 342]),
            }
          : l,
      );
      const { ears } = frame;
      expect(ears).toBeDefined();
      expect(eared.hairSide!.left!.cover!.px).toBeGreaterThan(0);
      for (const y of [ears!.bottom - 0.5, ears!.top + 0.5]) {
        expect(frame.headHalfAt(y), `y ${y}`).toBeLessThan(
          frame.paintedHalfAt(y),
        );
      }
    });

    it("reports unavailable for a lock without rowRuns, and nothing else", () => {
      const { report: r } = rig(
        { sideLocks: true },
        {},
        { drop: (role) => role.startsWith("hair_side_") },
      );
      for (const side of ["left", "right"] as const) {
        const room = r!.hairSide![side]!;
        expect(room.unavailable).toBe("no rowRuns");
        expect(room.cover).toBeUndefined();
        expect(room.tail).toBeUndefined();
      }
    });

    /** The screen-left lock's report with its rows `[0, 200)` running over
     *  columns `upper` and the rest over columns 250–320 (outside the head). */
    function twoPart(upper: [number, number]) {
      const { report: r } = withEars({ sideLocks: true }, {}, (l) =>
        l.role === "hair_side_R"
          ? {
              ...l,
              bbox: { ...l.bbox, x: 250, w: 200 },
              cropW: 200,
              rowRuns: l.rowRuns!.map((_, i) => (i < 200 ? upper : [250, 320])),
            }
          : l,
      );
      return r.hairSide!.left!;
    }

    it("reads the cover from the rows the lock covers at rest only", () => {
      // Its upper rows lie inside the head's edge (the root, the ear beside
      // it), 125 px from the axis against a head 132 to 160 wide: no edge to keep covering
      // and must not drag the number negative.
      const room = twoPart([375, 445]);
      expect(room.cover!.rest).toBeGreaterThanOrEqual(0);
      expect(room.cover!.px).toBeGreaterThan(0);
      // Model y of crop row 200 is 0: the covered rows lie below it.
      expect(room.cover!.y).toBeLessThan(0);
    });

    it("has no cover for a lock wholly inside the head's edge, and keeps the tail", () => {
      const { report: r } = withEars({ sideLocks: true }, {}, (l) =>
        l.role === "hair_side_R"
          ? {
              ...l,
              bbox: { ...l.bbox, x: 460, w: 40 },
              cropW: 40,
              rowRuns: l.rowRuns!.map(() => [460, 500]),
            }
          : l,
      );
      const room = r.hairSide!.left!;
      expect(room.cover).toBeUndefined();
      expect(room.tail).toBeDefined();
      expect(room.unavailable).toBeUndefined();
    });

    it("omits the tail where a lock stops short of the eye's row", () => {
      // Rows 300–400: on the plate, above the eye's centre row (433.5).
      const r = cut(100);
      for (const side of ["left", "right"] as const) {
        const room = r.hairSide![side]!;
        expect(room.cover, side).toBeDefined();
        expect(room.tail, side).toBeUndefined();
        expect(room.unavailable, side).toBeUndefined();
      }
    });

    it("is absent without locks", () => {
      expect(hero.report!.hairSide).toBeUndefined();
      expect(rig({ fullBack: true }).report!.hairSide).toBeUndefined();
    });
  });
});
