#!/usr/bin/env python3
"""
从 Lark 公会_日核心指标.csv 读「计划注册数」按周聚合 → 写入 guild_targets

修复（2026-05-01）：仪表盘「目标」字段曾用 SUM(实际注册数)（错），
改为 Lark「公会最核心指标 / 日核心指标」E 列「计划注册数」（运营录入的真目标），按周聚合。

依赖：
- /home/ubuntu/feishu-sync/lark-exports/公会_日核心指标.csv（lark-export.py 每天 15:20 下载）
- guild_targets PG 表（unique on guildAlias+weekKey）

cron: 30 15 * * * （在 lark-export 之后 10 分钟）
"""
import csv
import os
import sys
import psycopg2
from datetime import datetime, timezone, timedelta

CSV_PATH = "/home/ubuntu/feishu-sync/lark-exports/公会_日核心指标.csv"
PG_CONN = dict(
    host="127.0.0.1", port=5432, database="nova_dashboard",
    user="nova_app", password="Nova2026pg!",
)
CST = timezone(timedelta(hours=8))


def log(msg):
    print(f"[{datetime.now(CST).strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def parse_date(s):
    """'2026/4/30' → date"""
    try:
        return datetime.strptime(s.strip(), "%Y/%m/%d").date()
    except Exception:
        return None


def week_key(d):
    """date → 'MM/DD~MM/DD' (周一~周日)"""
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    return f"{monday.month:02d}/{monday.day:02d}~{sunday.month:02d}/{sunday.day:02d}"


def main():
    log("[Lark 目标同步] 开始")

    if not os.path.exists(CSV_PATH):
        log(f"  ❌ CSV 不存在: {CSV_PATH}")
        return 1

    # 解析 CSV
    week_guild_map = {}
    with open(CSV_PATH, encoding="utf-8-sig") as f:
        reader = list(csv.reader(f))

    parsed_rows = 0
    for row in reader[2:]:  # 跳过 2 行 header
        if len(row) < 5:
            continue
        d = parse_date(row[2])
        guild = (row[3] or "").strip()
        try:
            planned = int(row[4]) if row[4] and row[4].strip() else 0
        except (ValueError, TypeError):
            planned = 0
        if not d or not guild or planned <= 0:
            continue
        wk = week_key(d)
        key = (wk, guild)
        week_guild_map[key] = week_guild_map.get(key, 0) + planned
        parsed_rows += 1

    log(f"  解析 {parsed_rows} 行有效，聚合为 {len(week_guild_map)} 个 (周, 公会) 组合")

    if not week_guild_map:
        log("  ⚠️ 无有效数据，退出")
        return 1

    # 写入 PG（强制覆盖）
    conn = psycopg2.connect(**PG_CONN)
    cur = conn.cursor()
    inserts = 0
    updates = 0
    for (wk, guild), planned in sorted(week_guild_map.items()):
        cur.execute(
            'SELECT "plannedRegistrations" FROM guild_targets WHERE "guildAlias"=%s AND "weekKey"=%s',
            (guild, wk),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(
                'INSERT INTO guild_targets ("guildAlias","weekKey","plannedRegistrations","createdAt") VALUES (%s,%s,%s,NOW())',
                (guild, wk, planned),
            )
            inserts += 1
        elif row[0] != planned:
            cur.execute(
                'UPDATE guild_targets SET "plannedRegistrations"=%s WHERE "guildAlias"=%s AND "weekKey"=%s',
                (planned, guild, wk),
            )
            updates += 1

    conn.commit()
    cur.close()
    conn.close()

    log(f"  ✅ INSERT {inserts} / UPDATE {updates}")

    # 打印最近 3 周对账
    log("  最近 3 周目标快照：")
    conn = psycopg2.connect(**PG_CONN)
    cur = conn.cursor()
    cur.execute("""
        SELECT "weekKey", "guildAlias", "plannedRegistrations"
        FROM guild_targets
        WHERE "weekKey" IN (SELECT "weekKey" FROM guild_targets ORDER BY "weekKey" DESC LIMIT 3)
        ORDER BY "weekKey" DESC, "guildAlias"
    """)
    for r in cur.fetchall():
        log(f"    {r[0]} | {r[1]:6s} | {r[2]:>5}")
    cur.close()
    conn.close()

    log("[Lark 目标同步] 完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
