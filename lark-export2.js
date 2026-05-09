const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const state = JSON.parse(fs.readFileSync("lark-session.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.goto("https://bjpem4otfhn6.jp.larksuite.com/wiki/SqU9w6gnEijI6BkPXeVjHMhLp4c?table=tblMa2F60C8jcIqL", {
    waitUntil: "domcontentloaded", timeout: 90000
  });
  await page.waitForTimeout(15000);
  
  // 点击 "..." 菜单
  const moreBtn = await page.$("[class*=more-btn]") || await page.$("[class*=toolbar] button:last-child");
  if (moreBtn) await moreBtn.click();
  await page.waitForTimeout(2000);
  
  // 悬停"导出"展开子菜单
  const exportItem = await page.$("text=导出");
  if (exportItem) {
    await exportItem.hover();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "/tmp/lark-export-submenu.png" });
    
    // 查找子菜单项
    const frame = page.frames()[0];
    const subItems = await frame.evaluate(() => {
      const items = document.querySelectorAll("[class*=submenu] [class*=item], [class*=menu-item]");
      return [...items].map(el => el.textContent.trim().substring(0, 50)).filter(t => t.length > 0 && t.length < 30);
    });
    console.log("子菜单:", JSON.stringify(subItems));
  }
  
  await browser.close();
})();
