import { type Affine, multiply, scale, translate } from "./affine";

/**
 * The part of model space a host wants on the canvas: its CENTRE and size, in
 * the frame a part's `x` / `y` already uses (origin at the canvas's centre, +y
 * up). A centre rather than a corner so the default, the model's own box, is
 * `{ x: 0, y: 0, width: model.canvas.width, height: model.canvas.height }`. The view is the
 * host's, not the model's: the format carries no field for it.
 */
export interface IkiView {
  x: number;
  y: number;
  width: number;
  height: number;
}

// No getter and no pose-bounds helper: how much room a pose set needs is the
// host's call (see the README's Framing section).

/** Copy `view`, throwing at the call that made a bad one rather than in the render loop. */
export function checkedView(view: IkiView): IkiView {
  const { x, y, width, height } = view;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Iki: setView() needs a finite x and y, got ${x}, ${y}`);
  }
  if (!(Number.isFinite(width) && width > 0)) {
    throw new Error(
      `Iki: setView() needs a positive finite width, got ${width}`,
    );
  }
  if (!(Number.isFinite(height) && height > 0)) {
    throw new Error(
      `Iki: setView() needs a positive finite height, got ${height}`,
    );
  }
  return { x, y, width, height };
}

/**
 * Model space -> clip space: fit `view` into the viewport (aspect kept, centred)
 * as `scale ∘ translate(-view.x, -view.y)`. With the view = the model's box
 * this is the plain `scale` the player always used.
 */
export function projectView(
  viewportWidth: number,
  viewportHeight: number,
  view: IkiView,
): Affine {
  const fit = Math.min(
    viewportWidth / view.width,
    viewportHeight / view.height,
  );
  return multiply(
    scale((fit * 2) / viewportWidth, (fit * 2) / viewportHeight),
    translate(-view.x, -view.y),
  );
}
