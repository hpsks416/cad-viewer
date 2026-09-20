# -*- coding: utf-8 -*-
"""轻量探针：只读取 STEP 结构，不网格化，用于快速验证 1GB 大装配的解析与中文名解码。"""
import os, sys, re, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "work", "_vendor"))

from import_step import _StepDoc, _get_name, _iter_leaves, _ensure_utf8_step, _detect_up

def main():
    p = sys.argv[1]
    print(f"[probe] ensure utf8 ...", flush=True)
    up = _detect_up(p)
    print(f"[probe] up-axis={up}", flush=True)
    tmp = _ensure_utf8_step(p)
    print(f"[probe] using {tmp if tmp!=os.path.abspath(p) else '原文件'} (size={os.path.getsize(tmp)/1e6:.1f}MB)", flush=True)
    print("[probe] 读取 STEP + Transfer (这一步可能要几分钟) ...", flush=True)
    doc = _StepDoc(p)
    free = doc.free_shapes()
    print(f"[probe] 顶层 free shapes = {len(free)}", flush=True)

    n_parts = 0
    n_asm = 0
    names = {}
    def walk(lab, depth):
        nonlocal n_parts, n_asm
        raw = _get_name(lab)
        if doc.st.IsAssembly_s(lab):
            n_asm += 1
            kind = "asm"
        else:
            n_parts += 1
            kind = "part"
        if depth <= 6:
            print(f"{'  '*depth}{kind}: {raw!r}", flush=True)
        names[raw] = names.get(raw, 0) + 1
        if doc.st.IsAssembly_s(lab):
            for refd, loc in doc.components(lab):
                walk(refd, depth+1)
    for r in free:
        walk(r, 0)

    print(f"[probe] 统计: assemblies={n_asm}, parts={n_parts}, unique names={len(names)}", flush=True)
    zh = [k for k in names if re.search(r'[\u3400-\u4dbf\u4e00-\u9fff]', k)]
    moji = [k for k in names if re.search(r'[\u0100-\u024f]', k) and not re.search(r'[\u3400-\u4dbf\u4e00-\u9fff]', k)]
    print(f"[probe] 含中文的名 {len(zh)} 个; 疑似乱码(拉丁扩展)名 {len(moji)} 个", flush=True)
    print("[probe] 中文名样例(前30):", flush=True)
    for k in zh[:30]:
        print(f"   {k!r}", flush=True)
    print("[probe] 乱码名样例(前20):", flush=True)
    for k in moji[:20]:
        print(f"   {k!r}", flush=True)

if __name__ == "__main__":
    main()
