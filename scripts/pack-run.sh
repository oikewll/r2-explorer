#!/usr/bin/env bash
# 打包自解压安装器: r2-explorer-installer.run
# 用法: bash scripts/pack-run.sh <version>
#
# 结构：头部脚本 + tar.gz 载荷，头部按字节偏移量用 tail -c 切出载荷。
# 不用 sed 找标记行——busybox 的 sed 处理二进制会损坏字节（实测 md5 变化）。
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

tar czf "$WORK/payload.tar.gz" -C "$PAYLOAD" install.sh r2-explorer config.sh

# 头部脚本。偏移量占位 10 位（零填充），替换后头部字节数不变，偏移计算稳定
HEADER="$WORK/header.sh"
cat > "$HEADER" <<'HEADER'
#!/bin/sh
# r2-explorer 自解压安装器（适用于任何带 Docker 的 OpenWrt/iStoreOS/Linux）
# 用法: sh r2-explorer-installer.run [--slim] [--port N] [--data-dir X] [--skip-start]
set -e
TMP=$(mktemp -d 2>/dev/null || echo /tmp/r2ex-installer.$$)
trap 'rm -rf "$TMP"' EXIT
tail -c +0000000000 "$0" | tar xzf - -C "$TMP"
sh "$TMP/install.sh" "$@"
exit 0
HEADER

HEADER_BYTES=$(wc -c < "$HEADER" | tr -d '[:space:]')
OFFSET=$(printf "%010d" $((HEADER_BYTES + 1)))
sed -i.bak "s/0000000000/$OFFSET/" "$HEADER" && rm -f "$HEADER.bak"

# 固定文件名（不带版本号），配合 GitHub Releases 的 latest/download 直链使用
OUT="$DIST/r2-explorer-installer.run"
mkdir -p "$DIST"
cat "$HEADER" "$WORK/payload.tar.gz" > "$OUT"
chmod 755 "$OUT"

# 自检：按偏移切出载荷，验证 tar 结构 + 内容与源一致
if ! tail -c "+$OFFSET" "$OUT" | tar tzf - >/dev/null 2>&1; then
    echo "错误：自检失败（载荷无法解出）" >&2
    exit 1
fi
if ! tail -c "+$OFFSET" "$OUT" | tar xzf - -O install.sh 2>/dev/null | cmp -s - "$PAYLOAD/install.sh"; then
    echo "错误：自检失败（载荷内容与源不一致）" >&2
    exit 1
fi

echo "已生成 ${OUT}（载荷偏移 ${OFFSET}，自检通过）"
