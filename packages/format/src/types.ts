/**
 * The `.iki` model format, version 1.
 *
 * A model is a flat list of drawable {@link IkiPart}s composited back-to-front,
 * plus a list of {@link IkiParameter}s (the controllable knobs) wired to those
 * parts through linear {@link IkiBinding}s. This is deliberately small: it
 * covers what a talking avatar needs (mouth, eyes, head, breath) without the
 * full deformer/warp-mesh system. Mesh deformation is a later format version.
 */
export const IKI_FORMAT_VERSION = 1;

/** A controllable knob on the model (e.g. mouth open, head angle). */
export interface IkiParameter {
  /** Stable id used by bindings and runtime control. */
  id: string;
  /** Human-readable label for editors. */
  name?: string;
  min: number;
  max: number;
  /** Resting value the runtime starts from. */
  default: number;
}

/** Which channel of a part's transform a binding drives. */
export type IkiTransformChannel =
  | "translateX"
  | "translateY"
  | "rotate"
  | "scaleX"
  | "scaleY"
  | "opacity";

/**
 * Linear mapping from one parameter's range onto a transform channel.
 *
 * The parameter's current value is normalized to 0..1 across its [min, max],
 * then mapped to `[from, to]`. For translate/rotate/scale channels the result
 * is summed onto the part's base transform; for `opacity` it is multiplied.
 */
export interface IkiBinding {
  /** Id of the parameter this binding listens to. */
  parameter: string;
  channel: IkiTransformChannel;
  from: number;
  to: number;
}

/** A part's base transform in model space, before bindings apply. */
export interface IkiTransform {
  /** Center position, model-space units, origin at canvas center, +y up. */
  x: number;
  y: number;
  /** Degrees, counter-clockwise positive. */
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  /** 0..1, default 1. */
  opacity?: number;
}

/** A drawable piece of the character. */
export interface IkiPart {
  id: string;
  /** RGBA fill, each channel 0..1. (Texture sampling arrives in a later version.) */
  color: [number, number, number, number];
  /** Width in model-space units. */
  width: number;
  /** Height in model-space units. */
  height: number;
  transform: IkiTransform;
  /** Paint order; lower draws first (further back). */
  order: number;
  bindings?: IkiBinding[];
}

/** A complete `.iki` puppet model. */
export interface IkiModel {
  /** Format version; see {@link IKI_FORMAT_VERSION}. */
  version: number;
  name: string;
  /** Logical model-space canvas the parts are laid out in. */
  canvas: { width: number; height: number };
  parameters: IkiParameter[];
  parts: IkiPart[];
}
