const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SCRIPT_DIR = __dirname;
const SESSION = path.join(SCRIPT_DIR, "lark-session.json");
const EXPORT_DIR = path.join(SCRIPT_DIR, "lark-exports");
const OUTPUT = path.join(SCRIPT_DIR, "lark_data.json");
const BASE_URL = "https://bjpem4otfhn6.jp.larksuite.com/wiki/SqU9w6gnEijI6BkPXeVjHMhLp4c";

// Sheet 名到内部 key 的映射
const SHEET_MAP = {
  "【每日】公会数据汇总": "guild_daily",
  "钻石支出表": "diamond_expense",
  "【公式】巴西个人运营数据": "br_ops",
  "【公式】印尼个人运营数据": "id_ops",
  "【公式】土耳其个人运营数据": "tr_ops",
  "【公式】中东个人运营数据": "me_ops",
  "公会群组 & WA账号": "guild_groups",
  "【按需】申请资金表": "fund_requests",
  "【每日】巴西备用金使用数据": "br_petty_cash",
  "【每日】印尼备用金使用数据": "id_petty_cash",
};

(async () => {
  if (!fs.existsSync(SESSION)) {
    console.log("无会话文件 lark-session.json");
    process.exit(1);
  }

  const XLSX = require("xlsx");
  const browser = await chromium.launch({ headless: true });
  const state = JSON.parse(fs.readFileSync(SESSION, "utf8"));
  const context = await browser.newContext({
    storageState: state,
    locale: "zh-CN",
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
  });

  const page = await context.newPage();
  console.log("打开 Lark 运营数据页面...");
  await page.goto(BASE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 120000,
  });
  await page.waitForTimeout(15000);

  // 点击 ... → 导出 → Excel/CSV → 下载
  console.log("触发导出...");
  await page.click(".suite-more-menu");
  await page.waitForTimeout(1500);
  await page.hover("text=导出");
  await page.waitForTimeout(1500);
  await page.click("text=Excel/CSV 文件");
  await page.waitForTimeout(2000);

  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await page.locator("button", { hasText: "下载" }).click();
  const download = await downloadPromise;

  const filePath = path.join(EXPORT_DIR, "lark-full-export.xlsx");
  await download.saveAs(filePath);
  const stat = fs.statSync(filePath);
  console.log("📥 下载完成: " + (stat.size / 1024).toFixed(0) + "KB");

  await page.close();
  await browser.close();

  // 解析所有 sheet
  console.log("\n解析 xlsx...");
  const wb = XLSX.readFile(filePath);
  const results = {};

  for (const sheetName of wb.SheetNames) {
    const key = SHEET_MAP[sheetName];
    if (!key) {
      console.log("  跳过: " + sheetName + " (未配置)");
      continue;
    }

    const ws = wb.Sheets[sheetName];
    const records = XLSX.utils.sheet_to_json(ws);
    results[key] = records;

    const cols = Object.keys(records[0] || {});
    console.log("  ✅ " + sheetName + ": " + records.length + " 条 (" + cols.slice(0, 3).join(", ") + "...)");
  }

  // 保存
  fs.writeFileSync(
    OUTPUT,
    JSON.stringify(
      {
        _export_time: new Date().toISOString(),
        _method: "playwright_full_xlsx_export",
        _source_file: filePath,
        data: results,
      },
      null,
      2
    )
  );

  const total = Object.values(results).reduce((s, r) => s + r.length, 0);
  console.log("\n💾 " + total + " 条 → " + OUTPUT);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
