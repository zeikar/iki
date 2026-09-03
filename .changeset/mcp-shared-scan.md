---
"@ikijs/mcp": patch
---

`detectAlphaBbox` now delegates to the shared scan in `@ikijs/editor` instead of re-implementing it, keeping this package's `AutoRigInputError` for an empty layer. Behavior is unchanged.

Also documents why input paths are deliberately NOT confined to the working directory while output paths are: a stray write destroys data, a read only surfaces a file the agent named and the user can already open, and confining reads would break the documented character-generation flow, which composes its layers in a scratch directory. Adds direct tests for the path-resolution rejection branches, which were the least-covered code in the package.
