# @ikijs/editor

**Headless** editing core for [`.iki`](https://github.com/zeikar/iki/tree/main/packages/format) models — a document with
undo/redo, invertible edit commands, atlas layout + UV math, and the auto-rigger.

This package ships no UI. It is the model and command layer an editor is built
_on_, not an editor you can mount.

Everything here is pure logic — no DOM, no canvas, no WebGL. It depends only on
[`@ikijs/format`](https://github.com/zeikar/iki/tree/main/packages/format), so the same core backs this repo's
browser editor app (`examples/editor`), the Node MCP server
([`@ikijs/mcp`](https://github.com/zeikar/iki/tree/main/packages/mcp)), and tests.

## Install

```bash
npm install @ikijs/editor @ikijs/format
```

## Usage

```ts
import { EditorDocument, SetPartWidth } from "@ikijs/editor";

const doc = new EditorDocument(model);

doc.execute(new SetPartWidth("mouth", 160));
doc.undo();
doc.redo();

const exported = doc.toIkiModel(); // validated via parseIkiModel, or throws
```

Every command captures its prior value on the first `apply`, so `undo` always
restores the original even after a `redo`. Commands that could produce an
invalid model validate a candidate **before** mutating, so a rejected edit
leaves the document untouched.

## API

| Area               | Exports                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document           | `EditorDocument`, `EditCommand`                                                                                                                                   |
| Part edits         | `AddPart`, `DeletePart`, `SetPartColor`, `SetPartWidth`, `SetPartHeight`, `SetPartOrder`, `SetPartTransform`, `SetPartBindings`, `SetPartMesh`, `SetPartDeformer` |
| Deformer edits     | `AddDeformer`, `DeleteDeformer`, `SetDeformerParent`, `SetDeformerTransform`, `SetDeformerBindings`, `SetDeformerPivot` (+ `X`/`Y`), `CaptureGridKeyform`         |
| Physics edits      | `AddPhysicsRig`, `SetPhysicsRig`, `DeletePhysicsRig`                                                                                                              |
| Referential guards | `validateDeformerReparent`, `validateDeformerDelete`, `validatePartAttach`                                                                                        |
| Atlas              | `packAtlas`, `uvRectFor`, `ATLAS_PADDING`, `UV_INSET_PX`                                                                                                          |
| Grid keyforms      | `computeGridOffsets`, `interpolateGridOffsets`, `upsertGridKeyform`                                                                                               |
| Factories          | `createDefaultPart`, `createDefaultMatrixDeformer`, `createDefaultWarpDeformer`, `createGridMesh`                                                                 |
| Pixels             | `detectAlphaBbox`, `ALPHA_BBOX_THRESHOLD`, `AlphaBbox`                                                                                                            |
| Auto-rig           | `generateIkiFromLayerSet`, `parseLayerRoles`, `TurnTargets`, `DEFAULT_TURN_TARGETS`, `TurnSolveReport`                                                            |
| Bindings           | `captureBindingEndpoint`                                                                                                                                          |

## Auto-rig

`generateIkiFromLayerSet` turns role-named layers (`face`, `eye_L`, `eye_R`,
`mouth`, plus optional `iris_*`, `brow_*`, `lash_*`, `hair_front`, `hair_back`,
…) into a rigged model that blinks, gazes, opens its mouth, turns its head on a
torso that follows and breathes, and emotes with its brows — including a
hair-sway physics rig when a `hair_front` layer is present.

On the turn the head's outline holds still — the bangs that draw it pin their
own silhouette — while everything inside it slides: the face plate, its
features, and the bangs' own inner strands. That slide is the plate's own ask, a
quarter of its half-width, capped to what the held outline has room for when
`turnTargets.headHalfWidth` was measured and uncut when it was not. That turn is
**fitted, not tuned**: on a layer set with a `nose`, the cylinder's radius and
each feature's own depth on top of that slide are solved from
`options.turnTargets` — the cues a 30° reference measures (how far the eye pair
slides, how much the far eye foreshortens, whether the silhouette holds),
defaulting to `DEFAULT_TURN_TARGETS`. The features' slide is bounded by the art:
every feature has to stay on the face plate, because past its contour the far
eye is drawn over the side hair, which still bends with the plate inside that
held outline and swallows it. Given `options.strandEdges`, the eyes are also
kept from sliding the far iris under the bangs' side strand any further than it
is painted — best effort, never a refusal: the fit prefers radii where some eye
depth holds that, and where none does (a fringe spanning the face included) the
rig is still built with the eyes' turn depth at 0. The report's `strandOverlap`
gives, per side whose far iris the bangs' run still covers at some far stop,
the covered width: how much of the iris's painted row the run covers at the
stop where that is largest, in px and head half-widths, next to how much it
covers at rest, and whether the bound held — `true` for an iris painted under
its run that the turn took no deeper, `false` where the fitted radius could not
hold it and the eyes' turn depth is 0.

A target that came from the defaults is a style prior, not a measurement of
this character, so it is **clamped** to what the layer set can do and the rig is
built. So is an `eyeShift` you passed that runs past the room the art leaves the
far eye — the face plate's edge, or the bangs' strand — since that room is a
fact about these layers, not about the reference. Every other target you passed
that this layer set cannot reach **throws**, naming the field and the range it
could have had: a `farEyeRatio` or `silhouetteRatio` no radius renders, a
`noseShift` / `mouthShift` outside what that feature can reach, or an
`eyeShift` smaller than the slide the face's own turn already gives the eyes.
Pass `options.onTurnSolved` to see what the turn settled on and which targets
were clamped.

`turnTargets.headHalfWidth` is what the shift targets are fractions of, when a
caller has measured the actual head (the face plate stands in otherwise).
Alongside it, `options.headEdges` names, per side, every layer with an opaque
pixel at the eye row and its own rest x there — a companion to a measured
`headHalfWidth`, absent otherwise — so the solver can land each candidate
through its OWN part's deformation (the bangs move with their hold, the back
hair holds still, a face-plate or body edge slide) rather than assume the head
is centred on the face plate or that whichever part drew furthest out at rest
is still the furthest out after it turns.

`options.strandEdges` gives, per side, that side's iris and the `hair_front`
run it would slide under on the turn, as real pixel edges on the row holding
the iris's centre (`IrisStrand`: the iris's opaque span, and the run's outer
and face-side ends). One shape covers a strand outward of a clear iris, a run
over the iris centre that clears on the face side, and a fringe spanning the
face, whose `runFace` is `null` because it has no face-side end on that side.
`@ikijs/mcp` measures it off the pixels it decodes. It is always validated
against the layers, but like `headEdges` it is only read by the turn solve, so
it has no effect on the rig without a `nose`; absent or `{}`, the rig is exactly
the one built without it.

It takes **already-decoded** layer geometry (`LayerInput`), never pixels, which
is what keeps this package free of any image dependency: the editor app
decodes with canvas, `@ikijs/mcp` decodes with `sharp`, and both feed the same
pure function — including the optional `rowHalfWidths` (one entry per crop row,
half that row's opaque span in canvas px), which `@ikijs/mcp` measures for the
face so the plate turns on a radius that varies by row; absent, it turns on one
constant radius.

`*_L` / `*_R` are the **character's** sides — `eye_L` is the character's left
eye, which appears on the viewer's right.

## License

MIT © Zeikar
