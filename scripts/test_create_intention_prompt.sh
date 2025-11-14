#!/usr/bin/env bash
# 目的: /api/intention-prompts/create の疎通テスト（service-role 側保存 → id返却）
# 使い方:
#   chmod +x scripts/test_create_intention_prompt.sh
#   ./scripts/test_create_intention_prompt.sh | jq

BASE_URL="${BASE_URL:-http://localhost:3000}"

# ---- サンプル入力（最小限＋仕様準拠） ----
read -r -d '' FORM_JSON <<'JSON'
{
  "name": "orion",
  "target": "世界",
  "desire": "静けさを広げたい",
  "reason": "疲弊を鎮めたい",
  "vision": "金白の柔らかな面発光で満ちた世界",
  "mood": "希望",
  "visibility": "公開",
  "lat": 35.7,
  "lon": 139.7,
  "season": "秋",
  "timing": "近未来",
  "tLayer": "T2"
}
JSON

read -r -d '' FT_JSON <<'JSON'
{
  "baseTone": "deep ultramarine",
  "baseLPercent": 16,
  "texture": "soft grain",
  "sheetGlowPercent": 28,
  "flowMotif": "converging streams",
  "obstaclePattern": "turbulence",
  "highlightClipPercent": 90,
  "colorRatioOverride": "ultramarine 5 / violet 3 / gold 2",
  "grainNoteOverride": "fine grains, sparse",
  "addNotes": ["avoid vignette lines", "keep center-edge equality"]
}
JSON

# 共有URLはクライアント側 buildShareUrl() と同等のダミー値でOK（検証用）
SHARE_URL="${BASE_URL}/intention-prompt?n=orion&tl=T2"

# 作品タイトル（例示）
TITLE="$(date +%F)-orion-T2"

# プロンプト本文（本来は UI で生成された文字列を送る）
read -r -d '' PROMPT_TEXT <<'TXT'
Boundaryless intention field, deep ultramarine base (not too dark). Interweaving flows (T2) with hopeful gold-white micro-sparks. No center; edges equal. Static still image, painterly soft grain. Safe highlights ≤90%. Print/projection ready.
TXT

curl -sS -X POST "${BASE_URL}/api/intention-prompts/create" \
  -H 'content-type: application/json' \
  -d "{
    \"title\": \"${TITLE}\",
    \"form\": ${FORM_JSON},
    \"finetune\": ${FT_JSON},
    \"prompt\": $(jq -R -s @json <<< \"${PROMPT_TEXT}\"),
    \"shareUrl\": \"${SHARE_URL}\"
  }"
