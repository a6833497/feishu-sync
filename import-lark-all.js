// import-lark-all.js — 导入所有Lark CSV文件到Nova Dashboard数据库
// 幂等导入，ON CONFLICT DO UPDATE

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const CSV_DIR = "/home/ubuntu/feishu-sync/lark-exports/";
const PG_CONFIG = {
  host: "127.0.0.1", port: 5432,
  database: "nova_dashboard", user: "nova_app", password: "Nova2026pg!"
};

// ──────────── 工具函数 ────────────

function parseCSV(content) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (inQuotes && content[i+1] === '"') { field += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      row.push(field); field = "";
    } else if (c === "\n" && !inQuotes) {
      row.push(field); field = "";
      if (row.some(x => x !== "")) rows.push(row);
      row = [];
    } else if (c === "\r" && !inQuotes) {
      // skip
    } else {
      field += c;
    }
  }
  if (row.some(x => x !== "")) rows.push(row);
  return rows;
}

function cleanStr(v) {
  if (!v) return null;
  const s = v.trim();
  if (!s || s === "#N/A" || s === "#DIV/0!" || s === "#REF!" || s === "#VALUE!" || s === "#NAME?") return null;
  return s;
}

// 解析整数（含"万"单位）
function parseIntVal(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const clean = s.replace(/,/g, "").replace(/\s/g, "");
  if (/[万]/.test(clean)) {
    const num = parseFloat(clean.replace("万", ""));
    return isNaN(num) ? null : Math.round(num * 10000);
  }
  const n = parseInt(clean, 10);
  return isNaN(n) ? null : n;
}

// 解析浮点（含"万"、"%"，返回字符串保留原值）
function parseFloatStr(v) {
  const s = cleanStr(v);
  if (!s) return null;
  return s.trim();  // 保留"万"和"%"原值存TEXT（旧版逻辑，给仍是 text 的字段用）
}

// 2026-05-04 新增：转 numeric（用于 lark_daily_kpi 改 numeric 后的字段）
// 含"万" → ×10000；含"%" → strip %；其他 → parseFloat
function parseNumericFromText(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  // 含"万" → 数字 × 10000
  if (trimmed.includes("万")) {
    const n = parseFloat(trimmed.replace(/万/g, "").replace(/,/g, ""));
    return isNaN(n) ? null : n * 10000;
  }
  // 含"%" → 数字（保留原值，130% → 130）
  if (trimmed.includes("%")) {
    const n = parseFloat(trimmed.replace(/%/g, "").replace(/,/g, ""));
    return isNaN(n) ? null : n;
  }
  const n = parseFloat(trimmed.replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

// 解析日期字符串 → YYYY-MM-DD
function parseDate(v) {
  const s = cleanStr(v);
  if (!s) return null;
  // 2026/4/26 或 2026/04/26 → 2026-04-26
  const m1 = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2,"0")}-${m1[3].padStart(2,"0")}`;
  // 2026-04-26 直接返回
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

// ──────────── fuzzy 列名匹配（2026-05-03 改造，避免 r[N] 硬编码）────────────
// 把列名标准化：去空白/换行/全角空格
function normName(s) {
  return (s || "").replace(/[\s\n\r　]/g, "").toLowerCase();
}
// 在 header 中找首个含 name 的列（任意 name 命中即返回）
function findCol(header, ...names) {
  const ns = names.map(normName);
  for (const n of ns) {
    const idx = header.findIndex((h) => normName(h).includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}
// 从 startIdx (含) 到 endIdx (不含) 之间找列；用于"直属/公会"列名重复时按区段定位
function findColIn(header, startIdx, endIdx, ...names) {
  const ns = names.map(normName);
  const end = (endIdx === undefined || endIdx < 0) ? header.length : endIdx;
  for (const n of ns) {
    for (let i = startIdx; i < end; i++) {
      if (normName(header[i]).includes(n)) return i;
    }
  }
  return -1;
}
// 把 row0(分类) + row1(子列名) 合并成一个"完整列名"数组，便于直接 fuzzy
// 例如 row0=[..,"直属",..] row1=[..,"S用户数",..] → merged=[.."直属·S用户数"..]
// 但保留 row1 单独的 fuzzy 路径
function mergeHeaders(row0, row1) {
  const len = Math.max((row0||[]).length, (row1||[]).length);
  const out = [];
  let lastCat = "";
  for (let i = 0; i < len; i++) {
    const cat = (row0 && row0[i]) ? row0[i].trim() : "";
    if (cat) lastCat = cat;
    const sub = (row1 && row1[i]) ? row1[i].trim() : "";
    out.push(`${lastCat}|${sub}`);
  }
  return out;
}

// ──────────── 建表 DDL ────────────

const DDL = `
-- 1. lark_daily_kpi：公会日核心指标（替代lark_daily_sync数据源）
CREATE TABLE IF NOT EXISTS lark_daily_kpi (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  "guildAlias" TEXT NOT NULL,
  "revenueMonth" TEXT,
  "revenueWeek" TEXT,
  "plannedRegistrations" INTEGER,
  "actualRegistrations" INTEGER,
  "registrationRate" TEXT,
  "groupJoins" INTEGER,
  "groupJoinRate" TEXT,
  "directFirstPaidCount" INTEGER,
  "directFirstPaidRate" TEXT,
  "directSUserCount" INTEGER,
  "directSPlusUserCount" INTEGER,
  "directTotalDailyOutput" TEXT,
  "directOutputShare" TEXT,
  "directDailyOnline" INTEGER,
  "directCurrentMonthOutput" TEXT,
  "directNonCurrentMonthOutput" TEXT,
  "guildSUserCount" INTEGER,
  "guildSPlusUserCount" INTEGER,
  "guildTotalDailyOutput" TEXT,
  "guildDailyOnline" INTEGER,
  "guildCurrentMonthOutput" TEXT,
  "guildNonCurrentMonthOutput" TEXT,
  "fissionCount" INTEGER,
  "fissionOutput" TEXT,
  "fissionOutputShare" TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(date, "guildAlias")
);

-- 2. lark_monthly_kpi：公会月核心指标
CREATE TABLE IF NOT EXISTS lark_monthly_kpi (
  id SERIAL PRIMARY KEY,
  "revenueMonth" TEXT NOT NULL,
  "guildAlias" TEXT NOT NULL,
  "plannedRegistrations" TEXT,
  "actualRegistrations" TEXT,
  "registrationRate" TEXT,
  "groupJoins" TEXT,
  "groupJoinRate" TEXT,
  "firstPaidCount" TEXT,
  "firstPaidRate" TEXT,
  "guildSUserAvg" TEXT,
  "guildSPlusUserAvg" TEXT,
  "guildTotalMonthlyOutput" TEXT,
  "guildDailyAvgOutput" TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("revenueMonth", "guildAlias")
);

-- 3. lark_operator_daily：各国运营人员日数据（印尼/巴西/西语通用）
CREATE TABLE IF NOT EXISTS lark_operator_daily (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  "revenueWeek" TEXT,
  "operatorName" TEXT NOT NULL,
  "guildAlias" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "directGroupJoins" INTEGER,
  "directFirstPaidCount" INTEGER,
  "directFirstPaidRate" TEXT,
  "directSUserCount" INTEGER,
  "directSPlusUserCount" INTEGER,
  "directTotalDailyOutput" TEXT,
  "directDailyOnline" INTEGER,
  "directCurrentMonthOutput" TEXT,
  "guildSUserCount" INTEGER,
  "guildSPlusUserCount" INTEGER,
  "guildTotalDailyOutput" TEXT,
  "guildDailyOnline" INTEGER,
  "guildCurrentMonthOutput" TEXT,
  "fissionCount" INTEGER,
  "fissionOutput" TEXT,
  "fissionOutputShare" TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(date, "operatorName", "guildAlias", "region")
);

-- 4. lark_operator_weekly：各国运营人员周数据
CREATE TABLE IF NOT EXISTS lark_operator_weekly (
  id SERIAL PRIMARY KEY,
  "revenueWeek" TEXT NOT NULL,
  "operatorName" TEXT NOT NULL,
  "guildAlias" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "guildSUserCount" INTEGER,
  "guildSPlusUserCount" INTEGER,
  "guildTotalWeeklyOutput" TEXT,
  "guildWeeklyOnline" INTEGER,
  "currentWeekRegOutput" TEXT,
  "currentWeekRegOnline" TEXT,
  "nextWeekOutput" TEXT,
  "nextWeekOnline" TEXT,
  "nextNextWeekOutput" TEXT,
  "nextNextWeekOnline" TEXT,
  "directSUserCount" INTEGER,
  "directSPlusUserCount" INTEGER,
  "directTotalWeeklyOutput" TEXT,
  "directCurrentWeekOutput" TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE("revenueWeek", "operatorName", "guildAlias", "region")
);
`;

// ──────────── 导入逻辑 ────────────

async function importDailyKPI(client) {
  const content = fs.readFileSync(path.join(CSV_DIR, "公会_日核心指标.csv"), "utf-8");
  // 去BOM
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const rows = parseCSV(cleanContent);
  // Row 0: 分类行（直属指标/公会指标/裂变…），Row 1: 子列名行，Row 2+: 数据
  const cat = rows[0] || [];
  const header = rows[1] || [];
  const dataRows = rows.slice(2);
  let inserted = 0, skipped = 0;

  // 用分类行划分"直属/公会/裂变"区段（用于解决列名重复：S用户数/S+用户数/总粉日产出 直属和公会同名）
  const directStart = cat.findIndex(c => normName(c).includes("直属"));
  const guildStart  = cat.findIndex((c, i) => i > directStart && normName(c).includes("公会"));
  const fissionStart = cat.findIndex(c => normName(c).includes("裂变"));
  const directEnd = guildStart > 0 ? guildStart : (fissionStart > 0 ? fissionStart : header.length);
  const guildEnd  = fissionStart > 0 ? fissionStart : header.length;

  const c = {
    revenueMonth: findCol(header, "收入月"),
    revenueWeek:  findCol(header, "收入周"),
    date:         findCol(header, "收入日"),
    guild:        findCol(header, "公会"),
    plannedReg:   findCol(header, "计划注册数", "计划\n注册数"),
    actualReg:    findCol(header, "实际注册数", "实际\n注册数"),
    regRate:      findCol(header, "注册完成率", "注册\n完成率"),
    groupJoins:   findCol(header, "新人群进群数", "新人群\n进群数"),
    groupJoinRate:findCol(header, "新人群进群率", "新人群\n进群率"),
    directFirstPaidCount: findCol(header, "投流首提数", "投流\n首提数"),
    directFirstPaidRate:  findCol(header, "投流首提率", "投流\n首提率"),
    // 直属区段
    directSUser:           findColIn(header, directStart, directEnd, "S用户数"),
    directSPlusUser:       findColIn(header, directStart, directEnd, "S+用户数"),
    directTotalDailyOutput:findColIn(header, directStart, directEnd, "总粉日产出", "总粉\n日产出"),
    directOutputShare:     findColIn(header, directStart, directEnd, "直属占比"),
    directDailyOnline:     findColIn(header, directStart, directEnd, "直属日在线", "直属\n日在线"),
    directCurrentMonthOutput:    findColIn(header, directStart, directEnd, "当月粉日产出", "当月粉\n日产出"),
    directNonCurrentMonthOutput: findColIn(header, directStart, directEnd, "非当月粉产出", "非当月粉\n产出"),
    // 公会区段
    guildSUser:            findColIn(header, guildStart, guildEnd, "S用户数"),
    guildSPlusUser:        findColIn(header, guildStart, guildEnd, "S+用户数"),
    guildTotalDailyOutput: findColIn(header, guildStart, guildEnd, "总粉日产出", "总粉\n日产出"),
    guildDailyOnline:      findColIn(header, guildStart, guildEnd, "总粉日在线", "总粉\n日在线"),
    guildCurrentMonthOutput:    findColIn(header, guildStart, guildEnd, "当月粉日产出", "当月粉\n日产出"),
    guildNonCurrentMonthOutput: findColIn(header, guildStart, guildEnd, "非当月粉产出", "非当月粉\n产出"),
    // 裂变
    fissionCount:       findColIn(header, fissionStart, header.length, "裂变人数"),
    fissionOutput:      findColIn(header, fissionStart, header.length, "裂变粉产出", "裂变粉\n产出"),
    fissionOutputShare: findColIn(header, fissionStart, header.length, "裂变产出占比", "裂变产出\n占比"),
  };
  // 关键列缺失即报错（防止 fuzzy 误漂）
  const required = ["date","guild","directSUser","directSPlusUser","directTotalDailyOutput","guildSUser","guildSPlusUser","guildTotalDailyOutput"];
  const missing = required.filter(k => c[k] < 0);
  if (missing.length) throw new Error(`importDailyKPI 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);

  const sql = `
    INSERT INTO lark_daily_kpi (
      date, "guildAlias", "revenueMonth", "revenueWeek",
      "plannedRegistrations", "actualRegistrations", "registrationRate",
      "groupJoins", "groupJoinRate",
      "directFirstPaidCount", "directFirstPaidRate",
      "directSUserCount", "directSPlusUserCount",
      "directTotalDailyOutput", "directOutputShare", "directDailyOnline",
      "directCurrentMonthOutput", "directNonCurrentMonthOutput",
      "guildSUserCount", "guildSPlusUserCount",
      "guildTotalDailyOutput", "guildDailyOnline",
      "guildCurrentMonthOutput", "guildNonCurrentMonthOutput",
      "fissionCount", "fissionOutput", "fissionOutputShare",
      "updatedAt"
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,NOW()
    ) ON CONFLICT(date,"guildAlias") DO UPDATE SET
      "revenueMonth"=EXCLUDED."revenueMonth","revenueWeek"=EXCLUDED."revenueWeek",
      "plannedRegistrations"=EXCLUDED."plannedRegistrations","actualRegistrations"=EXCLUDED."actualRegistrations",
      "registrationRate"=EXCLUDED."registrationRate","groupJoins"=EXCLUDED."groupJoins",
      "groupJoinRate"=EXCLUDED."groupJoinRate","directFirstPaidCount"=EXCLUDED."directFirstPaidCount",
      "directFirstPaidRate"=EXCLUDED."directFirstPaidRate","directSUserCount"=EXCLUDED."directSUserCount",
      "directSPlusUserCount"=EXCLUDED."directSPlusUserCount","directTotalDailyOutput"=EXCLUDED."directTotalDailyOutput",
      "directOutputShare"=EXCLUDED."directOutputShare","directDailyOnline"=EXCLUDED."directDailyOnline",
      "directCurrentMonthOutput"=EXCLUDED."directCurrentMonthOutput","directNonCurrentMonthOutput"=EXCLUDED."directNonCurrentMonthOutput",
      "guildSUserCount"=EXCLUDED."guildSUserCount","guildSPlusUserCount"=EXCLUDED."guildSPlusUserCount",
      "guildTotalDailyOutput"=EXCLUDED."guildTotalDailyOutput","guildDailyOnline"=EXCLUDED."guildDailyOnline",
      "guildCurrentMonthOutput"=EXCLUDED."guildCurrentMonthOutput","guildNonCurrentMonthOutput"=EXCLUDED."guildNonCurrentMonthOutput",
      "fissionCount"=EXCLUDED."fissionCount","fissionOutput"=EXCLUDED."fissionOutput",
      "fissionOutputShare"=EXCLUDED."fissionOutputShare","updatedAt"=NOW()
  `;
  const get = (r, idx) => (idx >= 0 ? r[idx] : null);

  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const date = parseDate(get(r, c.date));
      const guild = cleanStr(get(r, c.guild));
      if (!date || !guild) { skipped++; continue; }
      await client.query(sql, [
        date, guild, cleanStr(get(r, c.revenueMonth)), cleanStr(get(r, c.revenueWeek)),
        parseIntVal(get(r, c.plannedReg)), parseIntVal(get(r, c.actualReg)), parseNumericFromText(get(r, c.regRate)),
        parseIntVal(get(r, c.groupJoins)), parseNumericFromText(get(r, c.groupJoinRate)),
        parseIntVal(get(r, c.directFirstPaidCount)), parseNumericFromText(get(r, c.directFirstPaidRate)),
        parseIntVal(get(r, c.directSUser)), parseIntVal(get(r, c.directSPlusUser)),
        parseNumericFromText(get(r, c.directTotalDailyOutput)), parseNumericFromText(get(r, c.directOutputShare)), parseIntVal(get(r, c.directDailyOnline)),
        parseNumericFromText(get(r, c.directCurrentMonthOutput)), parseNumericFromText(get(r, c.directNonCurrentMonthOutput)),
        parseIntVal(get(r, c.guildSUser)), parseIntVal(get(r, c.guildSPlusUser)),
        parseNumericFromText(get(r, c.guildTotalDailyOutput)), parseIntVal(get(r, c.guildDailyOnline)),
        parseNumericFromText(get(r, c.guildCurrentMonthOutput)), parseNumericFromText(get(r, c.guildNonCurrentMonthOutput)),
        parseIntVal(get(r, c.fissionCount)), parseNumericFromText(get(r, c.fissionOutput)), parseNumericFromText(get(r, c.fissionOutputShare))
      ]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  return { table: "lark_daily_kpi", inserted, skipped };
}

async function importWeeklyKPI(client) {
  const content = fs.readFileSync(path.join(CSV_DIR, "公会_周核心指标.csv"), "utf-8");
  // 去BOM
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const rows = parseCSV(cleanContent);
  const cat = rows[0] || [];
  const header = rows[1] || [];
  const dataRows = rows.slice(2);
  let inserted = 0, skipped = 0;

  // 分类锚点：直属指标 / 公会指标 / 次周指标 / 次次周指标
  const directStart = cat.findIndex(c => normName(c).includes("直属"));
  const guildStart  = cat.findIndex((c, i) => i > directStart && normName(c).includes("公会指标"));
  const nextWeekStart     = cat.findIndex(c => normName(c).includes("次周指标"));
  const nextNextWeekStart = cat.findIndex(c => normName(c).includes("次次周"));
  const directEnd = guildStart > 0 ? guildStart : header.length;
  const guildEnd  = nextWeekStart > 0 ? nextWeekStart : (nextNextWeekStart > 0 ? nextNextWeekStart : header.length);
  const nextWeekEnd = nextNextWeekStart > 0 ? nextNextWeekStart : header.length;
  // "公会指标"区段下半段（当周注册粉的当周/次周/次次周块都在此），需要进一步切片：
  // header 中 "当周注册粉\n当周产出/在线/在线率/人均" → 当周, "次周产出/.../留存百分比" → 次周, "次次周产出/.../留存百分比" → 次次周
  const c = {
    week:        findCol(header, "收入周"),
    guild:       findCol(header, "公会"),
    plannedReg:  findCol(header, "计划注册数", "计划\n注册数"),
    actualReg:   findCol(header, "实际注册数", "实际\n注册数"),
    regRate:     findCol(header, "注册完成率"),
    groupJoins:  findCol(header, "新人群进群数"),
    groupJoinRate: findCol(header, "新人群进群率"),
    firstPaidCount: findCol(header, "投流首提数"),
    firstPaidRate:  findCol(header, "投流首提率"),
    // 直属
    directSUser:           findColIn(header, directStart, directEnd, "S用户数"),
    directSPlusUser:       findColIn(header, directStart, directEnd, "S+用户数"),
    directTotalWeeklyOutput: findColIn(header, directStart, directEnd, "总粉周产出", "总粉\n周产出"),
    directDailyAvgOutput:    findColIn(header, directStart, directEnd, "总粉日均产出", "总粉\n日均产出"),
    directCurrentWeekOutput: findColIn(header, directStart, directEnd, "当周粉周产出", "当周粉\n周产出"),
    // 公会
    guildSUser:           findColIn(header, guildStart, guildEnd, "S用户数"),
    guildSPlusUser:       findColIn(header, guildStart, guildEnd, "S+用户数"),
    guildTotalWeeklyOutput: findColIn(header, guildStart, guildEnd, "总粉周产出", "总粉\n周产出"),
    guildWeeklyOnline:      findColIn(header, guildStart, guildEnd, "总粉周在线", "总粉\n周在线"),
    guildDailyAvgOutput:    findColIn(header, guildStart, guildEnd, "总粉日均产出", "总粉\n日均产出"),
    // 当周注册粉（在公会指标段后半部分）
    currentWeekRegOutput:    findColIn(header, guildStart, guildEnd, "当周注册粉当周产出", "当周注册粉\n当周产出"),
    currentWeekRegOnline:    findColIn(header, guildStart, guildEnd, "当周注册粉当周在线", "当周注册粉\n当周在线"),
    currentWeekRegOnlineRate:findColIn(header, guildStart, guildEnd, "当周注册粉当周在线率", "当周注册粉\n当周在线率"),
    currentWeekRegPerCapita: findColIn(header, guildStart, guildEnd, "当周注册粉当周人均", "当周注册粉\n当周人均"),
    // 次周指标
    nextWeekOutput:    findColIn(header, nextWeekStart, nextWeekEnd, "次周产出"),
    nextWeekOnline:    findColIn(header, nextWeekStart, nextWeekEnd, "次周在线"),
    nextWeekOnlineRate:findColIn(header, nextWeekStart, nextWeekEnd, "次周在线率"),
    nextWeekPerCapita: findColIn(header, nextWeekStart, nextWeekEnd, "次周人均"),
    nextWeekRetentionPct: findColIn(header, nextWeekStart, nextWeekEnd, "次周产出剩余百分比", "次周产出\n剩余百分比"),
    // 次次周指标
    nextNextWeekOutput:    findColIn(header, nextNextWeekStart, header.length, "次次周产出"),
    nextNextWeekOnline:    findColIn(header, nextNextWeekStart, header.length, "次次周在线"),
    nextNextWeekOnlineRate:findColIn(header, nextNextWeekStart, header.length, "次次周在线率"),
    nextNextWeekPerCapita: findColIn(header, nextNextWeekStart, header.length, "次次周人均"),
    nextNextWeekRetentionPct: findColIn(header, nextNextWeekStart, header.length, "次次周产出剩余百分比", "次次周产出\n剩余百分比"),
  };
  const required = ["week","guild","directSUser","directTotalWeeklyOutput","guildSUser","guildTotalWeeklyOutput","currentWeekRegOutput","nextWeekOutput","nextNextWeekOutput"];
  const missing = required.filter(k => c[k] < 0);
  if (missing.length) throw new Error(`importWeeklyKPI 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);

  const sql = `
    INSERT INTO lark_weekly_kpi (
      week, "guildAlias",
      "plannedRegistrations","actualRegistrations","registrationRate",
      "groupJoins","groupJoinRate",
      "firstPaidCount","firstPaidRate",
      "directSUserCount","directSPlusUserCount",
      "directTotalWeeklyOutput","directDailyAvgOutput","directCurrentWeekOutput",
      "guildSUserCount","guildSPlusUserCount",
      "guildTotalWeeklyOutput","guildWeeklyOnline","guildDailyAvgOutput",
      "currentWeekRegOutput","currentWeekRegOnline","currentWeekRegOnlineRate","currentWeekRegPerCapita",
      "nextWeekOutput","nextWeekOnline","nextWeekOnlineRate","nextWeekPerCapita","nextWeekRetentionPct",
      "nextNextWeekOutput","nextNextWeekOnline","nextNextWeekOnlineRate","nextNextWeekPerCapita","nextNextWeekRetentionPct",
      "updatedAt"
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,NOW()
    ) ON CONFLICT(week,"guildAlias") DO UPDATE SET
      "plannedRegistrations"=EXCLUDED."plannedRegistrations","actualRegistrations"=EXCLUDED."actualRegistrations",
      "registrationRate"=EXCLUDED."registrationRate","groupJoins"=EXCLUDED."groupJoins","groupJoinRate"=EXCLUDED."groupJoinRate",
      "firstPaidCount"=EXCLUDED."firstPaidCount","firstPaidRate"=EXCLUDED."firstPaidRate",
      "directSUserCount"=EXCLUDED."directSUserCount","directSPlusUserCount"=EXCLUDED."directSPlusUserCount",
      "directTotalWeeklyOutput"=EXCLUDED."directTotalWeeklyOutput","directDailyAvgOutput"=EXCLUDED."directDailyAvgOutput",
      "directCurrentWeekOutput"=EXCLUDED."directCurrentWeekOutput","guildSUserCount"=EXCLUDED."guildSUserCount",
      "guildSPlusUserCount"=EXCLUDED."guildSPlusUserCount","guildTotalWeeklyOutput"=EXCLUDED."guildTotalWeeklyOutput",
      "guildWeeklyOnline"=EXCLUDED."guildWeeklyOnline","guildDailyAvgOutput"=EXCLUDED."guildDailyAvgOutput",
      "currentWeekRegOutput"=EXCLUDED."currentWeekRegOutput","currentWeekRegOnline"=EXCLUDED."currentWeekRegOnline",
      "currentWeekRegOnlineRate"=EXCLUDED."currentWeekRegOnlineRate","currentWeekRegPerCapita"=EXCLUDED."currentWeekRegPerCapita",
      "nextWeekOutput"=EXCLUDED."nextWeekOutput","nextWeekOnline"=EXCLUDED."nextWeekOnline",
      "nextWeekOnlineRate"=EXCLUDED."nextWeekOnlineRate","nextWeekPerCapita"=EXCLUDED."nextWeekPerCapita",
      "nextWeekRetentionPct"=EXCLUDED."nextWeekRetentionPct","nextNextWeekOutput"=EXCLUDED."nextNextWeekOutput",
      "nextNextWeekOnline"=EXCLUDED."nextNextWeekOnline","nextNextWeekOnlineRate"=EXCLUDED."nextNextWeekOnlineRate",
      "nextNextWeekPerCapita"=EXCLUDED."nextNextWeekPerCapita","nextNextWeekRetentionPct"=EXCLUDED."nextNextWeekRetentionPct",
      "updatedAt"=NOW()
  `;
  const get = (r, idx) => (idx >= 0 ? r[idx] : null);
  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const week = cleanStr(get(r, c.week)), guild = cleanStr(get(r, c.guild));
      if (!week || !guild) { skipped++; continue; }
      await client.query(sql, [
        week, guild,
        parseIntVal(get(r, c.plannedReg)), parseIntVal(get(r, c.actualReg)), parseNumericFromText(get(r, c.regRate)),
        parseIntVal(get(r, c.groupJoins)), parseNumericFromText(get(r, c.groupJoinRate)),
        parseIntVal(get(r, c.firstPaidCount)), parseNumericFromText(get(r, c.firstPaidRate)),
        parseIntVal(get(r, c.directSUser)), parseIntVal(get(r, c.directSPlusUser)),
        parseNumericFromText(get(r, c.directTotalWeeklyOutput)), parseNumericFromText(get(r, c.directDailyAvgOutput)), parseNumericFromText(get(r, c.directCurrentWeekOutput)),
        parseIntVal(get(r, c.guildSUser)), parseIntVal(get(r, c.guildSPlusUser)),
        parseNumericFromText(get(r, c.guildTotalWeeklyOutput)), parseIntVal(get(r, c.guildWeeklyOnline)), parseNumericFromText(get(r, c.guildDailyAvgOutput)),
        parseNumericFromText(get(r, c.currentWeekRegOutput)), parseIntVal(get(r, c.currentWeekRegOnline)), parseNumericFromText(get(r, c.currentWeekRegOnlineRate)), parseNumericFromText(get(r, c.currentWeekRegPerCapita)),
        parseNumericFromText(get(r, c.nextWeekOutput)), parseIntVal(get(r, c.nextWeekOnline)), parseNumericFromText(get(r, c.nextWeekOnlineRate)), parseNumericFromText(get(r, c.nextWeekPerCapita)), parseNumericFromText(get(r, c.nextWeekRetentionPct)),
        parseNumericFromText(get(r, c.nextNextWeekOutput)), parseIntVal(get(r, c.nextNextWeekOnline)), parseNumericFromText(get(r, c.nextNextWeekOnlineRate)), parseNumericFromText(get(r, c.nextNextWeekPerCapita)), parseNumericFromText(get(r, c.nextNextWeekRetentionPct))
      ]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  return { table: "lark_weekly_kpi", inserted, skipped };
}

async function importMonthlyKPI(client) {
  const content = fs.readFileSync(path.join(CSV_DIR, "公会_月核心指标.csv"), "utf-8");
  // 去BOM
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const rows = parseCSV(cleanContent);
  const header = rows[1] || [];
  const dataRows = rows.slice(2);
  let inserted = 0, skipped = 0;

  const c = {
    month:        findCol(header, "收入月"),
    guild:        findCol(header, "公会"),
    plannedReg:   findCol(header, "计划注册数"),
    actualReg:    findCol(header, "实际注册数"),
    regRate:      findCol(header, "注册完成率"),
    groupJoins:   findCol(header, "新人群进群数"),
    groupJoinRate:findCol(header, "新人群进群率"),
    firstPaidCount: findCol(header, "首提数"),
    firstPaidRate:  findCol(header, "首提率"),
    guildSUserAvg:     findCol(header, "S用户日平均数"),
    guildSPlusUserAvg: findCol(header, "S+用户日平均数", "S+用户 日平均数"),
    guildTotalMonthlyOutput: findCol(header, "总粉月产出", "总粉\n月产出"),
    guildDailyAvgOutput:     findCol(header, "总粉日均产出", "总粉\n日均产出"),
  };
  const required = ["month","guild"];
  const missing = required.filter(k => c[k] < 0);
  if (missing.length) throw new Error(`importMonthlyKPI 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);

  const sql = `
    INSERT INTO lark_monthly_kpi (
      "revenueMonth","guildAlias",
      "plannedRegistrations","actualRegistrations","registrationRate",
      "groupJoins","groupJoinRate","firstPaidCount","firstPaidRate",
      "guildSUserAvg","guildSPlusUserAvg","guildTotalMonthlyOutput","guildDailyAvgOutput",
      "updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
    ON CONFLICT("revenueMonth","guildAlias") DO UPDATE SET
      "plannedRegistrations"=EXCLUDED."plannedRegistrations","actualRegistrations"=EXCLUDED."actualRegistrations",
      "registrationRate"=EXCLUDED."registrationRate","groupJoins"=EXCLUDED."groupJoins",
      "groupJoinRate"=EXCLUDED."groupJoinRate","firstPaidCount"=EXCLUDED."firstPaidCount",
      "firstPaidRate"=EXCLUDED."firstPaidRate","guildSUserAvg"=EXCLUDED."guildSUserAvg",
      "guildSPlusUserAvg"=EXCLUDED."guildSPlusUserAvg","guildTotalMonthlyOutput"=EXCLUDED."guildTotalMonthlyOutput",
      "guildDailyAvgOutput"=EXCLUDED."guildDailyAvgOutput","updatedAt"=NOW()
  `;
  const get = (r, idx) => (idx >= 0 ? r[idx] : null);
  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const month = cleanStr(get(r, c.month)), guild = cleanStr(get(r, c.guild));
      if (!month || !guild) { skipped++; continue; }
      await client.query(sql, [
        month, guild,
        parseFloatStr(get(r, c.plannedReg)), parseFloatStr(get(r, c.actualReg)), parseFloatStr(get(r, c.regRate)),
        parseFloatStr(get(r, c.groupJoins)), parseFloatStr(get(r, c.groupJoinRate)), parseFloatStr(get(r, c.firstPaidCount)), parseFloatStr(get(r, c.firstPaidRate)),
        parseFloatStr(get(r, c.guildSUserAvg)), parseFloatStr(get(r, c.guildSPlusUserAvg)), parseFloatStr(get(r, c.guildTotalMonthlyOutput)), parseFloatStr(get(r, c.guildDailyAvgOutput))
      ]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  return { table: "lark_monthly_kpi", inserted, skipped };
}

// 印尼/西语/巴西日数据：CSV row 0 前4列写真名(收入周/人员/公会/收入日)+后面写分类(直属/公会/裂变)，row 1 前4列空+后面写子列名
// 改造为 fuzzy match 后印尼/西语/巴西可共用同一逻辑
async function importOperatorDailyByHeader(client, filename, region) {
  const content = fs.readFileSync(path.join(CSV_DIR, filename), "utf-8");
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const rows = parseCSV(cleanContent);
  // row 0 既包含前4列字段名，也包含后面分类锚点
  const cat = rows[0] || [];
  const sub = rows[1] || [];
  // 合并 header：前 4 列 sub 是空，用 cat（收入周/人员/公会/收入日）；后面 sub 一定非空（如"裂变人数"），优先用 sub
  const header = [];
  for (let i = 0; i < Math.max(cat.length, sub.length); i++) {
    const a = (cat[i]||"").trim();
    const b = (sub[i]||"").trim();
    if (b) header.push(b);
    else header.push(a);
  }
  // 用 cat 行定位区段
  const directStart  = cat.findIndex(c => normName(c) === "直属");
  const guildStart   = cat.findIndex((c, i) => i > directStart && normName(c) === "公会");
  const fissionStart = cat.findIndex(c => normName(c).includes("裂变"));
  const directEnd = guildStart > 0 ? guildStart : (fissionStart > 0 ? fissionStart : header.length);
  const guildEnd  = fissionStart > 0 ? fissionStart : header.length;

  // 数据从 row 2 开始（包括巴西，原 importBrazilDaily 写 slice(1) 是错的，row 1 是子列名）
  const dataRows = rows.slice(2);
  let inserted = 0, skipped = 0;

  const c = {
    week:     findCol(header, "收入周"),
    operator: findCol(header, "人员"),
    guild:    findCol(header, "公会"),
    date:     findCol(header, "收入日"),
    directGroupJoins:      findColIn(header, directStart, directEnd, "新人群进群数", "新人群\n进群数"),
    directFirstPaidCount:  findColIn(header, directStart, directEnd, "投流首提数", "投流\n首提数"),
    directFirstPaidRate:   findColIn(header, directStart, directEnd, "投流首提率", "投流\n首提率"),
    directSUser:           findColIn(header, directStart, directEnd, "S用户数"),
    directSPlusUser:       findColIn(header, directStart, directEnd, "S+用户数"),
    directTotalDailyOutput: findColIn(header, directStart, directEnd, "总粉日产出", "总粉\n日产出"),
    directDailyOnline:      findColIn(header, directStart, directEnd, "总粉日在线", "总粉\n日在线"),
    directCurrentMonthOutput: findColIn(header, directStart, directEnd, "当月粉日产出", "当月粉\n日产出"),
    guildSUser:           findColIn(header, guildStart, guildEnd, "S用户数"),
    guildSPlusUser:       findColIn(header, guildStart, guildEnd, "S+用户数"),
    guildTotalDailyOutput: findColIn(header, guildStart, guildEnd, "总粉产出", "总粉\n产出"),
    guildDailyOnline:      findColIn(header, guildStart, guildEnd, "总粉在线人数", "总粉\n在线人数"),
    guildCurrentMonthOutput: findColIn(header, guildStart, guildEnd, "当月粉产出", "当月粉\n产出"),
    // 裂变（巴西的"裂变首提数"和印尼/西语的"裂变人数"，都映射到 fissionCount；这是源头表差异，不在我们能改范围）
    fissionCount:       findColIn(header, fissionStart, header.length, "裂变人数", "裂变首提数", "裂变\n首提数"),
    fissionOutput:      findColIn(header, fissionStart, header.length, "裂变粉产出", "裂变粉\n产出"),
    fissionOutputShare: findColIn(header, fissionStart, header.length, "裂变产出占比", "裂变产出\n占比"),
  };
  const required = ["operator","guild","date","directSUser","directTotalDailyOutput","guildSUser","guildTotalDailyOutput"];
  const missing = required.filter(k => c[k] < 0);
  if (missing.length) throw new Error(`importOperatorDaily(${region}) 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);

  const sql = `
    INSERT INTO lark_operator_daily (
      date,"revenueWeek","operatorName","guildAlias","region",
      "directGroupJoins","directFirstPaidCount","directFirstPaidRate",
      "directSUserCount","directSPlusUserCount",
      "directTotalDailyOutput","directDailyOnline","directCurrentMonthOutput",
      "guildSUserCount","guildSPlusUserCount",
      "guildTotalDailyOutput","guildDailyOnline","guildCurrentMonthOutput",
      "fissionCount","fissionOutput","fissionOutputShare","updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW())
    ON CONFLICT(date,"operatorName","guildAlias","region") DO UPDATE SET
      "revenueWeek"=EXCLUDED."revenueWeek","directGroupJoins"=EXCLUDED."directGroupJoins",
      "directFirstPaidCount"=EXCLUDED."directFirstPaidCount","directFirstPaidRate"=EXCLUDED."directFirstPaidRate",
      "directSUserCount"=EXCLUDED."directSUserCount","directSPlusUserCount"=EXCLUDED."directSPlusUserCount",
      "directTotalDailyOutput"=EXCLUDED."directTotalDailyOutput","directDailyOnline"=EXCLUDED."directDailyOnline",
      "directCurrentMonthOutput"=EXCLUDED."directCurrentMonthOutput","guildSUserCount"=EXCLUDED."guildSUserCount",
      "guildSPlusUserCount"=EXCLUDED."guildSPlusUserCount","guildTotalDailyOutput"=EXCLUDED."guildTotalDailyOutput",
      "guildDailyOnline"=EXCLUDED."guildDailyOnline","guildCurrentMonthOutput"=EXCLUDED."guildCurrentMonthOutput",
      "fissionCount"=EXCLUDED."fissionCount","fissionOutput"=EXCLUDED."fissionOutput",
      "fissionOutputShare"=EXCLUDED."fissionOutputShare","updatedAt"=NOW()
  `;
  const get = (r, idx) => (idx >= 0 ? r[idx] : null);
  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const date = parseDate(get(r, c.date)), operator = cleanStr(get(r, c.operator)), guild = cleanStr(get(r, c.guild));
      if (!date || !operator || !guild) { skipped++; continue; }
      await client.query(sql, [
        date, cleanStr(get(r, c.week)), operator, guild, region,
        parseIntVal(get(r, c.directGroupJoins)), parseIntVal(get(r, c.directFirstPaidCount)), parseFloatStr(get(r, c.directFirstPaidRate)),
        parseIntVal(get(r, c.directSUser)), parseIntVal(get(r, c.directSPlusUser)),
        parseFloatStr(get(r, c.directTotalDailyOutput)), parseIntVal(get(r, c.directDailyOnline)), parseFloatStr(get(r, c.directCurrentMonthOutput)),
        parseIntVal(get(r, c.guildSUser)), parseIntVal(get(r, c.guildSPlusUser)),
        parseFloatStr(get(r, c.guildTotalDailyOutput)), parseIntVal(get(r, c.guildDailyOnline)), parseFloatStr(get(r, c.guildCurrentMonthOutput)),
        parseIntVal(get(r, c.fissionCount)), parseFloatStr(get(r, c.fissionOutput)), parseFloatStr(get(r, c.fissionOutputShare))
      ]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  return { table: `lark_operator_daily(${region})`, inserted, skipped };
}

// 兼容旧调用名
async function importOperatorDaily2Header(client, filename, region) {
  return importOperatorDailyByHeader(client, filename, region);
}
async function importBrazilDaily(client) {
  return importOperatorDailyByHeader(client, "公会_巴西日.csv", "巴西");
}

// 周数据（印尼/巴西/西语，2行表头）
async function importOperatorWeekly(client, filename, region) {
  const content = fs.readFileSync(path.join(CSV_DIR, filename), "utf-8");
  // 去BOM
  const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
  const rows = parseCSV(cleanContent);
  const cat = rows[0] || [];
  const header = rows[1] || [];
  const dataRows = rows.slice(2);
  let inserted = 0, skipped = 0;

  // 分类锚点
  const guildStart  = cat.findIndex(c => normName(c) === "公会");
  const directStart = cat.findIndex(c => normName(c) === "直属");
  const guildEnd  = directStart > 0 ? directStart : header.length;
  const directEnd = header.length;

  const c = {
    week:     findCol(header, "收入周"),
    guild:    findCol(header, "公会"),
    operator: findCol(header, "人员"),
    // 公会段
    guildSUser:           findColIn(header, guildStart, guildEnd, "S用户数"),
    guildSPlusUser:       findColIn(header, guildStart, guildEnd, "S+用户数"),
    guildTotalWeeklyOutput: findColIn(header, guildStart, guildEnd, "总粉周产出", "总粉\n周产出"),
    guildWeeklyOnline:      findColIn(header, guildStart, guildEnd, "总粉周在线", "总粉\n周在线"),
    currentWeekRegOutput: findColIn(header, guildStart, guildEnd, "当周注册粉当周产出", "当周注册粉\n当周产出", "当周注册粉\n周产出"),
    currentWeekRegOnline: findColIn(header, guildStart, guildEnd, "当周注册粉当周在线", "当周注册粉\n当周在线", "当周注册粉\n周在线"),
    nextWeekOutput:       findColIn(header, guildStart, guildEnd, "当周注册粉次周产出", "当周注册粉\n次周产出"),
    nextWeekOnline:       findColIn(header, guildStart, guildEnd, "当周注册粉次周在线", "当周注册粉\n次周在线"),
    nextNextWeekOutput:   findColIn(header, guildStart, guildEnd, "当周注册粉次次周产出", "当周注册粉\n次次周产出"),
    nextNextWeekOnline:   findColIn(header, guildStart, guildEnd, "当周注册粉次次周在线", "当周注册粉\n次次周在线"),
    // 直属段
    directSUser:           findColIn(header, directStart, directEnd, "S用户数"),
    directSPlusUser:       findColIn(header, directStart, directEnd, "S+用户数"),
    directTotalWeeklyOutput: findColIn(header, directStart, directEnd, "总粉当周产出", "总粉\n当周产出", "总粉周产出", "总粉\n周产出", "总粉产出", "总粉\n产出"),
    directCurrentWeekOutput: findColIn(header, directStart, directEnd, "当周粉当周产出", "当周粉\n当周产出", "当周粉周产出", "当周粉\n周产出", "当周粉产出", "当周粉\n产出"),
  };
  const required = ["week","guild","operator","guildSUser","guildTotalWeeklyOutput","directSUser","directTotalWeeklyOutput"];
  const missing = required.filter(k => c[k] < 0);
  if (missing.length) throw new Error(`importOperatorWeekly(${region}) 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);

  const sql = `
    INSERT INTO lark_operator_weekly (
      "revenueWeek","operatorName","guildAlias","region",
      "guildSUserCount","guildSPlusUserCount","guildTotalWeeklyOutput","guildWeeklyOnline",
      "currentWeekRegOutput","currentWeekRegOnline","nextWeekOutput","nextWeekOnline",
      "nextNextWeekOutput","nextNextWeekOnline",
      "directSUserCount","directSPlusUserCount","directTotalWeeklyOutput","directCurrentWeekOutput",
      "updatedAt"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
    ON CONFLICT("revenueWeek","operatorName","guildAlias","region") DO UPDATE SET
      "guildSUserCount"=EXCLUDED."guildSUserCount","guildSPlusUserCount"=EXCLUDED."guildSPlusUserCount",
      "guildTotalWeeklyOutput"=EXCLUDED."guildTotalWeeklyOutput","guildWeeklyOnline"=EXCLUDED."guildWeeklyOnline",
      "currentWeekRegOutput"=EXCLUDED."currentWeekRegOutput","currentWeekRegOnline"=EXCLUDED."currentWeekRegOnline",
      "nextWeekOutput"=EXCLUDED."nextWeekOutput","nextWeekOnline"=EXCLUDED."nextWeekOnline",
      "nextNextWeekOutput"=EXCLUDED."nextNextWeekOutput","nextNextWeekOnline"=EXCLUDED."nextNextWeekOnline",
      "directSUserCount"=EXCLUDED."directSUserCount","directSPlusUserCount"=EXCLUDED."directSPlusUserCount",
      "directTotalWeeklyOutput"=EXCLUDED."directTotalWeeklyOutput","directCurrentWeekOutput"=EXCLUDED."directCurrentWeekOutput",
      "updatedAt"=NOW()
  `;
  const get = (r, idx) => (idx >= 0 ? r[idx] : null);
  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const week = cleanStr(get(r, c.week)), guild = cleanStr(get(r, c.guild)), operator = cleanStr(get(r, c.operator));
      if (!week || !guild || !operator) { skipped++; continue; }
      await client.query(sql, [
        week, operator, guild, region,
        parseIntVal(get(r, c.guildSUser)), parseIntVal(get(r, c.guildSPlusUser)), parseFloatStr(get(r, c.guildTotalWeeklyOutput)), parseIntVal(get(r, c.guildWeeklyOnline)),
        parseFloatStr(get(r, c.currentWeekRegOutput)), parseFloatStr(get(r, c.currentWeekRegOnline)), parseFloatStr(get(r, c.nextWeekOutput)), parseFloatStr(get(r, c.nextWeekOnline)),
        parseFloatStr(get(r, c.nextNextWeekOutput)), parseFloatStr(get(r, c.nextNextWeekOnline)),
        parseIntVal(get(r, c.directSUser)), parseIntVal(get(r, c.directSPlusUser)), parseFloatStr(get(r, c.directTotalWeeklyOutput)), parseFloatStr(get(r, c.directCurrentWeekOutput))
      ]);
      inserted++;
    }
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  return { table: `lark_operator_weekly(${region})`, inserted, skipped };
}

// ──────────── 主流程 ────────────

(async () => {
  const client = new Client(PG_CONFIG);
  await client.connect();
  console.log("已连接数据库");

  // 建表
  console.log("\n[1/2] 创建表...");
  await client.query(DDL);
  console.log("  表创建完成（已有则跳过）");

  // 导入
  console.log("\n[2/2] 导入数据...");
  const results = [];

  try {
    results.push(await importDailyKPI(client));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ lark_daily_kpi 失败:", e.message); }

  try {
    results.push(await importWeeklyKPI(client));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ lark_weekly_kpi 失败:", e.message); }

  try {
    results.push(await importMonthlyKPI(client));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ lark_monthly_kpi 失败:", e.message); }

  try {
    results.push(await importOperatorDaily2Header(client, "公会_印尼日.csv", "印尼"));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 印尼日 失败:", e.message); }

  try {
    results.push(await importBrazilDaily(client));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 巴西日 失败:", e.message); }

  try {
    results.push(await importOperatorDaily2Header(client, "公会_西语日.csv", "西语"));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 西语日 失败:", e.message); }

  try {
    results.push(await importOperatorWeekly(client, "公会_印尼周.csv", "印尼"));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 印尼周 失败:", e.message); }

  try {
    results.push(await importOperatorWeekly(client, "公会_巴西周.csv", "巴西"));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 巴西周 失败:", e.message); }

  try {
    results.push(await importOperatorWeekly(client, "公会_西语周.csv", "西语"));
    console.log(`  ✓ ${results[results.length-1].table}: ${results[results.length-1].inserted} 行`);
  } catch(e) { console.error("  ✗ 西语周 失败:", e.message); }

  console.log("\n========== 汇总 ==========");
  let totalInserted = 0;
  for (const r of results) {
    console.log(`  ${r.table}: 写入 ${r.inserted} 行，跳过 ${r.skipped} 行`);
    totalInserted += r.inserted;
  }
  console.log(`\n  总计写入: ${totalInserted} 行`);

  // 验证
  console.log("\n========== 验证查询 ==========");
  const tables = ["lark_daily_kpi","lark_weekly_kpi","lark_monthly_kpi","lark_operator_daily","lark_operator_weekly"];
  for (const t of tables) {
    const { rows } = await client.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: ${rows[0].cnt} 行`);
  }

  await client.end();
})().catch(e => { console.error("致命错误:", e); process.exit(1); });
