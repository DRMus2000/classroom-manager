#!/bin/sh
# 数据卷在首次挂载时属于 root。可写目录先改属主，再降到 nodejs 运行。
# API 把备份卷挂成只读，跳过不能写的目录。
set -e
if [ "$(id -u)" = "0" ]; then
  for dir in /app/backups /app/anon-ledger /backups; do
    mkdir -p "$dir" 2>/dev/null || true
    if touch "$dir/.write-probe" 2>/dev/null; then
      rm -f "$dir/.write-probe"
      chown nodejs:nodejs "$dir"
    fi
  done
  exec su-exec nodejs "$@"
fi
exec "$@"
