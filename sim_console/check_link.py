# -*- coding: utf-8 -*-
"""检查 daedalus 仿真器链路：连 7666 读一帧 + 连 7667 确认控制端口。

用法：
  python sim_console/check_link.py               # 连 127.0.0.1
  python sim_console/check_link.py --host <ip>
"""
import argparse
import socket
import struct
import time

HEADER = struct.Struct('>4sIIIIQIff')
MAGIC = b'DAED'


def check_image(host, port, timeout=10):
    s = socket.create_connection((host, port), timeout=timeout)
    s.settimeout(timeout)
    try:
        buf = b''
        while len(buf) < HEADER.size:
            chunk = s.recv(HEADER.size - len(buf))
            if not chunk:
                return False, 'connection closed before header'
            buf += chunk
        deadline = time.time() + timeout
        while buf[:4] != MAGIC:
            if time.time() > deadline:
                return False, 'magic DAED not found'
            chunk = s.recv(1)
            if not chunk:
                return False, 'connection closed while syncing'
            buf = buf[1:] + chunk
        hdr = HEADER.unpack(buf[:HEADER.size])
        version, width, height, payload_len = hdr[1], hdr[2], hdr[3], hdr[4]
        yaw, pitch = hdr[7], hdr[8]
        # 读完整帧（确认 JPEG 负载也到了）
        buf = buf[HEADER.size:]
        while len(buf) < payload_len:
            chunk = s.recv(payload_len - len(buf))
            if not chunk:
                return False, 'connection closed mid-frame'
            buf += chunk
        return True, f'version={version} {width}x{height} jpeg={payload_len}B gimbal_yaw={yaw:.3f} pitch={pitch:.3f}'
    finally:
        s.close()


def check_command(host, port, timeout=5):
    s = socket.create_connection((host, port), timeout=timeout)
    s.close()
    return True, 'port open'


def main():
    ap = argparse.ArgumentParser(description='check daedalus simulator link')
    ap.add_argument('--host', default='127.0.0.1')
    ap.add_argument('--image-port', type=int, default=7666)
    ap.add_argument('--cmd-port', type=int, default=7667)
    a = ap.parse_args()

    print(f'checking daedalus @ {a.host} ...')
    ok = True
    try:
        good, msg = check_image(a.host, a.image_port)
        print(f'  image {a.image_port}: {"OK " if good else "FAIL"} ({msg})')
        ok = ok and good
    except Exception as e:
        print(f'  image {a.image_port}: FAIL ({e})')
        ok = False
    try:
        good, msg = check_command(a.host, a.cmd_port)
        print(f'  command {a.cmd_port}: {"OK " if good else "FAIL"} ({msg})')
        ok = ok and good
    except Exception as e:
        print(f'  command {a.cmd_port}: FAIL ({e})')
        ok = False
    print('LINK OK' if ok else 'LINK NOT READY (start daedalus simulator first)')


if __name__ == '__main__':
    main()
