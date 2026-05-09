const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const state = JSON.parse(fs.readFileSync("lark-session.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 }, acceptDownloads: true });
  const page = await context.newPage();

  await page.goto("https://bjpem4otfhn6.jp.larksuite.com/wiki/SqU9w6gnEijI6BkPXeVjHMhLp4c?table=tblMa2F60C8jcIqL", {
    waitUntil: "domcontentloaded", timeout: 90000
  });
  await page.waitForTimeout(15000);
  
  // 点击更多菜单
  const moreBtn = await page.$("[class*=more-btn]") || await page.$("[class*=toolbar] button:last-child");
  if (moreBtn) await moreBtn.click();
  await page.waitForTimeout(1500);
  
  // 悬停导出
  const exportSpan = await page.$("span.navigation-bar__moreMenu_v3-item__text >> text=导出");
  if (exportSpan) await exportSpan.hover();
  else await page.hover("text=导出");
  await page.waitForTimeout(1500);
  
  // 点击 Excel/CSV
  await page.click("text=Excel/CSV 文件");
  await page.waitForTimeout(3000);
  
  // 截图看弹出了什么
  await page.screenshot({ path: "/tmp/lark-export-dialog.png" });
  console.log("截图已保存");
  
  // 看看页面上有什么按钮
  const frame = page.frames()[0];
  const buttons = await frame.evaluate(() => {
    return [...document.querySelectorAll("button, [role=button]")]
      .map(b => b.textContent.trim().substring(0, 40))
      .filter(t => t.length > 0 && t.length < 30);
  });
  console.log("按钮:", JSON.stringify(buttons));
  
  await browser.close();
})();
