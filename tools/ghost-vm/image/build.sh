#!/bin/sh
# Builds the Ghost virtual computer system image for ONE CPU family. Run as root inside an Alpine container (the workflow does this).
#   build.sh <x86_64|aarch64> <output folder>
# Output:  kernel-<arch>  initrd-<arch>  base-<arch>.qcow2
# The image holds Alpine Linux with git, python3 + pip + pipx, node + npm, go, build tools, curl, jq and unzip (Rust only when WITH_RUST=1).
# It has NO network card and no host access: the only things it can reach are the two serial channels the QEMU command line gives it.
set -eu
ARCH="${1:?architecture: x86_64 or aarch64}"
OUT="${2:?output folder}"
BRANCH="${ALPINE_BRANCH:-v3.20}"
SIZE_MB="${IMAGE_MB:-5000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
GUEST="$HERE/../guest"
case "$ARCH" in x86_64|aarch64) ;; *) echo "unknown architecture $ARCH" >&2; exit 2;; esac

apk add --no-cache e2fsprogs e2fsprogs-extra qemu-img apk-tools >/dev/null
ROOT="$(mktemp -d)"; mkdir -p "$OUT"
REPOS="https://dl-cdn.alpinelinux.org/alpine/$BRANCH/main
https://dl-cdn.alpinelinux.org/alpine/$BRANCH/community"

mkdir -p "$ROOT/etc/apk" "$ROOT/var/cache/apk"
printf '%s\n' "$REPOS" > "$ROOT/etc/apk/repositories"
PKGS="alpine-base openrc linux-virt mkinitfs e2fsprogs doas bash git python3 py3-pip pipx nodejs npm go build-base curl jq unzip ca-certificates eudev udev-init-scripts"
[ "${WITH_RUST:-0}" = "1" ] && PKGS="$PKGS rust cargo"
apk add --root "$ROOT" --initdb --arch "$ARCH" --keys-dir /etc/apk/keys --no-cache --repositories-file "$ROOT/etc/apk/repositories" $PKGS

# ---- the machine's own programs
install -d "$ROOT/usr/local/lib/ghost" "$ROOT/usr/local/bin"
install -m 0755 "$GUEST/ghost-agent.py" "$GUEST/ghost-netd.py" "$ROOT/usr/local/lib/ghost/"
install -m 0755 "$GUEST/ghost-wrap.py" "$ROOT/usr/local/bin/ghost-wrap"

# ---- users: one unprivileged user for terminals and tools, one for the proxy
echo "ghost" > "$ROOT/etc/hostname"
chroot "$ROOT" /bin/sh -e <<'CHROOT'
addgroup -g 1000 ghost && adduser -D -u 1000 -G ghost -s /bin/bash ghost && passwd -l ghost >/dev/null
addgroup -S ghostnet && adduser -S -D -G ghostnet -s /sbin/nologin ghostnet
passwd -l root >/dev/null
mkdir -p /opt/ghost-tools /mnt/shared /home/ghost/src && chown ghost:ghost /home/ghost/src
CHROOT

# ---- device permissions: the agent port is root only; the net port belongs to the proxy user only
cat > "$ROOT/etc/udev/rules.d/90-ghost.rules" <<'RULES'
SUBSYSTEM=="virtio-ports", ATTR{name}=="org.mayfair.ghost.agent", OWNER="root", GROUP="root", MODE="0600"
SUBSYSTEM=="virtio-ports", ATTR{name}=="org.mayfair.ghost.net", OWNER="ghostnet", GROUP="ghostnet", MODE="0600"
RULES

# ---- the only thing the person may run as root: installing system packages (through the proxy, so the chosen route applies)
cat > "$ROOT/etc/doas.d/ghost.conf" <<'DOAS'
permit nopass setenv { http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128 } ghost cmd apk
DOAS

# ---- network: loopback only. There is no card. Programs use the proxy on 127.0.0.1.
printf 'auto lo\niface lo inet loopback\n' > "$ROOT/etc/network/interfaces"
cat > "$ROOT/etc/profile.d/ghost.sh" <<'PROFILE'
export http_proxy=http://127.0.0.1:3128 https_proxy=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128 HTTPS_PROXY=http://127.0.0.1:3128
export ALL_PROXY=socks5h://127.0.0.1:9050 NO_PROXY=localhost,127.0.0.1,::1
export PATH="$PATH:/opt/ghost-tools/bin" GHOST_TOOLS=/opt/ghost-tools GHOST_SHARE=/mnt/shared
PS1='ghost:\w\$ '
PROFILE
printf 'virtio_blk\nvirtio_pci\nvirtio_console\n9p\n9pnet_virtio\nvfat\nnls_cp437\nnls_iso8859-1\n' > "$ROOT/etc/modules"

# ---- services
cat > "$ROOT/etc/init.d/ghost-agent" <<'SVC'
#!/sbin/openrc-run
description="Ghost control agent"
command=/usr/bin/python3
command_args="/usr/local/lib/ghost/ghost-agent.py"
command_background=yes
pidfile=/run/ghost-agent.pid
depend() { need localmount udev; after modules; }
SVC
cat > "$ROOT/etc/init.d/ghost-netd" <<'SVC'
#!/sbin/openrc-run
description="Ghost network proxy (no network card: connections go to Ghost over a serial channel)"
command=/usr/bin/python3
command_args="/usr/local/lib/ghost/ghost-netd.py"
command_user=ghostnet:ghostnet
command_background=yes
pidfile=/run/ghost-netd.pid
depend() { need localmount udev; after modules; }
SVC
cat > "$ROOT/etc/init.d/ghost-resize" <<'SVC'
#!/sbin/openrc-run
description="Grow the root file system to the size of the virtual disk"
depend() { need root; before ghost-agent; }
start() { resize2fs /dev/vda >/dev/null 2>&1 || true; }
SVC
chmod 0755 "$ROOT"/etc/init.d/ghost-*
chroot "$ROOT" /bin/sh -e <<'CHROOT'
rc-update add devfs sysinit; rc-update add udev sysinit; rc-update add udev-trigger sysinit; rc-update add modules boot
rc-update add networking boot; rc-update add ghost-resize boot; rc-update add ghost-netd default; rc-update add ghost-agent default
echo 'features="base ext4 virtio"' > /etc/mkinitfs/mkinitfs.conf
KVER="$(ls /lib/modules | head -n1)"; mkinitfs -o /boot/initramfs-virt "$KVER"
CHROOT
# the console is the serial line to Ghost: no login prompt is started on it
sed -i '/^ttyS0\|^tty[0-9]/d' "$ROOT/etc/inittab"
printf '/dev/vda / ext4 rw,relatime 0 1\n' > "$ROOT/etc/fstab"

cp "$ROOT/boot/vmlinuz-virt" "$OUT/kernel-$ARCH"
cp "$ROOT/boot/initramfs-virt" "$OUT/initrd-$ARCH"
rm -rf "$ROOT/boot" "$ROOT/var/cache/apk"/*

# ---- the disk: an ext4 file system filled from the folder (no loop device needed), then qcow2
truncate -s "${SIZE_MB}M" "$OUT/base-$ARCH.raw"
mkfs.ext4 -q -L ghostroot -d "$ROOT" "$OUT/base-$ARCH.raw"
qemu-img convert -f raw -O qcow2 -c "$OUT/base-$ARCH.raw" "$OUT/base-$ARCH.qcow2"
rm -f "$OUT/base-$ARCH.raw"
ls -l "$OUT"
