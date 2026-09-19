# -*- coding: utf-8 -*-
"""本地服务器：静态文件 + 批量导出/转换 API。"""
import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(ROOT, "user_state.json")
sys.path.insert(0, os.path.join(ROOT, "tools"))

import build as pipeline

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/files":
            try:
                self._send(200, pipeline.inventory())
            except Exception as e:
                self._send(500, {"error": str(e)})
            return
        if path == "/api/state":
            try:
                if os.path.isfile(STATE_FILE):
                    with open(STATE_FILE, "r", encoding="utf-8") as f:
                        self._send(200, json.load(f))
                else:
                    self._send(200, {})
            except Exception:
                self._send(200, {})
            return
        if path == "/api/manifest":
            try:
                with open(os.path.join(ROOT, "models", "manifest.json"), encoding="utf-8") as f:
                    self._send(200, json.load(f))
            except Exception:
                self._send(200, {"title": "RoboMaster 作品", "models": []})
            return
        self._serve_static(path)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            data = {}

        if path == "/api/build":
            try:
                files = data.get("files") or None
                preview = bool(data.get("preview", True))
                res = pipeline.build(files=files, preview=preview)
                self._send(200, {"ok": True, "models": res["models"], "results": res["results"]})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
            return
        if path == "/api/translate":
            try:
                from translate_names import translate, slugify, display_name
                name = data.get("name", "")
                en = translate(name)
                s = slugify(en)
                self._send(200, {"translation": en, "slug": s, "name": display_name(s)})
            except Exception as e:
                self._send(500, {"error": str(e)})
            return
        if path == "/api/state":
            try:
                tmp = STATE_FILE + ".tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False)
                os.replace(tmp, STATE_FILE)
                self._send(200, {"ok": True})
            except Exception as e:
                self._send(500, {"ok": False, "error": str(e)})
            return
        self._send(404, {"error": "not found"})

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        rel = urllib.parse.unquote(path).lstrip("/")
        full = os.path.normpath(os.path.join(ROOT, rel))
        if not (full == ROOT or full.startswith(ROOT + os.sep)) or not os.path.isfile(full):
            self._send(404, {"error": "not found"})
            return
        ext = os.path.splitext(full)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self._send(200, body, ctype)

    def log_message(self, fmt, *args):
        return


def serve(port=8123, open_browser=True):
    if open_browser:
        import threading
        import webbrowser
        threading.Timer(1.0, lambda: webbrowser.open(f"http://127.0.0.1:{port}/")).start()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"服务已启动：http://127.0.0.1:{port}/ （Ctrl+C 停止）")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8123)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    serve(a.port, open_browser=not a.no_browser)