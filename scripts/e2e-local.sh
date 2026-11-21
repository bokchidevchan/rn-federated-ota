#!/usr/bin/env bash
# 로컬 end-to-end 검증. AWS 없이 배포 파이프라인 전체를 돌린다.
#
#   피처 빌드 → publish(업로드+등록) → promote → resolve 확인
#   → v2 빌드 → 카나리 30% → 사용자별 분배 확인 → 번들 다운로드 확인
#   → rollback → 전원 v1 확인 → 런타임이 다른 앱 확인
#
# 저장소는 임시 디렉터리, 서버는 packages/ota-server/src/local.ts 를 띄운다.
# 피처 의존성은 미리 설치돼 있어야 한다: (cd features/cart && npm ci), (cd features/profile && npm ci)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-4399}"
STORE_DIR="$(mktemp -d)"
export OTA_STORE="local:$STORE_DIR"
BASE="http://localhost:$PORT"
ota() { node packages/ota-cli/src/main.ts "$@"; }

pass=0
check() { # check <설명> <기대값> <실제값>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); echo "  ok   $1"; else echo "  FAIL $1: 기대 [$2], 실제 [$3]"; exit 1; fi
}

build() { # build <피처> <라벨>
  (cd "features/$1" && OTA_LABEL="$2" npm run --silent bundle:android >/dev/null)
}

publish() { # publish <피처이름> <디렉터리> <메모> → 릴리스 id
  ota publish "$1" --app "features/$2" --android "features/$2/build/generated/android" --note "$3" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).releaseId))'
}

resolve() { # resolve <사용자> [런타임] → JSON
  local rt="${2:-$RUNTIME}"
  curl -sf "$BASE/api/resolve?channel=prod&platform=android&runtimeVersion=$rt&userId=$1"
}

field() { # field <JSON> <피처> <키>
  node -e 'const r=JSON.parse(process.argv[1]).features[process.argv[2]];console.log(r?r[process.argv[3]]:"null")' "$1" "$2" "$3"
}

echo "== 서버 시작 ($BASE, 저장소 $STORE_DIR)"
node packages/ota-server/src/local.ts --port "$PORT" --store "$STORE_DIR" > "$STORE_DIR/server.log" 2>&1 &
SERVER_PID=$!
# 끝나면 서버를 내리고, 이 스크립트가 만든 임시 저장소도 지운다.
trap 'kill $SERVER_PID 2>/dev/null || true; rm -rf "$STORE_DIR"' EXIT
for _ in $(seq 1 50); do curl -s --max-time 1 "$BASE/api/resolve" >/dev/null && break; sleep 0.1; done
# 포트가 이미 쓰이는 중이면 서버는 바로 죽는다. 엉뚱한 서버와 대화하지 않게 여기서 멈춘다.
if ! kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "서버가 뜨지 않았습니다. 포트 $PORT 가 쓰이는 중이면 PORT=다른번호 로 다시 실행하세요."
  cat "$STORE_DIR/server.log"
  exit 1
fi

RUNTIME="$(ota runtime-version apps/host)"
echo "== 호스트 런타임 지문: $RUNTIME"
check "피처와 호스트의 런타임 지문이 같다" "$RUNTIME" "$(ota runtime-version features/cart)"

echo "== v1 빌드, 배포"
build cart v1; build profile v1
CART_V1="$(publish featureCart cart 'cart v1')"
PROFILE_V1="$(publish featureProfile profile 'profile v1')"
check "등록만 한 릴리스는 내려가지 않는다" "null" "$(field "$(resolve user-1)" featureCart releaseId)"
ota promote featureCart "$CART_V1" >/dev/null
ota promote featureProfile "$PROFILE_V1" >/dev/null
R="$(resolve user-1)"
check "promote 뒤 cart 는 v1" "$CART_V1" "$(field "$R" featureCart releaseId)"
check "promote 뒤 profile 은 v1" "$PROFILE_V1" "$(field "$R" featureProfile releaseId)"

echo "== v2 빌드, 카나리 30%"
build cart v2
CART_V2="$(publish featureCart cart 'cart v2')"
ota canary featureCart "$CART_V2" --ratio 30 >/dev/null

expected_canary=0; got_canary=0
for i in $(seq 1 20); do
  u="user-$i"
  bucket="$(ota bucket featureCart "$u" | cut -f2)"
  R="$(resolve "$u")"
  id="$(field "$R" featureCart releaseId)"
  if (( bucket < 30 )); then
    expected_canary=$((expected_canary + 1))
    check "$u (버킷 $bucket) 는 카나리 v2" "$CART_V2" "$id"
  else
    check "$u (버킷 $bucket) 는 stable v1" "$CART_V1" "$id"
  fi
  [[ "$id" == "$CART_V2" ]] && got_canary=$((got_canary + 1))
  check "$u 의 profile 은 카나리와 무관하게 v1" "$PROFILE_V1" "$(field "$R" featureProfile releaseId)"
done
echo "   카나리 대상 $got_canary/20 명 (버킷 계산상 기대 $expected_canary 명)"

echo "== 같은 사용자는 몇 번을 물어도 같은 답"
first="$(field "$(resolve user-3)" featureCart releaseId)"
for _ in 1 2 3 4 5; do check "user-3 반복 요청" "$first" "$(field "$(resolve user-3)" featureCart releaseId)"; done

echo "== resolve 가 준 경로로 실제 번들을 받는다"
BP="$(field "$(resolve user-1)" featureCart basePath)"
code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/${BP}featureCart.container.js.bundle")"
check "컨테이너 번들 200" "200" "$code"
check "엔트리 번들(index.bundle)은 올라가 있지 않다" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/${BP}index.bundle")"
check "소스맵은 올라가 있지 않다" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/${BP}featureCart.container.js.bundle.map")"
check "경로 조작은 막힌다" "404" "$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$BASE/releases/../manifests/prod.json")"
check "인코딩한 경로 조작도 막힌다" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/releases/..%2fmanifests%2fprod.json")"

echo "== rollback (카나리 회수)"
ota rollback featureCart >/dev/null
for i in $(seq 1 20); do
  check "user-$i 는 다시 v1" "$CART_V1" "$(field "$(resolve "user-$i")" featureCart releaseId)"
done
if ota canary featureCart "$CART_V2" --ratio 10 >/dev/null 2>&1; then echo "  FAIL 회수된 릴리스를 다시 카나리로 낼 수 있다"; exit 1; fi
check "회수된 릴리스는 다시 낼 수 없다" "ok" "ok"

echo "== 런타임이 다른 앱(예: 스토어 업데이트 전 옛 앱)"
check "맞는 릴리스가 없으면 null" "null" "$(field "$(resolve user-1 rn0.75.0-000000000000)" featureCart releaseId)"

echo "== 입력 검증"
check "잘못된 플랫폼은 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/resolve?platform=web&runtimeVersion=$RUNTIME&userId=u")"

echo
ota status
echo
echo "통과 $pass 건"
