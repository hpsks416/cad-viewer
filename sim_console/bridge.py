# -*- coding: utf-8 -*-
"""仿真器浏览器控制台桥接：连 daedalus 的 TCP 图像流 + 控制端口 + 3D 状态流，
在浏览器里显示相机画面（MJPEG）、3D 骨架场景，并转发控制指令。

daedalus 协议（见 simulator_source/.../API.md + state_stream.rs）：
  TCP 7666：40 字节大端帧头 + JPEG
  TCP 7667：文本控制指令（GIMBAL / FIRE / RESET / GYRO / DART / GIMBAL_VISION）
  TCP 7670：每帧一行 JSON 的 3D 场景状态（vehicle/camera/armors/projectiles）

用法：
  python sim_console/bridge.py                       # 连本机，网页开 8124
  python sim_console/bridge.py --sim-host 192.168.1.100
  浏览器打开 http://127.0.0.1:8124/          （控制台：相机画面 + 指令）
                 http://127.0.0.1:8124/scene.html  （3D 骨架场景）
"""
import argparse
import json
import os
import socket
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'simulator-config.json')

HEADER = struct.Struct('>4sIIIIQIff')  # 40 字节大端帧头
MAGIC = b'DAED'

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.glb': 'model/gltf-binary',
}


def find_vehicle_glb():
    """定位 daedalus 的整车模型 vehicle.glb（armor_chassis 场景用）。"""
    import glob
    pattern = os.path.join(
        HERE, '..', '..', '..', 'simulator_source', 'daedalus-*',
        'simulator', 'src', 'assets', 'vehicle.glb',
    )
    matches = glob.glob(pattern)
    return matches[0] if matches else None


class FrameStore:
    """线程安全的「最新一帧」缓存 + 连接状态。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._frame = None
        self._meta = {}
        self._connected = False

    def set(self, jpeg, meta):
        with self._lock:
            self._frame = jpeg
            self._meta = meta
            self._connected = True

    def disconnected(self):
        with self._lock:
            self._connected = False

    def get(self):
        with self._lock:
            return self._frame, dict(self._meta)

    def is_connected(self):
        with self._lock:
            return self._connected


class StateStore:
    """线程安全的「最新场景状态」缓存（一行 JSON 字符串）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._line = None

    def set(self, line):
        with self._lock:
            self._line = line

    def get(self):
        with self._lock:
            return self._line


class ImageClient(threading.Thread):
    """连 daedalus 7666，持续读帧写入 FrameStore，断开自动重连。"""

    def __init__(self, host, port, store):
        super().__init__(daemon=True)
        self.host = host
        self.port = port
        self.store = store

    def run(self):
        while True:
            try:
                self._loop()
            except Exception as e:
                print(f'[bridge] image stream disconnected: {e}, retry in 3s', flush=True)
                self.store.disconnected()
            time.sleep(3)

    def _loop(self):
        with socket.create_connection((self.host, self.port), timeout=10) as s:
            s.settimeout(5)
            buf = b''
            while True:
                while len(buf) < HEADER.size:
                    chunk = s.recv(HEADER.size - len(buf))
                    if not chunk:
                        raise ConnectionError('eof')
                    buf += chunk
                if buf[:4] != MAGIC:
                    buf = buf[1:]
                    continue
                hdr = HEADER.unpack(buf[:HEADER.size])
                version, width, height, payload_len = hdr[1], hdr[2], hdr[3], hdr[4]
                ts, seq, yaw, pitch = hdr[5], hdr[6], hdr[7], hdr[8]
                buf = buf[HEADER.size:]
                while len(buf) < payload_len:
                    chunk = s.recv(payload_len - len(buf))
                    if not chunk:
                        raise ConnectionError('eof')
                    buf += chunk
                jpeg = buf[:payload_len]
                buf = buf[payload_len:]
                self.store.set(jpeg, {'version': version, 'width': width, 'height': height,
                                      'ts': ts, 'seq': seq, 'yaw': yaw, 'pitch': pitch})


class StateClient(threading.Thread):
    """连 daedalus 7670，按行读 3D 场景状态，存最新一行。"""

    def __init__(self, host, port, store):
        super().__init__(daemon=True)
        self.host = host
        self.port = port
        self.store = store

    def run(self):
        while True:
            try:
                with socket.create_connection((self.host, self.port), timeout=10) as s:
                    s.settimeout(5)
                    buf = b''
                    while True:
                        chunk = s.recv(4096)
                        if not chunk:
                            raise ConnectionError('eof')
                        buf += chunk
                        while b'\n' in buf:
                            line, buf = buf.split(b'\n', 1)
                            if line.strip():
                                self.store.set(line.decode('utf-8', errors='replace'))
            except Exception as e:
                print(f'[bridge] state stream disconnected: {e}, retry in 3s', flush=True)
            time.sleep(3)


class CommandClient:
    """向 daedalus 7667 发控制指令（持久连接 + 自动重连）。"""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self._lock = threading.Lock()
        self._sock = None

    def send(self, line):
        line = line.strip()
        if not line:
            return False, 'empty command'
        with self._lock:
            try:
                if self._sock is None:
                    self._sock = socket.create_connection((self.host, self.port), timeout=3)
                self._sock.sendall((line + '\n').encode('utf-8'))
                return True, line
            except Exception as e:
                self._sock = None
                return False, str(e)


def main():
    ap = argparse.ArgumentParser(description='daedalus simulator browser console bridge')
    ap.add_argument('--sim-host', default='127.0.0.1')
    ap.add_argument('--sim-port', type=int, default=7666)
    ap.add_argument('--cmd-port', type=int, default=7667)
    ap.add_argument('--state-port', type=int, default=7670)
    ap.add_argument('--port', type=int, default=8124)
    a = ap.parse_args()

    store = FrameStore()
    state_store = StateStore()
    cmds = CommandClient(a.sim_host, a.cmd_port)
    ImageClient(a.sim_host, a.sim_port, store).start()
    StateClient(a.sim_host, a.state_port, state_store).start()

    vehicle_glb = find_vehicle_glb()
    if vehicle_glb:
        print(f'[bridge] vehicle model: {vehicle_glb}', flush=True)
    else:
        print('[bridge] warning: vehicle.glb not found, 3D scene will show markers only', flush=True)

    class Handler(BaseHTTPRequestHandler):
        def _json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            path = self.path.split('?')[0]
            if path == '/stream':
                self.send_response(200)
                self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
                self.end_headers()
                try:
                    while True:
                        jpeg, _ = store.get()
                        if jpeg:
                            self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\n')
                            self.wfile.write(b'Content-Length: ' + str(len(jpeg)).encode() + b'\r\n\r\n')
                            self.wfile.write(jpeg)
                            self.wfile.write(b'\r\n')
                        time.sleep(0.03)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if path == '/api/status':
                _, meta = store.get()
                meta['connected'] = store.is_connected()
                self._json(200, meta)
                return
            if path == '/api/config':
                try:
                    with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                        self._json(200, json.load(f))
                except Exception:
                    self._json(200, {})
                return
            if path == '/api/scene':
                line = state_store.get()
                if line is None:
                    self._json(200, {'ready': False})
                else:
                    body = line.encode('utf-8')
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json; charset=utf-8')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                return
            if path == '/models/vehicle.glb':
                if vehicle_glb and os.path.isfile(vehicle_glb):
                    with open(vehicle_glb, 'rb') as f:
                        body = f.read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'model/gltf-binary')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                else:
                    self.send_error(404)
                return
            # 静态文件：sim_console/ 下；/lib/* → cad-viewer 的 lib/；/cviewer-models/* → cad-viewer 的 models/
            rel = 'index.html' if path == '/' else path.lstrip('/')
            if rel.startswith('lib/'):
                base = os.path.normpath(os.path.join(HERE, '..'))
                full = os.path.normpath(os.path.join(base, rel))
            elif rel.startswith('cviewer-models/'):
                base = os.path.normpath(os.path.join(HERE, '..', 'models'))
                full = os.path.normpath(os.path.join(base, rel[len('cviewer-models/'):]))
            else:
                base = os.path.normpath(HERE)
                full = os.path.normpath(os.path.join(base, rel))
            if not os.path.isfile(full) or not full.startswith(base + os.sep):
                self.send_error(404)
                return
            with open(full, 'rb') as f:
                body = f.read()
            ext = os.path.splitext(full)[1].lower()
            self.send_response(200)
            self.send_header('Content-Type', CONTENT_TYPES.get(ext, 'application/octet-stream'))
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            path = self.path.split('?')[0]
            if path == '/api/config':
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b'{}'
                try:
                    data = json.loads(raw.decode('utf-8'))
                    tmp = CONFIG_PATH + '.tmp'
                    with open(tmp, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False, indent=2)
                    os.replace(tmp, CONFIG_PATH)
                    self._json(200, {'ok': True})
                except Exception as e:
                    self._json(500, {'ok': False, 'error': str(e)})
                return
            if path == '/api/command':
                length = int(self.headers.get('Content-Length') or 0)
                raw = self.rfile.read(length) if length else b'{}'
                try:
                    data = json.loads(raw.decode('utf-8'))
                except Exception:
                    data = {}
                cmd = str(data.get('cmd', '')).strip()
                ok, msg = cmds.send(cmd)
                self._json(200 if ok else 500, {'ok': ok, 'cmd': cmd, 'msg': msg})
                return
            self._json(404, {'error': 'not found'})

        def log_message(self, *args):
            return

    httpd = ThreadingHTTPServer(('127.0.0.1', a.port), Handler)
    print(f'[bridge] image {a.sim_host}:{a.sim_port}  command {a.sim_host}:{a.cmd_port}  state {a.sim_host}:{a.state_port}', flush=True)
    print(f'[bridge] console http://127.0.0.1:{a.port}/   scene http://127.0.0.1:{a.port}/scene.html', flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
