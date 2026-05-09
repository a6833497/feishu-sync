// lark-api-download.js — 用 Lark API 替代 Playwright 下载所有 CSV
// 跑法：node lark-api-download.js [输出目录]
// 默认输出 lark-exports-api/，便于和 Playwright 的 lark-exports/ 对比验证

const fs = require("fs");
const path = require("path");

// ─── 配置 ────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, "lark-config.json");
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
const APP_ID = cfg.app_id;
const APP_SECRET = cfg.app_secret;
const API_BASE = cfg.api_base || "https://open.larksuite.com";

const EXPORT_DIR = process.argv[2] || path.join(__dirname, "lark-exports");
if (!fs.existsSync(EXPORT_DIR)) fs.mkdirSync(EXPORT_DIR, { recursive: true });

// 4 个源 sheet（5-3 解出来的 spreadsheet token，已验证可读）
const SHEETS = {
  guild_core: "JffEsLQ0ThS4dstNdBWjWhOmpug",  // 公会最核心指标
  indo_chat: "I5o1sE8Jyhuijjtug8JjJwsHptb",   // 印尼聊天
  br_chat:   "T9HfssY4rhH8ZitdUjJj2soapgg",   // 巴西聊天
  es_chat:   "PRVHs7jKRhyhcTtIfIqjW0kSp5e",   // 西语聊天
};

// 下载计划：兼容现有 import-lark-all.js / import-chat-data.js 期望的文件名
// 公会_印尼日 / 公会_巴西日 / 公会_西语日 等本是聚合 sheet 的 IMPORTRANGE → 直接从源 sheet 拿
const PLAN = [
  // 公会最核心指标（前 3 个 tab 是真数据，后面的是 IMPORTRANGE → 跳过去源拿）
  { sheet: "guild_core", tab: "日核心指标", file: "公会_日核心指标.csv" },
  { sheet: "guild_core", tab: "周核心指标", file: "公会_周核心指标.csv" },
  { sheet: "guild_core", tab: "月核心指标", file: "公会_月核心指标.csv" },
  // 印尼源 sheet
  { sheet: "indo_chat", tab: "日数据", file: "印尼聊天_日数据.csv" },
  { sheet: "indo_chat", tab: "日数据", file: "公会_印尼日.csv" },        // 复用源（聚合 sheet 是 IMPORTRANGE）
  { sheet: "indo_chat", tab: "周数据", file: "印尼聊天_周数据.csv" },
  { sheet: "indo_chat", tab: "周数据", file: "公会_印尼周.csv" },
  { sheet: "indo_chat", tab: "日汇总", file: "印尼聊天_日汇总.csv" },
  { sheet: "indo_chat", tab: "周汇总", file: "印尼聊天_周汇总.csv" },
  { sheet: "indo_chat", tab: "印尼id", file: "印尼聊天_印尼id.csv" },
  { sheet: "indo_chat", tab: "官方数据", file: "印尼聊天_官方数据.csv" },
  { sheet: "indo_chat", tab: "裂变关系", file: "印尼聊天_裂变关系.csv" },
  { sheet: "indo_chat", tab: "周排行", file: "印尼聊天_周排行.csv" },
  { sheet: "indo_chat", tab: "裂变周数据", file: "印尼聊天_裂变周数据.csv" },
  { sheet: "indo_chat", tab: "带动消费对比", file: "印尼聊天_带动消费对比.csv" },
  // 巴西
  { sheet: "br_chat", tab: "日数据", file: "巴西聊天_日数据.csv" },
  { sheet: "br_chat", tab: "日数据", file: "公会_巴西日.csv" },
  { sheet: "br_chat", tab: "周数据", file: "巴西聊天_周数据.csv" },
  { sheet: "br_chat", tab: "周数据", file: "公会_巴西周.csv" },
  { sheet: "br_chat", tab: "日汇总", file: "巴西聊天_日汇总.csv" },
  { sheet: "br_chat", tab: "周汇总", file: "巴西聊天_周汇总.csv" },
  { sheet: "br_chat", tab: "巴西id", file: "巴西聊天_巴西id.csv" },
  { sheet: "br_chat", tab: "官方数据", file: "巴西聊天_官方数据.csv" },
  { sheet: "br_chat", tab: "裂变关系", file: "巴西聊天_裂变关系.csv" },
  { sheet: "br_chat", tab: "裂变周数据", file: "巴西聊天_裂变周数据.csv" },
  { sheet: "br_chat", tab: "周排名", file: "巴西聊天_周排名.csv" },
  // 西语
  { sheet: "es_chat", tab: "日数据", file: "西语聊天_日数据.csv" },
  { sheet: "es_chat", tab: "日数据", file: "公会_西语日.csv" },
  { sheet: "es_chat", tab: "周数据", file: "西语聊天_周数据.csv" },
  { sheet: "es_chat", tab: "周数据", file: "公会_西语周.csv" },
  { sheet: "es_chat", tab: "日汇总", file: "西语聊天_日汇总.csv" },
  { sheet: "es_chat", tab: "周汇总", file: "西语聊天_周汇总.csv" },
  { sheet: "es_chat", tab: "西语id", file: "西语聊天_西语id.csv" },
  { sheet: "es_chat", tab: "官方数据", file: "西语聊天_官方数据.csv" },
  { sheet: "es_chat", tab: "裂变关系", file: "西语聊天_裂变关系.csv" },
  { sheet: "es_chat", tab: "裂变周数据", file: "西语聊天_裂变周数据.csv" },
  { sheet: "es_chat", tab: "裂变每周新增达标数", file: "西语聊天_裂变每周新增达标数.csv" },
  { sheet: "es_chat", tab: "非直属转直属", file: "西语聊天_非直属转直属.csv" },
  { sheet: "es_chat", tab: "国家数据分析", file: "西语聊天_国家数据分析.csv" },
];

// 分页：单次 < 10 MB，保险用 20000 行
const PAGE_ROWS = 20000;

// ─── token 缓存 ──────────────────────────────────────────
let tokenCache = null;
async function getToken() {
  if (tokenCache && tokenCache.exp > Date.now()) return tokenCache.tok;
  const r = await fetch(`${API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error("get_token: " + d.msg);
  tokenCache = { tok: d.tenant_access_token, exp: Date.now() + (d.expire - 300) * 1000 };
  return tokenCache.tok;
}

// ─── Lark API 调用 ───────────────────────────────────────
async function listSheetTabs(spreadsheetToken) {
  const tok = await getToken();
  const r = await fetch(`${API_BASE}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`, {
    headers: { Authorization: `Bearer ${tok}` },
  });
  const d = await r.json();
  if (d.code !== 0) throw new Error("list_tabs: " + d.msg);
  return d.data.sheets;
}

async function getSheetRange(spreadsheetToken, sheetId, startRow, endRow, lastCol = "Z") {
  const tok = await getToken();
  const range = `${sheetId}!A${startRow}:${lastCol}${endRow}`;
  const url = `${API_BASE}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}?valueRenderOption=FormattedValue`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  const d = await r.json();
  if (d.code !== 0) throw new Error(`get_range ${range}: ${d.msg}`);
  return d.data.valueRange.values || [];
}

// ─── CSV 写入 ────────────────────────────────────────────
// Lark API 返回值类型多样：string / number / null / {type:"#UNSUPPORT VALUE"} / 富文本数组 / hyperlink object
// 这里把所有类型转成跟 Playwright 渲染等价的字符串
function cellToString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    // 修浮点尾巴：3.7237999999999998 → 3.7238
    if (!Number.isInteger(v) && String(v).length > 12) {
      return String(Number(v.toPrecision(12)));
    }
    return String(v);
  }
  if (Array.isArray(v)) {
    // 富文本：[{type:"text", text:"..."}, ...]
    return v.map(cellToString).join("");
  }
  if (typeof v === "object") {
    if (v.type === "#UNSUPPORT VALUE") return "#N/A";  // 兼容 Playwright 渲染
    if ("text" in v) return String(v.text);
    if ("link" in v && v.text) return String(v.text);
    if ("link" in v) return String(v.link);
    return "";
  }
  return String(v);
}

function csvEscape(v) {
  const s = cellToString(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function rowsToCsv(rows) {
  return rows.map(row => row.map(csvEscape).join(",")).join("\n") + "\n";
}

// 列号转字母 (1→A, 26→Z, 27→AA)
function colNum2Letter(n) {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ─── 单个 tab 下载 ───────────────────────────────────────
async function downloadTab(spreadsheetToken, tab, outFile) {
  const rowCount = tab.grid_properties?.row_count || 1000;
  const colCount = tab.grid_properties?.column_count || 26;
  const lastCol = colNum2Letter(colCount);

  const allRows = [];
  for (let start = 1; start <= rowCount; start += PAGE_ROWS) {
    const end = Math.min(start + PAGE_ROWS - 1, rowCount);
    const batch = await getSheetRange(spreadsheetToken, tab.sheet_id, start, end, lastCol);
    allRows.push(...batch);
    process.stdout.write(`    [${start}-${end}] +${batch.length} 行  `);
  }
  // 去掉末尾全空行（API 经常返回 row_count 但实际有效行更少）
  while (allRows.length > 0 && allRows[allRows.length - 1].every(c => c == null || c === "")) {
    allRows.pop();
  }
  const csv = rowsToCsv(allRows);
  fs.writeFileSync(outFile, "﻿" + csv);  // BOM 兼容 Excel
  console.log(`→ ${path.basename(outFile)} (${allRows.length} 行, ${(csv.length/1024).toFixed(1)} KB)`);
  return allRows.length;
}

// ─── 主流程 ──────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  console.log(`[lark-api-download] 输出: ${EXPORT_DIR}\n`);

  // 拿所有 sheet 的 tab 元数据（只 4 次调用）
  const sheetTabs = {};
  for (const [key, token] of Object.entries(SHEETS)) {
    sheetTabs[key] = await listSheetTabs(token);
    console.log(`✓ ${key} (${token.slice(0,12)}...) ${sheetTabs[key].length} tabs`);
  }
  console.log("");

  // 按 PLAN 下载每个 tab
  let ok = 0, fail = 0;
  for (const item of PLAN) {
    const tabs = sheetTabs[item.sheet];
    const tab = tabs.find(t => t.title === item.tab);
    if (!tab) {
      console.log(`✗ ${item.file}: 找不到 tab "${item.tab}" in ${item.sheet}`);
      fail++;
      continue;
    }
    const outFile = path.join(EXPORT_DIR, item.file);
    console.log(`  ${item.sheet}/${item.tab} (${tab.grid_properties?.row_count||"?"}行 × ${tab.grid_properties?.column_count||"?"}列)`);
    try {
      await downloadTab(SHEETS[item.sheet], tab, outFile);
      ok++;
    } catch (e) {
      console.log(`✗ ${item.file}: ${e.message}`);
      fail++;
    }
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n完成 ${ok}/${PLAN.length} 文件，失败 ${fail}，耗时 ${dt}s`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error("致命错误:", e);
  process.exit(2);
});
