'use strict';
// Ghost virtual computer: the QEMU command line, built as an array (never a string, never a shell). Pure.
// What the machine does NOT have, on purpose: no network card (traffic goes only through Ghost's own gateway over a serial channel),
// no USB, no sound, no display or clipboard channel, no host devices, no host folder except the one share. `-nodefaults` removes
// everything QEMU adds by itself, and this file adds back only what is listed here.
const path = require('node:path');

const MIN = { memMb: 512, cpus: 1 }, MAX = { memMb: 8192, cpus: 4 };
const PORT_AGENT = 'org.mayfair.ghost.agent', PORT_NET = 'org.mayfair.ghost.net';
// QEMU option values treat a comma as the start of the next option: a comma inside a path is doubled, or it would inject options.
const esc = (v) => String(v).replace(/,/g, ',,');

function resources({ memMb, cpus, hostMemMb, hostCpus }) {
  const mem = Math.max(MIN.memMb, Math.min(MAX.memMb, Number.isFinite(memMb) ? Math.round(memMb) : 2048, Math.floor((hostMemMb || 4096) / 2)));
  const c = Math.max(MIN.cpus, Math.min(MAX.cpus, Number.isFinite(cpus) ? Math.round(cpus) : Math.max(1, Math.floor((hostCpus || 2) / 2))));
  return { memMb: mem, cpus: c };
}

// Machine, CPU and console by CPU family and accelerator.
function machine({ guest, accel }) {
  if (guest === 'x86_64') {
    const cpu = accel === 'kvm' || accel === 'hvf' ? 'host' : accel === 'tcg' ? 'max' : 'qemu64';
    return { machine: 'q35', cpu, console: 'ttyS0' };
  }
  if (guest === 'aarch64') {
    const cpu = accel === 'tcg' ? 'max' : 'host';
    return { machine: 'virt' + (accel === 'kvm' ? ',gic-version=host' : ''), cpu, console: 'ttyAMA0' };
  }
  throw new Error('Unsupported CPU family: ' + guest);
}

// share: null | {dir, mode: '9p'|'fat', readOnly?}. The mode is chosen by the host system: 9p exists in QEMU on Linux and macOS, not on Windows.
function shareMode(platform) { return platform === 'win32' ? 'fat' : '9p'; }

// opts: {platform, guest, dataDir, accel, memMb, cpus, kernel, initrd, baseDisk, overlay, keyFiles {root, tools} (a missing key: that disk is not encrypted), toolsDisk, share, token,
//        channels: {agent: {path}|{port}, net: {path}|{port}}, sandbox}
function buildArgv(o) {
  const m = machine(o);
  const a = [];
  a.push('-nodefaults', '-no-user-config', '-nic', 'none', '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-no-reboot');
  if (o.dataDir) a.push('-L', o.dataDir);              // the firmware files that come in the QEMU package (linuxboot_dma.bin is needed to start a kernel directly)
  if (o.sandbox && o.platform === 'linux') a.push('-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny');
  a.push('-machine', m.machine, '-accel', o.accel === 'tcg' ? 'tcg,thread=multi' : o.accel, '-cpu', m.cpu);
  a.push('-m', o.memMb + 'M', '-smp', String(o.cpus), '-rtc', 'base=utc');
  a.push('-object', 'rng-builtin,id=rng0', '-device', 'virtio-rng-pci,rng=rng0');
  // The base image is read-only and named explicitly: the overlay's own header is never trusted to say which file is behind it.
  a.push('-blockdev', 'driver=file,node-name=basef,filename=' + esc(o.baseDisk) + ',read-only=on');
  a.push('-blockdev', 'driver=qcow2,node-name=base,file=basef,read-only=on');
  a.push('-blockdev', 'driver=file,node-name=ovf,filename=' + esc(o.overlay));
  const keys = o.keyFiles || {};
  if (keys.root) {
    a.push('-object', 'secret,id=sec0,file=' + esc(keys.root));
    a.push('-blockdev', 'driver=qcow2,node-name=ovl,file=ovf,backing=base,encrypt.key-secret=sec0');
  } else a.push('-blockdev', 'driver=qcow2,node-name=ovl,file=ovf,backing=base');
  a.push('-device', 'virtio-blk-pci,drive=ovl,serial=ghostroot');
  if (o.toolsDisk) {       // the persistent tools disk: no backing image, survives a reset of the machine's own disk
    a.push('-blockdev', 'driver=file,node-name=tlf,filename=' + esc(o.toolsDisk));
    if (keys.tools) { a.push('-object', 'secret,id=sec1,file=' + esc(keys.tools)); a.push('-blockdev', 'driver=qcow2,node-name=tld,file=tlf,encrypt.key-secret=sec1'); } else a.push('-blockdev', 'driver=qcow2,node-name=tld,file=tlf');
    a.push('-device', 'virtio-blk-pci,drive=tld,serial=ghosttools');
  }
  if (o.share) {
    if (o.share.mode === '9p') {
      a.push('-fsdev', 'local,id=fs0,path=' + esc(o.share.dir) + ',security_model=' + (o.platform === 'linux' ? 'mapped-xattr' : 'none') + (o.share.readOnly ? ',readonly=on' : ''));
      a.push('-device', 'virtio-9p-pci,fsdev=fs0,mount_tag=ghost');
    } else {
      a.push('-drive', 'file=fat:' + (o.share.readOnly ? '' : 'rw:') + esc(o.share.dir) + ',format=raw,if=none,id=share');
      a.push('-device', 'virtio-blk-pci,drive=share,serial=ghostshare');
    }
  }
  a.push('-device', 'virtio-serial-pci,id=vs0');
  for (const [id, name] of [['agent', PORT_AGENT], ['net', PORT_NET]]) {
    const ch = o.channels[id];
    a.push('-chardev', 'socket,id=' + id + ',' + (ch.path ? 'path=' + esc(ch.path) : 'host=127.0.0.1,port=' + ch.port));
    a.push('-device', 'virtserialport,chardev=' + id + ',name=' + name + ',bus=vs0.0');
  }
  a.push('-kernel', o.kernel, '-initrd', o.initrd);
  a.push('-append', ['console=' + m.console, 'root=/dev/vda', 'rootfstype=ext4', 'rw', 'quiet', 'ghost.token=' + o.token, 'ghost.share=' + (o.share ? o.share.mode : 'none'), 'ghost.tools=' + (o.toolsDisk ? '1' : '0')].join(' '));
  return a;
}

// A run-time self-check on the finished command line: nothing the design rules out may be in it.
function selfCheck(argv) {
  const bad = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '-nic' && argv[i + 1] !== 'none') bad.push('network card');
    if (x === '-display' && argv[i + 1] !== 'none') bad.push('display');
    if (x === '-net' || x === '-netdev' || x === '-usb' || x === '-vga' || x === '-spice' || x === '-vnc' || x === '-parallel' || x === '-soundhw' || x === '-audiodev' || x === '-audio') bad.push(x);
    if (typeof x === 'string' && /(^|,)(hostfwd|guestfwd)=|usb-host|vfio-pci|virtio-net|e1000|rtl8139|spice|vdagent/.test(x)) bad.push(x.slice(0, 40));
  }
  const fs = argv.filter((x, i) => argv[i - 1] === '-fsdev' || (argv[i - 1] === '-drive' && /^file=fat:/.test(x)));
  if (fs.length > 1) bad.push('more than one shared folder');
  return bad;
}

module.exports = { buildArgv, resources, machine, shareMode, selfCheck, esc, PORT_AGENT, PORT_NET, MIN, MAX };
