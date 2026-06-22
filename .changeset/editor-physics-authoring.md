---
"@iki/format": minor
"@iki/editor-core": minor
---

Editor physics-rig authoring. `@iki/format` now rejects duplicate physics rig ids in `parseIkiModel` (consistent with the existing parameter- and part-id uniqueness checks) so id-keyed tooling can rely on unique rig ids — an additive validation tightening, no `IKI_FORMAT_VERSION` bump. `@iki/editor-core` adds a `findPhysicsRig` accessor and three invertible commands — `AddPhysicsRig`, `DeletePhysicsRig`, `SetPhysicsRig` — for CRUD + tuning of `model.physics` spring-mass-damper rigs (deep-cloning the nested `input`/`output`, validating each edit through `parseIkiModel`, forbidding rename, and keeping the `physics` key absent when empty). These back a new model-level "Physics Rigs" panel in the editor app.
