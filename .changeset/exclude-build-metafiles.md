---
"@ikijs/engine": patch
"@ikijs/editor": patch
"@ikijs/mcp": patch
---

Keep esbuild metafiles out of the published tarball. The build now emits `dist/metafile-*.json` so the pre-publish check can prove `@ikijs/format` stays external rather than being inlined into each dependent (a second copy would break `instanceof IkiFormatError` across package boundaries), but that is build introspection: it carries no value for a consumer and leaks local paths.
