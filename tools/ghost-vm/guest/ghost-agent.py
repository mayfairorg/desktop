#!/usr/bin/env python3
"""Ghost virtual computer: the control agent that runs inside the machine.

Talks to Ghost over one serial channel, one JSON object per line (see src/main/ghost/vm/agent.js).
It starts terminals and argv-only commands as the unprivileged user, copies files into the tools
area, mounts the shared folder and the tools disk, and powers the machine off when asked.
It never runs a shell string it was not given as a plain argument array.
"""
import argparse, asyncio, base64, errno, fcntl, json, os, pwd, shutil, signal, struct, subprocess, sys, termios

VERSION = 1
ALLOWED = ['/opt/ghost-tools/', '/home/ghost/']
PROXY_ENV = {
    'http_proxy': 'http://127.0.0.1:3128', 'https_proxy': 'http://127.0.0.1:3128',
    'HTTP_PROXY': 'http://127.0.0.1:3128', 'HTTPS_PROXY': 'http://127.0.0.1:3128',
    'ALL_PROXY': 'socks5h://127.0.0.1:9050', 'all_proxy': 'socks5h://127.0.0.1:9050',
    'NO_PROXY': 'localhost,127.0.0.1,::1', 'no_proxy': 'localhost,127.0.0.1,::1',
}


def cmdline_value(key):
    try:
        for part in open('/proc/cmdline').read().split():
            if part.startswith(key + '='):
                return part[len(key) + 1:]
    except OSError:
        pass
    return ''


class Chan:
    """Line channel over a unix socket (tests) or a virtio serial character device."""

    def __init__(self, loop, spec):
        self.loop, self.spec, self.buf, self.q = loop, spec, b'', asyncio.Queue()
        self.fd = None; self.writer = None; self.out = b''

    async def open(self):
        if self.spec.startswith('unix:'):
            r, w = await asyncio.open_unix_connection(self.spec[5:])
            self.reader, self.writer = r, w
        else:
            self.fd = os.open(self.spec, os.O_RDWR | os.O_NONBLOCK)
            self.loop.add_reader(self.fd, self._readable)

    def _readable(self):
        try:
            d = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            d = b''
        if not d:
            self.loop.remove_reader(self.fd); self.q.put_nowait(None); return
        self.buf += d
        while b'\n' in self.buf:
            line, self.buf = self.buf.split(b'\n', 1)
            self.q.put_nowait(line)

    async def readline(self):
        if self.writer is not None:
            line = await self.reader.readline()
            return line.rstrip(b'\n') if line else None
        return await self.q.get()

    def write(self, data):
        if self.writer is not None:
            self.writer.write(data); return
        self.out += data
        self._flush()

    def _flush(self):
        while self.out:
            try:
                n = os.write(self.fd, self.out)
            except BlockingIOError:
                self.loop.add_writer(self.fd, self._flush_cb); return
            except OSError:
                self.out = b''; return
            self.out = self.out[n:]

    def _flush_cb(self):
        self.loop.remove_writer(self.fd); self._flush()


class Agent:
    def __init__(self, loop, chan, token, user, prefixes):
        self.loop, self.chan, self.token, self.user, self.prefixes = loop, chan, token, user, prefixes
        self.shells, self.execs = {}, {}
        self.pw = pwd.getpwnam(user) if user else None

    def send(self, obj):
        self.chan.write((json.dumps(obj, separators=(',', ':')) + '\n').encode())

    def ack(self, rid, ok=True, err=''):
        self.send({'ev': 'ack', 'rid': rid, 'ok': ok, **({} if ok else {'err': str(err)[:300]})})

    def env(self, extra=None):
        home = self.pw.pw_dir if self.pw else os.path.expanduser('~')
        e = {'HOME': home, 'USER': self.user or os.environ.get('USER', ''), 'LOGNAME': self.user or '', 'LANG': 'C.UTF-8',
             'TERM': 'xterm-256color', 'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/ghost-tools/bin',
             'GHOST_TOOLS': '/opt/ghost-tools', 'GHOST_SHARE': '/mnt/shared', 'GIT_TERMINAL_PROMPT': '0',
             'PIP_DISABLE_PIP_VERSION_CHECK': '1', 'PYTHONUNBUFFERED': '1', 'PIPX_HOME': home + '/.local/pipx',
             'GOPATH': home + '/go', 'CARGO_HOME': home + '/.cargo', 'RUSTUP_HOME': home + '/.rustup', 'NPM_CONFIG_UPDATE_NOTIFIER': 'false'}
        e.update(PROXY_ENV)
        if extra:
            for k, v in extra.items():
                if isinstance(k, str) and isinstance(v, str) and k.replace('_', '').isalnum():
                    e[k] = v
        return e

    def drop(self):
        if not self.pw:
            return None
        uid, gid = self.pw.pw_uid, self.pw.pw_gid
        def fn():
            os.setgroups([]); os.setgid(gid); os.setuid(uid)
        return fn

    def safe_path(self, p):
        if not isinstance(p, str) or not p.startswith('/') or '\0' in p:
            return None
        n = os.path.normpath(p)
        if n != p.rstrip('/') and n != p:
            return None
        for pre in self.prefixes:
            if (n + '/').startswith(pre) and n + '/' != pre:
                return n
        return None

    # ---- terminals ----
    def start_shell(self, m):
        import pty
        sid = m['sid']
        cols, rows = int(m.get('cols') or 100), int(m.get('rows') or 30)
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
        drop = self.drop()
        cwd = m.get('cwd') or (self.pw.pw_dir if self.pw else None)
        if cwd and not os.path.isdir(cwd):
            cwd = None
        def pre():
            os.setsid(); fcntl.ioctl(0, termios.TIOCSCTTY, 0)
            if drop: drop()
        sh = shutil.which('bash') or '/bin/sh'
        argv = [sh, '-l'] if os.path.basename(sh) == 'bash' else [sh]
        proc = subprocess.Popen(argv, stdin=slave, stdout=slave, stderr=slave, preexec_fn=pre, env=self.env(), cwd=cwd, close_fds=True)
        os.close(slave)
        os.set_blocking(master, False)
        st = {'proc': proc, 'master': master, 'paused': False}
        self.shells[sid] = st
        self.loop.add_reader(master, self.shell_readable, sid)
        self.loop.create_task(self.wait_shell(sid))

    def shell_readable(self, sid):
        st = self.shells.get(sid)
        if not st:
            return
        try:
            d = os.read(st['master'], 65536)
        except BlockingIOError:
            return
        except OSError:
            d = b''
        if not d:
            self.loop.remove_reader(st['master']); return
        self.send({'ev': 'data', 'sid': sid, 'b64': base64.b64encode(d).decode()})

    async def wait_shell(self, sid):
        st = self.shells[sid]
        code = await self.loop.run_in_executor(None, st['proc'].wait)
        await asyncio.sleep(0.1)
        self.shell_readable(sid)
        try:
            self.loop.remove_reader(st['master']); os.close(st['master'])
        except Exception:
            pass
        self.shells.pop(sid, None)
        self.send({'ev': 'exit', 'sid': sid, 'code': code if code >= 0 else None, 'signal': signal.Signals(-code).name if code < 0 else None})

    # ---- commands ----
    async def run_exec(self, m):
        xid = m['xid']; argv = m['argv']
        cwd = m.get('cwd') if isinstance(m.get('cwd'), str) and os.path.isdir(m.get('cwd')) else (self.pw.pw_dir if self.pw else None)
        drop = self.drop()
        try:
            p = await asyncio.create_subprocess_exec(*argv, cwd=cwd, env=self.env(m.get('env')), stdin=asyncio.subprocess.DEVNULL,
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True,
                                                     preexec_fn=drop)
        except Exception as e:
            self.send({'ev': 'x-out', 'xid': xid, 'ch': 'e', 'b64': base64.b64encode(('cannot start: %s\n' % e).encode()).decode()})
            self.send({'ev': 'x-exit', 'xid': xid, 'code': 127}); return
        self.execs[xid] = p
        async def pump(stream, ch):
            while True:
                d = await stream.read(32768)
                if not d:
                    return
                self.send({'ev': 'x-out', 'xid': xid, 'ch': ch, 'b64': base64.b64encode(d).decode()})
        tasks = [asyncio.ensure_future(pump(p.stdout, 'o')), asyncio.ensure_future(pump(p.stderr, 'e'))]
        timeout = max(1, min(float(m.get('timeoutMs') or 60000) / 1000.0, 7200))
        try:
            await asyncio.wait_for(p.wait(), timeout)
        except asyncio.TimeoutError:
            self.kill_group(p)
            await p.wait()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.execs.pop(xid, None)
        rc = p.returncode
        self.send({'ev': 'x-exit', 'xid': xid, 'code': rc if rc >= 0 else None, 'signal': signal.Signals(-rc).name if rc < 0 else None})

    def kill_group(self, p):
        for sig in (signal.SIGTERM,):
            try:
                os.killpg(p.pid, sig)
            except ProcessLookupError:
                return
        def hard():
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.loop.call_later(0.8, hard)

    # ---- files and mounts ----
    def put(self, m):
        path = self.safe_path(m.get('path'))
        if not path:
            raise ValueError('path is not allowed')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        mode = 'ab' if m.get('append') else 'wb'
        with open(path, mode) as f:
            f.write(base64.b64decode(m.get('b64') or ''))
        os.chmod(path, int(m.get('mode') or 0o644) & 0o777)
        if self.pw:
            d = os.path.dirname(path)
            while (d + '/').startswith(tuple(self.prefixes)) and d + '/' not in self.prefixes:
                try: os.chown(d, self.pw.pw_uid, self.pw.pw_gid)
                except OSError: pass
                d = os.path.dirname(d)
            os.chown(path, self.pw.pw_uid, self.pw.pw_gid)

    def rm(self, m):
        path = self.safe_path(m.get('path'))
        if not path:
            raise ValueError('path is not allowed')
        shutil.rmtree(path, ignore_errors=False) if os.path.isdir(path) and not os.path.islink(path) else (os.remove(path) if os.path.lexists(path) else None)

    def mount(self, kind):
        uid = self.pw.pw_uid if self.pw else 0; gid = self.pw.pw_gid if self.pw else 0
        def run(*a): return subprocess.run(list(a), capture_output=True, text=True)
        if kind == '9p':
            os.makedirs('/mnt/shared', exist_ok=True)
            r = run('mount', '-t', '9p', '-o', 'trans=virtio,version=9p2000.L,msize=524288', 'ghost', '/mnt/shared')
        elif kind == 'fat':
            os.makedirs('/mnt/shared', exist_ok=True)
            dev = '/dev/vdb1' if os.path.exists('/dev/vdb1') else '/dev/vdb'
            r = run('mount', '-t', 'vfat', '-o', 'uid=%d,gid=%d' % (uid, gid), dev, '/mnt/shared')
        elif kind == 'tools':
            dev = '/dev/disk/by-id/virtio-ghosttools'
            if not os.path.exists(dev):
                raise OSError('there is no tools disk')
            if run('blkid', dev).returncode != 0:
                r = run('mkfs.ext4', '-q', '-L', 'ghosttools', dev)
                if r.returncode: raise OSError(r.stderr.strip() or 'mkfs failed')
            os.makedirs('/opt/ghost-tools', exist_ok=True)
            r = run('mount', dev, '/opt/ghost-tools')
            if r.returncode == 0:
                os.makedirs('/opt/ghost-tools/bin', exist_ok=True)
                os.chown('/opt/ghost-tools', uid, gid); os.chown('/opt/ghost-tools/bin', uid, gid)
        else:
            raise ValueError('unknown mount')
        if r.returncode:
            raise OSError((r.stderr or 'mount failed').strip()[:200])

    # ---- the loop ----
    async def handle(self, m):
        op, rid = m.get('op'), m.get('rid')
        try:
            if op == 'shell': self.start_shell(m); self.ack(rid)
            elif op == 'in':
                st = self.shells.get(m['sid'])
                if st: os.write(st['master'], base64.b64decode(m['b64']))
            elif op == 'resize':
                st = self.shells.get(m['sid'])
                if st:
                    fcntl.ioctl(st['master'], termios.TIOCSWINSZ, struct.pack('HHHH', int(m['rows']), int(m['cols']), 0, 0))
                    try: os.killpg(st['proc'].pid, signal.SIGWINCH)
                    except OSError: pass
            elif op == 'pause':
                st = self.shells.get(m['sid'])
                if st: self.loop.remove_reader(st['master'])
            elif op == 'resume':
                st = self.shells.get(m['sid'])
                if st: self.loop.add_reader(st['master'], self.shell_readable, m['sid'])
            elif op == 'close':
                st = self.shells.get(m['sid'])
                if st:
                    try: os.killpg(st['proc'].pid, signal.SIGHUP)
                    except OSError: pass
            elif op == 'exec': self.loop.create_task(self.run_exec(m))
            elif op == 'xkill':
                p = self.execs.get(m['xid'])
                if p: self.kill_group(p)
            elif op == 'put': self.put(m); self.ack(rid)
            elif op == 'rm': self.rm(m); self.ack(rid)
            elif op == 'mount': self.mount(m['kind']); self.ack(rid)
            elif op == 'ping': self.ack(rid)
            elif op == 'poweroff': subprocess.Popen(['poweroff'])
        except Exception as e:
            if rid is not None: self.ack(rid, False, e)

    async def serve(self):
        self.send({'ev': 'hello', 'token': self.token, 'version': VERSION})
        while True:
            line = await self.chan.readline()
            if line is None:
                return
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if isinstance(m, dict):
                await self.handle(m)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--channel', default='/dev/virtio-ports/org.mayfair.ghost.agent')
    ap.add_argument('--token', default=None)
    ap.add_argument('--user', default='ghost')
    ap.add_argument('--allow-prefix', action='append', default=None)
    a = ap.parse_args()
    loop = asyncio.get_running_loop()
    token = a.token or cmdline_value('ghost.token')
    chan = Chan(loop, a.channel)
    while True:
        try:
            await chan.open(); break
        except OSError:
            await asyncio.sleep(0.5)
    await Agent(loop, chan, token, a.user, a.allow_prefix or ALLOWED).serve()


if __name__ == '__main__':
    asyncio.run(main())
