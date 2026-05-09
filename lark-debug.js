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

  // 检查 frames
  const frames = page.frames();
  console.log("Frames: " + frames.length);
  for (const f of frames) {
    console.log("  " + f.url().substring(0, 120));
    const cellCount = await f.evaluate(() => document.querySelectorAll("[class*=cell]").length).catch(() => -1);
    const allText = await f.evaluate(() => document.body.innerText.substring(0, 200)).catch(() => "");
    console.log("    cells: " + cellCount + " text: " + allText.substring(0, 100).replace(/\n/g, " | "));
  }

  await browser.close();
})();
