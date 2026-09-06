# Contributing

Thanks for looking. Iki is early, so the most useful contributions right now are
bug reports with a model that reproduces them, and questions about the `.iki`
format that reveal where the docs are wrong.

## Setup

```bash
pnpm install
pnpm build
pnpm playground   # open the Vite URL and drag the sliders
```

Node >= 22.13 and pnpm >= 11 (the repo pins its own pnpm version).

## The demo site

<https://zeikar.dev/iki/> is the landing page in `site/` plus both example
apps, rebuilt by `.github/workflows/pages.yml` on every push to `main`.

```bash
pnpm build:site   # assembles dist/ exactly as the workflow does
```

The apps are served from a sub-path there, so anything they fetch at runtime has
to go through `import.meta.env.BASE_URL` rather than an absolute `/path`. To
check that locally, serve `dist/` from under an `/iki/` prefix — opening
`dist/index.html` straight off the filesystem will not catch a base-path bug.

## Before you open a PR

```bash
pnpm verify   # build + typecheck + format:check
pnpm test
```

Both must pass. `pnpm format` fixes formatting.

## The layering rule

The one architectural constraint worth knowing before you write code:

```
@ikijs/format  ->  @ikijs/engine  ->  examples / host adapters
   (schema)         (runtime)
```

- `@ikijs/format` is the single source of truth for the `.iki` contract. Engine
  and editor code reads those types; it never redefines them.
- `@ikijs/engine` depends only on `@ikijs/format`. It must not import a host
  framework — a host consumes Iki through its own thin adapter.
- Validate external input in `@ikijs/format` and throw `IkiFormatError` with a
  path-qualified message. Unchecked data must not reach the renderer, and
  nothing fails silently.

## Changesets

Publishable packages use [Changesets](https://github.com/changesets/changesets).
If your change should reach npm, add one:

```bash
pnpm changeset
```

`minor` for public API or `.iki` format-contract changes, `patch` for fixes and
non-breaking updates. Docs-only and example-only changes do not need one.

## Format versioning

`IKI_FORMAT_VERSION` identifies the `.iki` model contract. **Before 1.0 the v1
schema is unstable**: it may change without a version bump, including tightening
validation so that a 0.x release rejects a model an earlier one accepted. That
still reaches users, so call it out in the changeset even though no bump is
required. From 1.0 on, any breaking schema change bumps the version.

## Reporting a bug

A `.iki` model that reproduces it is worth more than a description. If the model
is large, the smallest one that still shows the problem is ideal — most renderer
bugs reduce to a handful of parts.
