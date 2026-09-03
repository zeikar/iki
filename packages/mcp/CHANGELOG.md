# @ikijs/mcp

## 0.1.0

### Minor Changes

- f8e2030: Add an `auto_rig_from_layers` MCP tool: an agent passes role-named PNG file paths (face, eye_L/eye_R, mouth required; iris/brow/hair/lash optional) and gets back a renderable, validated `.iki` written to disk. The tool decodes, alpha-bboxes, crops, and atlases the layers in Node (via a new `sharp` dependency confined to `@ikijs/mcp`), reusing the pure `@ikijs/editor` model/atlas math (`generateIkiFromLayerSet`, `packAtlas`, `uvRectFor`, `EditorDocument.applyAtlas`) so the browser and Node paths stay in sync. The atlas is embedded as a base64 `data:image/png` texture and the model is `parseIkiModel`-validated before writing; the result returns the output path + summary stats rather than inlining the multi-MB model. No `.iki` schema change (no `IKI_FORMAT_VERSION` bump).
- de09cbd: Auto-rig now generates hair-sway secondary motion. `@ikijs/format` adds a `StandardParameter.HairSwayX` id (a physics-OUTPUT sway driver). `@ikijs/editor`'s `generateIkiFromLayerSet` now emits, when a `hair_front` layer is present, a `HairSwayX` parameter, a rotate + translateX sway binding on the front-hair part, and one `IkiPhysics` rig that lags `ParamAngleX` onto `HairSwayX` — so every auto-rigged / MCP-generated / skill-built character with front hair sways on head turn out of the box (no manual rigging). `@ikijs/mcp`'s `list_standard_parameters` now advertises `HairSwayX` (annotated as physics-output). No-hair models are unchanged (no extra param, no physics). Additive — no `IKI_FORMAT_VERSION` bump.
- da7ad77: Add per-side brow expression: BrowLeftY/RightY (raise/lower) and BrowLeftAngle/RightAngle (tilt) standard parameters in @ikijs/format, emitted as translateY + rotate bindings and declared parameters by the @ikijs/editor auto-rig, and surfaced by the @ikijs/mcp `list_standard_parameters` tool.
- 29914ab: Add @ikijs/mcp: stdio MCP server with validate/describe/list tools.

### Patch Changes

- b03198b: Keep esbuild metafiles out of the published tarball. The build now emits `dist/metafile-*.json` so the pre-publish check can prove `@ikijs/format` stays external rather than being inlined into each dependent (a second copy would break `instanceof IkiFormatError` across package boundaries), but that is build introspection: it carries no value for a consumer and leaks local paths.
- 3701485: The MCP server reported a hardcoded `version: "0.0.0"` in its `serverInfo`, which every MCP client shows in its server listing — so a published `@ikijs/mcp@0.1.0` would have introduced itself as 0.0.0, and drifted further with each release. The version is now baked from `package.json` at build time, and since the release script builds after the version bump, the published artifact always reports its own version.
- 2eae3fc: `detectAlphaBbox` now delegates to the shared scan in `@ikijs/editor` instead of re-implementing it, keeping this package's `AutoRigInputError` for an empty layer. Behavior is unchanged.

  Also documents why input paths are deliberately NOT confined to the working directory while output paths are: a stray write destroys data, a read only surfaces a file the agent named and the user can already open, and confining reads would break the documented character-generation flow, which composes its layers in a scratch directory. Adds direct tests for the path-resolution rejection branches, which were the least-covered code in the package.

- c5714cf: Ship `LICENSE` inside each package. Every package declared `"license": "MIT"`, but npm only picks up a package-ROOT licence file and does not follow a symlink, so the repo-root `LICENSE` never reached any tarball — the published artifacts named a licence they did not carry. The pre-publish check now gates on it alongside the README.
- Updated dependencies [11a5b64]
- Updated dependencies [79e384c]
- Updated dependencies [de09cbd]
- Updated dependencies [43047ea]
- Updated dependencies [da7ad77]
- Updated dependencies [2eae3fc]
- Updated dependencies [4e51f08]
- Updated dependencies [fddc7af]
- Updated dependencies [279928d]
- Updated dependencies [7def749]
- Updated dependencies [6025534]
- Updated dependencies [f7fa92f]
- Updated dependencies [87a38f4]
- Updated dependencies [09197f2]
- Updated dependencies [6c85def]
- Updated dependencies [c717bb2]
- Updated dependencies [0c23219]
- Updated dependencies [0542d48]
- Updated dependencies [9489848]
- Updated dependencies [0a910df]
- Updated dependencies [88bf46b]
- Updated dependencies [87a38f4]
- Updated dependencies [b03198b]
- Updated dependencies [d25f9bb]
- Updated dependencies [3441699]
- Updated dependencies [c5714cf]
- Updated dependencies [279928d]
- Updated dependencies [f9f5dfa]
- Updated dependencies [e2f4a89]
- Updated dependencies [008df01]
  - @ikijs/format@0.1.0
  - @ikijs/editor@0.1.0
