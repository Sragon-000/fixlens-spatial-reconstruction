#!/bin/bash

set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
WEB_PID="$RUN_DIR/web.pid"
OLLAMA_PID="$RUN_DIR/ollama.pid"
TUNNEL_PID="$RUN_DIR/tunnel.pid"
WEB_URL="http://127.0.0.1:4173"
OLLAMA_URL="http://127.0.0.1:11434"
MODEL="qwen3.5:4b"
QR_SCRIPT="$ROOT/scripts/generate-qr.mjs"
QR_IMAGE="$RUN_DIR/phone-access-qr.png"

mkdir -p "$RUN_DIR"

find_bin() {
  local name="$1"
  command -v "$name" 2>/dev/null || true
}

service_responds() {
  curl -fsS --max-time 2 "$1" >/dev/null 2>&1
}

managed_pid_matches() {
  local pid_file="$1" needle="$2" pid command
  [[ -f "$pid_file" ]] || return 1
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"$needle"* ]]
}

start_process() {
  local name="$1" pid_file="$2" log_file="$3"
  shift 3
  nohup "$@" >>"$log_file" 2>&1 </dev/null &
  echo "$!" >"$pid_file"
  printf '%s 시작 중입니다. 로그: %s\n' "$name" "$log_file"
}

wait_for_service() {
  local url="$1" attempts="$2" i
  for ((i=0; i<attempts; i++)); do
    service_responds "$url" && return 0
    sleep 1
  done
  return 1
}

start_ollama() {
  if service_responds "$OLLAMA_URL/api/tags"; then
    printf 'Ollama가 이미 실행 중입니다.\n'
    return 0
  fi
  local ollama_bin
  ollama_bin="$(find_bin ollama)"
  if [[ -z "$ollama_bin" ]]; then
    printf 'Ollama 실행 파일을 찾지 못했습니다.\n'
    return 1
  fi
  if managed_pid_matches "$OLLAMA_PID" 'ollama serve'; then
    printf 'Ollama가 시작되는 중입니다.\n'
  else
    start_process 'Ollama' "$OLLAMA_PID" "$RUN_DIR/ollama.log" "$ollama_bin" serve
  fi
  if wait_for_service "$OLLAMA_URL/api/tags" 30; then
    printf 'Ollama 준비 완료.\n'
  else
    printf 'Ollama가 응답하지 않습니다. 로그를 확인하세요: %s\n' "$RUN_DIR/ollama.log"
    return 1
  fi
}

start_web() {
  if service_responds "$WEB_URL/api/health"; then
    local pid command process_cwd
    if command -v lsof >/dev/null 2>&1; then
      while IFS= read -r pid; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
        process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
        if [[ "$process_cwd" == "$ROOT" && "$command" == *"server/local.mjs"* ]]; then
          printf '%s\n' "$pid" >"$WEB_PID"
          printf '이미 실행 중인 FixLens 웹 서버를 관리 메뉴에 연결했습니다.\n'
          return 0
        fi
      done < <(lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null)
    fi
    printf 'FixLens 웹 서버가 이미 실행 중입니다.\n'
    return 0
  fi
  local node_bin
  node_bin="$(find_bin node)"
  if [[ -z "$node_bin" ]]; then
    printf 'Node.js를 찾지 못했습니다. Node.js 20 이상을 설치하세요.\n'
    return 1
  fi
  if managed_pid_matches "$WEB_PID" 'server/local.mjs'; then
    printf 'FixLens 웹 서버가 시작되는 중입니다.\n'
  else
    start_process 'FixLens 웹 서버' "$WEB_PID" "$RUN_DIR/web.log" "$node_bin" "$ROOT/server/local.mjs"
  fi
  if wait_for_service "$WEB_URL/api/health" 15; then
    printf 'FixLens 웹 서버 준비 완료: %s\n' "$WEB_URL"
  else
    printf '웹 서버가 응답하지 않습니다. 로그를 확인하세요: %s\n' "$RUN_DIR/web.log"
    return 1
  fi
}

stop_process() {
  local label="$1" pid_file="$2" needle="$3" pid
  if ! managed_pid_matches "$pid_file" "$needle"; then
    rm -f "$pid_file"
    printf '%s는 이 관리자로 실행한 프로세스가 없습니다.\n' "$label"
    return 0
  fi
  pid="$(cat "$pid_file")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..5}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$pid_file"
  printf '%s를 종료했습니다.\n' "$label"
}

start_all() {
  start_ollama || true
  start_web || return 1
  if ! service_responds "$OLLAMA_URL/api/tags"; then
    printf '참고: Ollama가 꺼져 있어도 기기 내 물체 감지는 사용할 수 있습니다.\n'
  fi
  if ! start_tunnel; then
    printf '웹 서버는 실행 중입니다. 휴대폰 QR을 자동으로 열지 못했어요. 메뉴에서 HTTPS 터널 상태를 확인하세요.\n'
  fi
}

show_tunnel_qr() {
  local url
  url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" 2>/dev/null | tail -1 || true)"
  if [[ -z "$url" ]]; then
    printf '실행 중인 HTTPS 주소가 없습니다. 먼저 휴대폰용 HTTPS 터널을 시작하세요.\n'
    return 1
  fi
  local node_bin
  node_bin="$(find_bin node)"
  if [[ -z "$node_bin" ]]; then
    printf 'Node.js를 찾지 못했습니다. 휴대폰에서 직접 열 주소: %s\n' "$url"
    return 1
  fi
  if ! "$node_bin" "$QR_SCRIPT" "$url" "$QR_IMAGE"; then
    printf 'QR 이미지를 만들지 못했습니다. 휴대폰에서 직접 열 주소: %s\n' "$url"
    return 1
  fi
  printf '휴대폰 접속 QR을 열었습니다: %s\n주소: %s\n' "$QR_IMAGE" "$url"
  open "$QR_IMAGE"
}

tunnel_health() {
  local url="$1" hostname ip resolver
  if curl -fsS --max-time 3 "$url/api/health" >/dev/null 2>&1; then return 0; fi
  command -v dig >/dev/null 2>&1 || return 1
  hostname="${url#https://}"
  hostname="${hostname%%/*}"
  for resolver in 1.1.1.1 8.8.8.8; do
    ip="$(dig +time=2 +tries=1 +short "@$resolver" "$hostname" A | awk '/^[0-9.]+$/ { print; exit }')"
    [[ -n "$ip" ]] || continue
    if curl -fsS --max-time 4 --resolve "$hostname:443:$ip" "$url/api/health" >/dev/null 2>&1; then return 0; fi
  done
  return 1
}

wait_for_tunnel() {
  local url="$1" attempts="${2:-30}"
  for ((i=0; i<attempts; i++)); do
    managed_pid_matches "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173' || return 1
    if tunnel_health "$url"; then return 0; fi
    sleep 1
  done
  return 1
}

start_tunnel() {
  if managed_pid_matches "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173'; then
    local current_url
    current_url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" 2>/dev/null | tail -1 || true)"
    if [[ -n "$current_url" ]] && wait_for_tunnel "$current_url" 8; then
      printf 'HTTPS 터널 연결을 확인했습니다.\n'
      show_tunnel_qr
      return $?
    fi
    printf '기존 HTTPS 터널에 연결할 수 없어 새 주소로 다시 시작합니다.\n'
    stop_process 'HTTPS 터널' "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173'
  fi
  if ! service_responds "$WEB_URL/api/health"; then
    printf '먼저 FixLens 웹 서버를 시작하세요.\n'
    return 1
  fi
  local tunnel_bin
  tunnel_bin="$(find_bin cloudflared)"
  if [[ -z "$tunnel_bin" ]]; then
    printf 'cloudflared를 찾지 못했습니다.\n'
    return 1
  fi
  : >"$RUN_DIR/tunnel.log"
  start_process '임시 HTTPS 터널' "$TUNNEL_PID" "$RUN_DIR/tunnel.log" "$tunnel_bin" tunnel --url "$WEB_URL"
  for _ in {1..30}; do
    local url
    url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" | tail -1 || true)"
    if [[ -n "$url" ]]; then
      printf '휴대폰에서 열 HTTPS 주소: %s\n' "$url"
      printf '외부 접속을 확인하는 중입니다.\n'
      if wait_for_tunnel "$url" 30; then
        show_tunnel_qr
        return $?
      fi
      printf '터널 주소는 발급됐지만 웹 서버에 연결되지 않습니다. cloudflared 로그를 확인하세요: %s\n' "$RUN_DIR/tunnel.log"
      return 1
    fi
    sleep 1
  done
  printf '터널이 아직 주소를 만들지 못했습니다. 로그를 확인하세요: %s\n' "$RUN_DIR/tunnel.log"
  return 1
}

show_status() {
  printf '\nFixLens 웹 서버: '
  if service_responds "$WEB_URL/api/health"; then curl -fsS "$WEB_URL/api/health"; else printf '꺼짐\n'; fi
  printf 'Ollama: '
  if service_responds "$OLLAMA_URL/api/tags"; then
    curl -fsS "$OLLAMA_URL/api/tags" 2>/dev/null || printf '실행 중\n'
  else
    printf '꺼짐\n'
  fi
  printf '관리자 HTTPS 터널: '
  if managed_pid_matches "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173'; then
    local tunnel_url
    tunnel_url="$(grep -Eo 'https://[[:alnum:]-]+\.trycloudflare\.com' "$RUN_DIR/tunnel.log" | tail -1 || true)"
    if [[ -n "$tunnel_url" ]] && tunnel_health "$tunnel_url"; then
      printf '%s (접속 확인됨)\n' "$tunnel_url"
    elif [[ -n "$tunnel_url" ]]; then
      printf '%s (외부 연결 확인 중/실패)\n' "$tunnel_url"
    else
      printf '시작 중\n'
    fi
  else
    printf '꺼짐\n'
  fi
  printf '로그 폴더: %s\n\n' "$RUN_DIR"
}

case "${1:-status}" in
  start) start_all ;;
  stop)
    stop_process 'HTTPS 터널' "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173'
    stop_process 'FixLens 웹 서버' "$WEB_PID" 'server/local.mjs'
    stop_process '관리자가 시작한 Ollama' "$OLLAMA_PID" 'ollama serve'
    ;;
  tunnel-start) start_tunnel ;;
  tunnel-qr) show_tunnel_qr ;;
  tunnel-stop) stop_process 'HTTPS 터널' "$TUNNEL_PID" 'cloudflared tunnel --url http://127.0.0.1:4173' ;;
  status) show_status ;;
  open) open "$WEB_URL" ;;
  logs)
    tail -n 40 "$RUN_DIR/web.log" "$RUN_DIR/ollama.log" "$RUN_DIR/tunnel.log" 2>/dev/null || true
    ;;
  *) printf '사용법: %s {start|stop|tunnel-start|tunnel-stop|status|open|logs}\n' "$0"; exit 2 ;;
esac
