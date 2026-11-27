#!/usr/bin/env bash
# RooMi 발표용 데모 워크스루 (v1.83). 서버를 띄우고, 데모 계정을 만들고, 핵심 기능을 순서대로 보여 준다.
#   실행: bash scripts/demo.sh        (규칙 폴백 모드: API 키 불필요)
#   브라우저 시연 주소는 마지막에 출력된다. 이 스크립트는 API 로 각 단계가 실제로 동작하는지 확인한다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$HOME/.workbuddy/binaries/node/versions/22.12.0/bin/node}"
[ -x "$NODE" ] || NODE="$(command -v node)"
PORT="${PORT:-3100}"
B="http://127.0.0.1:$PORT"
DB="$(mktemp -t roomi-demo).db"
LOG="$(mktemp -t roomi-demo-server).log"

json() { "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval("o."+process.argv[1]))})' "$1"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

cleanup() { [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true; rm -f "$DB" "$DB-wal" "$DB-shm"; }
trap cleanup EXIT

step "0. 서버 시작 (규칙 폴백, 포트 $PORT)"
(cd "$ROOT" && ROOMI_TEST_NO_LLM=1 DB_PATH="$DB" ADMIN_KEY=demo-admin PORT="$PORT" \
  "$NODE" --experimental-sqlite server.js >"$LOG" 2>&1) &
PID=$!
for _ in $(seq 1 60); do curl -s -o /dev/null "$B/" && break; sleep 0.5; done
curl -s -o /dev/null -w "서버 응답: %{http_code}\n" "$B/"

step "1. 데모 계정 만들기 (7일치 기록, Lv.5, 스트릭 6)"
# 시드 API 는 로그인한 계정의 토큰이 필요하므로, 먼저 임시 계정을 만든 뒤 그 토큰으로 데모 계정을 만든다.
BOOT_TOKEN=$(curl -s -X POST "$B/api/user" -H 'Content-Type: application/json' -d '{"nickname":"발표준비"}' | json user.token)
SEED_TOKEN=$(curl -s -X POST "$B/api/demo/seed" -H "X-Token: $BOOT_TOKEN" -H 'Content-Type: application/json' -d '{}' | json token)
echo "데모 계정 토큰 준비됨 (길이 ${#SEED_TOKEN})"
curl -s -X POST "$B/api/demo/lamps" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' -d '{}' | json 'topics.join(", ")' | sed 's/^/등불 3개 켜짐: /'

step "2. 아이가 설명하기 — 맞는 설명 (루미가 칭찬 없이 다음 질문을 한다)"
curl -s -X POST "$B/api/chat/explain" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' \
  -d '{"concept":"분수의 덧셈","text":"분모가 같으면 분자끼리 더하면 돼요"}' | json reply

step "3. 아이가 설명하기 — 틀린 설명 (맞다/틀리다 표시 없이 빈틈을 겨냥한 질문)"
curl -s -X POST "$B/api/chat/explain" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' \
  -d '{"concept":"분수의 덧셈","text":"분모가 클수록 더 큰 수야"}' | json reply

step "4. 보호자 대시보드 (가르친 것, 등불, 주간 요약)"
curl -s "$B/api/parent/dashboard" -H "X-Token: $SEED_TOKEN" | "$NODE" -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);
console.log("닉네임:",o.nickname,"| 레벨:",o.level,"| 이번 주 공부:",o.weekly.studyDays,"일");
console.log("가르친 개념:",o.taughtThisWeek.map(t=>t.topic).join(", ")||"(없음)");
console.log("등불:",o.lamps.total,"개 · 수정 구슬:",o.lamps.crystals,"개");
console.log("추천:",o.weekly.suggestion);});'

step "5. 보호자 PIN 게이트 (틀린 PIN → 거절, 맞는 PIN → 통과)"
curl -s -X POST "$B/api/account/pin" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' -d '{"pin":"1357"}' >/dev/null
curl -s -X POST "$B/api/parent/verify-pin" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' -d '{"pin":"0000"}' | json error | sed 's/^/0000 → /'
curl -s -X POST "$B/api/parent/verify-pin" -H "X-Token: $SEED_TOKEN" -H 'Content-Type: application/json' -d '{"pin":"1357"}' | json ok | sed 's/^/1357 → ok=/'

step "끝 (자동 테스트는 'npm test' 로 따로 실행)"
echo "브라우저 시연: 서버를 직접 띄우면 http://127.0.0.1:3000/ 에서 보호자 화면과 설명 화면을 함께 보여 줄 수 있습니다."
echo "서버 로그: $LOG"
