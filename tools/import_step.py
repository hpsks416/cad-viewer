# -*- coding: utf-8 -*-
"""STEP AP214 -> 装配层级 + 每零件网格(STL) + AP214 颜色 + 中文名翻译。

用 OCP(OpenCascade) 的 XCAF 读取 STEP，保留 product 嵌套层级、实例变换、AP214 面颜色。
输出到 <out_dir>：
  hierarchy.json        装配树（每个节点：id/name/source_name/kind/local/color/part/children）
  parts/<id>.stl        每个叶子零件的网格（局部坐标，二进制 STL）

用法：
  python tools/import_step.py --input assets/export/装配体.step --output work/step/robo
"""
import hashlib
import json
import math
import os
import re
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "work", "_vendor")
sys.path.insert(0, os.path.join(ROOT, "tools"))

from ensure_ocp import ensure_ocp

if not ensure_ocp():
    raise SystemExit("无法加载 OpenCascade 绑定（OCP），请检查网络或手动安装 cadquery-ocp + vtk")

from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.XCAFApp import XCAFApp_Application
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.collections import Sequence_TDF_Label
from OCP.TopLoc import TopLoc_Location
from OCP.Quantity import Quantity_Color
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.StlAPI import StlAPI_Writer

from translate_names import translate, slugify, display_name

IDENTITY = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
NAMING = os.path.join(ROOT, "assets", "naming-map.json")


def _load_naming():
    try:
        with open(NAMING, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_naming(naming):
    os.makedirs(os.path.dirname(NAMING), exist_ok=True)
    with open(NAMING, "w", encoding="utf-8") as f:
        json.dump(naming, f, ensure_ascii=False, indent=2)


def _trsf_matrix(t):
    return [[t.Value(r, c) for c in range(1, 5)] for r in range(1, 4)] + [[0, 0, 0, 1]]


def _get_name(lab):
    attr = TDataStd_Name()
    if lab.FindAttribute(TDataStd_Name.GetID_s(), attr):
        s = attr.Get().ToExtString()
        if isinstance(s, bytes):
            s = s.decode("utf-8", errors="replace")
        return str(s)
    return ""


def _translate_name(raw, naming):
    raw = (raw or "").strip()
    if not raw:
        return "part", "Part"
    key = f"step-node::{raw}"
    rec = naming.get(key)
    if rec and rec.get("slug"):
        return rec["slug"], rec.get("name") or display_name(rec["slug"])
    # 无中文则直接按英文 slug 化，避免把英文名误送进 zh->en 机器翻译
    if not re.search(r"[\u3400-\u4dbf\u4e00-\u9fff]", raw):
        slug = slugify(raw) or "part"
        name = display_name(slug)
        naming[key] = {"slug": slug, "name": name, "translation": raw}
        return slug, name
    en = ""
    try:
        en = translate(raw)
        slug = slugify(en) or "part"
    except Exception:
        slug = slugify(raw) or "part"
    name = display_name(slug)
    naming[key] = {"slug": slug, "name": name, "translation": en}
    return slug, name


def _detect_up(path):
    """检测 STEP 源文件的上轴约定。

    SolidWorks 导出的 STEP 通常 Y-up（竖直轴为 Y）；Autodesk 等多为 Z-up。
    返回 'y' 或 'z'。仅在 header 里找不到明确标志时默认 'z'（更常见的 CAD 约定）。
    """
    try:
        with open(path, "rb") as f:
            head = f.read(8192)
        text = None
        for enc in ("utf-8", "gbk", "gb18030"):
            try:
                text = head.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        if text and re.search(r"solidworks|swstep", text, re.I):
            return "y"
    except Exception:
        pass
    return "z"


def _ensure_utf8_step(path):
    """SolidWorks 中文版常把 STEP 写成 GBK；转成 UTF-8 供 OCP 正确读取中文名。

    返回 (可用路径, 临时文件路径)。若无需转码，临时文件路径为 None。
    """
    raw = open(path, "rb").read()
    try:
        raw.decode("utf-8")
        return path, None
    except UnicodeDecodeError:
        pass
    text = None
    for enc in ("gbk", "gb18030"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        text = raw.decode("utf-8", "replace")
    fd, tmp = tempfile.mkstemp(suffix=".step", prefix="cadview_utf8_")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return tmp, tmp


class _StepDoc:
    def __init__(self, path):
        path, self._tmp = _ensure_utf8_step(path)
        try:
            self.app = XCAFApp_Application.GetApplication_s()
            self.doc = TDocStd_Document(TCollection_ExtendedString("step"))
            self.app.InitDocument(self.doc)
            r = STEPCAFControl_Reader()
            r.SetColorMode(True)
            r.SetNameMode(True)
            print("[import_step] 正在读取 STEP 文件 ...", flush=True)
            st = r.ReadFile(os.path.abspath(path))
            if st != 1:  # IFSelect_RetDone
                raise SystemExit(f"读取 STEP 失败：{path} (status={st})")
            print("[import_step] ReadFile 完成，正在 Transfer 到 XCAF ...", flush=True)
            if not r.Transfer(self.doc):
                raise SystemExit("STEP 转 XCAF 失败")
            print("[import_step] Transfer 完成", flush=True)
        except BaseException:
            self._cleanup_tmp()
            raise
        self._cleanup_tmp()
        self.st = XCAFDoc_DocumentTool.ShapeTool_s(self.doc.Main())
        self.ct = XCAFDoc_DocumentTool.ColorTool_s(self.doc.Main())

    def _cleanup_tmp(self):
        """删除 GBK->UTF-8 转码产生的临时 STEP 文件（约等于源文件大小）。"""
        tmp = getattr(self, "_tmp", None)
        if tmp:
            try:
                os.remove(tmp)
            except OSError:
                pass
            self._tmp = None

    def get_color(self, lab):
        c = Quantity_Color()
        if self.ct.GetColor_s(lab, XCAFDoc_ColorType.XCAFDoc_ColorSurf, c) or \
           self.ct.GetColor_s(lab, XCAFDoc_ColorType.XCAFDoc_ColorGen, c):
            return [round(c.Red(), 4), round(c.Green(), 4), round(c.Blue(), 4)]
        return None

    def free_shapes(self):
        seq = Sequence_TDF_Label()
        self.st.GetFreeShapes(seq)
        return [seq.Value(i) for i in range(1, seq.Length() + 1)]

    def components(self, lab):
        seq = Sequence_TDF_Label()
        self.st.GetComponents_s(lab, seq)
        out = []
        for i in range(1, seq.Length() + 1):
            ref = seq.Value(i)
            refd = TDF_Label()
            if self.st.GetReferredShape_s(ref, refd):
                out.append((refd, _trsf_matrix(self.st.GetLocation_s(ref).Transformation())))
        return out

    def leaf_shape(self, lab):
        s = self.st.GetShape_s(lab)
        return s


def _bounds(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    if box.IsVoid():
        return None
    mn = (box.GetXMin(), box.GetYMin(), box.GetZMin())
    mx = (box.GetXMax(), box.GetYMax(), box.GetZMax())
    if not all(math.isfinite(v) for v in mn + mx):
        return None
    return mn, mx


def _iter_leaves(doc, lab):
    """深度优先遍历，产出叶子 label（顺序稳定，与建树时一致）。"""
    if doc.st.IsAssembly_s(lab):
        for refd, _loc in doc.components(lab):
            yield from _iter_leaves(doc, refd)
    else:
        yield lab


def _angular_for_extent(d, base_ang):
    """按零件包围盒尺寸分档角度偏差（尺寸自适应精修）。

    中件(25~60mm，典型齿轮/轴承座/支架等曲面件)给最细角度；
    小件(<25mm，螺钉/小圆角)给中细，避免小特征过度细分；
    大件(>=60mm，机架/底盘)用 base 角度作为粗帽，由线性偏差保证大曲面圆度。
    """
    if d < 25.0:
        return min(base_ang, 0.30)
    if d < 60.0:
        return min(base_ang, 0.15)
    return base_ang


def import_step(step_path, out_dir, linear_deflection=None, angular_deflection=0.5,
                linear_factor=0.0004, size_adaptive=False, dedup=True):
    step_path = os.path.abspath(step_path)
    out_dir = os.path.abspath(out_dir)
    parts_dir = os.path.join(out_dir, "parts")
    os.makedirs(parts_dir, exist_ok=True)

    doc = _StepDoc(step_path)
    naming = _load_naming()

    free = doc.free_shapes()
    n_leaves = sum(1 for root in free for leaf in _iter_leaves(doc, root))
    print(f"[import_step] 顶层根节点 {len(free)} 个，叶子零件 {n_leaves} 个", flush=True)
    # 计算整体尺寸以决定网格精度
    extents = []
    idx = 0
    for root in free:
        for leaf in _iter_leaves(doc, root):
            idx += 1
            shape = doc.leaf_shape(leaf)
            if shape is None or shape.IsNull():
                continue
            b = _bounds(shape)
            if not b:
                continue
            mn, mx = b
            ext = max(mx[i] - mn[i] for i in range(3))
            if not math.isfinite(ext) or ext <= 0 or ext > 1e6:
                continue
            extents.append(ext)
            if idx % 100 == 0:
                print(f"[import_step] 尺寸预扫描 {idx}/{n_leaves} ...", flush=True)
    # 用 95% 分位而非最大值：个别零件可能带有远处孤立顶点/退化边而把包围盒撑大，
    # 导致网格精度过粗。取稳健的 95% 分位作为整体尺寸代理。
    max_dim = 100.0
    if extents:
        extents.sort()
        k = min(len(extents) - 1, int(len(extents) * 0.95))
        max_dim = extents[k] or 100.0
    if linear_deflection is None:
        linear_deflection = max_dim * linear_factor
    lin = float(linear_deflection)
    ang = float(angular_deflection)
    print(f"[import_step] 网格精度: 95%分位尺寸={max_dim:.1f}mm, 线性偏差={lin:.3f}mm, 角度偏差={ang:.2f}rad", flush=True)
    print(f"[import_step] 选项: 线性系数={linear_factor} 尺寸自适应={size_adaptive} 几何去重={dedup}", flush=True)

    # 预写所有叶子 STL（保证建树时 id 可用），顺序与遍历一致。
    leaf_meta = []  # {"id","name","source_name","color","part"}
    used = set()
    hash_to_stl = {}   # 网格内容哈希 -> 已写入 stl 相对路径（相同几何共享一份 STL）
    idx = 0
    dup_instances = 0
    for root in free:
        for leaf in _iter_leaves(doc, root):
            idx += 1
            shape = doc.leaf_shape(leaf)
            raw = _get_name(leaf)
            slug, name = _translate_name(raw, naming)
            base = slug or "part"
            if base in used:
                k = 2
                while f"{base}-{k}" in used:
                    k += 1
                base = f"{base}-{k}"
            used.add(base)
            stl_rel = f"parts/{base}.stl"
            stl_abs = os.path.join(parts_dir, f"{base}.stl")
            # 半径自适应细分：小线性偏差(lin)负责大半径曲面(轮子)的圆度，
            # 大角度偏差(ang)作为粗帽，避免小半径圆角被过度细分。
            part_ang = ang
            if size_adaptive:
                b = _bounds(shape)
                if b:
                    mn, mx = b
                    d = max(mx[i] - mn[i] for i in range(3))
                    part_ang = _angular_for_extent(d, ang)
            BRepMesh_IncrementalMesh(shape, lin, False, part_ang, True).Perform()
            w = StlAPI_Writer()
            w.ASCIIMode = False
            w.Write(shape, stl_abs)
            # 相同几何共享一份 STL，避免重复网格撑大 GLB
            if dedup:
                with open(stl_abs, "rb") as f:
                    h = hashlib.md5(f.read()).hexdigest()
                if h in hash_to_stl:
                    os.remove(stl_abs)
                    stl_rel = hash_to_stl[h]
                    dup_instances += 1
                else:
                    hash_to_stl[h] = stl_rel
            leaf_meta.append({
                "id": base, "name": name, "source_name": raw,
                "color": doc.get_color(leaf), "part": stl_rel,
            })
            if idx % 25 == 0:
                print(f"[import_step] 网格化 {idx}/{n_leaves} ...", flush=True)
    if dup_instances:
        print(f"[import_step] 相同几何去重：{dup_instances} 个实例共享已有 STL", flush=True)

    meta_iter = iter(leaf_meta)
    parts_map = {}
    serial_p = [0]
    serial_a = [0]

    def build(lab, local):
        raw = _get_name(lab)
        if doc.st.IsAssembly_s(lab):
            slug, name = _translate_name(raw, naming)
            serial_a[0] += 1
            sid = f"A{serial_a[0]:03d}"
            node = {
                "id": sid, "name_en": name, "name_zh": raw,
                "kind": "assembly", "local": local, "color": None, "children": [],
            }
            parts_map[sid] = {"name_en": name, "name_zh": raw, "kind": "assembly"}
            for refd, child_local in doc.components(lab):
                node["children"].append(build(refd, child_local))
            return node
        else:
            m = next(meta_iter)
            serial_p[0] += 1
            sid = f"P{serial_p[0]:03d}"
            node = {
                "id": sid, "name_en": m["name"], "name_zh": m["source_name"],
                "kind": "part", "local": local, "color": m["color"],
                "part": m["part"], "children": [],
            }
            parts_map[sid] = {"name_en": m["name"], "name_zh": m["source_name"], "kind": "part"}
            return node

    roots = [build(r, IDENTITY) for r in free]
    _save_naming(naming)

    hierarchy = {
        "source": os.path.basename(step_path),
        "up": _detect_up(step_path),
        "units": "mm",
        "linear_deflection": lin,
        "angular_deflection": ang,
        "linear_factor": linear_factor,
        "size_adaptive": size_adaptive,
        "dedup": dedup,
        "roots": roots,
        "parts": parts_map,
    }
    with open(os.path.join(out_dir, "hierarchy.json"), "w", encoding="utf-8") as f:
        json.dump(hierarchy, f, ensure_ascii=False, indent=2)

    return hierarchy


def flatten_parts(node):
    if node.get("kind") == "part":
        return [node]
    out = []
    for c in node.get("children", []):
        out += flatten_parts(c)
    return out


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--linear-deflection", type=float, default=None)
    ap.add_argument("--angular-deflection", type=float, default=0.5)
    ap.add_argument("--linear-factor", type=float, default=0.0004)
    ap.add_argument("--size-adaptive", action="store_true")
    ap.add_argument("--no-dedup", action="store_true")
    a = ap.parse_args()
    h = import_step(a.input, a.output, a.linear_deflection, a.angular_deflection,
                    a.linear_factor, a.size_adaptive, not a.no_dedup)
    n = sum(len(flatten_parts(r)) for r in h["roots"])
    print(f"STEP -> {n} 个零件, 输出 {a.output}")


if __name__ == "__main__":
    main()


