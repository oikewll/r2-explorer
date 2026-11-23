#!/usr/bin/env bash
# 打包自解压安装器: r2-explorer-installer-vX.Y.Z.run
# 用法: bash scripts/pack-run.sh <version>
set -euo pipefail

VERSION="${1:?用法: pack-run.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PAYLOAD="$WORK/payload"
mkdir -p "$PAYLOAD"

# 载荷 = 安装脚本 + CLI + 默认配置
cp "$ROOT/packaging/install.sh" "$PAYLOAD/"
cp "$ROOT/packaging/r2-explorer" "$PAYLOAD/"
cp "$ROOT/packaging/config.sh" "$PAYLOAD/"

chmod 755 "$PAYLOAD/install.sh" "$PAYLOAD/r2-explorer"

# 固定文件名（不带版本号），配合 GitHub Releases 的 latest/download 直链使用
OUT="$DIST/r2-explorer-installer.run"
mkdir -p "$DIST"

# 头部脚本 + tar.gz 载荷，用标记行分隔；busybox 的 sed/tar/gzip 均可解
cat > "$OUT" <<'HEADER'
#!/bin/sh
# r2-explorer 自解压安装器（适用于任何带 Docker 的 OpenWrt/iStoreOS/Linux）
# 用法: sh r2-explorer-installer-vX.Y.Z.run [--slim] [--port N] [--data-dir X] [--skip-start]
set -e
TMP=$(mktemp -d 2>/dev/null || echo /tmp/r2ex-installer.$$)
trap 'rm -rf "$TMP"' EXIT
sed -n '/^__R2EXPLORER_PAYLOAD__$/,$p' "$0" | tail -n +2 | tar xzf - -C "$TMP"
sh "$TMP/install.sh" "$@"
exit 0
__R2EXPLORER_PAYLOAD__
HEADER

tar czf "$WORK/payload.tar.gz" -C "$PAYLOAD" install.sh r2-explorer config.sh
cat "$WORK/payload.tar.gz" >> "$OUT"
chmod 755 "$OUT"
echo "已生成 $OUT"
