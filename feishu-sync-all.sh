#!/bin/bash
cd /home/ubuntu/feishu-sync
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 飞书全量同步开始"

python3 feishu-to-db.py 2>&1 && echo "  P1(4张表): 成功" || echo "  P1: 失败"
python3 feishu-finance-sync.py 2>&1 && echo "  P2(2张表): 成功" || echo "  P2: 失败"
python3 feishu-remaining-sync.py 2>&1 && echo "  P3(6张表): 成功" || echo "  P3: 失败"

python3 feishu-sync-remaining-v2.py 2>&1 && echo "  P4(28张表): 成功" || echo "  P4: 失败"

# 验证
TOTAL=$(PGPASSWORD='Nova2026pg!' psql -U nova_app -h localhost -d nova_dashboard -t -c "
SELECT SUM(cnt) FROM (
  SELECT COUNT(*) cnt FROM lk_ad_daily
  UNION ALL SELECT COUNT(*) FROM lk_guild_daily
  UNION ALL SELECT COUNT(*) FROM customer_service_quality
  UNION ALL SELECT COUNT(*) FROM operator_quality
  UNION ALL SELECT COUNT(*) FROM feishu_finance_detail
  UNION ALL SELECT COUNT(*) FROM feishu_weekly_actual
  UNION ALL SELECT COUNT(*) FROM feishu_indo_register
  UNION ALL SELECT COUNT(*) FROM feishu_align_indo
  UNION ALL SELECT COUNT(*) FROM feishu_profit_weekly_guild
  UNION ALL SELECT COUNT(*) FROM feishu_weekly_settlement
  UNION ALL SELECT COUNT(*) FROM feishu_dashboard_data
  UNION ALL SELECT COUNT(*) FROM feishu_daily_estimate
) x;" | tr -d ' ')

echo "  飞书总记录数: $TOTAL"
if [ "$TOTAL" -lt 1000 ] 2>/dev/null; then
  python3 feishu-notify.py "⚠️ 飞书同步异常: 总记录数=$TOTAL (预期>4000)"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 飞书全量同步完成"
