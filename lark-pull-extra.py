#!/usr/bin/env python3
# Lark国际版「补抓指定tab」→ lark_raw(行级原始). 6-5 CEO要:裂变推荐人(印尼/巴西/西语)+周钻石排名(西语)。
import json, urllib.request, urllib.parse, time, os
import psycopg2
from psycopg2.extras import execute_values

SD = os.path.dirname(os.path.abspath(__file__))
cfg = json.load(open(os.path.join(SD, "lark-config.json")))
API = cfg.get("api_base", "https://open.larksuite.com")
SHEETS = {"印尼": "I5o1sE8Jyhuijjtug8JjJwsHptb", "巴西": "T9HfssY4rhH8ZitdUjJj2soapgg", "西语": "PRVHs7jKRhyhcTtIfIqjW0kSp5e"}
# 要抓的 (市场, tab名)
TARGETS = [("印尼", "裂变推荐人"), ("巴西", "裂变推荐人"), ("西语", "裂变推荐人"), ("西语", "周钻石排名"),
           ("巴西", "直属周数据")]  # 6-26 加:经纪人周表含首提数/首提率,先入lark_raw,展示后议

_tok = None
def tok():
    global _tok
    if _tok: return _tok
    r = urllib.request.Request(API + "/open-apis/auth/v3/tenant_access_token/internal",
        data=json.dumps({"app_id": cfg["app_id"], "app_secret": cfg["app_secret"]}).encode(),
        headers={"Content-Type": "application/json"})
    _tok = json.loads(urllib.request.urlopen(r).read())["tenant_access_token"]; return _tok

def get(url):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"Authorization": "Bearer " + tok()})).read())

def tabs(sp):
    return get(API + "/open-apis/sheets/v3/spreadsheets/" + sp + "/sheets/query")["data"]["sheets"]

def rows(sp, sid, rc):
    out = []; step = 5000
    for s in range(1, rc + 1, step):
        e = min(s + step - 1, rc)
        rng = sid + "!A" + str(s) + ":Z" + str(e)
        d = get(API + "/open-apis/sheets/v2/spreadsheets/" + sp + "/values/" + urllib.parse.quote(rng) + "?valueRenderOption=FormattedValue")
        out += (d.get("data", {}).get("valueRange", {}).get("values", []) or [])
        time.sleep(0.3)
    return out

def cell(v):
    if v is None: return ""
    if isinstance(v, (str, int, float)): return v
    if isinstance(v, list): return "".join(cell(x.get("text", "")) if isinstance(x, dict) else cell(x) for x in v)
    if isinstance(v, dict): return v.get("text", "") or v.get("link", "")
    return str(v)

def main():
    conn = psycopg2.connect(host="localhost", dbname="nova_dashboard", user="nova_app", password="Nova2026pg!")
    cur = conn.cursor()
    cur.execute("""CREATE TABLE IF NOT EXISTS lark_raw (
        market TEXT, tab TEXT, row_idx INT, cells JSONB, synced_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (market, tab, row_idx))""")
    conn.commit()
    total = 0
    for mkt, tabname in TARGETS:
        sp = SHEETS[mkt]
        tinfo = next((t for t in tabs(sp) if t["title"] == tabname), None)
        if not tinfo:
            print("  [缺] %s/%s 找不到" % (mkt, tabname)); continue
        rc = tinfo.get("grid_properties", {}).get("row_count", 0)
        data = rows(sp, tinfo["sheet_id"], rc)
        vals = [(mkt, tabname, i, json.dumps([cell(c) for c in row], ensure_ascii=False)) for i, row in enumerate(data) if any((c is not None and str(c).strip()) for c in row)]
        if not vals:
            print("  %s / %s : 抓到0行,跳过不清表(防临时失败清空旧数据)" % (mkt, tabname)); continue
        cur.execute("DELETE FROM lark_raw WHERE market=%s AND tab=%s", (mkt, tabname))
        execute_values(cur, "INSERT INTO lark_raw (market, tab, row_idx, cells) VALUES %s", vals)
        conn.commit()
        total += len(vals)
        print("  %s / %s : %d 行" % (mkt, tabname, len(vals)))
    print("Lark补抓完成,共 %d 行" % total)
    cur.close(); conn.close()

main()
