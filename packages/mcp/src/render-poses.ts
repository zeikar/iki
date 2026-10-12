/**
 * The pose plan `render_poses` captures: the canvas framing, the crops and the
 * pose list, all decided from the model. It is the iki-character-loop's
 * render recipe, minus the page that ran it.
 */

import { StandardParameter, type IkiModel } from "@ikijs/format";

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

// The playground's view width for a full body, in model widths.
const FULL_BODY_VIEW_WIDTH = 2.5;
// The model's square is drawn this many px wide, in the whole shot or a crop.
const BUST_SIZE = 560;

export function planRenders(model: IkiModel): RenderPlan {
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
