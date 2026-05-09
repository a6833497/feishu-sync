#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书剩余6张表同步到PostgreSQL数据库
- 印尼注册日报
- LK对齐印尼
- 利润周报表-公会版
- LK每周进粉结算
- 大盘数据
- 日预估2026
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

# 表配置
TABLES_CONFIG = {
    "tblIMwzwPce2ty1N": {
        "name": "印尼注册日报",
        "pg_table": "feishu_indo_register",
    },
    "tblDoPoeBrSZ9CoY": {
        "name": "LK对齐印尼",
        "pg_table": "feishu_align_indo",
    },
    "tblWCN0GSZ2mNLsS": {
        "name": "利润周报表-公会版",
        "pg_table": "feishu_profit_weekly_guild",
    },
    "tblcBYCY6h4bqh2a": {
        "name": "LK每周进粉结算",
        "pg_table": "feishu_weekly_settlement",
    },
    "tblLqwcUXRFO0Pxx": {
        "name": "大盘数据",
        "pg_table": "feishu_dashboard_data",
    },
    "tbl8FxFh44AiSJIC": {
        "name": "日预估2026",
        "pg_table": "feishu_daily_estimate",
    },
}

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

def extract_text(v):
    """提取飞书文本字段"""
    if isinstance(v, list):
        if len(v) > 0 and isinstance(v[0], dict) and "text" in v[0]:
            return v[0]["text"]
        return None
    return str(v) if v is not None else None

def timestamp_to_date(ts_ms):
    """毫秒时间戳转日期字符串 YYYY-MM-DD"""
    if ts_ms is None:
        return None
    try:
        dt = datetime.fromtimestamp(int(ts_ms) / 1000, tz=CST)
        return dt.strftime("%Y-%m-%d")
    except:
        return None

def create_tables(conn):
    """创建所有PG表"""
    cur = conn.cursor()
    
    # 1. 印尼注册日报
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_indo_register (
            record_id VARCHAR(50) PRIMARY KEY,
            platform VARCHAR(100),
            region VARCHAR(100),
            service_name VARCHAR(100),
            success_registers INT,
            date DATE,
            register_rate NUMERIC(10, 6),
            shift VARCHAR(100),
            group_num VARCHAR(100),
            people_in_group INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 2. LK对齐印尼
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_align_indo (
            record_id VARCHAR(50) PRIMARY KEY,
            cpa_usd INT,
            dau NUMERIC(15, 2),
            s_female_ratio TEXT,
            s_female_count INT,
            streamer_income_usd NUMERIC(15, 2),
            weekly_new_register INT,
            female_arpu_usd NUMERIC(15, 6),
            weekly_actual_account_usd NUMERIC(15, 2),
            weekly_expected_account_usd INT,
            ad_spend_loss_usd INT,
            ad_spend_weekly_usd NUMERIC(15, 2),
            revenue_new_ratio TEXT,
            time_period VARCHAR(100),
            new_female_arpu_usd NUMERIC(15, 6),
            revenue_new_count INT,
            settlement_unit_price_usd NUMERIC(15, 2),
            voice_room_income_usd NUMERIC(15, 2),
            account_loss_usd NUMERIC(15, 6),
            account_loss_ratio NUMERIC(15, 6),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 3. 利润周报表-公会版 (29字段，核心字段出来，其余存data_json)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_profit_weekly_guild (
            record_id VARCHAR(50) PRIMARY KEY,
            guild_name VARCHAR(100),
            week_range VARCHAR(100),
            total_income NUMERIC(15, 2),
            total_expense NUMERIC(15, 2),
            net_profit NUMERIC(15, 2),
            net_profit_rate NUMERIC(15, 6),
            backend_registers INT,
            settlement_registers INT,
            settlement_rate NUMERIC(15, 6),
            cpa_income INT,
            cps_income NUMERIC(15, 2),
            data_json TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 4. LK每周进粉结算 (21字段，核心字段出来，其余存data_json)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_weekly_settlement (
            record_id VARCHAR(50) PRIMARY KEY,
            guild_name VARCHAR(100),
            region VARCHAR(100),
            week_range VARCHAR(100),
            month VARCHAR(100),
            cpa_usd INT,
            cps_usd NUMERIC(15, 2),
            settlement_registers INT,
            actual_account_usd NUMERIC(15, 2),
            expected_account_usd INT,
            expected_account_cny NUMERIC(15, 2),
            settlement_unit_price_usd NUMERIC(15, 2),
            data_json TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 5. 大盘数据
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_dashboard_data (
            record_id VARCHAR(50) PRIMARY KEY,
            guild_name VARCHAR(100),
            guild_type VARCHAR(100),
            region VARCHAR(100),
            date_range VARCHAR(100),
            daily_new INT,
            daily_active_anchors INT,
            revenue_per_user NUMERIC(15, 2),
            social_a_ratio NUMERIC(15, 6),
            social_a_female_count INT,
            one_on_one_consumption_usd INT,
            voice_room_consumption_usd INT,
            weekly_anchor_revenue_usd INT,
            weekly_driven_consumption_usd INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 6. 日预估2026 (22字段，核心字段出来，其余存data_json)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_daily_estimate (
            record_id VARCHAR(50) PRIMARY KEY,
            date DATE,
            month VARCHAR(100),
            week_day VARCHAR(100),
            effective_registers INT,
            people_in_group INT,
            personnel_cost_per_register NUMERIC(15, 2),
            staff_cost_other NUMERIC(15, 2),
            estimated_total_cost INT,
            estimated_revenue INT,
            estimated_gross_profit INT,
            data_json TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    conn.commit()
    cur.close()
    log("OK PG表创建完成")

def sync_indo_register(token, app_token, conn):
    """同步印尼注册日报"""
    log("开始同步 印尼注册日报...")
    table_id = "tblIMwzwPce2ty1N"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("今日注册平台"),
            fields.get("地区"),
            fields.get("客服姓名"),
            safe_int(fields.get("成功注册人数")),
            timestamp_to_date(fields.get("日期")),
            safe_float(fields.get("注册转化率")),
            fields.get("班次"),
            fields.get("群编号"),
            safe_int(fields.get("进群人数")),
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_indo_register
        (record_id, platform, region, service_name, success_registers, date, register_rate, shift, group_num, people_in_group)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            platform = EXCLUDED.platform,
            region = EXCLUDED.region,
            service_name = EXCLUDED.service_name,
            success_registers = EXCLUDED.success_registers,
            date = EXCLUDED.date,
            register_rate = EXCLUDED.register_rate,
            shift = EXCLUDED.shift,
            group_num = EXCLUDED.group_num,
            people_in_group = EXCLUDED.people_in_group,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 印尼注册日报: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 印尼注册日报: 无数据")
    cur.close()
    return len(rows)

def sync_align_indo(token, app_token, conn):
    """同步LK对齐印尼"""
    log("开始同步 LK对齐印尼...")
    table_id = "tblDoPoeBrSZ9CoY"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            safe_int(fields.get("CPA结算款/$")),
            safe_float(fields.get("DAU")),
            extract_text(fields.get("S女占比")),
            safe_int(fields.get("S女数量")),
            safe_float(fields.get("主播1v1收入/$")),
            safe_int(fields.get("周新增注册")),
            safe_float(fields.get("女arpu/$")),
            safe_float(fields.get("当周实进帐/$")),
            safe_int(fields.get("当周应进帐/$")),
            safe_float(fields.get("投放支出亏损/$")),
            safe_float(fields.get("投放款周支出/$")),
            extract_text(fields.get("收益新增占比")),
            fields.get("时间周期"),
            safe_float(fields.get("有收益 新女arpu/$")),
            safe_int(fields.get("有收益新增")),
            safe_float(fields.get("结算单价/$")),
            safe_float(fields.get("语音房收入/$")),
            safe_float(fields.get("进账损耗$")),
            safe_float(fields.get("进账损耗比例")),
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_align_indo
        (record_id, cpa_usd, dau, s_female_ratio, s_female_count, streamer_income_usd, weekly_new_register, female_arpu_usd,
         weekly_actual_account_usd, weekly_expected_account_usd, ad_spend_loss_usd, ad_spend_weekly_usd, revenue_new_ratio,
         time_period, new_female_arpu_usd, revenue_new_count, settlement_unit_price_usd, voice_room_income_usd, account_loss_usd, account_loss_ratio)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            cpa_usd = EXCLUDED.cpa_usd,
            dau = EXCLUDED.dau,
            s_female_ratio = EXCLUDED.s_female_ratio,
            s_female_count = EXCLUDED.s_female_count,
            streamer_income_usd = EXCLUDED.streamer_income_usd,
            weekly_new_register = EXCLUDED.weekly_new_register,
            female_arpu_usd = EXCLUDED.female_arpu_usd,
            weekly_actual_account_usd = EXCLUDED.weekly_actual_account_usd,
            weekly_expected_account_usd = EXCLUDED.weekly_expected_account_usd,
            ad_spend_loss_usd = EXCLUDED.ad_spend_loss_usd,
            ad_spend_weekly_usd = EXCLUDED.ad_spend_weekly_usd,
            revenue_new_ratio = EXCLUDED.revenue_new_ratio,
            time_period = EXCLUDED.time_period,
            new_female_arpu_usd = EXCLUDED.new_female_arpu_usd,
            revenue_new_count = EXCLUDED.revenue_new_count,
            settlement_unit_price_usd = EXCLUDED.settlement_unit_price_usd,
            voice_room_income_usd = EXCLUDED.voice_room_income_usd,
            account_loss_usd = EXCLUDED.account_loss_usd,
            account_loss_ratio = EXCLUDED.account_loss_ratio,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK LK对齐印尼: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP LK对齐印尼: 无数据")
    cur.close()
    return len(rows)

def sync_profit_weekly_guild(token, app_token, conn):
    """同步利润周报表-公会版"""
    log("开始同步 利润周报表-公会版...")
    table_id = "tblWCN0GSZ2mNLsS"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        # 存储所有字段到JSON
        data_json = json.dumps(fields, ensure_ascii=False, default=str)
        
        row = (
            rec.get("record_id"),
            fields.get("公会"),
            fields.get("对应周"),
            safe_float(fields.get("总收入")),
            safe_float(fields.get("总支出")),
            safe_float(fields.get("净利润")),
            safe_float(fields.get("净利润率")),
            safe_int(fields.get("后台注册量")),
            safe_int(fields.get("结算注册量", [None])[0]) if isinstance(fields.get("结算注册量"), list) else safe_int(fields.get("结算注册量")),
            safe_float(fields.get("结算率")),
            safe_int(fields.get("CPA收入")),
            safe_float(fields.get("CPS收入")),
            data_json,
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_profit_weekly_guild
        (record_id, guild_name, week_range, total_income, total_expense, net_profit, net_profit_rate,
         backend_registers, settlement_registers, settlement_rate, cpa_income, cps_income, data_json)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            week_range = EXCLUDED.week_range,
            total_income = EXCLUDED.total_income,
            total_expense = EXCLUDED.total_expense,
            net_profit = EXCLUDED.net_profit,
            net_profit_rate = EXCLUDED.net_profit_rate,
            backend_registers = EXCLUDED.backend_registers,
            settlement_registers = EXCLUDED.settlement_registers,
            settlement_rate = EXCLUDED.settlement_rate,
            cpa_income = EXCLUDED.cpa_income,
            cps_income = EXCLUDED.cps_income,
            data_json = EXCLUDED.data_json,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 利润周报表-公会版: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 利润周报表-公会版: 无数据")
    cur.close()
    return len(rows)

def sync_weekly_settlement(token, app_token, conn):
    """同步LK每周进粉结算"""
    log("开始同步 LK每周进粉结算...")
    table_id = "tblcBYCY6h4bqh2a"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        # 存储所有字段到JSON
        data_json = json.dumps(fields, ensure_ascii=False, default=str)
        
        row = (
            rec.get("record_id"),
            fields.get("公会"),
            fields.get("地区"),
            fields.get("预估周"),
            extract_text(fields.get("对应月")),
            safe_int(fields.get("CPA结算款/$")),
            safe_float(fields.get("CPS结算款/$")),
            safe_int(fields.get("周结算注册数")),
            safe_float(fields.get("当周实进帐/$")),
            safe_int(fields.get("当周应进帐/$")),
            safe_float(fields.get("当周应进帐/¥")),
            safe_float(fields.get("结算单价/$")),
            data_json,
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_weekly_settlement
        (record_id, guild_name, region, week_range, month, cpa_usd, cps_usd, settlement_registers,
         actual_account_usd, expected_account_usd, expected_account_cny, settlement_unit_price_usd, data_json)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            region = EXCLUDED.region,
            week_range = EXCLUDED.week_range,
            month = EXCLUDED.month,
            cpa_usd = EXCLUDED.cpa_usd,
            cps_usd = EXCLUDED.cps_usd,
            settlement_registers = EXCLUDED.settlement_registers,
            actual_account_usd = EXCLUDED.actual_account_usd,
            expected_account_usd = EXCLUDED.expected_account_usd,
            expected_account_cny = EXCLUDED.expected_account_cny,
            settlement_unit_price_usd = EXCLUDED.settlement_unit_price_usd,
            data_json = EXCLUDED.data_json,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK LK每周进粉结算: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP LK每周进粉结算: 无数据")
    cur.close()
    return len(rows)

def sync_dashboard_data(token, app_token, conn):
    """同步大盘数据"""
    log("开始同步 大盘数据...")
    table_id = "tblLqwcUXRFO0Pxx"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        row = (
            rec.get("record_id"),
            fields.get("公会"),
            fields.get("公会属性"),
            fields.get("地区"),
            fields.get("日期"),
            safe_int(fields.get("日新增")),
            safe_int(fields.get("主播日活")),
            safe_float(fields.get("人均创收")),
            safe_float(fields.get("社交A占比")),
            safe_int(fields.get("社交A女数")),
            safe_int(fields.get("1v1消费$")),
            safe_int(fields.get("语音房消费$")),
            safe_int(fields.get("周主播收益$")),
            safe_int(fields.get("周带动消费$")),
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_dashboard_data
        (record_id, guild_name, guild_type, region, date_range, daily_new, daily_active_anchors, revenue_per_user,
         social_a_ratio, social_a_female_count, one_on_one_consumption_usd, voice_room_consumption_usd,
         weekly_anchor_revenue_usd, weekly_driven_consumption_usd)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            guild_name = EXCLUDED.guild_name,
            guild_type = EXCLUDED.guild_type,
            region = EXCLUDED.region,
            date_range = EXCLUDED.date_range,
            daily_new = EXCLUDED.daily_new,
            daily_active_anchors = EXCLUDED.daily_active_anchors,
            revenue_per_user = EXCLUDED.revenue_per_user,
            social_a_ratio = EXCLUDED.social_a_ratio,
            social_a_female_count = EXCLUDED.social_a_female_count,
            one_on_one_consumption_usd = EXCLUDED.one_on_one_consumption_usd,
            voice_room_consumption_usd = EXCLUDED.voice_room_consumption_usd,
            weekly_anchor_revenue_usd = EXCLUDED.weekly_anchor_revenue_usd,
            weekly_driven_consumption_usd = EXCLUDED.weekly_driven_consumption_usd,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 大盘数据: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 大盘数据: 无数据")
    cur.close()
    return len(rows)

def sync_daily_estimate(token, app_token, conn):
    """同步日预估2026"""
    log("开始同步 日预估2026...")
    table_id = "tbl8FxFh44AiSJIC"
    records = fetch_all_records(token, app_token, table_id)
    
    rows = []
    for rec in records:
        fields = rec.get("fields", {})
        # 存储所有字段到JSON
        data_json = json.dumps(fields, ensure_ascii=False, default=str)
        
        row = (
            rec.get("record_id"),
            timestamp_to_date(fields.get("日期")),
            fields.get("月份"),
            extract_text(fields.get("周几")),
            safe_int(fields.get("有效注册数")),
            safe_int(fields.get("安徽(注册)")),
            safe_float(fields.get("单粉人工成本")),
            safe_float(fields.get("投流费用以外的支出")),
            safe_int(fields.get("预估成本合计(自动)")),
            safe_int(fields.get("预估收益")),
            safe_int(fields.get("预估毛利(自动)")),
            data_json,
        )
        rows.append(row)
    
    cur = conn.cursor()
    sql = """
        INSERT INTO feishu_daily_estimate
        (record_id, date, month, week_day, effective_registers, people_in_group, personnel_cost_per_register,
         staff_cost_other, estimated_total_cost, estimated_revenue, estimated_gross_profit, data_json)
        VALUES %s
        ON CONFLICT (record_id) DO UPDATE SET
            date = EXCLUDED.date,
            month = EXCLUDED.month,
            week_day = EXCLUDED.week_day,
            effective_registers = EXCLUDED.effective_registers,
            people_in_group = EXCLUDED.people_in_group,
            personnel_cost_per_register = EXCLUDED.personnel_cost_per_register,
            staff_cost_other = EXCLUDED.staff_cost_other,
            estimated_total_cost = EXCLUDED.estimated_total_cost,
            estimated_revenue = EXCLUDED.estimated_revenue,
            estimated_gross_profit = EXCLUDED.estimated_gross_profit,
            data_json = EXCLUDED.data_json,
            updated_at = CURRENT_TIMESTAMP
    """
    if rows:
        execute_values(cur, sql, rows)
        conn.commit()
        log(f"  OK 日预估2026: 同步 {len(rows)} 条")
    else:
        log(f"  SKIP 日预估2026: 无数据")
    cur.close()
    return len(rows)

def main():
    log("=" * 50)
    log("飞书剩余6张表同步到PostgreSQL - 开始")
    log("=" * 50)

    try:
        config = load_config()
        token = get_token(config)
        log(f"OK 飞书Token获取成功")

        app_token = config.get("bitable_app_token", "V1LNbTEv1aBvpXsRLU8cWzuhn6d")

        # 连接PG
        conn = psycopg2.connect(
            dbname="nova_dashboard",
            user="nova_app",
            password="Nova2026pg!",
            host="localhost",
            port=5432
        )
        log("OK PostgreSQL连接成功")

        # 创建表
        create_tables(conn)

        # 同步6张表
        total = 0
        total += sync_indo_register(token, app_token, conn)
        total += sync_align_indo(token, app_token, conn)
        total += sync_profit_weekly_guild(token, app_token, conn)
        total += sync_weekly_settlement(token, app_token, conn)
        total += sync_dashboard_data(token, app_token, conn)
        total += sync_daily_estimate(token, app_token, conn)

        conn.close()
        log("=" * 50)
        log(f"OK 同步完成！共导入 {total} 条数据")
        log("=" * 50)

    except Exception as e:
        log(f"ERROR: {e}")
        raise

if __name__ == "__main__":
    main()
