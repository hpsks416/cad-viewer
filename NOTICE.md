# Third-party notices

## occt-import-js (bundled under `lib/occt/`)

`lib/occt/occt-import-js.js` and `lib/occt/occt-import-js.wasm` are an **unmodified**
redistribution of [occt-import-js](https://github.com/kovacsv/occt-import-js) v0.0.23,
copyright Viktor Kovacs, licensed under the **GNU Lesser General Public License v2.1 (LGPL-2.1)**.

They are distributed as separate, replaceable files (loaded at runtime as their own script/WASM
module, never statically linked into this project's JavaScript). The rest of this repository
remains under the MIT license.

- `lib/occt/LICENSE.occt-import-js.txt` — LGPL-2.1 license text (for the JS/WASM wrapper)
- `lib/occt/LICENSE.occt.txt` — Open CASCADE license (LGPL-2.1 with the Open Cascade exception)

These files are only required for the optional in-browser STEP/IGES/BREP import feature
(drag a `.step`/`.stp` into the viewer with no Blender). If you delete `lib/occt/`, the
viewer still fully works for GLB/STL models.
