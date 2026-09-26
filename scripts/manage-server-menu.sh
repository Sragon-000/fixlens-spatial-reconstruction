#!/bin/bash

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANAGER="$ROOT/scripts/manage-server.sh"

pause_menu() {
  printf '\n'
  read -r -p '계속하려면 Enter를 누르세요... ' _
}

while true; do
  clear
  cat <<'MENU'
FixLens 서버 관리
────────────────────────
1) 서버 시작 (Ollama + 웹)
2) 관리자가 시작한 서버 종료
3) 상태 확인
4) 휴대폰용 HTTPS 터널 시작
5) HTTPS 터널 종료
6) 로컬 화면 열기
7) 로그 보기
q) 종료
MENU
  read -r -p '선택: ' choice

  case "$choice" in
    1) "$MANAGER" start; pause_menu ;;
    2) "$MANAGER" stop; pause_menu ;;
    3) "$MANAGER" status; pause_menu ;;
    4) "$MANAGER" tunnel-start; pause_menu ;;
    5) "$MANAGER" tunnel-stop; pause_menu ;;
    6) "$MANAGER" open; pause_menu ;;
    7) "$MANAGER" logs; pause_menu ;;
    q|Q) exit 0 ;;
    *) printf '메뉴에 있는 번호를 입력하세요.\n'; pause_menu ;;
  esac
done
