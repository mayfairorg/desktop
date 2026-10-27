# Ghost terminal helper (POSIX, standard library only). Gives the shell a real terminal when node-pty is not available.
# Started by backend.js with: python3 -I -c <this file> COLS ROWS SHELL ARGS...   fd 3 receives lines "R cols rows" (resize).
import os,sys,pty,select,fcntl,termios,struct,signal,errno
cols,rows=int(sys.argv[1]),int(sys.argv[2]);argv=sys.argv[3:]
pid,fd=pty.fork()
if pid==0:
 try: fcntl.ioctl(0,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,0,0))
 except Exception: pass
 os.execvp(argv[0],argv)
 os._exit(127)
def bye(*a):
 try: os.killpg(pid,signal.SIGHUP)
 except Exception: pass
 try: os.kill(pid,signal.SIGHUP)
 except Exception: pass
 os._exit(129)
signal.signal(signal.SIGTERM,bye);signal.signal(signal.SIGHUP,bye);signal.signal(signal.SIGPIPE,signal.SIG_DFL)
ctl=b""
ins=[0,fd,3]
while True:
 try: r,_,_=select.select(ins,[],[])
 except InterruptedError: continue
 if 3 in r:
  d=os.read(3,4096)
  if not d: ins.remove(3)
  else:
   ctl+=d
   while b"\n" in ctl:
    l,ctl=ctl.split(b"\n",1);p=l.split()
    if len(p)==3 and p[0]==b"R":
     try: fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",int(p[2]),int(p[1]),0,0));os.killpg(pid,signal.SIGWINCH)
     except Exception: pass
 if 0 in r:
  d=os.read(0,65536)
  if not d: bye()
  os.write(fd,d)
 if fd in r:
  try: d=os.read(fd,65536)
  except OSError: d=b""
  if not d: break
  os.write(1,d)
try: _,st=os.waitpid(pid,0)
except Exception: st=0
os._exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 128+os.WTERMSIG(st))
