#!/usr/bin/env python3
"""Ghost virtual computer: the proxy inside the machine.

The machine has no network card. Programs reach the network through this proxy, which hands each
connection to Ghost over a serial channel (frame format: src/main/ghost/vm/mux.js). Ghost decides
whether the connection is allowed and which route it takes (Tor, direct with encrypted DNS, or none).

  127.0.0.1:9050   SOCKS5 (CONNECT only; names are sent to Ghost, never resolved here)
  127.0.0.1:3128   HTTP proxy (CONNECT, and plain http requests)
"""
import argparse, asyncio, os, socket, struct

OPEN, DATA, CLOSE, OK, ERR = 1, 2, 3, 4, 5
MAXP = 16 * 1024


class Mux:
    def __init__(self, loop, spec):
        self.loop, self.spec, self.next, self.conns = loop, spec, 1, {}
        self.buf = b''; self.fd = None; self.writer = None; self.out = b''

    async def open(self):
        if self.spec.startswith('unix:'):
            self.reader, self.writer = await asyncio.open_unix_connection(self.spec[5:])
            self.loop.create_task(self._pump())
        else:
            self.fd = os.open(self.spec, os.O_RDWR | os.O_NONBLOCK)
            self.loop.add_reader(self.fd, self._readable)

    async def _pump(self):
        while True:
            d = await self.reader.read(65536)
            if not d:
                self.fail_all(); return
            self._feed(d)

    def _readable(self):
        try:
            d = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            d = b''
        if not d:
            self.loop.remove_reader(self.fd); self.fail_all(); return
        self._feed(d)

    def _feed(self, d):
        self.buf += d
        while len(self.buf) >= 7:
            t, c, n = struct.unpack('>BIH', self.buf[:7])
            if len(self.buf) < 7 + n:
                return
            payload, self.buf = self.buf[7:7 + n], self.buf[7 + n:]
            cn = self.conns.get(c)
            if cn is not None:
                cn.on_frame(t, payload)

    def fail_all(self):
        for cn in list(self.conns.values()):
            cn.on_frame(ERR, b'The connection to Ghost was lost.')

    def send(self, t, c, payload=b''):
        data = struct.pack('>BIH', t, c, len(payload)) + payload
        if self.writer is not None:
            self.writer.write(data); return
        self.out += data
        self._flush()

    def _flush(self):
        while self.out:
            try:
                n = os.write(self.fd, self.out)
            except BlockingIOError:
                self.loop.add_writer(self.fd, self._wcb); return
            except OSError:
                self.out = b''; return
            self.out = self.out[n:]

    def _wcb(self):
        self.loop.remove_writer(self.fd); self._flush()


class Conn:
    """One proxied connection. open() resolves to (True, '') or (False, reason)."""

    def __init__(self, mux):
        self.mux = mux; self.id = mux.next; mux.next = (mux.next % 0xFFFFFFFF) + 1
        mux.conns[self.id] = self
        self.fut = asyncio.get_running_loop().create_future(); self.q = asyncio.Queue(); self.closed = False

    def on_frame(self, t, p):
        if t == OK and not self.fut.done(): self.fut.set_result((True, ''))
        elif t == ERR:
            if not self.fut.done(): self.fut.set_result((False, p.decode('utf8', 'replace')))
            self.q.put_nowait(None)
        elif t == DATA: self.q.put_nowait(p)
        elif t == CLOSE: self.q.put_nowait(None)

    async def open(self, host, port):
        h = '[%s]' % host if ':' in host else host
        self.mux.send(OPEN, self.id, ('%s:%d' % (h, port)).encode())
        return await self.fut

    def write(self, data):
        for i in range(0, len(data), MAXP):
            self.mux.send(DATA, self.id, data[i:i + MAXP])

    def close(self):
        if not self.closed:
            self.closed = True; self.mux.send(CLOSE, self.id); self.mux.conns.pop(self.id, None)


async def relay(conn, reader, writer, first=b''):
    async def up():
        try:
            if first: conn.write(first)
            while True:
                d = await reader.read(MAXP)
                if not d: break
                conn.write(d)
        except Exception:
            pass
        conn.close()
    async def down():
        try:
            while True:
                d = await conn.q.get()
                if d is None: break
                writer.write(d); await writer.drain()
        except Exception:
            pass
        try: writer.close()
        except Exception: pass
    await asyncio.gather(up(), down())
    conn.close()


async def socks(mux, reader, writer):
    try:
        h = await reader.readexactly(2)
        if h[0] != 5: writer.close(); return
        await reader.readexactly(h[1]); writer.write(b'\x05\x00')
        r = await reader.readexactly(4)
        if r[1] != 1: writer.write(b'\x05\x07\x00\x01\0\0\0\0\0\0'); writer.close(); return
        if r[3] == 1: host = socket.inet_ntoa(await reader.readexactly(4))
        elif r[3] == 4: host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
        elif r[3] == 3:
            n = (await reader.readexactly(1))[0]; host = (await reader.readexactly(n)).decode('ascii', 'replace')
        else: writer.close(); return
        port = struct.unpack('>H', await reader.readexactly(2))[0]
    except Exception:
        try: writer.close()
        except Exception: pass
        return
    c = Conn(mux)
    ok, why = await c.open(host, port)
    if not ok:
        writer.write(b'\x05\x02\x00\x01\0\0\0\0\0\0'); writer.close(); c.close(); return
    writer.write(b'\x05\x00\x00\x01\0\0\0\0\0\0')
    await relay(c, reader, writer)


async def http(mux, reader, writer):
    try:
        head = await reader.readuntil(b'\r\n\r\n')
    except Exception:
        writer.close(); return
    line, _, rest = head.partition(b'\r\n')
    parts = line.split(b' ')
    if len(parts) != 3:
        writer.close(); return
    method, target, ver = parts
    def deny(msg):
        body = ('Ghost: ' + msg + '\n').encode()
        writer.write(b'HTTP/1.1 403 Forbidden\r\nContent-Length: %d\r\nConnection: close\r\n\r\n' % len(body) + body); writer.close()
    if method == b'CONNECT':
        host, _, port = target.decode('ascii', 'replace').rpartition(':')
        host = host.strip('[]')
        if not port.isdigit(): return deny('bad address')
        c = Conn(mux); ok, why = await c.open(host, int(port))
        if not ok: c.close(); return deny(why)
        writer.write(b'HTTP/1.1 200 Connection established\r\n\r\n')
        await relay(c, reader, writer); return
    t = target.decode('ascii', 'replace')
    if not t.startswith('http://'):
        return deny('only absolute http:// requests are proxied')
    rest_url = t[7:]; hostport, _, path = rest_url.partition('/')
    host, _, port = hostport.partition(':')
    c = Conn(mux); ok, why = await c.open(host, int(port or 80))
    if not ok: c.close(); return deny(why)
    # one request per connection: ask the server to close it
    lines = [l for l in rest.split(b'\r\n') if l and not l.lower().startswith((b'proxy-connection:', b'connection:'))]
    req = b'%s /%s %s\r\n' % (method, path.encode(), ver) + b'\r\n'.join(lines) + b'\r\nConnection: close\r\n\r\n'
    await relay(c, reader, writer, first=req)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channel', default='/dev/virtio-ports/org.mayfair.ghost.net')
    ap.add_argument('--socks', type=int, default=9050)
    ap.add_argument('--http', type=int, default=3128)
    ap.add_argument('--bind', default='127.0.0.1')
    a = ap.parse_args()
    loop = asyncio.get_running_loop()
    mux = Mux(loop, a.channel)
    while True:
        try:
            await mux.open(); break
        except OSError:
            await asyncio.sleep(0.5)
    s1 = await asyncio.start_server(lambda r, w: socks(mux, r, w), a.bind, a.socks)
    s2 = await asyncio.start_server(lambda r, w: http(mux, r, w), a.bind, a.http)
    print('ready', flush=True)
    async with s1, s2:
        await asyncio.gather(s1.serve_forever(), s2.serve_forever())


if __name__ == '__main__':
    asyncio.run(main())
