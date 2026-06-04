---
"@iki/engine": minor
---

Expose the 2D affine helpers (`translate`, `scale`, `rotate`, `multiply`, `toMat3`, and the `Affine` type) from the package root. They were previously private to the player; host adapters can now build transforms against the same math the engine uses.
