#!/usr/bin/env python3
"""
飞书4张核心表同步到PostgreSQL数据库
- LK投流日报
- LK各公会日进线
- 客服优质占比
- 投手优质占比
"""

import json
import os
import urllib.request
from datetime import datetime, timezone, timedelta
import psycopg2
from psycopg2.extras import execute_values

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")

CST = timezone(timedelta(hours=8))

def log(msg):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)

def get_token(config):
    api_base = config.get("api_base", "https://open.feishu.cn")
    data = json.dumps({
        "app_id": config["app_id"],
        "app_secret": config["app_secret"]
    }).encode()
    req = urllib.request.Request(
        f"{api_base}/open-apis/auth/v3/tenant_access_token/internal",
        data=data,
        headers={"Content-Type": "application/json"}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("code") != 0:
        raise Exception(f"获取token失败: {resp.get('msg')}")
    return resp["tenant_access_token"]

def fetch_all_records(token, app_token, table_id, api_base="https://open.feishu.cn"):
    """拉取飞书表的所有记录"""
    records = []
    page_token = None
    page_num = 0
    while True:
        url = f"{api_base}/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records?page_size=500"
        if page_token:
            url += f"&page_token={page_token}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        for attempt in range(3):
            try:
                resp = json.loads(urllib.request.urlopen(req).read())
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    body = e.read().decode()[:200]
                    if "quota" in body.lower() or "exceeded" in body.lower():
                        raise Exception(f"API月度配额已用完，等下月重置")
                    if attempt < 2:
                        import time; time.sleep([5, 15][attempt])
                        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
                        continue
                raise
        if resp.get("code") != 0:
            raise Exception(f"读取记录失败: {resp.get('msg')}")
        items = resp.get("data", {}).get("items", [])
        records.extend(items)
        if not resp.get("data", {}).get("has_more"):
            break
        page_token = resp["data"].get("page_token")
        page_num += 1
        if page_num % 3 == 0:
            import time; time.sleep(1)
    return records

def extract_text(v):
    """提取飞书文本字段"""
    if isinstance(v, list):
        parts = []
        for item in v:
            if isinstance(item, dict):
                parts.append(item.get("text", item.get("name", str(item))))
            else:
                parts.append(str(item))
        return ", ".join(parts)
    return str(v) if v is not None else ""

def safe_int(v, default=None):
    if v is None or v == "":
        return default
    try:
        return int(str(v).replace(",", ""))
    except:
        return default

def safe_float(v, default=None):
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", "").rstrip("%"))
    except:
        return default

def sync_lk_ad_daily(token, app_token, conn):
    """同步LK投流日报"""
    log("开始同步 LK投流日报...")
    table_id = "tblhOKoz6hEroVGG"
    records = fetch_all_records(token, app_token, table_id)

    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("日期"),
            fields.get("地区"),
            fields.get("对应工会"),
            fields.get("注册平台"),
            fields.get("Linky当日钻石数"),
            fields.get("进群人数"),
            safe_float(fields.get("花费（USD）")),
            safe_int(fields.get("注册人数")),
            safe_float(fields.get("注册率")),
            safe_float(fields.get("注册成本（有效CPA）")),
            safe_float(fields.get("CPA（进群成本）")),
            safe_float(extract_text(fields.get("赚钱转化率"))),
            extract_text(fields.get("周几")),
            extract_text(fields.get("月份")),
        )
        rows.append(row)

    cur = conn.cursor()
    sql = """
        INSERT INTO lk_ad_daily
        (record_id, date, region, guild_name, platform, daily_diamond_num, diamond_count,
         spend_usd, registers, register_rate, register_cost, cpa, earning_rate, week_day, month)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            date = EXCLUDED.date,
            region = EXCLUDED.region,
            guild_name = EXCLUDED.guild_name,
            platform = EXCLUDED.platform,
            daily_diamond_num = EXCLUDED.daily_diamond_num,
            diamond_count = EXCLUDED.diamond_count,
            spend_usd = EXCLUDED.spend_usd,
            registers = EXCLUDED.registers,
            register_rate = EXCLUDED.register_rate,
            register_cost = EXCLUDED.register_cost,
            cpa = EXCLUDED.cpa,
            earning_rate = EXCLUDED.earning_rate,
            week_day = EXCLUDED.week_day,
            month = EXCLUDED.month,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK LK投流日报: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP LK投流日报: 无数据")
    cur.close()
    return len(rows)

def sync_lk_guild_daily(token, app_token, conn):
    """同步LK各公会日进线"""
    log("开始同步 LK各公会日进线...")
    table_id = "tblpoEJVIFODsk0O"
    records = fetch_all_records(token, app_token, table_id)

    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("公会名称"),
            fields.get("地区"),
            fields.get("日期"),
            extract_text(fields.get("对应周")),
            extract_text(fields.get("对应月")),
            safe_int(fields.get("后台注册数")),
        )
        rows.append(row)

    cur = conn.cursor()
    sql = """
        INSERT INTO lk_guild_daily
        (record_id, guild_name, region, date, week, month, backend_registers)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            region = EXCLUDED.region,
            date = EXCLUDED.date,
            week = EXCLUDED.week,
            month = EXCLUDED.month,
            backend_registers = EXCLUDED.backend_registers,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK LK各公会日进线: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP LK各公会日进线: 无数据")
    cur.close()
    return len(rows)

def sync_customer_service_quality(token, app_token, conn):
    """同步客服优质占比"""
    log("开始同步 客服优质占比...")
    table_id = "tbliStDX24WdvLNb"
    records = fetch_all_records(token, app_token, table_id)

    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("客服"),
            fields.get("对应的投手"),
            fields.get("日期"),
            safe_int(fields.get("接粉数")),
            safe_int(fields.get("注册数")),
            extract_text(fields.get("注册率")),
            safe_int(fields.get("优质数")),
            safe_float(fields.get("优质")),
        )
        rows.append(row)

    cur = conn.cursor()
    sql = """
        INSERT INTO customer_service_quality
        (record_id, service_name, matching_operator, date, powder_num, register_num,
         register_rate, quality_num, quality_rate)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            service_name = EXCLUDED.service_name,
            matching_operator = EXCLUDED.matching_operator,
            date = EXCLUDED.date,
            powder_num = EXCLUDED.powder_num,
            register_num = EXCLUDED.register_num,
            register_rate = EXCLUDED.register_rate,
            quality_num = EXCLUDED.quality_num,
            quality_rate = EXCLUDED.quality_rate,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 客服优质占比: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 客服优质占比: 无数据")
    cur.close()
    return len(rows)

def sync_operator_quality(token, app_token, conn):
    """同步投手优质占比"""
    log("开始同步 投手优质占比...")
    table_id = "tblDsAb4DAJKNWRN"
    records = fetch_all_records(token, app_token, table_id)

    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("投手"),
            fields.get("日期"),
            safe_int(fields.get("注册数")),
            safe_int(fields.get("进粉数")),
            fields.get("群"),
            fields.get("优质用户"),
            safe_float(fields.get("优质占比")),
            safe_float(fields.get("文本 3")),
        )
        rows.append(row)

    cur = conn.cursor()
    sql = """
        INSERT INTO operator_quality
        (record_id, operator_name, date, register_num, powder_num, group_num, quality_user_num, quality_rate, field_text_3)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            operator_name = EXCLUDED.operator_name,
            date = EXCLUDED.date,
            register_num = EXCLUDED.register_num,
            powder_num = EXCLUDED.powder_num,
            group_num = EXCLUDED.group_num,
            quality_user_num = EXCLUDED.quality_user_num,
            quality_rate = EXCLUDED.quality_rate,
            field_text_3 = EXCLUDED.field_text_3,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 投手优质占比: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 投手优质占比: 无数据")
    cur.close()
    return len(rows)

def main():
    log("=" * 50)
    log("飞书数据同步到PostgreSQL - 开始")
    log("=" * 50)

    try:
        config = load_config()
        token = get_token(config)
        log(f"OK 飞书Token获取成功")

        app_token = "V1LNbTEv1aBvpXsRLU8cWzuhn6d"

        # 连接PG
        conn = psycopg2.connect(
            dbname="nova_dashboard",
            user="nova_app",
            password="Nova2026pg!",
            host="localhost",
            port=5432
        )
        log("OK PostgreSQL连接成功")

        # 同步4张表
        total = 0
        total += sync_lk_ad_daily(token, app_token, conn)
        total += sync_lk_guild_daily(token, app_token, conn)
        total += sync_customer_service_quality(token, app_token, conn)
        total += sync_operator_quality(token, app_token, conn)

        conn.close()
        log("=" * 50)
        log(f"OK 同步完成！共导入 {total} 条数据")
        log("=" * 50)

    except Exception as e:
        log(f"ERROR: {e}")
        raise

if __name__ == "__main__":
    main()
