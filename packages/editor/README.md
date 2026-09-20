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
held outline and swallows it. A target you passed that this layer set cannot
reach **throws**, naming the field and the range it could have had; a target
that came from the defaults is a style prior, not a measurement of this
character, so it is **clamped** to what the layer set can do and the rig is
built. Pass `options.onTurnSolved` to see what the turn settled on and which
targets were clamped.

`turnTargets.headHalfWidth` is what the shift targets are fractions of, when a
caller has measured the actual head (the face plate stands in otherwise).
Alongside it, `options.headEdges` names, per side, every layer with an opaque
pixel at the eye row and its own rest x there — a companion to a measured
`headHalfWidth`, absent otherwise — so the solver can land each candidate
through its OWN part's deformation (the bangs move with their hold, the back
hair holds still, a face-plate or body edge slide) rather than assume the head
is centred on the face plate or that whichever part drew furthest out at rest
is still the furthest out after it turns.

It takes **already-decoded** layer geometry (`LayerInput`), never pixels, which
is what keeps this package free of any image dependency: the editor app
decodes with canvas, `@ikijs/mcp` decodes with `sharp`, and both feed the same
pure function.

`*_L` / `*_R` are the **character's** sides — `eye_L` is the character's left
eye, which appears on the viewer's right.

## License

MIT © Zeikar
