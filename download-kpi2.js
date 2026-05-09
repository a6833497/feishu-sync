const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const state = JSON.parse(fs.readFileSync("lark-session.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state, locale: "zh-CN",
    viewport: { width: 1920, height: 1080 }, acceptDownloads: true,
  });

  const page = await context.newPage();
  console.log("打开公会最核心指标...");
  await page.goto("https://bjpem4otfhn6.jp.larksuite.com/wiki/F7mLwgvi3iQtMSkidqkjvGtepBc", {
    waitUntil: "domcontentloaded", timeout: 120000
  });
  await page.waitForTimeout(15000);

  // 点击 ... 菜单
  await page.click(".suite-more-menu");
  await page.waitForTimeout(1500);

  // 悬停"下载为"
  await page.hover("text=下载为");
  await page.waitForTimeout(1500);

  // 截图看子菜单
  await page.screenshot({ path: "/tmp/lark-kpi-submenu.png" });
  
  // 点击 xlsx/Excel
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("text=.xlsx").catch(() => page.click("text=Excel")).catch(() => page.click("text=Microsoft")),
  ]);

  const filePath = path.join(__dirname, "lark-exports", "公会最核心指标.xlsx");
  await download.saveAs(filePath);
  const stat = fs.statSync(filePath);
  console.log("✅ 下载完成: " + (stat.size / 1024).toFixed(0) + "KB");

  const XLSX = require("xlsx");
  const wb = XLSX.readFile(filePath);
  console.log("\nsheets:");
  for (const name of wb.SheetNames) {
    const data = XLSX.utils.sheet_to_json(wb.Sheets[name]);
    const cols = Object.keys(data[0] || {});
    console.log("  " + name + ": " + data.length + " 行 (" + cols.slice(0, 5).join(", ") + "...)");
  }

  await browser.close();
})();
