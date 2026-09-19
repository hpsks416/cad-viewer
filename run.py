# -*- coding: utf-8 -*-
"""一键入口：批量导出/转换 + 浏览器查看。

用法：
  python run.py                     # 启动服务 + 打开浏览器（在页面里批量选择导出/转换）
  python run.py --build             # 先把 assets/export/ 里全部 STL 转换完，再启动服务
  python run.py --build --no-serve  # 只转换（无头，不启动服务器）
  python run.py --no-preview        # 转换时不渲染缩略图（更快）
"""
import argparse
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(ROOT, "tools"))


def main():
    ap = argparse.ArgumentParser(description="RoboMaster 3D 展示：批量导出/转换 + 查看")
    ap.add_argument("--build", action="store_true", help="启动前先把全部 STL 转换")
    ap.add_argument("--no-serve", action="store_true", help="转换后不启动服务器")
    ap.add_argument("--no-preview", action="store_true", help="转换时不渲染缩略图")
    ap.add_argument("--port", type=int, default=8123)
    a = ap.parse_args()

    if a.build:
        from build import build
        res = build(preview=not a.no_preview)
        print(f"已转换 {len(res['models'])} 个模型")

    if not a.no_serve:
        from server import serve
        serve(a.port, open_browser=True)


if __name__ == "__main__":
    main()