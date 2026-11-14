---
"@ikijs/editor": minor
---

A custom part can declare `occlusion` (`{ by, parameter, stops }`): the generator writes `IkiPart.occlusion` on it, with `by` given as roles of the set and expanded to the part ids those roles yield. `CustomPartError` refuses an unknown key, an empty or repeated `by`, a role the set lacks or whose part is clipped or has no mesh, a parameter the rig does not declare or a physics rig outputs, and stops that break the format's rules. `DeletePart` and `SetPartMesh` refuse to remove a part, or its mesh, while another part names it in `occlusion.by`. A set without custom parts, and custom parts without `occlusion`, rig byte for byte as before.
