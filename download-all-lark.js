const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const EXPORT_DIR = path.join(__dirname, "lark-exports");
const SESSION = path.join(__dirname, "lark-session.json");

// ============================================================
// 下载配置：文档URL → 标签页列表
// ============================================================
const DOWNLOAD_PLAN = [
  {
    name: "公会最核心指标",
    url: "https://bjpem4otfhn6.jp.larksuite.com/wiki/F7mLwgvi3iQtMSkidqkjvGtepBc",
    tabs: [
      { sheet: "日核心指标", file: "公会_日核心指标.csv" },
      { sheet: "周核心指标", file: "公会_周核心指标.csv" },
      { sheet: "月核心指标", file: "公会_月核心指标.csv" },
      { sheet: "印尼日", file: "公会_印尼日.csv" },
      { sheet: "印尼周", file: "公会_印尼周.csv" },
      { sheet: "巴西日", file: "公会_巴西日.csv" },
      { sheet: "巴西周", file: "公会_巴西周.csv" },
      { sheet: "西语日", file: "公会_西语日.csv" },
      { sheet: "西语周", file: "公会_西语周.csv" },
      // 土耳其日 — 不需要
    ],
  },
  {
    name: "印尼聊天",
    url: "https://bjpem4otfhn6.jp.larksuite.com/wiki/DU3owAMqfidkyXklL6BjPgRApXf",
    tabs: [
      { sheet: "日数据", file: "印尼聊天_日数据.csv" },
      { sheet: "周数据", file: "印尼聊天_周数据.csv" },
      { sheet: "日汇总", file: "印尼聊天_日汇总.csv" },
      { sheet: "周汇总", file: "印尼聊天_周汇总.csv" },
      { sheet: "印尼id", file: "印尼聊天_印尼id.csv" },
      { sheet: "官方数据", file: "印尼聊天_官方数据.csv" },
      { sheet: "裂变关系", file: "印尼聊天_裂变关系.csv" },
      { sheet: "周排行", file: "印尼聊天_周排行.csv" },
      { sheet: "裂变周数据", file: "印尼聊天_裂变周数据.csv" },
      { sheet: "带动消费对比", file: "印尼聊天_带动消费对比.csv" },
    ],
  },
  {
    name: "巴西聊天",
    url: "https://bjpem4otfhn6.jp.larksuite.com/wiki/G29Cwov08iWq4Fk7kVPjW4K2pAe",
    tabs: [
      { sheet: "日数据", file: "巴西聊天_日数据.csv" },
      { sheet: "周数据", file: "巴西聊天_周数据.csv" },
      { sheet: "日汇总", file: "巴西聊天_日汇总.csv" },
      { sheet: "周汇总", file: "巴西聊天_周汇总.csv" },
      { sheet: "巴西id", file: "巴西聊天_巴西id.csv" },
      { sheet: "官方数据", file: "巴西聊天_官方数据.csv" },
      { sheet: "裂变关系", file: "巴西聊天_裂变关系.csv" },
      { sheet: "裂变周数据", file: "巴西聊天_裂变周数据.csv" },
      { sheet: "周排名", file: "巴西聊天_周排名.csv" },
    ],
  },
  {
    name: "西语聊天",
    url: "https://bjpem4otfhn6.jp.larksuite.com/wiki/Z50NwRS6cihkZJkdGwNj4wOzpse",
    tabs: [
      { sheet: "日数据", file: "西语聊天_日数据.csv" },
      { sheet: "周数据", file: "西语聊天_周数据.csv" },
      { sheet: "日汇总", file: "西语聊天_日汇总.csv" },
      { sheet: "周汇总", file: "西语聊天_周汇总.csv" },
      { sheet: "西语id", file: "西语聊天_西语id.csv" },
      { sheet: "官方数据", file: "西语聊天_官方数据.csv" },
      { sheet: "裂变关系", file: "西语聊天_裂变关系.csv" },
      { sheet: "裂变周数据", file: "西语聊天_裂变周数据.csv" },
      { sheet: "裂变每周新增达标数", file: "西语聊天_裂变每周新增达标数.csv" },
      { sheet: "非直属转直属", file: "西语聊天_非直属转直属.csv" },
      { sheet: "国家数据分析", file: "西语聊天_国家数据分析.csv" },
    ],
  },
];

async function downloadSheetAsCSV(page, sheetName, fileName) {
  console.log("  切换标签页: " + sheetName);
  try {
    await page.click("text=" + sheetName, { timeout: 10000 });
  } catch (e) {
    console.log("  ⚠️ 找不到标签页: " + sheetName + "，跳过");
    return null;
  }
  await page.waitForTimeout(3000);

  await page.click(".suite-more-menu", { timeout: 10000 });
  await page.waitForTimeout(1500);
  await page.hover("text=下载为");
  await page.waitForTimeout(1500);

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("text=本地 CSV 文件(.csv)"),
  ]);

  const filePath = path.join(EXPORT_DIR, fileName);
  await download.saveAs(filePath);
  const stat = fs.statSync(filePath);
  console.log("  ✅ " + fileName + " (" + (stat.size / 1024).toFixed(1) + " KB)");
  return filePath;
}

(async () => {
  if (!fs.existsSync(SESSION)) {
    console.log("❌ 无会话文件 lark-session.json");
    process.exit(1);
  }
  if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const state = JSON.parse(fs.readFileSync(SESSION, "utf8"));
  const context = await browser.newContext({
    storageState: state,
    locale: "zh-CN",
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
  });

  let totalFiles = 0;
  let failedFiles = 0;

  for (const doc of DOWNLOAD_PLAN) {
    console.log("\n📄 " + doc.name + " (" + doc.tabs.length + "个标签页)");
    const page = await context.newPage();
    
    try {
      await page.goto(doc.url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(15000);
      console.log("  页面加载完成");

      for (const tab of doc.tabs) {
        try {
          const result = await downloadSheetAsCSV(page, tab.sheet, tab.file);
          if (result) totalFiles++;
          else failedFiles++;
        } catch (e) {
          console.log("  ❌ " + tab.sheet + " 下载失败: " + e.message);
          failedFiles++;
        }
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log("  ❌ 文档打开失败: " + e.message);
      failedFiles += doc.tabs.length;
    }

    await page.close();
  }

  await browser.close();

  console.log("\n========================================");
  console.log("  下载完成: " + totalFiles + " 成功, " + failedFiles + " 失败");
  console.log("========================================");



  // ========== 下载后自动验证 ==========
  console.log("\n\u{1F50D} 数据验证...");
  const verifyErrors = [];
  const csvFiles = fs.readdirSync(EXPORT_DIR).filter(f => f.endsWith(".csv"));
  
  for (const file of csvFiles) {
    const content = fs.readFileSync(path.join(EXPORT_DIR, file), "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    
    if (lines.length < 3) {
      verifyErrors.push(file + ": 只有" + lines.length + "行");
      continue;
    }
    
    const dateMatches = content.match(/202[56]\/\d+\/\d+/g) || [];
    if (dateMatches.length === 0) continue;

    // 用 for 循环找最大值，避免 Math.max(...几十万个) 触发 V8 栈溢出（2026-04-30 修复）
    let maxDate = new Date(0);
    for (const d of dateMatches) {
      const parts = d.split("/");
      const dt = new Date(parts[0], parts[1]-1, parts[2]);
      if (dt > maxDate) maxDate = dt;
    }
    const daysAgo = Math.floor((Date.now() - maxDate.getTime()) / 86400000);
    
    if (daysAgo > 14) {
      verifyErrors.push(file + ": 最新=" + maxDate.toISOString().substring(0,10) + " (滞后" + daysAgo + "天)");
    }
  }
  
  if (verifyErrors.length > 0) {
    console.log("\u26A0\uFE0F 验证发现 " + verifyErrors.length + " 个问题:");
    verifyErrors.forEach(e => console.log("  " + e));
    // 2026-06-24 做减法：删除写错路径(__dirname，长期 broken)的验证告警调用，只留日志
  } else {
    console.log("\u2705 全部CSV验证通过");
  }

  // 2026-06-24 做减法：删除「N个文件失败」P1 告警（失败计数含大量良性 tab，会自愈，无人响应）。
  // 数据是否真到位由每日巡检(daily-audit) 的结果哨兵 lark_daily_kpi 滞后判定（一处说了算）。
  // 仍保留非0退出码（供 wrapper 日志与退出语义）。
  if (failedFiles > 0) {
    process.exit(1);
  }
})().catch((e) => {
  // 2026-05-01 加堆栈：之前只打 e.message 导致 RangeError 排查多花 4 天
  console.error("❌", e?.stack || e?.message || e);
  process.exit(1);
});
