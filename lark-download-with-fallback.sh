#!/bin/bash
#
# Lark 数据下载 A/B 降级 wrapper（2026-05-09 P2 Day 8-9，v2 修正）
#
# v1 痛点：API 退出码非 0 即触发 fallback，但 lark-api-download.js 部分 tab 找不到（schema 问题）
#         也会 exit !=0，导致误判 + 误推 P0「双路径全失败」
# v2：基于日志末尾「失败 N」数字判定。失败 <5 视为成功。
#
# 主路径：lark-api-download.js（API，~3 min）
# 备路径：download-all-lark.js（Playwright，~5 min）

set -uo pipefail

cd /home/ubuntu/feishu-sync || exit 99

NOTIFY=/home/ubuntu/nova-auto-download/feishu-notify.py
TODAY=$(date +%Y-%m-%d)
LOG_API=/tmp/lark-api.log
LOG_PW=/tmp/lark-pw.log

# 失败 tab 数 >= 此阈值才视为真失败（schema 飘移容忍）
FAIL_THRESHOLD=5

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

# 解析 API 日志末尾「完成 X/Y 文件，失败 Z」
parse_api_failures() {
  grep -oE '失败 [0-9]+' "$LOG_API" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 99
}

# 解析 Playwright 日志末尾「下载完成: X 成功, Y 失败」
parse_pw_failures() {
  grep -oE '[0-9]+ 失败' "$LOG_PW" 2>/dev/null | tail -1 | grep -oE '[0-9]+' || echo 99
}

# ─── 主路径：API ──────────────────────────────────────────
log "主路径 API 开始"
timeout 600 node lark-api-download.js > "$LOG_API" 2>&1
API_EXIT=$?
API_FAILED=$(parse_api_failures)

log "API 跑完 exit=$API_EXIT, 失败 $API_FAILED 个 tab"

if [ "$API_FAILED" -lt "$FAIL_THRESHOLD" ]; then
  # 真成功（即使 exit !=0）
  if [ "$API_FAILED" -gt 0 ]; then
    # 部分失败：仅 digest 入仪表盘，不推飞书
    python3 "$NOTIFY" "ℹ️ Lark API 部分 tab 找不到 ($API_FAILED 个)，主要数据已下载\nschema 可能变更，详见 /tmp/lark-api.log" \
      --level P2 --source lark-fallback --key "lark-api-partial-$TODAY" --channel digest
  fi
  log "主路径成功（失败 $API_FAILED < $FAIL_THRESHOLD），不切 fallback"
  exit 0
fi

# 真失败 - 切 Playwright（2026-06-24 做减法：不再推过程告警，静默切备路径）
log "主路径 API 真失败 ($API_FAILED >= $FAIL_THRESHOLD)，静默切 Playwright"

# ─── 备路径：Playwright ─────────────────────────────────
log "备路径 Playwright 开始（~5 分钟）"
timeout 600 node download-all-lark.js > "$LOG_PW" 2>&1
PW_EXIT=$?
PW_FAILED=$(parse_pw_failures)

log "Playwright 跑完 exit=$PW_EXIT, 失败 $PW_FAILED 个 tab"

if [ "$PW_FAILED" -lt "$FAIL_THRESHOLD" ]; then
  # 备路径成功：报喜走 digest（不打扰）
  python3 "$NOTIFY" "✅ Lark Playwright 备用路径成功（失败 $PW_FAILED 个 tab，可接受）\n时间: $(date '+%Y-%m-%d %H:%M')" \
    --level P1 --source lark-fallback --key "lark-pw-recovered-$TODAY" --channel digest
  exit 0
fi

# 双路径都真失败——2026-06-24 做减法：不再推 P0「双路径全部失败」。
# 理由：失败计数含大量良性情况（源 Data not ready 次日自愈 + 本就不存在的 tab），
#       且数据是否真到位由每日巡检(daily-audit) 的结果哨兵 lark_daily_kpi 滞后判定（一处说了算）。
# 这里只记日志 + 非0退出，不打扰飞书。
log "双路径都失败（API=$API_FAILED, PW=$PW_FAILED）——静默退出，交每日巡检结果哨兵判定，不推送"
exit 1
