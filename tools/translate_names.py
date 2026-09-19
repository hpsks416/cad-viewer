# -*- coding: utf-8 -*-
"""中文零件名 -> 英文 slug：本地开源机器翻译。

引擎：CTranslate2 + SentencePiece + OPUS/Argos 的 zh->en 模型（开放模型）。
完全本地离线运行，首次使用会下载一次模型并缓存到 tools/translate_models/。
依赖：ctranslate2、sentencepiece（见 requirements.txt）。

翻译结果由 build.py 缓存到 assets/naming-map.json，可人工复核/修改。
"""
import json
import os
import re
import sys
import threading
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG = os.path.join(ROOT, "tools", "config.json")

DEFAULT_MODEL_URL = "https://argos-net.com/v1/translate-zh_en-1_9.argosmodel"


def _load_config():
    cfg = {
        "lib_dir": "",
        "model_dir": os.path.join(ROOT, "tools", "translate_models"),
        "model_url": DEFAULT_MODEL_URL,
    }
    try:
        with open(CONFIG, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg.update(loaded)
    except Exception:
        pass
    for _k in ("model_dir", "lib_dir"):
        _v = cfg.get(_k)
        if _v:
            _v = os.path.expanduser(_v)
            if not os.path.isabs(_v):
                _v = os.path.join(ROOT, _v)
            cfg[_k] = _v
    return cfg


_CFG = _load_config()

if _CFG.get("lib_dir"):
    _lib = _CFG["lib_dir"]
    if os.path.isdir(_lib) and _lib not in sys.path:
        sys.path.insert(0, _lib)

_MODEL_DIR = os.path.abspath(_CFG.get("model_dir") or os.path.join(ROOT, "tools", "translate_models"))
_SP_PATH = os.path.join(_MODEL_DIR, "zh_en", "sentencepiece.model")
_MODEL_PATH = os.path.join(_MODEL_DIR, "zh_en", "model")

_translator = None
_sp = None
_lock = threading.Lock()


def _download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def _ensure_model():
    if os.path.isfile(_SP_PATH) and os.path.isfile(os.path.join(_MODEL_PATH, "model.bin")):
        return
    url = _CFG.get("model_url") or DEFAULT_MODEL_URL
    os.makedirs(_MODEL_DIR, exist_ok=True)
    tmp = os.path.join(_MODEL_DIR, "zh_en.argosmodel")
    print(f"[translate] 首次使用：下载模型 {url}")
    _download(url, tmp)
    print("[translate] 解压模型 ...")
    with zipfile.ZipFile(tmp) as z:
        sp_member = next(n for n in z.namelist() if n.endswith("/sentencepiece.model"))
        root = sp_member.rsplit("/", 2)[0]
        z.extractall(_MODEL_DIR)
    src_root = os.path.join(_MODEL_DIR, root)
    import shutil
    os.makedirs(_MODEL_PATH, exist_ok=True)
    for fn in os.listdir(os.path.join(src_root, "model")):
        shutil.copy2(os.path.join(src_root, "model", fn), os.path.join(_MODEL_PATH, fn))
    shutil.copy2(os.path.join(src_root, "sentencepiece.model"), _SP_PATH)
    shutil.rmtree(src_root, ignore_errors=True)
    try:
        os.remove(tmp)
    except OSError:
        pass
    print("[translate] 模型就绪:", _MODEL_PATH)


def _get():
    global _translator, _sp
    if _translator is None:
        with _lock:
            if _translator is None:
                try:
                    import ctranslate2
                    import sentencepiece as spm
                except ImportError as e:
                    raise SystemExit(
                        "缺少翻译依赖，请先安装：pip install ctranslate2 sentencepiece"
                    ) from e
                _ensure_model()
                _sp = spm.SentencePieceProcessor(model_file=_SP_PATH)
                _translator = ctranslate2.Translator(_MODEL_PATH, compute_type="int8")
    return _translator, _sp


def translate(text):
    """中文 -> 英文短语（本地离线推理）。"""
    if not text or not text.strip():
        return ""
    tr, sp = _get()
    tokens = sp.encode(text, out_type=str)
    hyp = tr.translate_batch([tokens], beam_size=4)[0].hypotheses[0]
    s = sp.decode(hyp)
    s = s.replace("\u2581", " ").replace("\u2582", " ").strip()
    s = re.sub(r"\s+", " ", s)
    return s.strip(" .。，,;；")


def slugify(phrase):
    """英文短语 -> 小写连字符 slug（保留 . 以便 M2.5 之类尺寸）。"""
    phrase = (phrase or "").lower()
    phrase = re.sub(r"[^a-z0-9.\-]+", "-", phrase)
    phrase = re.sub(r"\-{2,}", "-", phrase)
    return phrase.strip(".-")


def to_slug(text):
    return slugify(translate(text))


def display_name(slug):
    if not slug:
        return "Untitled"
    return " ".join(w.capitalize() for w in slug.split("-"))


if __name__ == "__main__":
    for arg in sys.argv[1:]:
        try:
            en = translate(arg)
            print(f"{arg}  ->  {en}  ->  {slugify(en)}  ({display_name(slugify(en))})")
        except Exception as e:
            print(f"{arg}  ERR  {e}")