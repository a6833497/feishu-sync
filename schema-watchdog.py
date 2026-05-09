#!/usr/bin/env python3
"""
飞书表 schema 漂移监控（牛马中台）

每日 17:30 cron 跑一次（在 import-lark-all.js 完成 5 分钟后）
- 监控对象：飞书 LK 多维表里"要下载"清单的所有表（白名单制）
- 检测维度：字段名集合 / 行数 / 最新业务日期
- 历史快照存 /home/ubuntu/feishu-sync/.schema-history/<table_id>.json
- 告警通道：胖虎助理群（Nova 专用 webhook）

关键纪律：
- 首次跑只建基线，不告警
- 业务区域只看印尼/巴西/西语，土耳其/埃及/中东暂停业务忽略
- 飞书 API 每月有配额（参考 memory feedback_api_fallback_download.md），不要重复跑

2026-04-30 创建
"""
import os
import sys
import json
import urllib.request
import importlib.util
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── 配置 ──
APP_TOKEN = "V1LNbTEv1aBvpXsRLU8cWzuhn6d"
NOVA_WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/48dff4e9-fa26-4813-b0d7-8bb5a09399d6"
SNAPSHOT_DIR = Path("/home/ubuntu/feishu-sync/.schema-history")
SCRIPT_DIR = Path("/home/ubuntu/feishu-sync")
CST = timezone(timedelta(hours=8))

# 白名单：表名包含这些关键词的才监控（参考 memory project_data_sources_canonical.md）
# 2026-04-30 调整：备用金 6 表整组下架（不在牛马大盘体现），「投流日报」→「LK投流日报」精确匹配
WHITELIST_KEYWORDS = [
    "财务利润报表",     # 含 6 子表（利润周报表/月报表 等）
    "财务收支明细",
    "每周进粉",
    "大盘数据",
    "LK投流日报",      # 精确匹配 🌶️LK投流日报，避开历史废弃表「投流日报timovsfumi」
    # 2026-05-01 用户确认「胖虎看的流水账」「daya 数据」暂时不统计，移除关键词
    # 子表（标签页级）
    "利润周报表", "利润月报表", "单项查看", "利润&单价",
]

# 黑名单：即使表名在白名单里也跳过（"老数据"折叠组下的表）
BLACKLIST_KEYWORDS = [
    "老数据",
    "土耳其", "埃及", "中东",
    "lk每周结算",      # 用户明确不要
    "财务管理规范",
    "印尼注册日报",
    "查询页",
    "lk各公会日进线",  # 已废弃
    "timovsfumi",      # 投流日报timovsfumi 历史废弃表（2025-10 起未更新）
]


def log(msg: str):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


def in_whitelist(name: str) -> bool:
    name_lower = name.lower()
    for bad in BLACKLIST_KEYWORDS:
        if bad.lower() in name_lower:
            return False
    for good in WHITELIST_KEYWORDS:
        if good.lower() in name_lower:
            return True
    return False


def load_feishu_lib():
    """复用 feishu-to-db.py 的 fetch_all_records / get_token / load_config"""
    spec = importlib.util.spec_from_file_location(
        "f2db", str(SCRIPT_DIR / "feishu-to-db.py")
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def list_tables(token: str) -> list:
    """列 app 下所有表"""
    url = f"https://open.feishu.cn/open-apis/bitable/v1/apps/{APP_TOKEN}/tables?page_size=100"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("code") != 0:
        raise Exception(f"list_tables 失败: {resp.get('msg')}")
    return resp.get("data", {}).get("items", [])


def snapshot_table(records: list) -> dict:
    """从记录列表生成 schema 快照"""
    field_count = {}
    latest_date_ms = 0
    for r in records:
        f = r.get("fields", {})
        for k in f.keys():
            field_count[k] = field_count.get(k, 0) + 1
        # 找日期字段（"日期" / "开支日期" / "创建时间" 都可能）
        for date_key in ("日期", "开支日期", "创建时间", "录入日期"):
            v = f.get(date_key)
            if isinstance(v, (int, float)) and v > latest_date_ms:
                latest_date_ms = int(v)
                break
    return {
        "row_count": len(records),
        "fields": field_count,
        "latest_record_ms": latest_date_ms,
        "snapshot_at": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
    }


def diff_snapshots(old: dict, new: dict, table_name: str) -> list[str]:
    """对比两份快照，返回告警消息列表（空列表 = 无变化）"""
    alerts = []

    # 1. 字段名变化
    old_fields = set(old.get("fields", {}).keys())
    new_fields = set(new.get("fields", {}).keys())
    added = new_fields - old_fields
    removed = old_fields - new_fields
    if added:
        alerts.append(f"  ➕ 新增字段: {', '.join(sorted(added))}")
    if removed:
        alerts.append(f"  ➖ 删除字段: {', '.join(sorted(removed))}")

    # 2. 行数骤减 >30%
    old_rows = old.get("row_count", 0)
    new_rows = new.get("row_count", 0)
    if old_rows >= 50 and new_rows < old_rows * 0.7:
        pct = (new_rows - old_rows) / old_rows * 100
        alerts.append(f"  📉 行数骤减: {old_rows} → {new_rows} ({pct:+.1f}%)")
    elif old_rows == 0 and new_rows > 100:
        alerts.append(f"  📈 行数从 0 → {new_rows}（首次有数据）")

    # 3. 最新日期超过 48h 没新增
    new_latest = new.get("latest_record_ms", 0)
    if new_latest > 0:
        latest_dt = datetime.fromtimestamp(new_latest / 1000, CST)
        now = datetime.now(CST)
        hours_lag = (now - latest_dt).total_seconds() / 3600
        if hours_lag > 48:
            alerts.append(f"  ⏰ 最新记录滞后: {latest_dt.strftime('%Y-%m-%d')}（{hours_lag:.0f} 小时前）")

    return alerts


def send_alert(text: str):
    """发飞书消息到胖虎助理群（统一走 feishu-notify.py 链路 B，2026-04-30 修：之前 bot webhook 发到了 Lark 错群）"""
    import subprocess
    try:
        result = subprocess.run(
            ["python3", "/home/ubuntu/nova-auto-download/feishu-notify.py", text],
            capture_output=True, timeout=15,
        )
        if b"OK" in result.stdout:
            log("  ✓ 飞书告警已发送（feishu-notify.py → 胖虎助理群）")
        else:
            log(f"  ✗ feishu-notify 返回: stdout={result.stdout!r} stderr={result.stderr!r}")
    except Exception as e:
        log(f"  ✗ feishu-notify 调用失败: {e}")



# ──────────────────────────────────────────────────────────
# 🆕 2026-05-03 新增：Lark CSV 列变更监控
# 背景：5-3 发现 import-lark-all.js 因 CSV 加 3 列被静默偏移导致 lark_daily_kpi 字段错位
# 防御：监控 lark-exports/*.csv 的列数 + 列名 fingerprint，变化立刻告警
# ──────────────────────────────────────────────────────────

import csv
import hashlib

LARK_CSV_DIR = Path("/home/ubuntu/feishu-sync/lark-exports")
CSV_SNAPSHOT_DIR = Path("/home/ubuntu/feishu-sync/.csv-schema-history")


def csv_fingerprint(csv_path: Path) -> dict:
    """读 CSV 第 1 行（列名）+ 总行数，生成 schema fingerprint"""
    try:
        with open(csv_path, encoding="utf-8-sig") as fh:
            rows = list(csv.reader(fh))
        if len(rows) < 2:
            return {"col_count": 0, "headers": [], "header_hash": "", "row_count": len(rows)}
        # 公会_*.csv 第 0 行是分类，第 1 行才是真列名
        # 印尼/巴西/西语聊天_*.csv 也是同样结构
        # 印尼聊天_日数据.csv 前 4 列为空，从第 4 列才有列名 → 用第 1 行就行
        header_row = rows[1] if len(rows) > 1 else rows[0]
        headers = [h.replace("\n", " ").strip() for h in header_row]
        # 拼接所有列名做 hash（顺序敏感）
        header_str = "|".join(headers)
        header_hash = hashlib.sha256(header_str.encode("utf-8")).hexdigest()[:16]
        return {
            "col_count": len(headers),
            "headers": headers,
            "header_hash": header_hash,
            "row_count": len(rows),
        }
    except Exception as e:
        return {"error": str(e), "col_count": 0, "headers": [], "header_hash": "", "row_count": 0}


def diff_csv_snapshots(old: dict, new: dict, filename: str) -> list[str]:
    alerts = []
    old_cols = set(old.get("headers", []))
    new_cols = set(new.get("headers", []))
    added = new_cols - old_cols
    removed = old_cols - new_cols

    if added:
        alerts.append(f"  ➕ 新增列: {', '.join(sorted(added))}")
    if removed:
        alerts.append(f"  ➖ 删除列: {', '.join(sorted(removed))}")

    # 列顺序变化（即便没有增删，顺序变了 import 脚本也会错位）
    if old.get("header_hash") and new.get("header_hash") and old["header_hash"] != new["header_hash"] and not added and not removed:
        alerts.append(f"  🔀 列顺序变化（hash {old['header_hash'][:8]} → {new['header_hash'][:8]}）")

    # 列数变化（双重保险）
    old_n = old.get("col_count", 0)
    new_n = new.get("col_count", 0)
    if old_n != new_n:
        alerts.append(f"  📐 列数变化: {old_n} → {new_n}")

    return alerts


def monitor_lark_csvs():
    """扫 lark-exports/*.csv，对比 snapshot"""
    log("── Lark CSV 列变更巡检 ──")
    CSV_SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

    if not LARK_CSV_DIR.exists():
        log(f"  CSV 目录不存在: {LARK_CSV_DIR}")
        return []

    csv_files = sorted(LARK_CSV_DIR.glob("*.csv"))
    log(f"  扫描 {len(csv_files)} 个 CSV 文件")

    is_first_run = not any(CSV_SNAPSHOT_DIR.glob("*.json"))
    all_csv_alerts = []

    for csv_path in csv_files:
        filename = csv_path.name
        new_fp = csv_fingerprint(csv_path)
        if new_fp.get("error"):
            log(f"  ✗ {filename}: {new_fp['error']}")
            continue

        snap_file = CSV_SNAPSHOT_DIR / f"{filename}.json"
        new_fp["snapshot_at"] = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")

        if is_first_run or not snap_file.exists():
            with open(snap_file, "w") as f:
                json.dump(new_fp, f, ensure_ascii=False, indent=2)
            log(f"  📌 {filename}: 基线 {new_fp['col_count']} 列 / {new_fp['row_count']} 行")
            continue

        with open(snap_file) as f:
            old_fp = json.load(f)

        alerts = diff_csv_snapshots(old_fp, new_fp, filename)
        if alerts:
            log(f"  ⚠️ {filename}: 列变化")
            for a in alerts:
                log(a)
            all_csv_alerts.append((filename, alerts))

        # 覆盖快照
        with open(snap_file, "w") as f:
            json.dump(new_fp, f, ensure_ascii=False, indent=2)

    return all_csv_alerts


def main():
    log("=" * 60)
    log("schema-watchdog 启动")
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

    f2db = load_feishu_lib()
    cfg = f2db.load_config()
    token = f2db.get_token(cfg)

    # 列所有表
    tables = list_tables(token)
    log(f"  app 下总表数: {len(tables)}")

    monitored = [t for t in tables if in_whitelist(t.get("name", ""))]
    log(f"  白名单内待监控: {len(monitored)} 张")

    all_alerts = []
    is_first_run = not any(SNAPSHOT_DIR.glob("*.json"))

    for t in monitored:
        tid = t["table_id"]
        name = t["name"]
        log(f"  · {name} ({tid})")

        try:
            records = f2db.fetch_all_records(token, APP_TOKEN, tid)
        except Exception as e:
            log(f"    ✗ 读取失败: {e}")
            continue

        new_snap = snapshot_table(records)
        new_snap["table_name"] = name
        snap_file = SNAPSHOT_DIR / f"{tid}.json"

        if is_first_run or not snap_file.exists():
            with open(snap_file, "w") as f:
                json.dump(new_snap, f, ensure_ascii=False, indent=2)
            log(f"    📌 基线已建立: 行数={new_snap['row_count']} 字段={len(new_snap['fields'])}")
            continue

        with open(snap_file) as f:
            old_snap = json.load(f)

        alerts = diff_snapshots(old_snap, new_snap, name)
        if alerts:
            log(f"    ⚠️ 检测到变化:")
            for a in alerts:
                log(a)
            all_alerts.append((name, alerts))

        # 写入新快照（覆盖旧的）
        with open(snap_file, "w") as f:
            json.dump(new_snap, f, ensure_ascii=False, indent=2)

    # 🆕 2026-05-03 加：扫描 Lark CSV 列变更
    csv_alerts = monitor_lark_csvs()

    # 发告警（飞书 + CSV 合并）
    if all_alerts or csv_alerts:
        msg = ["🚨 [牛马中台] schema 漂移检测", ""]
        if all_alerts:
            msg.append("=== 飞书表变化 ===")
            for name, alerts in all_alerts:
                msg.append(f"📋 {name}")
                msg.extend(alerts)
                msg.append("")
        if csv_alerts:
            msg.append("=== Lark CSV 列变化（可能导致 import 偏移）===")
            for name, alerts in csv_alerts:
                msg.append(f"📄 {name}")
                msg.extend(alerts)
                msg.append("")
        msg.append(f"巡检时间: {datetime.now(CST).strftime('%Y-%m-%d %H:%M')} CST")
        send_alert("\n".join(msg))
    elif is_first_run:
        log(f"  首次跑：基线已建立 {len(monitored)} 张表 + {len(list(CSV_SNAPSHOT_DIR.glob('*.json')))} 个 CSV，无告警")
    else:
        log(f"  ✅ 所有表 + CSV schema 无变化")

    log("schema-watchdog 完成")
    log("=" * 60)


if __name__ == "__main__":
    main()
