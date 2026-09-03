# @ikijs/editor

**Headless** editing core for [`.iki`](../format) models — a document with
undo/redo, invertible edit commands, atlas layout + UV math, and the auto-rigger.

This package ships no UI. It is the model and command layer an editor is built
_on_, not an editor you can mount.

Everything here is pure logic — no DOM, no canvas, no WebGL. It depends only on
[`@ikijs/format`](../format), so the same core backs the browser editor, the
Node MCP server ([`@ikijs/mcp`](../mcp)), and tests.

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
| Auto-rig           | `generateIkiFromLayerSet`, `parseLayerRoles`                                                                                                                      |
| Bindings           | `captureBindingEndpoint`                                                                                                                                          |

## Auto-rig

`generateIkiFromLayerSet` turns role-named layers (`face`, `eye_L`, `eye_R`,
`mouth`, plus optional `iris_*`, `brow_*`, `lash_*`, `hair_front`, `hair_back`,
…) into a rigged model that blinks, gazes, opens its mouth, turns its head, and
emotes with its brows — including a hair-sway physics rig when a `hair_front`
layer is present.

It takes **already-decoded** layer geometry (`LayerInput`), never pixels, which
is what keeps this package free of any image dependency: the browser editor
decodes with canvas, `@ikijs/mcp` decodes with `sharp`, and both feed the same
pure function.

`*_L` / `*_R` are the **character's** sides — `eye_L` is the character's left
eye, which appears on the viewer's right.

## License

MIT © Zeikar
