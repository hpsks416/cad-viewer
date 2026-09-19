# -*- coding: utf-8 -*-
"""Blender 无头脚本：STL -> 居中归一化 -> PBR 材质 -> glb（可选预览缩略图）。

由 build.py 调用；也可手动：
  blender.exe --background --python tools/export_blender.py -- \
      --input assets/export/电池锁紧盖.STL \
      --output models/battery-lock-cover.glb \
      --name battery-lock-cover \
      [--preview work/previews/battery-lock-cover.png]
"""
import os
import sys

import bpy
import mathutils


def parse_args(argv):
    args = {}
    if "--" in argv:
        argv = argv[argv.index("--") + 1:]
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:]
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                args[key] = argv[i + 1]
                i += 2
            else:
                args[key] = True
                i += 1
        else:
            i += 1
    return args


def enable_stl_import():
    import addon_utils
    mod = "bl_ext.blender_org.stl_format_legacy"
    if not addon_utils.check(mod)[1]:
        addon_utils.enable(mod, default_set=True, persistent=True)
    if not hasattr(bpy.ops.import_mesh, "stl"):
        raise SystemExit("STL_IMPORT_OPERATOR_NOT_AVAILABLE")


def render_preview(path, meshes, scene):
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        cam_data = bpy.data.cameras.new("Cam")
        cam = bpy.data.objects.new("Cam", cam_data)
        scene.collection.objects.link(cam)
        scene.camera = cam

        def area(label, loc, energy, size):
            ld = bpy.data.lights.new(label, type="AREA")
            ld.energy = energy
            ld.size = size
            lo = bpy.data.objects.new(label, ld)
            scene.collection.objects.link(lo)
            lo.location = loc
            return lo

        area("Key", (4, -4, 5), 120, 4)
        area("Fill", (-4, -2, 2), 60, 4)
        area("Rim", (0, 4, 3), 80, 4)

        world = bpy.data.worlds.new("World")
        scene.world = world
        world.use_nodes = True
        bg = world.node_tree.nodes.get("Background")
        bg.inputs["Color"].default_value = (0.14, 0.15, 0.17, 1.0)
        bg.inputs["Strength"].default_value = 1.0

        coords = []
        for o in meshes:
            for c in o.bound_box:
                coords.append(o.matrix_world @ mathutils.Vector(c))
        mn = mathutils.Vector(tuple(min(v[i] for v in coords) for i in range(3)))
        mx = mathutils.Vector(tuple(max(v[i] for v in coords) for i in range(3)))
        ctr = (mn + mx) / 2
        sz = max((mx - mn)[i] for i in range(3)) or 1.0
        d = sz * 3.0
        cam.location = ctr + mathutils.Vector((d, -d * 0.65, d * 0.8))
        aim = (ctr - cam.location).normalized()
        cam.rotation_euler = aim.to_track_quat("-Z", "Y").to_euler()
        cam.data.lens = 50

        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x = 640
        scene.render.resolution_y = 480
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)
        print("RENDERED_PNG", path)
    except Exception as e:
        print("RENDER_FAILED", repr(e))


def main():
    args = parse_args(sys.argv)
    inp = args.get("input")
    outp = args.get("output")
    name = args.get("name") or os.path.splitext(os.path.basename(outp or "part"))[0]
    preview = args.get("preview")
    if not inp or not outp:
        raise SystemExit("MISSING --input/--output")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_stl_import()
    scene = bpy.context.scene

    bpy.ops.import_mesh.stl(filepath=inp)
    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("NO_MESH_IMPORTED")
    print("IMPORTED_MESHES", len(meshes))

    # 归一化：居中 + 缩放到约 2 单位 + 应用变换
    bpy.ops.object.select_all(action="SELECT")
    coords = []
    for o in meshes:
        for c in o.bound_box:
            coords.append(o.matrix_world @ mathutils.Vector(c))
    mn = mathutils.Vector(tuple(min(v[i] for v in coords) for i in range(3)))
    mx = mathutils.Vector(tuple(max(v[i] for v in coords) for i in range(3)))
    center = (mn + mx) / 2
    max_dim = max((mx - mn)[i] for i in range(3)) or 1.0
    scale = 2.0 / max_dim
    for o in meshes:
        o.location = -center * scale
        o.scale = (scale, scale, scale)
    bpy.ops.object.transform_apply(location=True, scale=True, rotation=True)
    print("NORMALIZED max_dim->", round(max_dim, 3), "scale", round(scale, 4))

    # PBR 材质（深灰塑料，后续可接材质预设映射）
    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new(type="ShaderNodeBsdfPrincipled")
        out_node = mat.node_tree.nodes.get("Material Output")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])
    bsdf.inputs["Base Color"].default_value = (0.20, 0.21, 0.23, 1.0)
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.5
    for o in meshes:
        o.name = name
        o.data.name = name
        o.data.materials.clear()
        o.data.materials.append(mat)

    os.makedirs(os.path.dirname(os.path.abspath(outp)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=outp, export_format="GLB")
    print("EXPORTED_GLB", outp)

    if preview:
        render_preview(preview, meshes, scene)
    print("DONE")


if __name__ == "__main__":
    main()