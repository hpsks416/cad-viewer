#!/usr/bin/env python3
"""Local crates.io mirror (sparse index + crate downloads) over plain HTTP.

Why: inside the Codex Windows sandbox, Cargo's schannel backend cannot acquire
credentials (SEC_E_NO_CREDENTIALS), so it cannot speak HTTPS to crates.io.
Python uses its bundled OpenSSL and CAN reach crates.io through the proxy.

Cargo talks plain HTTP to this local server; this server talks HTTPS upstream
on Cargo's behalf. Configure Cargo with:

    [source.crates-io]
    replace-with = "mirror"
    [source.mirror]
    registry = "sparse+http://127.0.0.1:8124/"

Usage: python tools/crates_mirror.py [port]
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen

INDEX = "https://index.crates.io"
CRATES = "https://static.crates.io/crates"

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8124


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _upstream(self, url: str, ctype: str):
        req = Request(url, headers={"User-Agent": "crates-mirror/1.0"})
        with urlopen(req, timeout=120) as resp:
            data = resp.read()
        self._send(200, data, ctype)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path == "/config.json":
                body = json.dumps({
                    "dl": f"http://127.0.0.1:{PORT}/dl",
                    "api": "https://crates.io",
                }).encode("utf-8")
                self._send(200, body, "application/json")
                return
            if path.startswith("/dl/"):
                rest = path[len("/dl/"):].lstrip("/")
                self._upstream(f"{CRATES}/{rest}", "application/octet-stream")
                return
            # sparse index entry
            self._upstream(f"{INDEX}{path}", "application/json")
        except Exception as e:  # noqa: BLE001
            body = json.dumps({"error": str(e)}).encode("utf-8")
            self._send(500, body, "application/json")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"crates mirror listening on http://127.0.0.1:{PORT}/", flush=True)
    srv.serve_forever()
