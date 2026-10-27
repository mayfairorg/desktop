#!/usr/bin/env bash
# Builds the QEMU package the Ghost virtual computer downloads: a zip with the system emulator for this computer's own CPU family,
# qemu-img, the firmware files and whatever libraries they need. QEMU is free software (GPL-2.0-or-later); the zip carries its licence
# text and a notice, and the release carries the exact source archive this was built from.
#   pack-qemu.sh <linux|darwin|win32> <x64|arm64> <output zip>
# Needs QEMU_VERSION and QEMU_SHA256 (the SHA-256 of the source archive: the build stops when it does not match).
# Linux builds a static program in an Alpine container; macOS bundles Homebrew's build and signs it for the Hypervisor framework;
# Windows bundles the MSYS2 build with its DLLs.
set -euo pipefail
PLAT="${1:?platform}"; ARCH="${2:?arch}"; ZIP="$(realpath -m "${3:?output zip}")"
: "${QEMU_VERSION:?}"; : "${QEMU_SHA256:?set the SHA-256 of the QEMU source archive}"
case "$ARCH" in x64) G=x86_64;; arm64) G=aarch64;; *) echo "bad arch" >&2; exit 2;; esac
EXE=""; [ "$PLAT" = win32 ] && EXE=".exe"
PK="$(mktemp -d)"; mkdir -p "$PK/share/qemu"
HERE="$(cd "$(dirname "$0")" && pwd)"

fetch_source() {
  curl -fsSL "https://download.qemu.org/qemu-$QEMU_VERSION.tar.xz" -o "$1/qemu-src.tar.xz"
  echo "$QEMU_SHA256  $1/qemu-src.tar.xz" | sha256sum -c -
}

case "$PLAT" in
linux)
  # run inside an Alpine container with the build tools (the workflow does that)
  apk add --no-cache build-base python3 py3-pip ninja meson pkgconf perl flex bison xz curl \
    glib-dev glib-static pcre2-dev zlib-dev zlib-static pixman-dev pixman-static libcap-ng-dev libcap-ng-static attr-dev attr-static \
    bzip2-static libffi-dev linux-headers coreutils
  W="$(mktemp -d)"; fetch_source "$W"; tar -C "$W" -xf "$W/qemu-src.tar.xz"
  ( cd "$W/qemu-$QEMU_VERSION" && ./configure --static --target-list="$G-softmmu" --disable-docs --disable-user --disable-gtk --disable-sdl \
      --disable-opengl --disable-vnc --disable-curses --disable-slirp --disable-libusb --disable-usb-redir --disable-spice --disable-guest-agent \
      --disable-capstone --disable-werror --enable-virtfs --enable-kvm --prefix=/opt/q && make -j"$(nproc)" && make DESTDIR="$W/out" install )
  cp "$W/out/opt/q/bin/qemu-system-$G" "$W/out/opt/q/bin/qemu-img" "$PK/"
  for f in bios-256k.bin kvmvapic.bin linuxboot_dma.bin efi-virtio.rom; do [ -f "$W/out/opt/q/share/qemu/$f" ] && cp "$W/out/opt/q/share/qemu/$f" "$PK/share/qemu/"; done
  cp "$W/qemu-$QEMU_VERSION/COPYING" "$PK/COPYING"
  ;;
darwin)
  brew install qemu dylibbundler
  B="$(brew --prefix qemu)"
  cp "$B/bin/qemu-system-$G" "$B/bin/qemu-img" "$PK/"
  cp -R "$B/share/qemu/." "$PK/share/qemu/" 2>/dev/null || true
  mkdir -p "$PK/libs"
  for x in "$PK/qemu-system-$G" "$PK/qemu-img"; do dylibbundler -of -b -x "$x" -d "$PK/libs" -p @executable_path/libs; done
  cat > "$PK/hvf.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.hypervisor</key><true/></dict></plist>
PLIST
  codesign --force --sign - --entitlements "$PK/hvf.plist" "$PK/qemu-system-$G"
  rm "$PK/hvf.plist"
  [ -f "$(brew --prefix qemu)/share/doc/qemu/COPYING" ] && cp "$(brew --prefix qemu)/share/doc/qemu/COPYING" "$PK/COPYING" || curl -fsSL https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt -o "$PK/COPYING"
  ;;
win32)
  # run in an MSYS2 MINGW64 shell with: pacman -S mingw-w64-x86_64-qemu
  P="$(dirname "$(command -v qemu-system-$G.exe)")"
  cp "$P/qemu-system-$G.exe" "$P/qemu-img.exe" "$PK/"
  cp -R "$P/../share/qemu/." "$PK/share/qemu/" 2>/dev/null || true
  for x in "$PK/qemu-system-$G.exe" "$PK/qemu-img.exe"; do ldd "$x" | awk '/mingw64/ {print $3}' | while read -r d; do cp -n "$d" "$PK/"; done; done
  curl -fsSL https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt -o "$PK/COPYING"
  ;;
*) echo "bad platform" >&2; exit 2;;
esac

cat > "$PK/QEMU-NOTICE.txt" <<NOTE
QEMU $QEMU_VERSION runs the Ghost virtual computer as a separate program. It is free software, licensed under GPL-2.0-or-later (see COPYING),
and is not part of the Mayfair Desktop application. Its source code is published as an asset of the same release this file came from:
qemu-$QEMU_VERSION-source.tar.xz (SHA-256 $QEMU_SHA256).
NOTE
mkdir -p "$(dirname "$ZIP")"; rm -f "$ZIP"
( cd "$PK" && zip -qr -X "$ZIP" . )
ls -l "$ZIP"
