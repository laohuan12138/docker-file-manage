#!/usr/bin/env sh
# dockfile —— Docker 容器文件管理器
cd "$(dirname "$0")" || exit 1
exec node server.js --open "$@"
