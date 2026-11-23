#!/usr/bin/env bash
# 打包 OpenWrt/iStore 安装包: r2-explorer_vX.Y.Z-1_all.ipk
# 结构与 opkg 兼容（ar 归档: debian-binary + control.tar.gz + data.tar.gz）
# 依赖 docker-deps（iStoreOS/iStore 官方 Docker 依赖包，安装时自动带上 Docker）
# 用法: bash scripts/pack-ipk.sh <version>
set -euo pipefail

VERSION="${1:?用法: pack-ipk.sh <version>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CTRL="$WORK/control"
DATA="$WORK/data"
mkdir -p "$CTRL/etc/r2-explorer" "$DATA/usr/bin" "$DATA/etc/r2-explorer"

# ---------- data ----------
cp "$ROOT/packaging/r2-explorer" "$DATA/usr/bin/r2-explorer"
chmod 755 "$DATA/usr/bin/r2-explorer"
cp "$ROOT/packaging/config.sh" "$DATA/etc/r2-explorer/config.sh"

# ---------- control ----------
cat > "$CTRL/control" <<EOF
Package: r2-explorer
Version: ${VERSION}-1
Depends: docker-deps
Architecture: all
Maintainer: Hoanliu
Section: net
Description: 基于 Cloudflare R2 的轻量网盘：配置 API 凭证即可浏览/上传/分享 R2 存储桶，支持多账号与 WebDAV。
Source: https://github.com/oikewll/r2-explorer
EOF

cat > "$CTRL/conffiles" <<'EOF'
/etc/r2-explorer/config.sh
EOF

cat > "$CTRL/postinst" <<'EOF'
#!/bin/sh
echo "r2-explorer 已安装。执行 'r2-explorer install' 启动服务（默认端口 3000，自动生成登录密码）。"
exit 0
EOF

cat > "$CTRL/prerm" <<'EOF'
#!/bin/sh
docker rm -f r2-explorer >/dev/null 2>&1 || true
exit 0
EOF

chmod 755 "$CTRL/postinst" "$CTRL/prerm"

# ---------- 组包 ----------
# 固定文件名（不带版本号），配合 GitHub Releases 的 latest/download 直链使用；版本号在 control 里
OUT="$DIST/r2-explorer_all.ipk"
mkdir -p "$DIST"

tar czf "$WORK/control.tar.gz" -C "$CTRL" .
tar czf "$WORK/data.tar.gz" --owner=0 --group=0 -C "$DATA" etc usr

printf '2.0\n' > "$WORK/debian-binary"
rm -f "$OUT"
# -S 抑制符号表：opkg 需要普通归档，macOS/GNU ar 均兼容
ar rcS "$OUT" "$WORK/debian-binary" "$WORK/control.tar.gz" "$WORK/data.tar.gz"

echo "已生成 $OUT"
