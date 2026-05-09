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

  // 在导航栏区域找 "..." 按钮
  const frame = page.frames()[0];
  const candidates = await frame.evaluate(() => {
    const els = document.querySelectorAll("[class*=more], [class*=More], [aria-label], [data-testid]");
    return [...els].slice(0, 30).map(el => ({
      tag: el.tagName,
      class: (el.className || "").substring(0, 80),
      aria: el.getAttribute("aria-label") || "",
      testid: el.getAttribute("data-testid") || "",
      text: (el.textContent || "").substring(0, 20).trim(),
      rect: el.getBoundingClientRect ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y) } : null
    }));
  });
  
  console.log(JSON.stringify(candidates.filter(c => c.class.includes("more") || c.aria || c.testid), null, 2).substring(0, 3000));
  
  await browser.close();
})();
