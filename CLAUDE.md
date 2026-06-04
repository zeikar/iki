# AGENTS

Read [README.md](./README.md) first for what Iki is, the package map, and the roadmap.

## Core Rules

- Keep the engine host-agnostic: `@iki/engine` depends only on `@iki/format`. It must never import a host framework (e.g. Charivo); hosts consume Iki through their own thin adapter.
- Preserve the layering: `@iki/format` (schema/types/validator) -> `@iki/engine` (runtime) -> examples / host adapters. Do not collapse these boundaries.
- `@iki/format` is the single source of truth for the `.iki` model contract. Engine code reads the format types; it does not redefine them.
- Validate external/model input in `@iki/format` and throw `IkiFormatError` with a path-qualified message. Never let unchecked data reach the renderer, and do not fail silently.
- Match the surrounding style. Keep changes surgical — every changed line should trace to the request.

## Format versioning

- `IKI_FORMAT_VERSION` identifies the `.iki` model contract.
- **Before** the first published release, v1 is unstable: the schema may change (including tightening or removing fields) without a version bump. Do not treat such changes as breaking yet.
- **After** the first published release, any breaking change to the `.iki` schema must bump `IKI_FORMAT_VERSION`.

## Validation

- Run `pnpm verify` (build + typecheck + format:check) for repo-wide validation.
- Never read the full output of long build commands — check the exit code, or `tail` the summary.

## Versioning (packages)

- Publishable packages (`@iki/*`, excluding the playground) use Changesets. Add one with `pnpm changeset` when a package changes in a way that should reach npm.
- Use `minor` for public API or `.iki` format-contract changes, `patch` for fixes and non-breaking updates.
- Do not add a changeset for example-only or docs-only changes.
