
const { chromium } = require(playwright);
const fs = require(fs);
const path = require(path);

const SESSION = /home/ubuntu/feishu-sync/lark-session.json;
const EXPORT_DIR = /home/ubuntu/feishu-sync/lark-exports;
const BASE_URL = https://bjpem4otfhn6.jp.larksuite.com/wiki/SqU9w6gnEijI6BkPXeVjHMhLp4c;

const TABLES = [{"id": "tblMa2F60C8jcIqL", "name": "\u516c\u4f1a\u6570\u636e\u6c47\u603b", "key": "guild_daily"}, {"id": "tblIHJZg3r9oY1QN", "name": "\u94bb\u77f3\u652f\u51fa\u8868", "key": "diamond_expense"}, {"id": "tblQCOghP3rkDcIO", "name": "\u5df4\u897f\u4e2a\u4eba\u8fd0\u8425\u6570\u636e", "key": "br_ops"}, {"id": "tbl21rT3ghXwIBZw", "name": "\u5370\u5c3c\u4e2a\u4eba\u8fd0\u8425\u6570\u636e", "key": "id_ops"}];

(async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        storageState: JSON.parse(fs.readFileSync(SESSION, utf8)),
        locale: zh-CN
    });
    
    const results = {};
    
    for (const table of TABLES) {
        const url = `${BASE_URL}?table=${table.id}`;
        console.log(`读取: ${table.name}`);
        
        const page = await context.newPage();
        try {
            await page.goto(url, { waitUntil: networkidle, timeout: 60000 });
            await page.waitForTimeout(5000);
            
            // 尝试读取表格数据
            const data = await page.evaluate(() => {
                const rows = [];
                const headerCells = document.querySelectorAll(.lark-bitable-header-cell, th);
                const headers = [...headerCells].map(h => h.textContent.trim()).filter(h => h);
                
                if (headers.length === 0) return { headers: [], rows: [] };
                
                const rowEls = document.querySelectorAll(.lark-bitable-row, tr);
                for (const row of rowEls) {
                    const cells = row.querySelectorAll(.lark-bitable-cell, td);
                    const vals = [...cells].map(c => c.textContent.trim());
                    if (vals.length > 0 && vals.some(v => v)) {
                        rows.push(vals);
                    }
                }
                
                return { headers, rows };
            });
            
            // 转成对象数组
            const records = data.rows.map(row => {
                const obj = {};
                data.headers.forEach((h, i) => { obj[h] = row[i] || ; });
                return obj;
            });
            
            results[table.key] = records;
            console.log(`  ✅ ${records.length} 条`);
        } catch (e) {
            console.log(`  ❌ ${e.message}`);
            results[table.key] = [];
        }
        await page.close();
    }
    
    // 写入 JSON
    fs.writeFileSync(/home/ubuntu/feishu-sync/lark_data.json, JSON.stringify({
        _export_time: new Date().toISOString(),
        _method: playwright,
        data: results
    }, null, 2));
    
    console.log(`保存: /home/ubuntu/feishu-sync/lark_data.json`);
    await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
