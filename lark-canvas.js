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

  const frame = page.frames()[0];
  const info = await frame.evaluate(() => {
    const canvases = document.querySelectorAll("canvas");
    const iframes = document.querySelectorAll("iframe");
    // 也看看 shadow DOM
    const allEls = document.querySelectorAll("*");
    let shadowCount = 0;
    for (const el of allEls) {
      if (el.shadowRoot) shadowCount++;
    }
    return {
      canvasCount: canvases.length,
      canvasSizes: [...canvases].map(c => c.width + "x" + c.height),
      iframeCount: iframes.length,
      iframeSrcs: [...iframes].map(i => i.src.substring(0, 100)),
      shadowDomCount: shadowCount,
      bodyChildCount: document.body.children.length,
    };
  });
  
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
