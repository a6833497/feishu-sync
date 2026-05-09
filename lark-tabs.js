const { chromium } = require("playwright");
const fs = require("fs");

(async () => {
  const state = JSON.parse(fs.readFileSync("lark-session.json", "utf8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: state, viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.goto("https://bjpem4otfhn6.jp.larksuite.com/wiki/SqU9w6gnEijI6BkPXeVjHMhLp4c", {
    waitUntil: "domcontentloaded", timeout: 90000
  });
  await page.waitForTimeout(15000);

  // 找到所有表格标签/tab
  const frame = page.frames()[0];
  const tabs = await frame.evaluate(() => {
    // 找包含表名的元素
    const targets = ["公会数据汇总", "钻石支出表", "巴西个人运营数据", "印尼个人运营数据",
                     "进粉总汇", "公会群组", "申请资金", "备用金"];
    const found = [];
    const all = document.querySelectorAll("*");
    for (const el of all) {
      const text = (el.textContent || "").trim();
      for (const t of targets) {
        if (text === t || (text.includes(t) && text.length < t.length + 10)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.height < 50) {
            found.push({
              text: text.substring(0, 40),
              tag: el.tagName,
              class: (el.className || "").substring(0, 60),
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
          }
        }
      }
    }
    return found;
  });

  console.log(JSON.stringify(tabs, null, 2));
  await browser.close();
})();
