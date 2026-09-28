# 3D models

## Aircraft (third-party, CC BY 4.0)

These aircraft models were prepared by [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT code; the
models keep their own licence) from Sketchfab originals. They are licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the credits below do not imply endorsement.

| File | Original work and creator | Source | Changes |
|---|---|---|---|
| `airplane.glb` | "boeing 747" by [zairiq-123](https://sketchfab.com/zairiq-123) | [Sketchfab](https://sketchfab.com/3d-models/boeing-747-9b16672038ba48f98e6d80a159044ed9) | God's Eye View: simplified, re-oriented, rescaled |
| `jet.glb` | "Private Jet" by [Nick the Name](https://sketchfab.com/Nick_The_Name) | [Sketchfab](https://sketchfab.com/3d-models/private-jet-cbdd1de6ced9461e950eafaa302cc82b) | God's Eye View: repackaged, re-oriented, rescaled |
| `bell206.glb` | "Bell 206 JetRanger" by [terran4627](https://sketchfab.com/terran4627) | [Sketchfab](https://sketchfab.com/3d-models/bell-206-jetranger-d2f7ba1d671549d4b26aaf834139a1dd) | God's Eye View: simplified, textures resized, re-oriented |
| `c172.glb` | "Cessna 172" by [e737](https://sketchfab.com/e0057537) | [Sketchfab](https://sketchfab.com/3d-models/cessna-172-64cddaee5aff470682659a8c08525046) | God's Eye View: simplified, textures resized, re-oriented; this project: removed the KHR_materials_ior/specular material extensions (tools/models/fix-glb.mjs) |
| `citation2.glb` | "1990 Cessna Citation, Texture Detailed, Exterior" by [BlenderCommunityHead](https://sketchfab.com/aboodgoudagad) | [Sketchfab](https://sketchfab.com/3d-models/1990-cessna-citation-texture-detailed-exterior-a78839624fe64900a8352cb23462350a) | God's Eye View: simplified, textures resized, re-oriented |
| `b789.glb` | "Boeing 787-9" by [Nobilis 2](https://sketchfab.com/nobilishornet2) | [Sketchfab](https://sketchfab.com/3d-models/boeing-787-9-b6711e2e698e4e469675c1154a50b7a3) | God's Eye View: simplified, textures resized, re-oriented |
| `atr72.glb` | "ATR 72 - 600" by [Oyan3D](https://sketchfab.com/oyan3D) | [Sketchfab](https://sketchfab.com/3d-models/atr-72-600-1e1a7186f7444d288675262fcee44744) | God's Eye View: simplified, textures removed (colours baked into materials), re-oriented |

At run time the app scales each model non-uniformly to the length and wingspan of the aircraft type it stands for
(public/live/fleet.js), so a 787 model also represents a 737 or an A321.

## Buses, trains, floats, bridge leaves (this project)

`bus40-*`, `bus60f-*`, `bus60r-*`, `trolley*`, `loco-*`, `coach-*`, `superliner`, `floats` and `leaf-*` are generated
by `tools/models/build.mjs` (same licence as this repository). King County Metro liveries follow the fleet description
on Wikipedia (yellow lower body with teal, blue or green on top; red for RapidRide; purple for trolleybuses).
