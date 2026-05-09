#!/usr/bin/env python3
"""
飞书经营日报 v2
- 早上10:00: 完整经营日报（昨日投放/异常/本周累计/亮点）
- 傍晚18:00: 简版更新提醒
"""

import json
import os
import sys
import hashlib
import urllib.request
from datetime import datetime, timezone, timedelta
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(SCRIPT_DIR, "config.json")
SNAPSHOT_PATH = os.path.join(SCRIPT_DIR, "snapshot.json")
DATA_PATH = os.path.join(SCRIPT_DIR, "data_store.json")  # 存完整数据用于趋势分析
LOG_PATH = os.path.join(SCRIPT_DIR, "sync.log")

CST = timezone(timedelta(hours=8))
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# ── 异常检测阈值 ──
ALERT_RULES = {
    "cpa_spike_pct": 20,        # CPA环比涨幅 ≥ 20% 告警
    "cpa_trend_days": 3,        # CPA连续上涨天数触发趋势告警
    "register_drop_pct": 30,    # 注册环比跌幅 ≥ 30% 告警
    "quality_drop_pct": 50,     # 优质率环比跌幅 ≥ 50% 告警
    "quality_low_vs_avg": 0.5,  # 优质率低于全队平均的50% 告警
}


def log(msg):
    ts = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line)
    with open(LOG_PATH, "a") as f:
        f.write(line + "\n")


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
                        wait = [5, 15][attempt]
                        import time; time.sleep(wait)
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


def record_hash(record):
    fields = record.get("fields", {})
    s = json.dumps(fields, sort_keys=True, ensure_ascii=False)
    return hashlib.md5(s.encode()).hexdigest()


def parse_date(v):
    """解析飞书日期字段（毫秒时间戳或字符串）"""
    if isinstance(v, (int, float)) and v > 1e12:
        return datetime.fromtimestamp(v / 1000, CST).strftime("%Y-%m-%d")
    if isinstance(v, str):
        # 尝试 MM/DD 或 YYYY-MM-DD
        for fmt in ["%Y-%m-%d", "%m/%d", "%m.%d"]:
            try:
                return datetime.strptime(v.strip(), fmt).strftime("%Y-%m-%d")
            except:
                pass
    return str(v) if v else ""


def safe_float(v, default=0):
    if v is None or v == "":
        return default
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except:
        return default


def extract_text(v):
    if isinstance(v, list):
        parts = []
        for item in v:
            if isinstance(item, dict):
                parts.append(item.get("text", item.get("name", str(item))))
            else:
                parts.append(str(item))
        return ", ".join(parts)
    return str(v) if v is not None else ""


# ── 投流日报分析 ──
def analyze_ad_daily(records):
    """分析投流日报，按日期+地区聚合"""
    daily = defaultdict(lambda: defaultdict(lambda: {
        "spend": 0, "leads": 0, "registers": 0, "effective": 0
    }))

    for r in records:
        f = r.get("fields", {})
        date = parse_date(f.get("日期"))
        region = extract_text(f.get("地区", ""))
        if not date or not region:
            continue

        d = daily[date][region]
        d["spend"] += safe_float(f.get("花费（USD）"))
        d["leads"] += safe_float(f.get("进群人数"))
        d["registers"] += safe_float(f.get("注册人数"))
        d["effective"] += safe_float(f.get("有效注册"))

    # 转为排序列表
    result = {}
    for date in sorted(daily.keys()):
        result[date] = {}
        for region, data in daily[date].items():
            cpa = data["spend"] / data["leads"] if data["leads"] > 0 else 0
            reg_cost = data["spend"] / data["registers"] if data["registers"] > 0 else 0
            result[date][region] = {
                **data,
                "cpa": round(cpa, 2),
                "reg_cost": round(reg_cost, 2),
            }
    return result


def analyze_quality(records, name_field, quality_field, total_field):
    """分析优质率数据"""
    daily = defaultdict(list)
    for r in records:
        f = r.get("fields", {})
        date = parse_date(f.get("日期"))
        name = extract_text(f.get(name_field, ""))
        quality = safe_float(f.get(quality_field))
        total = safe_float(f.get(total_field))
        if date and name:
            rate = quality / total * 100 if total > 0 else 0
            daily[date].append({"name": name, "quality": quality, "total": total, "rate": round(rate, 1)})
    return dict(daily)


# ── 异常检测 ──
def detect_anomalies(ad_data):
    """检测投放异常"""
    alerts = []
    dates = sorted(ad_data.keys())
    if len(dates) < 2:
        return alerts

    latest = dates[-1]
    prev = dates[-2]

    for region in ad_data[latest]:
        curr = ad_data[latest][region]
        prev_data = ad_data.get(prev, {}).get(region)

        if not prev_data:
            continue

        # CPA 环比
        if prev_data["cpa"] > 0 and curr["cpa"] > 0:
            change = (curr["cpa"] - prev_data["cpa"]) / prev_data["cpa"] * 100
            if change >= ALERT_RULES["cpa_spike_pct"]:
                alerts.append(f"⚠️ {region} CPA 💲{curr['cpa']:.2f}，环比涨{change:.0f}%（昨日💲{prev_data['cpa']:.2f}）")

        # CPA 连续上涨
        if len(dates) >= ALERT_RULES["cpa_trend_days"]:
            recent_cpas = []
            for d in dates[-ALERT_RULES["cpa_trend_days"]:]:
                r = ad_data.get(d, {}).get(region)
                if r:
                    recent_cpas.append(r["cpa"])
            if len(recent_cpas) >= 3 and all(recent_cpas[i] > recent_cpas[i-1] for i in range(1, len(recent_cpas))):
                alerts.append(f"🔴 {region} CPA连续{len(recent_cpas)}天上涨：{'→'.join(f'💲{c:.2f}' for c in recent_cpas)}")

        # 注册骤降
        if prev_data["registers"] > 0:
            change = (curr["registers"] - prev_data["registers"]) / prev_data["registers"] * 100
            if change <= -ALERT_RULES["register_drop_pct"]:
                alerts.append(f"⚠️ {region} 注册骤降{abs(change):.0f}%（{int(prev_data['registers'])}→{int(curr['registers'])}）")

        # 注册归零
        if curr["registers"] == 0 and prev_data["registers"] > 0:
            alerts.append(f"🔴 {region} 注册归零！可能账户异常")

    return alerts


def detect_quality_anomalies(quality_data, role_name):
    """检测优质率异常"""
    alerts = []
    dates = sorted(quality_data.keys())
    if not dates:
        return alerts

    latest = dates[-1]
    entries = quality_data[latest]
    if not entries:
        return alerts

    # 全队平均
    total_q = sum(e["quality"] for e in entries)
    total_t = sum(e["total"] for e in entries)
    avg_rate = total_q / total_t * 100 if total_t > 0 else 0

    # 找异常低的人
    for e in entries:
        if e["total"] >= 10 and e["rate"] < avg_rate * ALERT_RULES["quality_low_vs_avg"]:
            alerts.append(f"⚠️ {role_name}[{e['name']}]优质率{e['rate']:.0f}%（全队均值{avg_rate:.0f}%）")

    return alerts


# ── 报告生成 ──
def build_morning_report(ad_data, cs_quality, buyer_quality, change_summary):
    """早上完整经营日报"""
    now = datetime.now(CST)
    today_str = now.strftime("%Y-%m-%d")
    weekday = WEEKDAYS[now.weekday()]

    dates = sorted(ad_data.keys())
    if not dates:
        return f"📊 经营日报 | {today_str}（{weekday}）\n\n暂无投流数据"

    latest_date = dates[-1]
    prev_date = dates[-2] if len(dates) >= 2 else None

    lines = [f"📊 经营日报 | {latest_date}（数据日）", ""]

    # ── 昨日投放 ──
    lines.append("💰 昨日投放  └ 来源: 飞书《LK投流日报》")
    regions = sorted(ad_data[latest_date].keys())
    total_spend = 0
    total_reg = 0

    for region in regions:
        curr = ad_data[latest_date][region]
        total_spend += curr["spend"]
        total_reg += curr["registers"]

        trend = ""
        if prev_date and region in ad_data.get(prev_date, {}):
            prev = ad_data[prev_date][region]
            if prev["cpa"] > 0:
                cpa_change = (curr["cpa"] - prev["cpa"]) / prev["cpa"] * 100
                if cpa_change > 5:
                    trend = f"↑{cpa_change:.0f}% ⚠️"
                elif cpa_change < -5:
                    trend = f"↓{abs(cpa_change):.0f}% ✅"
                else:
                    trend = "持平 ✅"

        lines.append(f"  {region:6s} 花费💲{curr['spend']:,.0f}  注册{int(curr['registers'])}  CPA 💲{curr['cpa']:.2f}  {trend}")

    lines.append(f"  {'合计':6s} 花费💲{total_spend:,.0f}  注册{int(total_reg)}")
    lines.append("")

    # ── 异常提醒 ──
    alerts = detect_anomalies(ad_data)
    alerts += detect_quality_anomalies(cs_quality, "客服")
    alerts += detect_quality_anomalies(buyer_quality, "投手")

    if alerts:
        lines.append("🚨 异常提醒  └ 来源: 飞书《LK投流日报》《客服优质占比》《投手优质占比》环比检测")
        for a in alerts[:5]:
            lines.append(f"  {a}")
        lines.append("")

    # ── 本周累计 ──
    # 算本周一到最新日期
    try:
        latest_dt = datetime.strptime(latest_date, "%Y-%m-%d")
        monday = latest_dt - timedelta(days=latest_dt.weekday())
        monday_str = monday.strftime("%Y-%m-%d")

        week_spend = 0
        week_reg = 0
        week_days = 0
        for d in dates:
            if d >= monday_str and d <= latest_date:
                week_days += 1
                for region in ad_data[d]:
                    week_spend += ad_data[d][region]["spend"]
                    week_reg += ad_data[d][region]["registers"]

        if week_days > 0:
            week_cpa = week_spend / week_reg if week_reg > 0 else 0
            lines.append(f"📈 本周累计（{monday_str} ~ {latest_date}，{week_days}天）  └ 来源: 飞书《LK投流日报》")
            lines.append(f"  总花费 💲{week_spend:,.0f}")
            lines.append(f"  总注册 {int(week_reg)}")
            lines.append(f"  平均CPA 💲{week_cpa:.2f}")

            # 对比上周同期
            last_monday = monday - timedelta(days=7)
            last_same_end = last_monday + timedelta(days=week_days - 1)
            last_monday_str = last_monday.strftime("%Y-%m-%d")
            last_end_str = last_same_end.strftime("%Y-%m-%d")

            lw_spend = 0
            lw_reg = 0
            for d in dates:
                if d >= last_monday_str and d <= last_end_str:
                    for region in ad_data[d]:
                        lw_spend += ad_data[d][region]["spend"]
                        lw_reg += ad_data[d][region]["registers"]

            if lw_reg > 0:
                lw_cpa = lw_spend / lw_reg if lw_reg > 0 else 0
                reg_change = (week_reg - lw_reg) / lw_reg * 100
                cpa_change = (week_cpa - lw_cpa) / lw_cpa * 100 if lw_cpa > 0 else 0
                lines.append(f"  vs上周同期: 注册{'+' if reg_change>=0 else ''}{reg_change:.1f}%  CPA{'+' if cpa_change>=0 else ''}{cpa_change:.1f}%")

            lines.append("")
    except:
        pass

    # ── 亮点 ──
    highlights = []
    if regions:
        # 找CPA最低的地区
        best = min(regions, key=lambda r: ad_data[latest_date][r]["cpa"] if ad_data[latest_date][r]["cpa"] > 0 else 999)
        best_cpa = ad_data[latest_date][best]["cpa"]
        if best_cpa > 0:
            highlights.append(f"{best} CPA最优 💲{best_cpa:.2f}")

    # 找优质率最高的客服
    cs_dates = sorted(cs_quality.keys())
    if cs_dates:
        latest_cs = cs_quality[cs_dates[-1]]
        if latest_cs:
            best_cs = max(latest_cs, key=lambda e: e["rate"] if e["total"] >= 5 else 0)
            if best_cs["rate"] > 0:
                highlights.append(f"客服[{best_cs['name']}]优质率{best_cs['rate']:.0f}%")

    if highlights:
        lines.append("🏆 亮点  └ 来源: 飞书《LK投流日报》《客服优质占比》")
        for h in highlights:
            lines.append(f"  • {h}")
        lines.append("")

    # ── 数据更新摘要 ──
    if change_summary:
        lines.append("📋 数据更新（飞书+Lark 各表行数变更）")
        for name, counts in change_summary.items():
            if counts["new"] > 0 or counts["modified"] > 0:
                parts = []
                if counts["new"] > 0:
                    parts.append(f"+{counts['new']}")
                if counts["modified"] > 0:
                    parts.append(f"~{counts['modified']}")
                lines.append(f"  {name} {' '.join(parts)}")

    return "\n".join(lines)


def build_evening_report(change_summary):
    """傍晚简版更新"""
    now = datetime.now(CST)
    lines = [f"📋 数据更新 | {now.strftime('%m月%d日')} 18:00", ""]

    has_changes = False
    for name, counts in change_summary.items():
        total = counts["new"] + counts["modified"]
        if total > 0:
            has_changes = True
            lines.append(f"  {name} +{counts['new']}条" + (f" ~{counts['modified']}条" if counts["modified"] else ""))

    if not has_changes:
        lines.append("  今日无新数据更新")

    lines.append("")
    lines.append("明早10点推送完整经营日报")

    return "\n".join(lines)


def send_feishu(token, chat_id, text):
    """通过飞书(feishu.cn)应用机器人发送消息到群聊 — 不使用Lark"""
    data = json.dumps({
        "receive_id": chat_id,
        "msg_type": "text",
        "content": json.dumps({"text": text})
    }).encode()
    req = urllib.request.Request(
        "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
    )
    try:
        resp = json.loads(urllib.request.urlopen(req).read())
        return resp.get("code") == 0
    except Exception as e:
        log(f"发送失败: {e}")
        return False


def main():
    init_mode = "--init" in sys.argv
    dry_run = "--dry-run" in sys.argv
    morning = "--morning" in sys.argv
    evening = "--evening" in sys.argv

    # 自动判断早晚
    if not morning and not evening and not init_mode and not dry_run:
        hour = datetime.now(CST).hour
        morning = hour < 14
        evening = not morning

    config = load_config()
    log("=" * 50)
    mode = "init" if init_mode else "dry-run" if dry_run else "morning" if morning else "evening"
    log(f"飞书同步开始 (mode={mode})")

    feishu_token = get_token(config)
    app_token = config["bitable_app_token"]
    tables = config["tables"]

    # Lark token（独立获取，失败不影响飞书）
    lark_token = None
    lark_config = config.get("lark")
    if lark_config:
        try:
            lark_token = get_token(lark_config)
            log("Lark token 获取成功")
        except Exception as e:
            log(f"Lark token 获取失败（配额可能用完）: {e}")

    # 加载旧快照
    old_snapshot = {}
    if os.path.exists(SNAPSHOT_PATH) and not init_mode:
        with open(SNAPSHOT_PATH) as f:
            old_snapshot = json.load(f)

    new_snapshot = {"_sync_time": datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")}
    change_summary = {}
    all_records = {}

    # ── 读取飞书表（feishu.cn）──
    log("── 飞书数据源 ──")
    for key, tbl in tables.items():
        tid = tbl["table_id"]
        name = tbl["name"]
        log(f"读取: {name}")
        try:
            records = fetch_all_records(feishu_token, app_token, tid)
            all_records[key] = records
            log(f"  → {len(records)} 条")

            new_hashes = {r["record_id"]: record_hash(r) for r in records}
            old_hashes = old_snapshot.get(key, {})
            new_count = sum(1 for rid in new_hashes if rid not in old_hashes)
            mod_count = sum(1 for rid in new_hashes if rid in old_hashes and new_hashes[rid] != old_hashes[rid])
            new_snapshot[key] = new_hashes
            change_summary[name] = {"new": new_count, "modified": mod_count}
            if new_count + mod_count > 0:
                log(f"  → 变更: +{new_count} ~{mod_count}")
        except Exception as e:
            log(f"  → 错误: {e}")
            all_records[key] = []
            change_summary[tbl["name"]] = {"new": 0, "modified": 0}

    # ── 读取 Lark 表（从 lark_data.json，由 lark-download.py Playwright下载）──
    lark_json_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lark_data.json")
    lark_tables = (lark_config or {}).get("tables", {}) if lark_config else {}
    if os.path.exists(lark_json_path) and lark_tables:
        log("── Lark数据源（本地文件）──")
        try:
            lark_file = json.load(open(lark_json_path))
            lark_data = lark_file.get("data", {})
            export_time = lark_file.get("_export_time", "未知")
            log(f"  数据文件时间: {export_time}")
            for key, tbl in lark_tables.items():
                lark_key = f"lark_{key}"
                name = f"[Lark]{tbl['name']}"
                rows = lark_data.get(key, [])
                if rows:
                    # 转为与API格式兼容的record结构
                    records = [{"record_id": f"{key}_{i}", "fields": row} for i, row in enumerate(rows)]
                    all_records[lark_key] = records
                    log(f"  {name}: {len(records)} 条")
                    change_summary[name] = {"new": 0, "modified": 0}
                else:
                    log(f"  {name}: 无数据")
                    change_summary[name] = {"new": 0, "modified": 0}
        except Exception as e:
            log(f"  Lark文件读取失败: {e}")
            for key, tbl in lark_tables.items():
                change_summary[f"[Lark]{tbl['name']}"] = {"new": 0, "modified": 0}
    else:
        log("── Lark 跳过（无本地数据文件）──")

    # 分析数据
    ad_data = analyze_ad_daily(all_records.get("ad_daily", []))
    cs_quality = analyze_quality(
        all_records.get("cs_quality", []), "客服", "优质数", "接粉数"
    )
    buyer_quality = analyze_quality(
        all_records.get("buyer_quality", []), "投手", "优质用户", "进粉数"
    )

    # 生成报告
    if morning or init_mode or dry_run:
        report = build_morning_report(ad_data, cs_quality, buyer_quality, change_summary)
    else:
        report = build_evening_report(change_summary)

    log("\n" + report)

    # 发送
    total_changes = sum(c["new"] + c["modified"] for c in change_summary.values())
    if not dry_run and not init_mode:
        if morning or total_changes > 0:
            ok = send_feishu(feishu_token, config["chat_id"], report)
            log(f"飞书推送: {'成功' if ok else '失败'}")
        else:
            log("傍晚无变更，跳过推送")

    # 保存快照
    if not dry_run:
        with open(SNAPSHOT_PATH, "w") as f:
            json.dump(new_snapshot, f, ensure_ascii=False)
        log("快照已保存")

    log("同步完成")
    log("=" * 50)


if __name__ == "__main__":
    main()
