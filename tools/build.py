# -*- coding: utf-8 -*-
"""编排：扫描 STL/STEP -> 中文命名翻译（本地模型）-> 转换 glb -> 生成 manifest。

对外提供：
  inventory()                      -> 列出所有 STL/STEP 及命名/转换状态
  build(files=None, preview=True)  -> 转换全部或指定文件，返回 {models, results}

STEP 走：OCP(OpenCascade) 解析 AP214 -> 零件网格 + 层级 + 颜色 -> Blender PBR 装配 -> glb。
"""
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from translate_names import translate, slugify, display_name

ASSETS = os.path.join(ROOT, "assets", "export")
MODELS = os.path.join(ROOT, "models")
PREVIEWS = os.path.join(ROOT, "work", "previews")
STEP_WORK = os.path.join(ROOT, "work", "step")
JOINTS = os.path.join(ROOT, "assets", "joints")
MANIFEST = os.path.join(MODELS, "manifest.json")
NAMING = os.path.join(ROOT, "assets", "naming-map.json")
CONFIG = os.path.join(ROOT, "tools", "config.json")
PRESETS = os.path.join(ROOT, "assets", "materials", "presets.json")
CONVERT_PRESETS = os.path.join(ROOT, "assets", "convert-presets.json")
HISTORY = os.path.join(ROOT, "work", "convert-history.json")

STL_EXTS = (".stl",)
STEP_EXTS = (".step", ".stp")


def load_config():
    cfg = {"blender": "", "preview": True}
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
    except Exception:
        pass
    if not cfg.get("blender") or not os.path.exists(cfg["blender"]):
        cfg["blender"] = detect_blender()
    return cfg


def detect_blender():
    found = shutil.which("blender")
    if found and os.path.exists(found):
        return found
    for c in (
        r"G:\Blender\Application\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 4.3\blender.exe",
        r"C:\Program Files\Blender Foundation\Blender 5.0\blender.exe",
    ):
        if os.path.exists(c):
            return c
    return ""


def load_naming():
    try:
        with open(NAMING, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_naming(naming):
    os.makedirs(os.path.dirname(NAMING), exist_ok=True)
    with open(NAMING, "w", encoding="utf-8") as f:
        json.dump(naming, f, ensure_ascii=False, indent=2)


DEFAULT_MODE = {
    "id": "meshopt",
    "name": "Meshopt（无损，推荐）",
    "compression": "meshopt",
    "angular_deflection": 0.5,
    "size_adaptive": False,
    "dedup": True,
    "radius_adaptive": True,
}


def load_convert_presets():
    """读取转换预设：{presets: [...], custom: [...]}。"""
    data = {"presets": [], "custom": []}
    try:
        with open(CONVERT_PRESETS, "r", encoding="utf-8") as f:
            data.update(json.load(f))
    except Exception:
        pass
    return data


def save_convert_presets(data):
    os.makedirs(os.path.dirname(CONVERT_PRESETS), exist_ok=True)
    tmp = CONVERT_PRESETS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, CONVERT_PRESETS)


def load_history():
    try:
        with open(HISTORY, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def save_history(entries):
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    with open(HISTORY, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def resolve_mode(mode=None):
    """把 mode 解析成完整参数字典。

    mode 可为预设 id 字符串、完整 mode 对象，或 None（默认 meshopt 预设）。
    """
    data = load_convert_presets()
    all_modes = data.get("presets", []) + data.get("custom", [])
    if mode is None:
        mode = "meshopt"
    if isinstance(mode, str):
        for m in all_modes:
            if m.get("id") == mode:
                return dict(m)
        return dict(DEFAULT_MODE)
    m = dict(DEFAULT_MODE)
    if isinstance(mode, dict):
        for k in ("id", "name", "compression", "angular_deflection",
                  "size_adaptive", "dedup", "radius_adaptive"):
            if mode.get(k) is not None:
                m[k] = mode[k]
    return m


def _mode_import_args(mode):
    """把 mode 参数转成 import_step.py 的命令行参数。"""
    ang = float(mode.get("angular_deflection", 0.5))
    linear_factor = 0.0004 if mode.get("radius_adaptive", True) else 0.002
    out = ["--angular-deflection", str(ang), "--linear-factor", str(linear_factor)]
    if mode.get("size_adaptive"):
        out.append("--size-adaptive")
    if not mode.get("dedup", True):
        out.append("--no-dedup")
    return out


def _rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


def _is_step(f):
    return f.lower().endswith(STEP_EXTS)


def scan_sources():
    if not os.path.isdir(ASSETS):
        return []
    exts = STL_EXTS + STEP_EXTS
    return sorted(
        [f for f in os.listdir(ASSETS) if f.lower().endswith(exts)],
        key=lambda s: s.lower(),
    )


def _slug_for(f, naming):
    """确保文件名有翻译后的 slug，返回 (slug, name, rec)。"""
    stem = os.path.splitext(f)[0]
    rec = naming.get(f)
    slug = rec.get("slug") if rec else None
    if not slug:
        try:
            en = translate(stem)
            slug = slugify(en) or "model"
            name = display_name(slug)
            naming[f] = {"slug": slug, "name": name, "translation": en}
            rec = naming[f]
        except Exception:
            rec = None
    if rec:
        slug = rec.get("slug")
        name = rec.get("name") or display_name(slug or "")
    else:
        slug = None
        name = None
    return slug, name, rec


def inventory():
    files = scan_sources()
    naming = load_naming()
    changed = False
    out = []
    for f in files:
        slug, name, rec = _slug_for(f, naming)
        if rec and not naming.get(f):
            changed = True
        if slug:
            glb = os.path.join(MODELS, f"{slug}.glb")
            png = os.path.join(PREVIEWS, f"{slug}.png")
            joints = os.path.join(MODELS, f"{slug}.joints.json")
            has_glb = os.path.exists(glb)
            out.append({
                "filename": f,
                "type": "step" if _is_step(f) else "stl",
                "slug": slug,
                "name": name,
                "translation": (rec or {}).get("translation"),
                "has_glb": has_glb,
                "glb": _rel(glb) if has_glb else None,
                "preview": _rel(png) if os.path.exists(png) else None,
                "joints": _rel(joints) if os.path.exists(joints) else None,
            })
        else:
            out.append({
                "filename": f,
                "type": "step" if _is_step(f) else "stl",
                "slug": None, "name": None, "translation": None,
                "has_glb": False, "glb": None, "preview": None, "joints": None,
            })
    if changed:
        save_naming(naming)
    return {"files": out}


def _collect_assembly_nodes(node, out):
    if node.get("kind") == "assembly":
        out.append({"id": node.get("id"), "name": node.get("name_en"), "name_zh": node.get("name_zh")})
    for c in node.get("children", []):
        _collect_assembly_nodes(c, out)


def ensure_joints_template(slug, hierarchy_path):
    target = os.path.join(JOINTS, f"{slug}.json")
    if os.path.exists(target):
        return target
    candidates = []
    try:
        with open(hierarchy_path, "r", encoding="utf-8") as f:
            h = json.load(f)
        for r in h.get("roots", []):
            _collect_assembly_nodes(r, candidates)
    except Exception:
        candidates = []
    data = {"joints": [], "candidates": candidates}
    os.makedirs(JOINTS, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return target


def _run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")


def _find_ocp_python():
    """找到能导入 OCP 的 Python，用于 STEP 解析。

    OCP 绑定按 Python 版本编译（当前为 cp312）；服务层可能跑在其它版本（如 3.11）。
    优先用 config.json 里的 python，其次当前解释器，再自动探测 Codex 运行时里的 Python 3.12。
    """
    import glob

    vendor = os.path.join(ROOT, "work", "_vendor")
    seen = set()
    candidates = []

    cfg = load_config()
    if cfg.get("python"):
        candidates.append(cfg["python"])
    candidates.append(sys.executable)

    home = os.path.expanduser("~")
    for pat in (
        os.path.join(home, ".cache", "codex-runtimes", "*", "dependencies", "python", "python.exe"),
        os.path.join(home, ".cache", "codex-runtimes", "*", "dependencies", "python", "python"),
    ):
        candidates.extend(sorted(glob.glob(pat)))

    def can(py):
        if not py or not os.path.exists(py):
            return False
        code = "import sys; sys.path.insert(0, %r); import OCP" % vendor
        try:
            r = subprocess.run([py, "-c", code], capture_output=True, timeout=120)
            return r.returncode == 0
        except Exception:
            return False

    for py in candidates:
        if not py or py in seen:
            continue
        seen.add(py)
        if can(py):
            return py
    return sys.executable


def _convert_stl(f, blender, preview, naming):
    slug, name, rec = _slug_for(f, naming)
    src = os.path.join(ASSETS, f)
    glb = os.path.join(MODELS, f"{slug}.glb")
    png = os.path.join(PREVIEWS, f"{slug}.png") if preview else None
    cmd = [
        blender, "--background", "--python",
        os.path.join(ROOT, "tools", "export_blender.py"), "--",
        "--input", src, "--output", glb, "--name", slug,
    ]
    if preview:
        cmd += ["--preview", png]
    r = _run(cmd)
    ok = r.returncode == 0 and os.path.exists(glb)
    return {
        "filename": f, "type": "stl", "slug": slug, "name": name,
        "ok": ok, "glb": _rel(glb) if ok else None,
        "preview": _rel(png) if (preview and os.path.exists(png)) else None,
        "error": None if ok else (r.stdout + "\n" + r.stderr)[-800:],
    }


def _convert_step(f, blender, preview, naming, mode):
    slug, name, rec = _slug_for(f, naming)
    src = os.path.join(ASSETS, f)
    out_dir = os.path.join(STEP_WORK, slug)
    hierarchy_path = os.path.join(out_dir, "hierarchy.json")
    glb = os.path.join(MODELS, f"{slug}.glb")
    png = os.path.join(PREVIEWS, f"{slug}.png") if preview else None
    joints_dst = os.path.join(MODELS, f"{slug}.joints.json")
    meta_path = os.path.join(MODELS, f"{slug}.meta.json")

    # 1) STEP -> 零件网格 + 层级 + 颜色（OCP）
    r1 = _run([
        _find_ocp_python(), os.path.join(ROOT, "tools", "import_step.py"),
        "--input", src, "--output", out_dir,
    ] + _mode_import_args(mode))
    if r1.returncode != 0 or not os.path.exists(hierarchy_path):
        return {
            "filename": f, "type": "step", "slug": slug, "name": name, "ok": False,
            "glb": None, "preview": None,
            "error": (r1.stdout + "\n" + r1.stderr)[-800:],
        }

    # 2) 关节模板（列出可动候选的装配节点）
    try:
        joints_src = ensure_joints_template(slug, hierarchy_path)
    except Exception:
        joints_src = None

    # 3) Blender 装配 -> glb + 缩略图
    cmd = [
        blender, "--background", "--python",
        os.path.join(ROOT, "tools", "export_step.py"), "--",
        "--hierarchy", hierarchy_path, "--output", glb, "--name", slug,
        "--compression", mode.get("compression") or "meshopt",
    ]
    if os.path.exists(PRESETS):
        cmd += ["--presets", PRESETS]
    if preview:
        cmd += ["--preview", png]
    r2 = _run(cmd)
    ok = r2.returncode == 0 and os.path.exists(glb)

    # 4) 关节描述拷到 models/（查看器按此加载）
    if ok and joints_src and os.path.exists(joints_src):
        try:
            shutil.copy2(joints_src, joints_dst)
        except Exception:
            pass
    elif ok and not os.path.exists(joints_dst):
        try:
            os.makedirs(MODELS, exist_ok=True)
            with open(joints_dst, "w", encoding="utf-8") as f:
                json.dump({"joints": [], "candidates": []}, f, ensure_ascii=False, indent=2)
        except Exception:
            pass

    return {
        "filename": f, "type": "step", "slug": slug, "name": name,
        "ok": ok, "glb": _rel(glb) if ok else None,
        "preview": _rel(png) if (preview and os.path.exists(png)) else None,
        "joints": _rel(joints_dst) if os.path.exists(joints_dst) else None,
        "error": None if ok else (r2.stdout + "\n" + r2.stderr)[-800:],
    }


def build(files=None, preview=None, mode=None):
    cfg = load_config()
    blender = cfg["blender"]
    if not blender:
        raise SystemExit("未找到 Blender，请在 tools/config.json 里配置 blender 路径。")
    if preview is None:
        preview = bool(cfg.get("preview", True))
    mode = resolve_mode(mode)

    all_files = scan_sources()
    if files is None:
        files = all_files
    else:
        files = [f for f in files if f in all_files]

    os.makedirs(MODELS, exist_ok=True)
    os.makedirs(PREVIEWS, exist_ok=True)
    os.makedirs(STEP_WORK, exist_ok=True)
    naming = load_naming()

    used = {}
    results = []
    new_history = []
    for f in files:
        # 预先翻译，避免 slug 冲突；冲突时加后缀
        slug, name, rec = _slug_for(f, naming)
        if slug in used and used[slug] != f:
            base = slug
            k = 2
            while f"{base}-{k}" in used:
                k += 1
            slug = f"{base}-{k}"
            naming[f] = {"slug": slug, "name": name, "translation": rec.get("translation") if rec else ""}
            rec = naming[f]
        used[slug] = f

        t0 = time.time()
        if _is_step(f):
            r = _convert_step(f, blender, preview, naming, mode)
        else:
            r = _convert_stl(f, blender, preview, naming)
        dt = time.time() - t0

        if r["ok"]:
            print(f"[{f}] -> {r['slug']} 完成 ({dt:.1f}s)")
        else:
            print(f"[{f}] 转换失败")

        glb_size = None
        if r["ok"] and r.get("glb"):
            p = os.path.join(ROOT, r["glb"])
            if os.path.exists(p):
                glb_size = os.path.getsize(p)
        new_history.append({
            "filename": f, "slug": r.get("slug"), "type": r.get("type"),
            "preset": mode.get("id"), "preset_name": mode.get("name"),
            "angular": mode.get("angular_deflection"), "compression": mode.get("compression"),
            "ok": r["ok"], "seconds": round(dt, 2), "glb_size": glb_size,
            "error": (r.get("error") or "")[-200:] if not r["ok"] else None,
            "timestamp": time.time(),
        })
        results.append(r)

    save_naming(naming)
    hist = (new_history + load_history())[:200]
    save_history(hist)

    models = []
    for f in all_files:
        slug, name, rec = _slug_for(f, naming)
        if not slug:
            continue
        glb = os.path.join(MODELS, f"{slug}.glb")
        if not os.path.exists(glb):
            continue
        entry = {
            "id": slug,
            "name": name,
            "source": f,
            "type": "step" if _is_step(f) else "stl",
            "glb": _rel(glb),
        }
        png = os.path.join(PREVIEWS, f"{slug}.png")
        if os.path.exists(png):
            entry["preview"] = _rel(png)
        joints = os.path.join(MODELS, f"{slug}.joints.json")
        if os.path.exists(joints):
            entry["joints"] = _rel(joints)
        meta = os.path.join(MODELS, f"{slug}.meta.json")
        if os.path.exists(meta):
            try:
                with open(meta, "r", encoding="utf-8") as f:
                    entry["meta"] = json.load(f)
            except Exception:
                pass
        parts = os.path.join(MODELS, f"{slug}.parts.json")
        if os.path.exists(parts):
            entry["parts"] = _rel(parts)
        models.append(entry)

    manifest = {"title": "RoboMaster 作品", "models": models}
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return {"models": models, "results": results, "history": hist}


if __name__ == "__main__":
    import argparse
    import json as _json
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-preview", action="store_true")
    ap.add_argument("--files", default=None, help="JSON array of filenames to convert, e.g. '[\"a.step\"]'")
    ap.add_argument("--mode", default=None, help="转换模式：预设 id 或 JSON 对象")
    a = ap.parse_args()

    files = None
    if a.files:
        try:
            parsed = _json.loads(a.files)
            if isinstance(parsed, list):
                files = [str(x) for x in parsed]
        except Exception:
            files = None

    mode = None
    if a.mode:
        try:
            mode = _json.loads(a.mode)
        except Exception:
            mode = a.mode

    res = build(files=files, preview=not a.no_preview, mode=mode)
    print(f"manifest -> {os.path.relpath(MANIFEST, ROOT)}  ({len(res['models'])} 个模型)")
