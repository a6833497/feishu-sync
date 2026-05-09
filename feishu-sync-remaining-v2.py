#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
飞书多维表格数据补齐脚本
统一拉取28张未入库表，分页获取全量数据，入库PG
"""

import requests
import json
import psycopg2
from psycopg2.extras import execute_values
import os
import sys
import re
from datetime import datetime

# 飞书API配置
APP_ID = "cli_a96f5150fc39dcbd"
APP_SECRET = "HP60FpH8gP7XnRjY4TbOgeFykER1zmyK"
BITABLE_TOKEN = "V1LNbTEv1aBvpXsRLU8cWzuhn6d"
BASE_URL = "https://open.feishu.cn/open-apis/bitable/v1"

# PG连接配置
PG_CONFIG = {
    "host": "localhost",
    "user": "nova_app",
    "password": "Nova2026pg!",
    "database": "nova_dashboard"
}

# 未入库的表列表（table_id | 名称）
TABLES_TO_SYNC = [
    ("tbl9XoQM4m7PBnp7", "利润周报表"),
    ("tbl3tBztJkQPJPJR", "利润月报表-公会版"),
    ("tblFRwXcuCBCUP4x", "利润月报表"),
    ("tblucPlmocDJegHT", "单项查看"),
    ("tblm3PIDbtlb2d75", "备用金-小美"),
    ("tblhWjaqUdNd4kMI", "备用金-老严"),
    ("tblJRs2uQrCz70mg", "备用金-佳佳"),
    ("tbltEBAA2X9WH4vP", "备用金-英子"),
    ("tblwtrwvMdppCvRE", "备用金-大牙"),
    ("tblaNOi9TP5gIGMQ", "备用金-紫币"),
    ("tblRKbPkWEDatbcV", "日预估10月"),
    ("tbl2kALGYdO53gaL", "日预估12月"),
    ("tbluoR3ebdQxfezR", "日预估11月"),
    ("tblKDetR3CLJ8vq0", "PH-Linky主播数据"),
    ("tblUd1EhtnIeAp9s", "ID-Linky主播数据"),
    ("tbl8xTIweISMTIlo", "LK对齐巴西"),
    ("tblxoGE7fGZsrHWk", "LK对齐中东"),
    ("tblbnCxGAobYrKmD", "LK对齐菲律宾"),
    ("tblPzCfGM3cO7hN6", "8月运营日报"),
    ("tblhmAMHuyknUzJQ", "fumi和云总对齐"),
    ("tbl4XvqJVviuuDT6", "TIMO"),
    ("tblTcyinVo3GMjaN", "D1.D3.D7"),
    ("tblvl5Ey9YBMXuNC", "Linky主播数据"),
    ("tblYo7MOSoUIgG0I", "运营日报"),
    ("tbl6OjBu7llLHPmY", "投流日报timovsfumi"),
    ("tbll9BaxogxfYefl", "优质与次留占比"),
    ("tbliNCEYaRflEoag", "每日进粉数据"),
    ("tblLAAeRGgIBAzwj", "数据表"),
]

class FeishuSync:
    def __init__(self):
        self.token = None
        self.conn = None
        self.results = []

    def get_tenant_token(self):
        """获取飞书tenant_access_token"""
        url = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"
        payload = {
            "app_id": APP_ID,
            "app_secret": APP_SECRET
        }
        try:
            resp = requests.post(url, json=payload, timeout=10)
            data = resp.json()
            if data.get("code") == 0:
                self.token = data.get("tenant_access_token")
                print(f"[√] 获取token成功: {self.token[:20]}...")
                return True
            else:
                print(f"[✗] 获取token失败: {data.get('msg')}")
                return False
        except Exception as e:
            print(f"[✗] 获取token异常: {e}")
            return False

    def connect_pg(self):
        """连接PG数据库"""
        try:
            self.conn = psycopg2.connect(**PG_CONFIG)
            print(f"[√] PG连接成功")
            return True
        except Exception as e:
            print(f"[✗] PG连接失败: {e}")
            return False

    def safe_table_name(self, name):
        """生成安全的表名：feishu_{safe_name}"""
        # 保留中文、字母、数字、下划线，其余替换为下划线
        safe = re.sub(r'[^\w\u4e00-\u9fff]', '_', name)
        safe = re.sub(r'_+', '_', safe)  # 多个下划线合并为一个
        safe = safe.strip('_')  # 移除首尾下划线
        return f"feishu_{safe}"

    def fetch_all_records(self, table_id):
        """
        分页获取表的全量数据
        必须分页：page_size=500，用has_more+page_token循环直到拿完
        """
        records = []
        page_token = None
        total_api = None

        headers = {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json"
        }

        while True:
            try:
                params = {"page_size": 500}
                if page_token:
                    params["page_token"] = page_token

                url = f"{BASE_URL}/apps/{BITABLE_TOKEN}/tables/{table_id}/records"
                resp = requests.get(url, headers=headers, params=params, timeout=30)
                data = resp.json()

                if data.get("code") != 0:
                    print(f"  [✗] API错误: {data.get('msg')}")
                    return None

                resp_data = data.get("data", {})
                items = resp_data.get("items", [])
                records.extend(items)

                # 首次请求时记录API返回的total
                if total_api is None and "total" in resp_data:
                    total_api = resp_data["total"]

                # 检查是否还有更多数据
                if not resp_data.get("has_more"):
                    break

                page_token = resp_data.get("page_token")
                if not page_token:
                    break

            except Exception as e:
                print(f"  [✗] 拉取数据异常: {e}")
                return None

        return records, total_api

    def create_table(self, table_name, record_id):
        """创建PG表，record_id作为唯一键"""
        cur = self.conn.cursor()
        try:
            # 删除旧表（如果存在）
            cur.execute(f"DROP TABLE IF EXISTS {table_name} CASCADE")

            # 创建新表：record_id + data (JSONB)
            create_sql = f"""
            CREATE TABLE {table_name} (
                id SERIAL PRIMARY KEY,
                record_id VARCHAR(255) UNIQUE NOT NULL,
                data JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX idx_{table_name}_record_id ON {table_name}(record_id);
            CREATE INDEX idx_{table_name}_data ON {table_name} USING GIN(data);
            """
            cur.execute(create_sql)
            self.conn.commit()
            print(f"  [√] 表 {table_name} 创建成功")
            return True
        except Exception as e:
            self.conn.rollback()
            print(f"  [✗] 创建表失败: {e}")
            return False
        finally:
            cur.close()

    def insert_records(self, table_name, records):
        """批量插入记录"""
        if not records:
            return 0

        cur = self.conn.cursor()
        try:
            # 准备数据：(record_id, data_json)
            values = []
            for rec in records:
                record_id = rec.get("record_id", "")
                fields = rec.get("fields", {})
                values.append((record_id, json.dumps(fields, ensure_ascii=False)))

            # 批量插入
            insert_sql = f"""
            INSERT INTO {table_name} (record_id, data)
            VALUES %s
            ON CONFLICT (record_id) DO UPDATE SET
                data = EXCLUDED.data,
                updated_at = CURRENT_TIMESTAMP
            """

            execute_values(cur, insert_sql, values)
            self.conn.commit()
            inserted = len(values)
            print(f"  [√] 插入 {inserted} 条记录")
            return inserted
        except Exception as e:
            self.conn.rollback()
            print(f"  [✗] 插入数据失败: {e}")
            return 0
        finally:
            cur.close()

    def sync_table(self, table_id, table_name_cn):
        """同步单张表"""
        print(f"\n【{table_name_cn}】 table_id={table_id}")

        # 拉取数据
        result = self.fetch_all_records(table_id)
        if result is None:
            self.results.append({
                "table_id": table_id,
                "name": table_name_cn,
                "api_total": 0,
                "fetched": 0,
                "inserted": 0,
                "status": "FAILED"
            })
            return False

        records, api_total = result
        fetched_count = len(records)

        print(f"  拉取数据: {fetched_count} 条 (API total: {api_total})")

        # 检查数据完整性
        if fetched_count == 0:
            print(f"  [警告] 表无数据或拉取失败")
            self.results.append({
                "table_id": table_id,
                "name": table_name_cn,
                "api_total": api_total or 0,
                "fetched": 0,
                "inserted": 0,
                "status": "NO_DATA"
            })
            return False

        if api_total and fetched_count != api_total:
            print(f"  [警告] 拉取数据不完整: 期望 {api_total}, 实际 {fetched_count}")

        # 创建表
        safe_name = self.safe_table_name(table_name_cn)
        if not self.create_table(safe_name, records[0].get("record_id") if records else None):
            self.results.append({
                "table_id": table_id,
                "name": table_name_cn,
                "api_total": api_total or 0,
                "fetched": fetched_count,
                "inserted": 0,
                "status": "CREATE_FAILED"
            })
            return False

        # 插入数据
        inserted = self.insert_records(safe_name, records)

        self.results.append({
            "table_id": table_id,
            "name": table_name_cn,
            "pg_table": safe_name,
            "api_total": api_total or fetched_count,
            "fetched": fetched_count,
            "inserted": inserted,
            "status": "SUCCESS"
        })

        return True

    def run(self):
        """主流程"""
        print("=" * 70)
        print("飞书多维表格数据补齐 - 统一拉取脚本 v2")
        print("=" * 70)

        # 1. 获取token
        if not self.get_tenant_token():
            return False

        # 2. 连接PG
        if not self.connect_pg():
            return False

        # 3. 逐表处理
        print(f"\n开始处理 {len(TABLES_TO_SYNC)} 张表...")
        for table_id, table_name in TABLES_TO_SYNC:
            self.sync_table(table_id, table_name)

        # 4. 输出统计
        self.print_summary()

        # 5. 关闭连接
        if self.conn:
            self.conn.close()

        return True

    def print_summary(self):
        """打印统计信息"""
        print("\n" + "=" * 70)
        print("【处理统计】")
        print("=" * 70)

        success = sum(1 for r in self.results if r["status"] == "SUCCESS")
        total_fetched = sum(r["fetched"] for r in self.results)
        total_inserted = sum(r["inserted"] for r in self.results)

        print(f"\n总计: {len(self.results)} 张表 | 成功: {success} | 拉取: {total_fetched} 条 | 入库: {total_inserted} 条\n")

        # 详细列表
        print("表明细:")
        print("-" * 100)
        print(f"{'表名':<30} {'table_id':<25} {'API总数':<8} {'拉取数':<8} {'入库数':<8} {'状态':<15}")
        print("-" * 100)

        for r in self.results:
            status_icon = "[√]" if r["status"] == "SUCCESS" else "[✗]"
            print(f"{r['name']:<30} {r['table_id']:<25} {r['api_total']:<8} {r['fetched']:<8} {r['inserted']:<8} {status_icon} {r['status']:<12}")

        print("-" * 100)

        # 异常提示
        failures = [r for r in self.results if r["status"] != "SUCCESS"]
        if failures:
            print(f"\n[异常表] {len(failures)} 张:")
            for r in failures:
                print(f"  - {r['name']} ({r['status']})")

if __name__ == "__main__":
    syncer = FeishuSync()
    success = syncer.run()
    sys.exit(0 if success else 1)
