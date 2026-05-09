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
  
  // 找到 "..." 更多菜单按钮并点击
  const moreBtn = await page.$("[aria-label*=more], [aria-label*=More], [data-testid*=more], [class*=more-btn]") 
    || await page.$("text=⋯")
    || await page.$("[class*=toolbar] button:last-child");
  
  if (moreBtn) {
    await moreBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/lark-menu.png" });
    console.log("菜单截图已保存");
  } else {
    console.log("未找到更多按钮，尝试右键菜单");
    // 在表名位置右键
    await page.mouse.click(400, 60, { button: "right" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "/tmp/lark-menu.png" });
  }

  // 找所有包含"导出"或"export"或"下载"的元素
  const frame = page.frames()[0];
  const exportEls = await frame.evaluate(() => {
    const all = document.querySelectorAll("*");
    const found = [];
    for (const el of all) {
      const text = el.innerText || el.textContent || "";
      if (text.match(/导出|export|下载|download|xlsx|csv/i) && text.length < 50) {
        found.push({ tag: el.tagName, text: text.trim().substring(0, 50), className: (el.className || "").substring(0, 60) });
      }
    }
    return found.slice(0, 15);
  });
  
  console.log("含导出/下载的元素:", JSON.stringify(exportEls, null, 2));
  
  await browser.close();
})();
