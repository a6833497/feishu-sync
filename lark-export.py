#!/usr/bin/env python3
"""
Lark 多维表格导出脚本（使用文件导出API，不消耗 records API 配额）
每天导出4张表为xlsx，解析后合并到经营日报
"""
import json, os, sys, time, urllib.request, hashlib
from datetime import datetime, timezone, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
EXPORT_DIR = os.path.join(SCRIPT_DIR, "lark-exports")
CST = timezone(timedelta(hours=8))

def log(msg):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] {msg}")

def get_lark_token(config):
    lark = config["lark"]
    data = json.dumps({"app_id": lark["app_id"], "app_secret": lark["app_secret"]}).encode()
    req = urllib.request.Request(
        "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
        data=data, headers={"Content-Type": "application/json"}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("code") != 0:
        raise Exception(f"Lark token 失败: {resp.get(msg)}")
    return resp["tenant_access_token"]

def export_table(token, app_token, table_id, table_name):
    """导出单张表为 xlsx 文件"""
    log(f"  导出: {table_name}")
    
    # 1. 创建导出任务
    data = json.dumps({
        "file_extension": "xlsx",
        "token": app_token,
        "type": "bitable",
        "sub_id": table_id
    }).encode()
    req = urllib.request.Request(
        "https://open.larksuite.com/open-apis/drive/v1/export_tasks",
        data=data,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    )
    resp = json.loads(urllib.request.urlopen(req).read())
    if resp.get("code") != 0:
        raise Exception(f"创建导出任务失败: {resp.get(code)} {resp.get(msg)}")
    
    ticket = resp["data"]["ticket"]
    
    # 2. 轮询等待完成
    for _ in range(20):
        time.sleep(3)
        req2 = urllib.request.Request(
            f"https://open.larksuite.com/open-apis/drive/v1/export_tasks/{ticket}?token={app_token}",
            headers={"Authorization": f"Bearer {token}"}
        )
        resp2 = json.loads(urllib.request.urlopen(req2).read())
        result = resp2.get("data", {}).get("result", {})
        if result.get("job_status") == 0:
            file_token = result["file_token"]
            file_size = result.get("file_size", 0)
            
            # 3. 下载文件
            req3 = urllib.request.Request(
                f"https://open.larksuite.com/open-apis/drive/v1/export_tasks/file/{file_token}/download",
                headers={"Authorization": f"Bearer {token}"}
            )
            content = urllib.request.urlopen(req3).read()
            
            path = os.path.join(EXPORT_DIR, f"{table_id}.xlsx")
            with open(path, "wb") as f:
                f.write(content)
            
            log(f"  ✅ {file_size/1024:.0f}KB → {path}")
            return path
        elif result.get("job_status") == 2:
            raise Exception("导出任务失败")
    
    raise Exception("导出超时")

def parse_xlsx(path):
    """解析 xlsx 返回 [dict] 列表"""
    try:
        import openpyxl
    except ImportError:
        os.system("pip3 install openpyxl -q")
        import openpyxl
    
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return []
    
    headers = [str(h) if h else f"col_{i}" for i, h in enumerate(rows[0])]
    records = []
    for row in rows[1:]:
        record = {}
        for i, val in enumerate(row):
            if i < len(headers):
                record[headers[i]] = val
        records.append(record)
    
    wb.close()
    return records

def main():
    config = json.load(open(CONFIG_PATH))
    lark = config.get("lark")
    if not lark:
        log("无 Lark 配置，跳过")
        return
    
    log("=" * 40)
    log("Lark 数据导出开始")
    
    try:
        token = get_lark_token(config)
        log("Token 获取成功")
    except Exception as e:
        log(f"❌ {e}")
        return
    
    app_token = lark["bitable_app_token"]
    tables = lark.get("tables", {})
    all_data = {}
    
    for key, tbl in tables.items():
        try:
            path = export_table(token, app_token, tbl["table_id"], tbl["name"])
            records = parse_xlsx(path)
            all_data[key] = records
            log(f"  解析: {len(records)} 条记录")
            time.sleep(5)  # 避免限流
        except Exception as e:
            log(f"  ❌ {tbl[name]}: {e}")
            all_data[key] = []
    
    # 保存解析后的数据为 JSON（供 feishu-sync.py 读取）
    output_path = os.path.join(SCRIPT_DIR, "lark_data.json")
    
    # 序列化时处理 datetime
    def default_serializer(obj):
        if hasattr(obj, isoformat):
            return obj.isoformat()
        return str(obj)
    
    with open(output_path, "w") as f:
        json.dump({
            "_export_time": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S"),
            "data": {k: v for k, v in all_data.items()}
        }, f, ensure_ascii=False, default=default_serializer, indent=2)
    
    total = sum(len(v) for v in all_data.values())
    log(f"✅ 导出完成: {total} 条记录 → {output_path}")
    log("=" * 40)

if __name__ == "__main__":
    main()
