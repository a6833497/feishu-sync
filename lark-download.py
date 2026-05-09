#!/usr/bin/env python3
"""Lark 数据下载 + 导入 DB + 失败告警"""
import subprocess, os, json, sys
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
API_DIR = "/home/ubuntu/nova-dashboard-deploy-final/api"
CST = timezone(timedelta(hours=8))

def log(msg):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def send_alert(msg):
    """Lark 下载失败时通过飞书告警"""
    try:
        config = json.load(open(os.path.join(SCRIPT_DIR, "config.json")))
        token_data = json.dumps({
            "app_id": config["app_id"],
            "app_secret": config["app_secret"]
        }).encode()
        import urllib.request
        req = urllib.request.Request(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            data=token_data, headers={"Content-Type": "application/json"}
        )
        token = json.loads(urllib.request.urlopen(req).read())["tenant_access_token"]
        
        data = json.dumps({
            "receive_id": config["chat_id"],
            "msg_type": "text",
            "content": json.dumps({"text": msg})
        }).encode()
        req2 = urllib.request.Request(
            "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
            data=data,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )
        urllib.request.urlopen(req2)
    except Exception as e:
        log(f"告警发送失败: {e}")

log("=" * 40)
log("Lark 数据同步")

# Step 1: Playwright 下载 xlsx
log("Step 1: 下载 Lark xlsx...")
session_file = os.path.join(SCRIPT_DIR, "lark-session.json")
if not os.path.exists(session_file):
    msg = "🔴 Lark 会话文件不存在！请在 Mac 上运行 node ~/Nova-Dashboard/lark-login.mjs 重新登录"
    log(msg)
    send_alert(msg)
    sys.exit(1)

# 检查会话是否过期（文件修改时间超过25天就预警）
import time
age_days = (time.time() - os.path.getmtime(session_file)) / 86400
if age_days > 25:
    send_alert(f"⚠️ Lark 登录会话即将过期（已 {int(age_days)} 天），请尽快在 Mac 上运行 node ~/Nova-Dashboard/lark-login.mjs 刷新")

result = subprocess.run(
    ["node", os.path.join(SCRIPT_DIR, "lark-pw-download.js")],
    capture_output=True, text=True, timeout=600,
    cwd=SCRIPT_DIR
)

for line in (result.stdout or "").strip().split("\n"):
    if line: log(f"  {line}")

if result.returncode != 0:
    msg = "Lark download failed: " + (result.stderr or "")[:200]
    log(msg)
    send_alert(msg)
    sys.exit(1)

output = os.path.join(SCRIPT_DIR, "lark_data.json")
if not os.path.exists(output):
    msg = "🔴 Lark 下载完成但未生成 lark_data.json"
    log(msg)
    send_alert(msg)
    sys.exit(1)

data = json.load(open(output))
total = sum(len(v) for v in data.get("data", {}).values() if isinstance(v, list))
log(f"  下载完成: {total} 条记录")

# Step 2: 导入到 Nova DB
log("Step 2: 导入到数据库...")
result2 = subprocess.run(
    ["npx", "tsx", "src/scripts/lark-import.ts", output],
    capture_output=True, text=True, timeout=120,
    cwd=API_DIR
)
for line in (result2.stdout or "").strip().split("\n"):
    if line: log(f"  {line}")

if result2.returncode != 0:
    log("import warning: " + (result2.stderr or "")[:200])

# Step 3: BI vs Lark 差异检测
log("Step 3: BI vs Lark 差异检测...")
import subprocess as sp2
diff_result = sp2.run(
    ["npx", "tsx", "src/scripts/bi-lark-diff.ts"],
    capture_output=True, text=True, timeout=120,
    cwd=API_DIR
)
if diff_result.returncode == 0:
    for line in (diff_result.stdout or "").strip().split("\n"):
        if line: log("  " + line)
    # 如果有差异告警文件，推送到飞书
    alert_file = "/tmp/bi-lark-diff-alert.txt"
    if os.path.exists(alert_file):
        alert_text = open(alert_file).read()
        if alert_text.strip():
            send_alert(alert_text)
            log("  差异告警已推送飞书")
            os.remove(alert_file)

log("✅ Lark 同步完成")
log("=" * 40)
