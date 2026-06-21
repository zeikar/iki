/**
 * Recommended parameter ids.
 *
 * Models that use these ids can be driven by any host — Charivo's render
 * adapter, the editor's preview, an AI generator — without per-model wiring.
 * The names intentionally echo Live2D's standard parameters so the mental
 * model (and future imports) carry over.
 */
export const StandardParameter = {
  /** Mouth open amount for lip-sync (0 closed .. 1 open). */
  MouthOpen: "ParamMouthOpenY",
  /** Mouth form / smile (-1 .. 1). */
  MouthForm: "ParamMouthForm",
  /** Left eye open (0 closed .. 1 open). Drive with the right eye for a blink. */
  EyeOpenLeft: "ParamEyeLOpen",
  /** Right eye open (0 closed .. 1 open). */
  EyeOpenRight: "ParamEyeROpen",
  /** Eyeball gaze, horizontal (-1 .. 1). */
  EyeballX: "ParamEyeBallX",
  /** Eyeball gaze, vertical (-1 .. 1). */
  EyeballY: "ParamEyeBallY",
  /** Head angle, horizontal degrees. */
  AngleX: "ParamAngleX",
  /** Head angle, vertical degrees. */
  AngleY: "ParamAngleY",
  /** Head tilt / roll degrees. */
  AngleZ: "ParamAngleZ",
  /** Idle breath (0 .. 1), cycled by the host. */
  Breath: "ParamBreath",
  /** Left brow vertical raise/lower (-1 down .. 1 up). */
  BrowLeftY: "ParamBrowLY",
  /** Right brow vertical raise/lower (-1 down .. 1 up). */
  BrowRightY: "ParamBrowRY",
  /** Left brow tilt (-1 .. 1, CCW-positive). */
  BrowLeftAngle: "ParamBrowLAngle",
  /** Right brow tilt (-1 .. 1, CCW-positive). */
  BrowRightAngle: "ParamBrowRAngle",
  /** Horizontal hair sway. Physics OUTPUT — driven by the spring, not set by the host. */
  HairSwayX: "ParamHairSwayX",
} as const;

export type StandardParameterId =
  (typeof StandardParameter)[keyof typeof StandardParameter];
