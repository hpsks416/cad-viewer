# -*- coding: utf-8 -*-
"""确保 OpenCascade 的 Python 绑定（OCP + vtk）可用。

首次构建 STEP 时，若 work/_vendor 里没有 OCP，则自动从 PyPI 下载对应平台的 wheel
并解压到 work/_vendor（离线缓存）。之后完全离线。
"""
import json
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "work", "_vendor")

# 依赖关系（cadquery-ocp 是 OCP 的 pip 发行名，依赖 vtk 与 proxy）
PKGS = ["cadquery-ocp", "cadquery-ocp-proxy", "vtk"]


def _pypi_json(name):
    req = urllib.request.Request(
        f"https://pypi.org/pypi/{name}/json", headers={"User-Agent": "Mozilla/5.0"}
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _platform_tag():
    if sys.platform.startswith("win"):
        return "win_amd64"
    if sys.platform == "darwin":
        return "macosx"
    return "manylinux"


def _pick_wheel(urls, py_tag, platform_tag):
    for u in urls:
        fn = u["filename"]
        if not fn.endswith(".whl"):
            continue
        if "py3-none-any" in fn:
            return u
    for u in urls:
        fn = u["filename"]
        if fn.endswith(".whl") and py_tag in fn and platform_tag in fn:
            return u
    # 兜底：平台标签含 manylinux/macosx/win 模糊匹配
    for u in urls:
        fn = u["filename"]
        if fn.endswith(".whl") and py_tag in fn and platform_tag.split("_")[0] in fn:
            return u
    return None


def _download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=900) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def _extract(wheel, vendor):
    with zipfile.ZipFile(wheel) as z:
        z.extractall(vendor)


def _ocp_importable():
    try:
        import OCP  # noqa: F401
        return True
    except Exception:
        return False


def ensure_ocp():
    """确保 OCP 可导入；必要时下载解压。返回 True/False。"""
    os.makedirs(VENDOR, exist_ok=True)
    if VENDOR not in sys.path:
        sys.path.insert(0, VENDOR)
    if _ocp_importable():
        return True

    py_tag = f"cp{sys.version_info.major}{sys.version_info.minor}"
    platform_tag = _platform_tag()
    tmp = os.path.join(VENDOR, "_wheels")
    os.makedirs(tmp, exist_ok=True)
    print("[ocp] 首次构建 STEP：自动下载 OpenCascade 绑定（cadquery-ocp + vtk）...")

    for name in PKGS:
        try:
            info = _pypi_json(name)
            u = _pick_wheel(info["urls"], py_tag, platform_tag)
            if not u:
                print(f"[ocp] 未找到 {name} 适配当前平台({py_tag}/{platform_tag})的 wheel")
                return False
            fn = u["filename"]
            dest = os.path.join(tmp, fn)
            if not os.path.exists(dest) or os.path.getsize(dest) == 0:
                print(f"[ocp] 下载 {fn} ...")
                _download(u["url"], dest)
            _extract(dest, VENDOR)
            print(f"[ocp] 解压 {fn}")
        except Exception as e:
            print(f"[ocp] 下载/解压 {name} 失败：{e}")
            return False

    return _ocp_importable()


if __name__ == "__main__":
    print("ensure_ocp ->", ensure_ocp())
