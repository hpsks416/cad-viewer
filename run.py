# -*- coding: utf-8 -*-
"""一键入口：批量导出/转换 + 浏览器查看。

用法：
  python run.py                     # 启动服务 + 打开浏览器（在页面里批量选择导出/转换）
  python run.py --build             # 先把 assets/export/ 里全部 STL 转换完，再启动服务
  python run.py --build --no-serve  # 只转换（无头，不启动服务器）
  python run.py --no-preview        # 转换时不渲染缩略图（更快）

说明：STEP 转换依赖 OCP，翻译依赖 ctranslate2/sentencepiece，这些绑定在 work/_vendor/
里是按 Python 3.12 编译的；若当前 `python` 是其它版本（如 3.11），本入口会自动找到
能加载这些依赖的 Python 并用它重新启动自己，因此 `start.cmd` / `python run.py` 均可直接使用。
"""
import argparse
import glob
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(ROOT, "work", "_vendor")


def _can_run_pipeline(py):
    """该 Python 能否加载翻译(ctranslate2/sentencepiece)与 OCP 绑定。"""
    if not py or not os.path.exists(py):
        return False
    code = "import sys; sys.path.insert(0, %r); import ctranslate2, sentencepiece, OCP" % VENDOR
    try:
        r = subprocess.run([py, "-c", code], capture_output=True, timeout=120)
        return r.returncode == 0
    except Exception:
        return False


def _preferred_python():
    """返回能跑流水线的 Python：config.json 的 python > 当前解释器 > Codex 运行时里的 3.12。"""
    seen = set()
    cands = []
    try:
        with open(os.path.join(ROOT, "tools", "config.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("python"):
            cands.append(cfg["python"])
    except Exception:
        pass
    cands.append(sys.executable)
    home = os.path.expanduser("~")
    for pat in (
        os.path.join(home, ".cache", "codex-runtimes", "*", "dependencies", "python", "python.exe"),
        os.path.join(home, ".cache", "codex-runtimes", "*", "dependencies", "python", "python"),
    ):
        cands.extend(sorted(glob.glob(pat)))
    for py in cands:
        if not py or py in seen:
            continue
        seen.add(py)
        if _can_run_pipeline(py):
            return os.path.abspath(py)
    return None


def _ensure_python():
    """若当前解释器跑不了流水线，则用能跑的解释器重新启动自身。"""
    if os.environ.get("CAD_VIEWER_PY") == "ok":
        return
    if _can_run_pipeline(sys.executable):
        return
    target = _preferred_python()
    if not target or os.path.normcase(target) == os.path.normcase(os.path.abspath(sys.executable)):
        return
    env = os.environ.copy()
    env["CAD_VIEWER_PY"] = "ok"
    pp = os.path.join(ROOT, "tools") + os.pathsep + VENDOR
    env["PYTHONPATH"] = pp + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    print(f"[run] 当前 python 无法加载流水线依赖，改用：{target}", flush=True)
    rc = subprocess.call([target, os.path.abspath(__file__)] + sys.argv[1:], cwd=ROOT, env=env)
    sys.exit(rc)


def main():
    ap = argparse.ArgumentParser(description="RoboMaster 3D 展示：批量导出/转换 + 查看")
    ap.add_argument("--build", action="store_true", help="启动前先把全部 STL 转换")
    ap.add_argument("--no-serve", action="store_true", help="转换后不启动服务器")
    ap.add_argument("--no-preview", action="store_true", help="转换时不渲染缩略图")
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--no-browser", action="store_true", help="启动服务时不自动打开浏览器")
    a = ap.parse_args()

    if a.build:
        from build import build
        res = build(preview=not a.no_preview)
        print(f"已转换 {len(res['models'])} 个模型")

    if not a.no_serve:
        from server import serve
        serve(a.port, open_browser=not a.no_browser)


if __name__ == "__main__":
    _ensure_python()
    main()
