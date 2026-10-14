/**
 * The pose plan `render_poses` captures: the canvas framing, the crops and the
 * pose list, all decided from the model. It is the iki-character-loop's
 * render recipe, minus the page that ran it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  IkiFormatError,
  StandardParameter,
  loadIkiModel,
  type IkiModel,
} from "@ikijs/format";
import type { FoldReport } from "@ikijs/engine";
import { checkModelFolds } from "./fold-report";
import {
  AutoRigInputError,
  confineToWorkingDirectory,
  resolveInputPath,
  resolveOutputDir,
  writeFileAtomic,
} from "./limits";
import { NO_BROWSER_MESSAGE, findBrowser, withBrowser } from "./render-browser";

export interface RenderCrop {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
}

export interface RenderPose {
  name: string;
  values: Record<string, number>;
  /** Canvas px source and output size; absent = the whole canvas. */
  crop?: RenderCrop;
}

export interface RenderPlan {
  canvas: { width: number; height: number };
  /** The player's view; absent = the model's own canvas. */
  view?: { x: number; y: number; width: number; height: number };
  fullBody: boolean;
  /** The mouth's centre in model px from the top-left. */
  mouth?: { cx: number; cy: number };
  poses: RenderPose[];
}

/** A pose the caller names, rendered in place of the model's own set. */
export interface RequestedPose {
  /** Written as `<outDir>/<name>.png`. */
  name: string;
  values: Record<string, number>;
  /** Model px from the top-left; absent = framed as the standard shots. */
  crop?: { x: number; y: number; w: number; h: number };
}

// The playground's view width for a full body, in model widths.
const FULL_BODY_VIEW_WIDTH = 2.5;
// The model's square is drawn this many px wide, in the whole shot or a crop.
export const BUST_SIZE = 560;
// A requested crop is drawn this many px wide, at its own aspect, and at
// most this many tall: the page sizes a canvas to it.
const CROP_WIDTH = 720;
const CROP_MAX_HEIGHT = 8192;
// The name becomes a file in outDir: no separator can climb out of it.
const POSE_NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * The model's own pose set, or `requested` alone when given. Throws
 * `AutoRigInputError` for a request it cannot render.
 */
export function planRenders(
  model: IkiModel,
  requested?: RequestedPose[],
): RenderPlan {
  const { width: W, height: H } = model.canvas;
  const fullBody = H > W;
  const canvas = fullBody
    ? {
        width: FULL_BODY_VIEW_WIDTH * BUST_SIZE,
        height: Math.ceil((BUST_SIZE * H) / W),
      }
    : { width: BUST_SIZE, height: BUST_SIZE };
  const view = fullBody
    ? { x: 0, y: 0, width: FULL_BODY_VIEW_WIDTH * W, height: H }
    : undefined;

  // The model's square sits in the middle of the canvas.
  const x0 = (canvas.width - BUST_SIZE) / 2;
  const s = BUST_SIZE / W;

  // The auto-rigger writes world-space part transforms and its deformers carry
  // no base transform, so the rest transform alone places the part.
  const mouthPart =
    model.parts.find((p) => p.id === "mouth_inner") ??
    model.parts.find((p) => p.id === "mouth");
  const mouth = mouthPart
    ? { cx: W / 2 + mouthPart.transform.x, cy: H / 2 - mouthPart.transform.y }
    : undefined;

  const squareCrop: RenderCrop | undefined = fullBody
    ? {
        sx: x0,
        sy: 0,
        sw: BUST_SIZE,
        sh: BUST_SIZE,
        dw: BUST_SIZE,
        dh: BUST_SIZE,
      }
    : undefined;
  const square = (name: string, values: Record<string, number> = {}) => ({
    name,
    values,
    crop: squareCrop,
  });
  const whole = (name: string, values: Record<string, number> = {}) => ({
    name,
    values,
  });

  if (requested) {
    if (requested.length === 0) throw new AutoRigInputError("poses is empty");
    const poses = requested.map((pose, i): RenderPose => {
      checkRequest(requested, i);
      if (!pose.crop) return square(pose.name, pose.values);
      // Clamped to the canvas first, so a box grown past an edge still renders.
      const left = Math.max(pose.crop.x, 0);
      const top = Math.max(pose.crop.y, 0);
      const w = Math.min(pose.crop.x + pose.crop.w, W) - left;
      const h = Math.min(pose.crop.y + pose.crop.h, H) - top;
      // Negated so a NaN corner is refused too.
      if (!(w > 0 && h > 0)) {
        throw new AutoRigInputError(
          `poses[${i}].crop does not overlap the model's ${W}x${H} canvas`,
        );
      }
      // Refused here, not by the page after earlier poses were written.
      const dh = Math.round((CROP_WIDTH * h) / w);
      if (dh < 1 || dh > CROP_MAX_HEIGHT) {
        throw new AutoRigInputError(
          `poses[${i}].crop meets the canvas in ${w}x${h} model px, which ${CROP_WIDTH} px wide draws ${dh} px tall, outside 1..${CROP_MAX_HEIGHT}`,
        );
      }
      return {
        name: pose.name,
        values: pose.values,
        crop: {
          sx: x0 + left * s,
          sy: top * s,
          sw: w * s,
          sh: h * s,
          dw: CROP_WIDTH,
          dh,
        },
      };
    });
    return { canvas, view, fullBody, mouth, poses };
  }

  // The engine ignores an undeclared id, so this only keeps `stress` from
  // naming settings the rig lacks: every loop rig declares its other ids (the
  // composer requires brows), but the body angles only with a `body` layer.
  const bodyAngles = Object.fromEntries(
    [
      StandardParameter.BodyAngleX,
      StandardParameter.BodyAngleY,
      StandardParameter.BodyAngleZ,
    ]
      .filter((id) => model.parameters.some((p) => p.id === id))
      .map((id) => [id, -10]),
  );

  const poses: RenderPose[] = [
    square("rest"),
    square("turn-m30", { ParamAngleX: -30 }),
    square("turn-p30", { ParamAngleX: 30 }),
    square("turn-15", { ParamAngleX: 15 }),
    square("nod-15", { ParamAngleY: 15 }),
    square("blink", { ParamEyeLOpen: 0 }),
    square("blink-half", { ParamEyeLOpen: 0.5 }),
    square("gaze", { ParamEyeBallX: 1 }),
    square("combined", { ParamAngleX: 30, ParamAngleY: 30, ParamAngleZ: 30 }),
    // Every head angle at its other extreme with the face moving too, where
    // moves that each look fine alone stack up into a fold.
    square("stress", {
      ParamAngleX: -30,
      ParamAngleY: -30,
      ParamAngleZ: -30,
      ParamMouthOpenY: 1,
      ParamEyeLOpen: 0.5,
      ParamEyeROpen: 0.5,
      ParamBrowLY: -1,
      ParamBrowRY: 1,
      ParamBrowLAngle: 1,
      ParamBrowRAngle: -1,
      ...bodyAngles,
    }),
  ];

  if (mouth) {
    // 180 x 120 model px centred on the mouth, drawn x4 onto 720 x 480: a
    // small mouth is unreadable in the whole shot.
    const crop = {
      sx: x0 + (mouth.cx - 90) * s,
      sy: (mouth.cy - 60) * s,
      sw: 180 * s,
      sh: 120 * s,
      dw: 720,
      dh: 480,
    };
    for (const open of [0, 0.3, 0.6, 1]) {
      for (const [name, form] of [
        ["m1", -1],
        ["0", 0],
        ["p1", 1],
      ] as const) {
        poses.push({
          name: `mouth-open-${open}-form-${name}`,
          values: { ParamMouthOpenY: open, ParamMouthForm: form },
          crop,
        });
      }
    }
    poses.push(
      {
        name: "mouth-laugh",
        values: { ParamMouthOpenY: 0.8, ParamMouthForm: 1 },
        crop,
      },
      { name: "mouth-surprised", values: { ParamMouthOpenY: 0.9 }, crop },
      {
        name: "mouth-turn-p30-half",
        values: { ParamAngleX: 30, ParamMouthOpenY: 0.5 },
        crop,
      },
    );
  }

  if (fullBody) {
    poses.push(
      whole("full-rest"),
      whole("full-turn-p30", { ParamAngleX: 30 }),
      whole("full-body-x-m10", { ParamBodyAngleX: -10 }),
      whole("full-body-x-p10", { ParamBodyAngleX: 10 }),
      whole("full-body-y-m10", { ParamBodyAngleY: -10 }),
      whole("full-body-y-p10", { ParamBodyAngleY: 10 }),
      whole("full-body-z-m10", { ParamBodyAngleZ: -10 }),
      whole("full-body-z-p10", { ParamBodyAngleZ: 10 }),
      whole("full-arm-l-16", { ParamArmL: 16 }),
      whole("full-arm-l-32", { ParamArmL: 32 }),
      whole("full-arm-r-16", { ParamArmR: 16 }),
      whole("full-arm-r-32", { ParamArmR: 32 }),
      whole("full-elbow-l-m10", { ParamElbowL: -10 }),
      whole("full-elbow-l-45", { ParamElbowL: 45 }),
      whole("full-elbow-l-90", { ParamElbowL: 90 }),
      whole("full-elbow-r-m10", { ParamElbowR: -10 }),
      whole("full-elbow-r-45", { ParamElbowR: 45 }),
      whole("full-elbow-r-90", { ParamElbowR: 90 }),
    );
    if (model.parameters.some((p) => p.id === StandardParameter.ArmPoseRight)) {
      poses.push(
        whole("full-pose-l", { ParamArmPoseL: 1 }),
        whole("full-pose-r", { ParamArmPoseR: 1 }),
        whole("full-pose-r-angle-m15", {
          ParamArmPoseR: 1,
          ParamArmPoseAngleR: -15,
        }),
        whole("full-pose-r-angle-p15", {
          ParamArmPoseR: 1,
          ParamArmPoseAngleR: 15,
        }),
        whole("full-pose-r-half", { ParamArmPoseR: 0.5 }),
      );
    }
  }

  return { canvas, view, fullBody, mouth, poses };
}

/** `requested[i]`'s name and values, as `planRenders` takes them. */
function checkRequest(requested: RequestedPose[], i: number): void {
  const { name, values } = requested[i];
  if (!POSE_NAME.test(name)) {
    throw new AutoRigInputError(
      `poses[${i}].name must match ${POSE_NAME.source} (it names <outDir>/<name>.png): ${JSON.stringify(name)}`,
    );
  }
  const first = requested.findIndex(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (first < i) {
    throw new AutoRigInputError(
      `poses[${i}].name ${JSON.stringify(name)} repeats poses[${first}].name ${JSON.stringify(requested[first].name)} (ignoring case: one file on a case-insensitive disk)`,
    );
  }
  for (const [id, value] of Object.entries(values)) {
    if (!Number.isFinite(value)) {
      throw new AutoRigInputError(
        `poses[${i}].values.${id} must be a finite number, got ${value}`,
      );
    }
  }
}

export interface RenderPosesInput {
  /** The rigged `.iki` to render (resolved against cwd). */
  modelPath: string;
  /** Existing directory under cwd the pose PNGs are written into. */
  outDir: string;
  /** Rendered in place of the model's own set; each is also fold-checked. */
  poses?: RequestedPose[];
}

export type RenderPosesResult =
  | {
      ok: true;
      outDir: string;
      canvas: RenderPlan["canvas"];
      fullBody: boolean;
      mouth?: RenderPlan["mouth"];
      /** Texture indices the engine could not load; the renders lack them. */
      failedTextures: number[];
      poses: { name: string; path: string }[];
      /** The model's own canvas, which `folds`' rest points are placed on in
       *  the text (`canvas` is the render's). */
      modelCanvas: IkiModel["canvas"];
      /** The model's folds, as `auto_rig_from_layers` reports them.
       *  Report-only: a fold never fails the render. */
      folds: FoldReport;
    }
  | { ok: false; error: string };

const PNG_PREFIX = "data:image/png;base64,";
const PAGE_SCRIPT_MS = 10_000;
const LOAD_MS = 60_000;
const CAPTURE_MS = 15_000;

function readPageScript(): string {
  // Resolves from both src/ (vitest) and dist/: each sits one level under the package.
  const url = new URL("../dist/render-page.global.js", import.meta.url);
  try {
    return readFileSync(url, "utf8");
  } catch (cause) {
    // A broken build or install, not caller input: it surfaces as a tool error.
    throw new Error(
      "could not read the render page script; run `pnpm build` in packages/mcp",
      { cause },
    );
  }
}

/**
 * Render the model's pose set into `outDir`. Only caller-input failures
 * (`AutoRigInputError`, `IkiFormatError`, and no installed browser) come back as
 * `{ ok: false, error }`; a browser or page failure throws.
 */
export async function renderPoses(
  input: RenderPosesInput,
): Promise<RenderPosesResult> {
  try {
    const modelFile = confineToWorkingDirectory(
      process.cwd(),
      resolveInputPath(input.modelPath, "model"),
      "model path",
      input.modelPath,
    );
    const outDir = resolveOutputDir(input.outDir);
    const model = loadIkiModel(readFileSync(modelFile, "utf8"));
    const plan = planRenders(model, input.poses);
    const browser = findBrowser();
    if (!browser) return { ok: false, error: NO_BROWSER_MESSAGE };
    const pageScript = readPageScript();
    const folds = checkModelFolds(
      model,
      input.poses?.map((p) => p.values),
    );

    const { failedTextures, poses } = await withBrowser(
      browser,
      async (evaluate) => {
        await evaluate(pageScript, PAGE_SCRIPT_MS);
        const loaded = (await evaluate(
          `window.__ikiRender.load(${JSON.stringify(model)}, ${JSON.stringify({ canvas: plan.canvas, view: plan.view })})`,
          LOAD_MS,
        )) as { failedTextures: number[] };
        const written: { name: string; path: string }[] = [];
        for (const pose of plan.poses) {
          const url = await evaluate(
            `window.__ikiRender.capture(${JSON.stringify(pose.values)}, ${JSON.stringify(pose.crop)})`,
            CAPTURE_MS,
          );
          if (typeof url !== "string" || !url.startsWith(PNG_PREFIX)) {
            throw new Error(`pose ${pose.name}: the page returned no PNG`);
          }
          const file = path.join(outDir, `${pose.name}.png`);
          writeFileAtomic(
            file,
            Buffer.from(url.slice(PNG_PREFIX.length), "base64"),
          );
          written.push({ name: pose.name, path: file });
        }
        return { failedTextures: loaded.failedTextures, poses: written };
      },
    );
    return {
      ok: true,
      outDir,
      canvas: plan.canvas,
      fullBody: plan.fullBody,
      mouth: plan.mouth,
      failedTextures,
      poses,
      modelCanvas: model.canvas,
      folds,
    };
  } catch (error) {
    if (error instanceof AutoRigInputError || error instanceof IkiFormatError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
