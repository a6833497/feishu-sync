#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import requests
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime
import json
import sys

# 配置
FEISHU_API = "https://open.feishu.cn"
APP_ID = "cli_a96f5150fc39dcbd"
APP_SECRET = "HP60FpH8gP7XnRjY4TbOgeFykER1zmyK"
BITABLE_APP_TOKEN = "V1LNbTEv1aBvpXsRLU8cWzuhn6d"

# 表ID
TABLE1_ID = "tblpuILASabhtZRU"  # LK财务收支明细
TABLE2_ID = "tbl4oB4AOsIDa4TO"  # 周实际

# DB 配置
DB_CONFIG = {
    "host": "localhost",
    "database": "nova_dashboard",
    "user": "nova_app",
    "password": "Nova2026pg!"
}

def get_feishu_token():
    """获取飞书token"""
    url = f"{FEISHU_API}/open-apis/auth/v3/tenant_access_token/internal"
    resp = requests.post(url, json={
        "app_id": APP_ID,
        "app_secret": APP_SECRET
    })
    data = resp.json()
    if data.get("code") != 0:
        raise Exception(f"获取token失败: {data}")
    return data["tenant_access_token"]

def extract_text_field(value):
    """提取文本字段值"""
    if isinstance(value, str):
        return value
    if isinstance(value, list) and len(value) > 0:
        if isinstance(value[0], dict) and "text" in value[0]:
            return value[0]["text"]
    return None

def extract_number_field(value):
    """提取数字字段值"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return float(value)
        except:
            return None
    return None

def fetch_table_data(token, table_id, table_name):
    """分页拉取表数据"""
    url = f"{FEISHU_API}/open-apis/bitable/v1/apps/{BITABLE_APP_TOKEN}/tables/{table_id}/records"
    headers = {"Authorization": f"Bearer {token}"}
    
    records = []
    page_token = None
    
    while True:
        params = {"page_size": 500}
        if page_token:
            params["page_token"] = page_token
        
        try:
            resp = requests.get(url, headers=headers, params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            
            if data.get("code") == 403:
                print(f"[WARNING] 表 {table_name} 无权限 (403), 跳过")
                return None
            
            if data.get("code") != 0:
                print(f"[ERROR] 拉取表 {table_name} 失败: {data.get('msg')}")
                return None
            
            table_data = data.get("data", {})
            records.extend(table_data.get("items", []))
            
            if not table_data.get("has_more"):
                break
            
            page_token = table_data.get("page_token")
        
        except Exception as e:
            print(f"[ERROR] 请求异常 ({table_name}): {str(e)}")
            return None
    
    return records

def create_tables(conn):
    """创建PG表"""
    cur = conn.cursor()
    
    # 表1: 财务收支明细
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_finance_detail (
            record_id VARCHAR(50) PRIMARY KEY,
            level1_category VARCHAR(100),
            level2_category VARCHAR(255),
            filler VARCHAR(100),
            week_range VARCHAR(50),
            month VARCHAR(50),
            expense_date TIMESTAMP,
            amount NUMERIC(15, 2),
            is_split VARCHAR(50),
            payer VARCHAR(100),
            expense_details VARCHAR(500),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # 表2: 周实际
    cur.execute("""
        CREATE TABLE IF NOT EXISTS feishu_weekly_actual (
            record_id VARCHAR(50) PRIMARY KEY,
            week_start_date VARCHAR(50),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    conn.commit()
    print("[INFO] PG表创建完成")

def sync_finance_detail(conn, records):
    """同步财务收支明细"""
    if not records:
        print("[INFO] 表1无数据")
        return 0
    
    cur = conn.cursor()
    inserted = 0
    
    for record in records:
        fields = record.get("fields", {})
        record_id = record.get("record_id")
        
        try:
            # 解析字段
            level1 = fields.get("一级科目")
            level2 = fields.get("二级科目")
            filler = fields.get("填写人")
            week_range = extract_text_field(fields.get("对应周"))
            month = extract_text_field(fields.get("对应月"))
            
            # 日期: 毫秒时间戳转datetime
            expense_date = None
            if fields.get("开支日期"):
                timestamp_ms = int(fields.get("开支日期")) / 1000
                expense_date = datetime.fromtimestamp(timestamp_ms)
            
            amount = extract_number_field(fields.get("总金额"))
            is_split = extract_text_field(fields.get("是否分摊"))
            payer = fields.get("谁支出")
            details = fields.get("费用明细")

            # 12 个公会均摊列（2026-04-30 加入）
            guild_cols = {
                "印尼1-nova": extract_number_field(fields.get("印尼1-nova")),
                "印尼2-胡萝卜": extract_number_field(fields.get("印尼2-胡萝卜")),
                "印尼3-宝石": extract_number_field(fields.get("印尼3-宝石")),
                "印尼4-胡萝卜2": extract_number_field(fields.get("印尼4-胡萝卜2")),
                "巴西1-nova": extract_number_field(fields.get("巴西1-nova")),
                "巴西2-evain": extract_number_field(fields.get("巴西2-evain")),
                "巴西3-Wisky": extract_number_field(fields.get("巴西3-Wisky")),
                "巴西4-Doce": extract_number_field(fields.get("巴西4-Doce")),
                "西语1-nova": extract_number_field(fields.get("西语1-nova")),
                "西语2-evain": extract_number_field(fields.get("西语2-evain")),
                "其它公会": extract_number_field(fields.get("其它公会")),
                "公会JH": extract_number_field(fields.get("公会JH")),
            }
            
            # upsert
            sql = """
                INSERT INTO feishu_finance_detail
                (record_id, level1_category, level2_category, filler, week_range, month,
                 expense_date, amount, is_split, payer, expense_details,
                 "印尼1-nova", "印尼2-胡萝卜", "印尼3-宝石", "印尼4-胡萝卜2",
                 "巴西1-nova", "巴西2-evain", "巴西3-Wisky", "巴西4-Doce",
                 "西语1-nova", "西语2-evain", "其它公会", "公会JH",
                 updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                        CURRENT_TIMESTAMP)
                ON CONFLICT (record_id) DO UPDATE SET
                    level1_category = EXCLUDED.level1_category,
                    level2_category = EXCLUDED.level2_category,
                    filler = EXCLUDED.filler,
                    week_range = EXCLUDED.week_range,
                    month = EXCLUDED.month,
                    expense_date = EXCLUDED.expense_date,
                    amount = EXCLUDED.amount,
                    is_split = EXCLUDED.is_split,
                    payer = EXCLUDED.payer,
                    expense_details = EXCLUDED.expense_details,
                    "印尼1-nova" = EXCLUDED."印尼1-nova",
                    "印尼2-胡萝卜" = EXCLUDED."印尼2-胡萝卜",
                    "印尼3-宝石" = EXCLUDED."印尼3-宝石",
                    "印尼4-胡萝卜2" = EXCLUDED."印尼4-胡萝卜2",
                    "巴西1-nova" = EXCLUDED."巴西1-nova",
                    "巴西2-evain" = EXCLUDED."巴西2-evain",
                    "巴西3-Wisky" = EXCLUDED."巴西3-Wisky",
                    "巴西4-Doce" = EXCLUDED."巴西4-Doce",
                    "西语1-nova" = EXCLUDED."西语1-nova",
                    "西语2-evain" = EXCLUDED."西语2-evain",
                    "其它公会" = EXCLUDED."其它公会",
                    "公会JH" = EXCLUDED."公会JH",
                    updated_at = CURRENT_TIMESTAMP
            """
            
            cur.execute(sql, (
                record_id, level1, level2, filler, week_range, month,
                expense_date, amount, is_split, payer, details,
                guild_cols["印尼1-nova"], guild_cols["印尼2-胡萝卜"],
                guild_cols["印尼3-宝石"], guild_cols["印尼4-胡萝卜2"],
                guild_cols["巴西1-nova"], guild_cols["巴西2-evain"],
                guild_cols["巴西3-Wisky"], guild_cols["巴西4-Doce"],
                guild_cols["西语1-nova"], guild_cols["西语2-evain"],
                guild_cols["其它公会"], guild_cols["公会JH"],
            ))
            inserted += 1
        
        except Exception as e:
            print(f"[ERROR] 同步record {record_id} 失败: {str(e)}")
            continue
    
    conn.commit()
    print(f"[INFO] 表1 (财务收支明细) 同步完成: {inserted}条")
    return inserted

def sync_weekly_actual(conn, records):
    """同步周实际"""
    if not records:
        print("[INFO] 表2无数据")
        return 0
    
    cur = conn.cursor()
    inserted = 0
    
    for record in records:
        fields = record.get("fields", {})
        record_id = record.get("record_id")
        
        try:
            week_start = extract_text_field(fields.get("周起始日(周一)"))
            
            sql = """
                INSERT INTO feishu_weekly_actual (record_id, week_start_date, updated_at)
                VALUES (%s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT (record_id) DO UPDATE SET
                    week_start_date = EXCLUDED.week_start_date,
                    updated_at = CURRENT_TIMESTAMP
            """
            
            cur.execute(sql, (record_id, week_start))
            inserted += 1
        
        except Exception as e:
            print(f"[ERROR] 同步record {record_id} 失败: {str(e)}")
            continue
    
    conn.commit()
    print(f"[INFO] 表2 (周实际) 同步完成: {inserted}条")
    return inserted

def main():
    print("[START] 飞书财务数据同步开始...")
    
    try:
        # 获取token
        print("[*] 获取飞书token...")
        token = get_feishu_token()
        print(f"[OK] Token获取成功")
        
        # 连接PG
        print("[*] 连接PostgreSQL...")
        conn = psycopg2.connect(**DB_CONFIG)
        print(f"[OK] 数据库连接成功")
        
        # 创建表
        print("[*] 创建PG表...")
        create_tables(conn)
        
        # 拉取数据
        print("[*] 拉取表1 (LK财务收支明细)...")
        records1 = fetch_table_data(token, TABLE1_ID, "LK财务收支明细")
        
        print("[*] 拉取表2 (周实际)...")
        records2 = fetch_table_data(token, TABLE2_ID, "周实际")
        
        # 同步数据
        count1 = 0
        count2 = 0
        
        if records1 is not None:
            count1 = sync_finance_detail(conn, records1)
        else:
            print("[SKIP] 表1 无权限或错误，跳过同步")
        
        if records2 is not None:
            count2 = sync_weekly_actual(conn, records2)
        else:
            print("[SKIP] 表2 无权限或错误，跳过同步")
        
        conn.close()
        
        print(f"\n[SUCCESS] 同步完成！")
        print(f"  - 表1 (LK财务收支明细): {count1}条")
        print(f"  - 表2 (周实际): {count2}条")
    
    except Exception as e:
        print(f"[FATAL] {str(e)}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
