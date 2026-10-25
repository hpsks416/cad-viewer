# -*- coding: utf-8 -*-
"""把 URDF 的关节/连杆结构转成查看器 joints.json（含 origin xyz+rpy + axis + limits）。

用法：
    python tools/urdf_to_joints.py robot.urdf -o models/robot.joints.json

URDF 关节语义（ROS 标准）：
    <joint name=... type="revolute|continuous|prismatic|fixed|floating|planar">
      <parent link=".."/> <child link=".."/>
      <origin xyz="x y z" rpy="r p y"/>   # 关节坐标系相对父连杆的位姿
      <axis xyz="x y z"/>                  # 关节轴（关节坐标系下，单位向量）
      <limit lower=.. upper=.. effort=.. velocity=../>
    </joint>

映射到 joints.json：
    node   = child link 名（需与 glb 节点名一致）
    type   = revolute / continuous / prismatic（fixed 忽略；floating/planar 暂不支持，警告）
    origin = {xyz, rpy}（关节坐标系位姿，节点局部空间；xyz/rpy 全 0 时省略）
    axis   = 关节轴（单位向量）
    min/max/default = 来自 limit lower/upper（缺省 revolute ±180、prismatic ±1）
"""
import argparse
import json
import sys
import xml.etree.ElementTree as ET

DEFAULT_LIMITS = {
    "revolute": (-180.0, 180.0),
    "continuous": (-180.0, 180.0),
    "prismatic": (-1.0, 1.0),
}


def _floats(s, n, default):
    try:
        vals = [float(x) for x in (s or "").split()]
        if len(vals) != n:
            return list(default)
        return vals
    except Exception:
        return list(default)


def parse_urdf(path):
    tree = ET.parse(path)
    root = tree.getroot()
    joints = []
    warnings = []
    for j in root.findall("joint"):
        name = j.get("name") or ""
        jtype = j.get("type", "revolute")
        parent = j.find("parent")
        child = j.find("child")
        child_link = child.get("link") if child is not None else name

        if jtype == "fixed":
            continue
        if jtype in ("floating", "planar"):
            warnings.append(f"关节 {name} 类型 {jtype} 暂不支持，已跳过")
            continue

        origin = j.find("origin")
        xyz = _floats(origin.get("xyz") if origin is not None else None, 3, [0.0, 0.0, 0.0])
        rpy = _floats(origin.get("rpy") if origin is not None else None, 3, [0.0, 0.0, 0.0])

        axis = j.find("axis")
        ax = _floats(axis.get("xyz") if axis is not None else None, 3, [0.0, 0.0, 1.0])
        norm = sum(x * x for x in ax) ** 0.5
        if norm < 1e-9:
            ax = [0.0, 0.0, 1.0]
        else:
            ax = [round(x / norm, 6) for x in ax]

        limit = j.find("limit")
        lo = hi = None
        if limit is not None:
            lo = limit.get("lower")
            hi = limit.get("upper")
        dlo, dhi = DEFAULT_LIMITS.get(jtype, (-180.0, 180.0))
        lo = float(lo) if lo is not None else dlo
        hi = float(hi) if hi is not None else dhi

        rec = {
            "node": child_link,
            "name": name or child_link,
            "type": jtype,
            "axis": ax,
            "min": lo,
            "max": hi,
            "default": 0.0,
        }
        if any(abs(v) > 1e-9 for v in xyz) or any(abs(v) > 1e-9 for v in rpy):
            rec["origin"] = {"xyz": [round(v, 6) for v in xyz], "rpy": [round(v, 6) for v in rpy]}
        joints.append(rec)

    return {"joints": joints, "candidates": []}, warnings


def main():
    ap = argparse.ArgumentParser(description="URDF -> joints.json")
    ap.add_argument("urdf", help="URDF 文件路径")
    ap.add_argument("-o", "--output", default=None, help="输出 joints.json 路径（默认打印到 stdout）")
    a = ap.parse_args()
    data, warnings = parse_urdf(a.urdf)
    for w in warnings:
        print(f"[warn] {w}", file=sys.stderr)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if a.output:
        with open(a.output, "w", encoding="utf-8") as f:
            f.write(text)
        print(f"已写入 {a.output}（{len(data['joints'])} 个关节）")
    else:
        print(text)


if __name__ == "__main__":
    main()
