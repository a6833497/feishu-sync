import csv, psycopg2
from psycopg2.extras import execute_values
from collections import defaultdict
CSV='/home/ubuntu/feishu-sync/lark-exports/西语聊天_官方数据.csv'
conn=psycopg2.connect(host="localhost", dbname="nova_dashboard", user="nova_app", password="Nova2026pg!")
cur=conn.cursor()
cur.execute("""CREATE TABLE IF NOT EXISTS timo_es3_weekly (
  person text, create_week text, paid_diamond double precision,
  streamers int, synced_at timestamp default now(), PRIMARY KEY(person, create_week))""")
agg=defaultdict(lambda:[0.0,0])
with open(CSV, encoding='utf-8-sig') as fh:
  r=csv.DictReader(fh)
  dcol=[c for c in r.fieldnames if '付费聊天钻石收益-总' in c][0]
  for row in r:
    if row.get('公会','').strip()!='西语3': continue
    wk=row.get('create_date(week)','').strip()
    if not wk: continue
    gz=row.get('归属','').strip() or '(未归属)'
    try: v=float(row.get(dcol,'') or 0)
    except: v=0
    agg[(gz,wk)][0]+=v; agg[(gz,wk)][1]+=1
vals=[(gz,wk,d,n) for (gz,wk),(d,n) in agg.items()]
cur.execute("DELETE FROM timo_es3_weekly")
execute_values(cur,"INSERT INTO timo_es3_weekly (person,create_week,paid_diamond,streamers) VALUES %s",vals)
conn.commit()
print("载入 (归属×周) 行:",len(vals))
