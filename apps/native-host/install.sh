#!/usr/bin/env bash
# Chrome Native Messaging 호스트 등록 (macOS).
# 한 번만 실행하면 그 뒤로는 확장이 자막을 시작할 때 Chrome 이 STT 서버를 알아서 띄우고,
# 자막을 끄면 알아서 죽인다. 터미널을 다시 볼 일이 없다.
#
#   bash apps/native-host/install.sh [확장 ID ...]
#
# 이건 개발자용 경로다. 최종 사용자는 사이드패널의 [고정확도 엔진 설치] -> .pkg 두 번 클릭으로 끝난다
# (설치 프로그램은 npm run engine:pkg 로 만든다).
# 확장 ID 를 적지 않으면 지금 Chrome 에 로드돼 있는 확장에서 자동으로 찾는다.
set -euo pipefail

HOST_NAME="com.study.whisper"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"

EXT_IDS=("$@")
if [ "${#EXT_IDS[@]}" -eq 0 ]; then
  # 사용자가 32자 ID 를 손으로 복사하지 않게 한다. Chrome 프로필에서 dist 경로로 찾아낸다.
  while IFS= read -r line; do
    [ -n "$line" ] && EXT_IDS+=("$line")
  done < <(node "$HERE/scripts/ext-ids.mjs" "$REPO_ROOT/apps/extension/dist" 2>/dev/null || true)
fi

if [ "${#EXT_IDS[@]}" -eq 0 ]; then
  echo "확장 ID 를 찾지 못했습니다."
  echo "  1) chrome://extensions 를 열고 오른쪽 위 '개발자 모드' 를 켠다"
  echo "  2) '압축해제된 확장 프로그램을 로드' 로 $REPO_ROOT/apps/extension/dist 를 연다"
  echo "  3) 이 명령을 다시 실행한다 (ID 는 자동으로 찾습니다)"
  exit 1
fi

for EXT_ID in "${EXT_IDS[@]}"; do
  if ! printf '%s' "$EXT_ID" | grep -Eq '^[a-p]{32}$'; then
    echo "확장 ID 형식이 아닙니다: $EXT_ID (영문 a-p 32자)"
    exit 1
  fi
done

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node 를 찾을 수 없습니다. Node.js 를 설치한 뒤 다시 실행하세요."
  exit 1
fi

LAUNCHER="$HERE/bin/study-whisper-host"
mkdir -p "$HERE/bin"
# Chrome 은 매니페스트의 path 를 직접 exec 한다. nvm 등으로 PATH 가 없을 수 있어 node 경로를 박아 둔다.
cat > "$LAUNCHER" <<LAUNCH
#!/bin/sh
exec "$NODE_BIN" "$HERE/src/host.mjs" "\$@"
LAUNCH
chmod +x "$LAUNCHER"

# 스토어 배포판 ID 가 생기면 인자로 함께 넘기면 된다: install.sh <개발ID> <스토어ID>
ORIGINS=""
for EXT_ID in "${EXT_IDS[@]}"; do
  [ -n "$ORIGINS" ] && ORIGINS="$ORIGINS, "
  ORIGINS="$ORIGINS\"chrome-extension://$EXT_ID/\""
done

MANIFEST="$(cat <<JSON
{
  "name": "$HOST_NAME",
  "description": "study sidepanel local whisper gateway launcher",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [$ORIGINS]
}
JSON
)"

INSTALLED=0
for BROWSER_DIR in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Google/Chrome Beta" \
  "$HOME/Library/Application Support/Google/Chrome Dev" \
  "$HOME/Library/Application Support/Google/Chrome Canary" \
  "$HOME/Library/Application Support/Chromium"; do
  [ -d "$BROWSER_DIR" ] || continue
  TARGET_DIR="$BROWSER_DIR/NativeMessagingHosts"
  mkdir -p "$TARGET_DIR"
  printf '%s\n' "$MANIFEST" > "$TARGET_DIR/$HOST_NAME.json"
  echo "등록: $TARGET_DIR/$HOST_NAME.json"
  INSTALLED=$((INSTALLED + 1))
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "Chrome 사용자 디렉터리를 찾지 못했습니다. Chrome 을 한 번 실행한 뒤 다시 시도하세요."
  exit 1
fi

echo
echo "완료. 저장소 위치: $REPO_ROOT"
echo "Chrome 을 완전히 종료했다 다시 켠 뒤 자막 시작을 누르면 STT 서버가 자동으로 뜹니다."
