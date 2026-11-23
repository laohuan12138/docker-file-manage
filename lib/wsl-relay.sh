#!/bin/sh
# dockfile WSL relay 控制脚本（在 WSL 内执行，避免 Windows 侧复杂的引号转义）
#   start <port>   建立 127.0.0.1:<port> → docker.sock 的转发
#   stop  <port>   停止
#   stop-all       清理所有残留 relay
#   status         列出正在运行的 relay
SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
BASE_PREFIX="/tmp/dockfile-relay"

start() {
  port="$1"
  base="$BASE_PREFIX-$port"
  # 先清掉同端口残留
  if [ -f "$base.pid" ]; then
    kill -9 "$(cat "$base.pid")" 2>/dev/null
    rm -f "$base.pid"
  fi
  if command -v socat >/dev/null 2>&1; then
    mode=socat
    setsid nohup socat "TCP-LISTEN:$port,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$SOCK" >/dev/null 2>&1 &
  elif command -v python3 >/dev/null 2>&1; then
    mode=python3
    setsid nohup python3 /tmp/dockfile-relay.py "$port" >/dev/null 2>&1 &
  else
    echo "no-tool" >&2
    exit 3
  fi
  pid=$!
  echo "$pid" > "$base.pid"
  # 给 setsid 一点时间脱离父会话，否则 wsl.exe 退出会连带杀掉它
  sleep 0.7
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$base.pid"
    echo "died" >&2
    exit 5
  fi
  echo "ok $mode $pid"
  exit 0
}

stop() {
  port="$1"
  base="$BASE_PREFIX-$port"
  if [ -f "$base.pid" ]; then
    pid="$(cat "$base.pid")"
    kill -9 "$pid" 2>/dev/null
    rm -f "$base.pid"
  fi
  # python 回退可能换了 pid，按脚本路径再清一次（脚本自身 cmdline 不含该路径）
  pkill -9 -f "dockfile-relay.py $port" 2>/dev/null
  exit 0
}

list() {
  for f in $BASE_PREFIX-*.pid; do
    [ -f "$f" ] || continue
    port=$(basename "$f" .pid)
    port=${port##*-}
    echo "$port $(cat "$f")"
  done
  exit 0
}

sweep() {
  # 10 分钟以上没动过的 pid 文件视为上一个进程遗留，清掉避免端口堆积
  for f in $(find /tmp -maxdepth 1 -name 'dockfile-relay-*.pid' -mmin +10 2>/dev/null); do
    kill -9 "$(cat "$f")" 2>/dev/null
    rm -f "$f"
  done
  exit 0
}

stop_all() {
  for f in $BASE_PREFIX-*.pid; do
    [ -f "$f" ] || continue
    kill -9 "$(cat "$f")" 2>/dev/null
    rm -f "$f"
  done
  pkill -9 -f "dockfile-relay.py" 2>/dev/null
  exit 0
}

status() {
  ls -l $BASE_PREFIX-*.pid 2>/dev/null || echo "no relay"
  command -v socat >/dev/null 2>&1 && echo "socat: yes" || echo "socat: no"
  command -v python3 >/dev/null 2>&1 && echo "python3: yes" || echo "python3: no"
  exit 0
}

cmd="$1"
shift 2>/dev/null
case "$cmd" in
  start) start "$1" ;;
  stop) stop "$1" ;;
  stop-all) stop_all ;;
  list) list ;;
  sweep) sweep ;;
  status) status ;;
  *) echo "usage: $0 start|stop|stop-all|list|sweep|status [port]" >&2; exit 2 ;;
esac
