# @ikijs/format

The `.iki` model format — schema, TypeScript types, loader, and validator.

This package is the single source of truth for the `.iki` contract. The runtime
([`@ikijs/engine`](https://github.com/zeikar/iki/tree/main/packages/engine)) and the editing core
([`@ikijs/editor`](https://github.com/zeikar/iki/tree/main/packages/editor)) read these types; they never redefine
them. It has **no runtime dependencies**.

## Install

```bash
npm install @ikijs/format
```

## Usage

```ts
import { loadIkiModel, IkiFormatError } from "@ikijs/format";

try {
  const model = loadIkiModel(await file.text()); // JSON string -> IkiModel
} catch (e) {
  if (e instanceof IkiFormatError) console.error(e.message);
}
```

`parseIkiModel(value)` does the same for an already-parsed object. Both are
fail-fast and throw one path-qualified message at a time, e.g.
`parts[3].mesh.indices[12] 40 is out of range`.

## API

| Export                              | What it is                                                        |
| ----------------------------------- | ----------------------------------------------------------------- |
| `parseIkiModel(value: unknown)`     | Validate a plain object, returning a typed `IkiModel` or throwing |
| `loadIkiModel(json: string)`        | `JSON.parse` + `parseIkiModel`                                    |
| `IkiFormatError`                    | The only error either loader throws                               |
| `IKI_FORMAT_VERSION`                | The format version this package implements (`1`)                  |
| `StandardParameter`                 | Recommended parameter ids so any host can drive any model         |
| `IkiModel`, `IkiPart`, `IkiWarp`, … | The full type surface                                             |

## The model

A model is a flat list of parts composited back-to-front, plus parameters wired
to those parts through linear bindings:

```ts
import { StandardParameter, type IkiModel } from "@ikijs/format";

const model: IkiModel = {
  version: 1,
  name: "Hello",
  canvas: { width: 1000, height: 1000 },
  parameters: [{ id: StandardParameter.MouthOpen, min: 0, max: 1, default: 0 }],
  parts: [
    {
      id: "mouth",
      color: [0.8, 0.3, 0.3, 1],
      width: 120,
      height: 40,
      transform: { x: 0, y: -120 },
      order: 1,
      bindings: [
        {
          parameter: StandardParameter.MouthOpen,
          channel: "scaleY",
          from: 0.2,
          to: 1,
        },
      ],
    },
  ],
};
```

Beyond flat parts the schema also carries triangle meshes with per-vertex UV,
per-vertex and per-control-point warp keyforms (1D and 2D parameter grids),
matrix and warp deformer hierarchies, clipping masks, and spring/chain physics
rigs. See [`src/types.ts`](https://github.com/zeikar/iki/tree/main/packages/format/src/types.ts) — every field is documented there.

### Side convention

`Left`/`Right` in `StandardParameter` name the **character's** own side, not the
viewer's (matching Live2D). Model space is +x-right as seen by the viewer, so
the character's left eye is the part at **positive x**.

## Stability

`IKI_FORMAT_VERSION` identifies the `.iki` contract, and from 1.0 on, any
breaking schema change bumps it. Until then the v1 schema is still settling: a
0.x release may tighten validation and reject a model an earlier one accepted —
canvas extents must now be `> 0`, for instance. Such changes are called out in
the changelog. The TypeScript surface can likewise shift between 0.x minors.

## License

MIT © Zeikar
