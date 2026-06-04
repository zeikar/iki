import { StandardParameter, type IkiModel } from "@iki/format";

/**
 * A hand-authored face built from solid-color quads. Crude on purpose — it
 * exists to prove the parameter -> binding -> transform -> pixels pipeline and
 * to show how a model wires the standard parameters a talking avatar needs.
 */
const SKIN: [number, number, number, number] = [0.98, 0.85, 0.74, 1];
const DARK: [number, number, number, number] = [0.16, 0.16, 0.2, 1];
const LIP: [number, number, number, number] = [0.78, 0.32, 0.36, 1];

// Shared head motion every facial part inherits so the face moves as one.
const headSway = [
  {
    parameter: StandardParameter.AngleX,
    channel: "translateX",
    from: -50,
    to: 50,
  },
  {
    parameter: StandardParameter.Breath,
    channel: "translateY",
    from: 0,
    to: -12,
  },
] as const;

export const sampleModel: IkiModel = {
  version: 1,
  name: "Sample Face",
  canvas: { width: 1000, height: 1000 },
  parameters: [
    {
      id: StandardParameter.MouthOpen,
      name: "Mouth Open",
      min: 0,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.MouthForm,
      name: "Mouth Form",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.EyeOpenLeft,
      name: "Eye L",
      min: 0,
      max: 1,
      default: 1,
    },
    {
      id: StandardParameter.EyeOpenRight,
      name: "Eye R",
      min: 0,
      max: 1,
      default: 1,
    },
    {
      id: StandardParameter.EyeballX,
      name: "Gaze X",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.EyeballY,
      name: "Gaze Y",
      min: -1,
      max: 1,
      default: 0,
    },
    {
      id: StandardParameter.AngleX,
      name: "Head Angle",
      min: -30,
      max: 30,
      default: 0,
    },
    {
      id: StandardParameter.Breath,
      name: "Breath",
      min: 0,
      max: 1,
      default: 0,
    },
  ],
  parts: [
    {
      id: "head",
      color: SKIN,
      width: 520,
      height: 620,
      order: 0,
      transform: { x: 0, y: 0 },
      bindings: [
        ...headSway,
        {
          parameter: StandardParameter.AngleX,
          channel: "rotate",
          from: 6,
          to: -6,
        },
      ],
    },
    {
      id: "eyeL",
      color: DARK,
      width: 90,
      height: 90,
      order: 2,
      transform: { x: -110, y: 70 },
      bindings: [
        ...headSway,
        {
          parameter: StandardParameter.EyeOpenLeft,
          channel: "scaleY",
          from: -0.85,
          to: 0,
        },
        {
          parameter: StandardParameter.EyeballX,
          channel: "translateX",
          from: -25,
          to: 25,
        },
        {
          parameter: StandardParameter.EyeballY,
          channel: "translateY",
          from: -20,
          to: 20,
        },
      ],
    },
    {
      id: "eyeR",
      color: DARK,
      width: 90,
      height: 90,
      order: 2,
      transform: { x: 110, y: 70 },
      bindings: [
        ...headSway,
        {
          parameter: StandardParameter.EyeOpenRight,
          channel: "scaleY",
          from: -0.85,
          to: 0,
        },
        {
          parameter: StandardParameter.EyeballX,
          channel: "translateX",
          from: -25,
          to: 25,
        },
        {
          parameter: StandardParameter.EyeballY,
          channel: "translateY",
          from: -20,
          to: 20,
        },
      ],
    },
    {
      id: "mouth",
      color: LIP,
      width: 150,
      height: 34,
      order: 2,
      transform: { x: 0, y: -150 },
      bindings: [
        ...headSway,
        {
          parameter: StandardParameter.MouthOpen,
          channel: "scaleY",
          from: 0,
          to: 3,
        },
        {
          parameter: StandardParameter.MouthForm,
          channel: "scaleX",
          from: -0.2,
          to: 0.4,
        },
      ],
    },
  ],
};
