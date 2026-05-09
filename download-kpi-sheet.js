const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const EXPORT_DIR = path.join(__dirname, "lark-exports");

async function downloadSheetAsCSV(page, sheetName, fileName) {
  // 切换到指定 sheet tab
  console.log("切换到 sheet: " + sheetName);
  await page.click("text=" + sheetName, { timeout: 10000 });
  await page.waitForTimeout(3000);

  // 点击 ... 菜单
  await page.click(".suite-more-menu", { timeout: 10000 });
  await page.waitForTimeout(1500);

  // 悬停"下载为"
  await page.hover("text=下载为");
  await page.waitForTimeout(1500);

  // 点击 CSV 选项并等待下载
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    page.click("text=本地 CSV 文件(.csv)"),
  ]);

  const filePath = path.join(EXPORT_DIR, fileName);
  await download.saveAs(filePath);
  const stat = fs.statSync(filePath);
  console.log("  下载完成: " + fileName + " (" + (stat.size / 1024).toFixed(1) + " KB)");

  // 简要预览
  const content = fs.readFileSync(filePath, "utf8");
  const rows = parseCSV(content);
  console.log("  解析行数: " + rows.length + " (含表头)");
  if (rows.length > 2) {
    const dataRows = rows.length - 2;
    const nonEmpty = rows[2].filter(v => v.trim() !== "").length;
    console.log("  数据行: " + dataRows + ", 首行非空列: " + nonEmpty + "/" + rows[2].length);
  }

  return filePath;
}

function parseCSV(content) {
  let rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (inQuotes && content[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !inQuotes) {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c === "\r" && !inQuotes) {
      // skip
    } else {
      field += c;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

(async () => {
  const state = JSON.parse(fs.readFileSync("lark-session.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state,
    locale: "zh-CN",
    viewport: { width: 1920, height: 1080 },
    acceptDownloads: true,
  });

  const page = await context.newPage();
  console.log("打开公会最核心指标...");
  await page.goto(
    "https://bjpem4otfhn6.jp.larksuite.com/wiki/F7mLwgvi3iQtMSkidqkjvGtepBc",
    { waitUntil: "domcontentloaded", timeout: 120000 }
  );
  await page.waitForTimeout(15000);
  console.log("页面加载完成\n");

  try {
    // 下载周核心指标 CSV
    await downloadSheetAsCSV(page, "周核心指标", "周核心指标.csv");
    console.log("");

    // 下载日核心指标 CSV
    await downloadSheetAsCSV(page, "日核心指标", "日核心指标.csv");
  } catch (e) {
    console.error("下载失败:", e.message);
    await page.screenshot({ path: "/tmp/lark-csv-error.png" });
  }

  await browser.close();
  console.log("\n全部完成!");
})();
