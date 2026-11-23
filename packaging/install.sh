#!/bin/sh
# r2-explorer .run 安装器载荷：把文件铺到系统目录，解析可选参数，然后启动服务
# 用法: sh r2-explorer-installer-vX.Y.Z.run [--slim] [--port N] [--image X] [--data-dir X] [--skip-start]

set -e
STAGE_DIR=$(dirname "$0")
[ "$STAGE_DIR" = "." ] && STAGE_DIR=$(pwd)

CONF_DIR=/etc/r2-explorer
CONFIG=$CONF_DIR/config.sh

echo "安装 r2-explorer 文件 ..."
mkdir -p "$CONF_DIR" "$CONF_DIR/data" /usr/bin /usr/share/r2-explorer
cp "$STAGE_DIR/r2-explorer" /usr/bin/r2-explorer
chmod 755 /usr/bin/r2-explorer
cp "$STAGE_DIR/config.sh" /usr/share/r2-explorer/config.sh

# 首次安装才铺配置文件；已有配置不动（升级不覆盖用户设置）
if [ ! -f "$CONFIG" ]; then
    cp "$STAGE_DIR/config.sh" "$CONFIG"
    echo "已生成配置文件 $CONFIG"
else
    echo "保留已有配置 $CONFIG"
fi

# 解析可选参数（写入配置文件）
while [ $# -gt 0 ]; do
    case "$1" in
        --slim)
            sed -i 's|^IMAGE=.*|IMAGE="ghcr.io/oikewll/r2-explorer:slim"|' "$CONFIG"
            echo "已切换为精简版镜像（slim）" ;;
        --port)
            sed -i "s|^PORT=.*|PORT=$2|" "$CONFIG"; shift ;;
        --image)
            sed -i "s|^IMAGE=.*|IMAGE=\"$2\"|" "$CONFIG"; shift ;;
        --data-dir)
            sed -i "s|^DATA_DIR=.*|DATA_DIR=\"$2\"|" "$CONFIG"; shift ;;
        --skip-start)
            SKIP_START=1 ;;
        *)
            echo "未知参数: $1（支持 --slim --port N --image X --data-dir X --skip-start）" ;;
    esac
    shift
done

if [ "${SKIP_START:-0}" = 1 ]; then
    echo "文件已安装。稍后执行 'r2-explorer install' 启动服务。"
    exit 0
fi

/usr/bin/r2-explorer install
