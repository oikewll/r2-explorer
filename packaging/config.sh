#!/bin/sh
# r2-explorer 配置文件（修改后执行 r2-explorer restart 生效）

# 服务端口（容器内固定 3000，这里只改映射端口）
PORT=3000

# Docker 镜像；轻量版（无 ffmpeg，体积更小）改为 ghcr.io/oikewll/r2-explorer:slim
IMAGE="ghcr.io/oikewll/r2-explorer:latest"

# 多账号配置持久化目录（data/accounts.json 存这里）
DATA_DIR="/etc/r2-explorer/data"
