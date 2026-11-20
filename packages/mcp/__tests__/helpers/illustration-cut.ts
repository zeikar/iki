import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  cutLayersFromIllustration,
  type CutLayersFromIllustrationResult,
} from "../../src/illustration-cut";
import {
  BLACK_ON_PEACH,
  characterLandmarks,
  ORANGE_ON_WARM,
  PINK_ON_PEACH,
  writeCharacter,
  type CharacterColours,
  type CharacterOptions,
} from "./illustration-character";

/**
 * What the illustration-cut.*.test.ts files share. The cut's tests are
 * split across files so vitest runs them in parallel, a worker each: in
 * one file they took over ten minutes on a CI runner.
 */

const createdDirs: string[] = [];
/** Outputs must lie under the working directory. */
export function outDir(): string {
  const d = fs.mkdtempSync(
    path.join(process.cwd(), "node_modules", ".iki-mcp-cut-"),
  );
  createdDirs.push(d);
  return d;
}
export function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "iki-cut-"));
  createdDirs.push(d);
  return d;
}

/** Removes what outDir and tmpDir made: each file's afterAll. */
export function removeCutDirs(): void {
  for (const d of createdDirs) fs.rmSync(d, { recursive: true, force: true });
}

export type Ok = Extract<CutLayersFromIllustrationResult, { ok: true }>;

export async function picture(
  colours: CharacterColours,
  options?: CharacterOptions,
): Promise<string> {
  const file = path.join(tmpDir(), "character.png");
  await writeCharacter(file, colours, options);
  return file;
}

export async function cut(
  imagePath: string,
  landmarks: Record<string, any> = characterLandmarks(),
): Promise<Ok> {
  const r = await cutLayersFromIllustration({
    imagePath,
    landmarks,
    outputDir: outDir(),
  });
  if (!r.ok) throw new Error(r.error);
  return r;
}

export const check = (r: Ok, id: string) => r.checks.find((c) => c.id === id)!;
export const layer = (r: Ok, role: string) =>
  r.layers.find((l) => l.role === role)!;
export const part = (r: Ok, id: string) =>
  r.customParts.find((p) => p.id === id)!;

/** A written PNG's RGBA at (x, y). */
export async function pixelsOf(file: string) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    info,
    at: (x: number, y: number) => {
      const i = (y * info.width + x) * 4;
      return [...data.subarray(i, i + 4)];
    },
  };
}

/** Every written layer's alpha at (x, y). */
export async function coverAt(r: Ok, x: number, y: number): Promise<number[]> {
  const files = [
    ...r.layers.map((l) => l.path),
    ...r.customParts.map((p) => p.path),
  ];
  return Promise.all(files.map(async (f) => (await pixelsOf(f)).at(x, y)[3]));
}

/** The written layers' RGBA, in draw order (the layers come in it, the
 *  custom parts right after the back hair). */
export async function stackOf(r: Ok): Promise<Buffer[]> {
  const files = r.layers.flatMap((l) =>
    l.role === "hair_back"
      ? [l.path, ...r.customParts.map((p) => p.path)]
      : [l.path],
  );
  return Promise.all(files.map((f) => sharp(f).ensureAlpha().raw().toBuffer()));
}

export const W = 1100;

/** A hook that cuts a picture runs a full cut, about 5 s alone and several
 *  times that on a CI runner with the suite running beside it. */
export const CUT_HOOK_TIMEOUT = 120_000;

/** The largest channel difference between two colours. */
export const off = (a: ArrayLike<number>, b: readonly number[]) =>
  Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c])));

/** A resized flat colour stays within this many levels of itself, and a
 *  feature's trace is many times more. */
export const NEAR = 16;
/** The resize's soft edge and overshoot reach this many px into a shape. */
export const EDGE = 3;

export const COLOURINGS: [string, CharacterColours, boolean][] = [
  ["pink hair on peach skin", PINK_ON_PEACH, false],
  ["orange hair on warm skin", ORANGE_ON_WARM, false],
  [
    "near-black hair over a dark torso, a bodyOnly polygon on it",
    BLACK_ON_PEACH,
    true,
  ],
];
