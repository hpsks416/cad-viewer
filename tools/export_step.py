# -*- coding: utf-8 -*-
"""Blender 无头脚本：读 STEP 装配树(hierarchy.json) -> 导入零件 STL -> 重建层级 + 变换
-> 按 AP214 颜色赋 PBR 材质 -> 归一化 -> 导出 glb（可选缩略图）。

由 build.py 调用；也可手动：
  blender.exe --background --python tools/export_step.py -- \
      --hierarchy work/step/robo/hierarchy.json \
      --output models/robo.glb --name robo \
      [--preview work/previews/robo.png]
"""
import json
import math
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


def load_presets(preset_path):
    """材质预设：{patterns:[{match, material}], default:{...}} -> 简化成按名称匹配的规则。"""
    presets = {"default": {"metalness": 0.35, "roughness": 0.42}, "patterns": []}
    if preset_path and os.path.exists(preset_path):
        try:
            with open(preset_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                presets.update(data)
        except Exception:
            pass
    return presets


def build_materials(hierarchy, presets):
    """为每个唯一颜色创建一个 PBR 材质；返回 {rgb_key: material_name}。"""
    import re

    mat_map = {}
    used_names = {}

    def default_pbr():
        return presets.get("default", {})

    def pbr_for_name(name):
        pbr = dict(default_pbr())
        for pat in presets.get("patterns", []):
            if pat.get("match") and re.search(pat["match"], name or "", re.I):
                pbr.update(pat.get("material", {}))
                break
        return pbr

    def color_key(c):
        return tuple(round(x, 4) for x in c) if c else None

    def ensure(name, color):
        key = color_key(color)
        if key in mat_map:
            return mat_map[key]
        pbr = pbr_for_name(name)
        mat_name = name or "part"
        base = mat_name
        k = 1
        while mat_name in used_names:
            k += 1
            mat_name = f"{base}-{k}"
        used_names[mat_name] = True
        mat = bpy.data.materials.new(name=mat_name)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf is None:
            bsdf = mat.node_tree.nodes.new(type="ShaderNodeBsdfPrincipled")
            out_node = mat.node_tree.nodes.get("Material Output")
            mat.node_tree.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])
        if color:
            bsdf.inputs["Base Color"].default_value = (color[0], color[1], color[2], 1.0)
        else:
            bsdf.inputs["Base Color"].default_value = (0.35, 0.37, 0.40, 1.0)
        bsdf.inputs["Metallic"].default_value = float(pbr.get("metalness", 0.35))
        bsdf.inputs["Roughness"].default_value = float(pbr.get("roughness", 0.42))
        mat_map[key] = mat_name
        return mat_name

    def walk(node):
        if node.get("kind") == "part":
            ensure(node.get("id") or "part", node.get("color"))
        for c in node.get("children", []):
            walk(c)

    for r in hierarchy.get("roots", []):
        walk(r)
    return mat_map


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
    hierarchy_path = args.get("hierarchy")
    outp = args.get("output")
    name = args.get("name") or "model"
    preview = args.get("preview")
    preset_path = args.get("presets")
    if not hierarchy_path or not outp:
        raise SystemExit("MISSING --hierarchy/--output")
    hierarchy_path = os.path.abspath(hierarchy_path)
    outp = os.path.abspath(outp)
    if preview:
        preview = os.path.abspath(preview)
    if preset_path:
        preset_path = os.path.abspath(preset_path)

    with open(hierarchy_path, "r", encoding="utf-8") as f:
        hierarchy = json.load(f)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    enable_stl_import()
    scene = bpy.context.scene

    presets = load_presets(preset_path)
    mat_map = build_materials(hierarchy, presets)

    base_dir = os.path.dirname(os.path.abspath(hierarchy_path))

    # 顶层空物体（承载整体归一化）
    top = bpy.data.objects.new(name, None)
    top.name = name
    top.empty_display_type = "PLAIN_AXES"
    scene.collection.objects.link(top)

    def create_node(node, parent):
        if node.get("kind") == "part":
            stl_path = os.path.join(base_dir, node["part"])
            before = set(scene.objects)
            bpy.ops.import_mesh.stl(filepath=stl_path)
            imported = [o for o in scene.objects if o not in before and o.type == "MESH"]
            obj = imported[0] if imported else None
            if obj is None:
                return None
            obj.name = node.get("id") or "part"
            obj.data.name = obj.name
            # 赋材质
            key = tuple(round(x, 4) for x in node["color"]) if node.get("color") else None
            mat_name = mat_map.get(key)
            if mat_name:
                mat = bpy.data.materials.get(mat_name)
                obj.data.materials.clear()
                obj.data.materials.append(mat)
        else:
            obj = bpy.data.objects.new(node.get("id") or "assembly", None)
            obj.empty_display_type = "PLAIN_AXES"
            scene.collection.objects.link(obj)

        obj.parent = parent
        obj.matrix_parent_inverse = mathutils.Matrix.Identity(4)
        local = node.get("local") or [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
        obj.matrix_basis = mathutils.Matrix(local)
        for child in node.get("children", []):
            create_node(child, obj)
        return obj

    for r in hierarchy.get("roots", []):
        create_node(r, top)

    meshes = [o for o in scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("NO_MESH_IMPORTED")

    # 建完层级后刷新 depsgraph，确保 matrix_world 反映完整父链
    bpy.context.view_layer.update()

    # 归一化：整体居中 + 缩放到约 2 单位（施加在顶层空物体上，保留内部层级）
    coords = []
    for o in meshes:
        for c in o.bound_box:
            coords.append(o.matrix_world @ mathutils.Vector(c))
    mn = mathutils.Vector(tuple(min(v[i] for v in coords) for i in range(3)))
    mx = mathutils.Vector(tuple(max(v[i] for v in coords) for i in range(3)))
    center = (mn + mx) / 2
    max_dim = max((mx - mn)[i] for i in range(3)) or 1.0
    scale = 2.0 / max_dim
    # 源文件上轴约定（import_step.py 里检测写入）：'y' 表示源文件竖直轴为 Y（如 SolidWorks），
    # 'z' 表示竖直轴为 Z（如 Autodesk）。Blender 导出 glTF 时会把 Blender 的 +Z 映射为 glTF 的 +Y，
    # 因此：
    #   - 源为 Y-up 时，需先绕 X 轴 +90° 把源 +Y 转到 Blender +Z，导出后才是 Y-up 且直立；
    #   - 源为 Z-up 时无需额外旋转，Blender 默认导出即可得到 Y-up。
    src_up = hierarchy.get("up", "y")
    rot = (
        mathutils.Matrix.Rotation(math.radians(90.0), 4, "X")
        if src_up == "y" else mathutils.Matrix.Identity(4)
    )
    top.matrix_basis = (
        mathutils.Matrix.Translation(-scale * (rot @ center))
        @ rot
        @ mathutils.Matrix.Diagonal((scale, scale, scale, 1.0))
    )
    bpy.context.view_layer.update()
    print(f"NORMALIZED max_dim={round(max_dim,3)} scale={round(scale,4)}")

    os.makedirs(os.path.dirname(os.path.abspath(outp)), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=outp, export_format="GLB")
    print("EXPORTED_GLB", outp)

    # 写元信息（归一化比例等），供查看器换算真实尺寸 / 关节平移单位
    meta_path = os.path.splitext(outp)[0] + ".meta.json"
    try:
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump({"scale": scale, "max_dim": max_dim, "units": "mm", "up": "y"}, f)
        print("WROTE_META", meta_path)
    except Exception as e:
        print("META_FAILED", repr(e))

    # 序列号 -> {name_en, name_zh, kind} 映射（供查看器场景树显示）
    parts_path = os.path.splitext(outp)[0] + ".parts.json"
    try:
        with open(parts_path, "w", encoding="utf-8") as f:
            json.dump(hierarchy.get("parts", {}), f, ensure_ascii=False, indent=2)
        print("WROTE_PARTS", parts_path)
    except Exception as e:
        print("PARTS_FAILED", repr(e))

    if preview:
        render_preview(preview, meshes, scene)
    print("DONE")


if __name__ == "__main__":
    main()
