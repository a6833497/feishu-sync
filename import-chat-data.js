// import-chat-data.js — 导入印尼/巴西/西语聊天CSV到Nova Dashboard
// 三国数据合并到统一表，用region字段区分

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

function parseDate(v) {
  const s = cleanStr(v);
  if (!s) return null;
  const m1 = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2,"0")}-${m1[3].padStart(2,"0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}

function parseWeekRange(v) {
  const s = cleanStr(v);
  if (!s) return null;
  return s;
}

// ──────────── fuzzy 列名匹配（2026-05-03 改造）────────────
function normName(s) {
  return (s || "").replace(/[\s\n\r　]/g, "").toLowerCase();
}
function findCol(header, ...names) {
  const ns = names.map(normName);
  for (const n of ns) {
    const idx = header.findIndex((h) => normName(h).includes(n));
    if (idx >= 0) return idx;
  }
  return -1;
}
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

// ──────────── 建表 DDL ────────────

const DDL = `
CREATE TABLE IF NOT EXISTS lark_chat_daily (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT,
  date DATE NOT NULL,
  person TEXT,
  guild TEXT,
  new_group_joins INTEGER,
  first_paid_count INTEGER,
  first_paid_rate TEXT,
  s_user_count INTEGER,
  s_plus_user_count INTEGER,
  total_daily_output TEXT,
  direct_daily_online INTEGER,
  direct_monthly_output TEXT,
  guild_s_user_count INTEGER,
  guild_s_plus_user_count INTEGER,
  guild_total_daily_output TEXT,
  guild_daily_online INTEGER,
  guild_monthly_output TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, date, person, guild)
);

CREATE TABLE IF NOT EXISTS lark_chat_weekly (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT NOT NULL,
  guild TEXT,
  person TEXT,
  s_user_count INTEGER,
  s_plus_user_count INTEGER,
  total_weekly_output TEXT,
  total_weekly_online INTEGER,
  current_week_output TEXT,
  current_week_online TEXT,
  next_week_output TEXT,
  next_week_online TEXT,
  next_next_week_output TEXT,
  next_next_week_online TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, week_range, guild, person)
);

CREATE TABLE IF NOT EXISTS lark_chat_daily_summary (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  date DATE NOT NULL,
  week_range TEXT,
  direct_expense_cny TEXT,
  s_user_count INTEGER,
  s_plus_user_count INTEGER,
  total_output TEXT,
  direct_share TEXT,
  total_online INTEGER,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, date)
);

CREATE TABLE IF NOT EXISTS lark_chat_weekly_summary (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT NOT NULL,
  direct_output TEXT,
  direct_share TEXT,
  guild_output TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, week_range)
);

CREATE TABLE IF NOT EXISTS lark_chat_id_records (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  date DATE,
  expense_form TEXT,
  linky_id TEXT,
  whatsapp_id TEXT,
  amount TEXT,
  dana_id TEXT,
  person TEXT,
  guild TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, linky_id, date)
);

CREATE TABLE IF NOT EXISTS lark_chat_official (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT,
  date DATE,
  sid TEXT,
  country TEXT,
  language TEXT,
  nickname TEXT,
  is_verified TEXT,
  conversation_type TEXT,
  diamond_spent TEXT,
  diamond_month TEXT,
  guild_name TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, sid, date)
);

CREATE TABLE IF NOT EXISTS lark_chat_fission (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT,
  fission_date DATE,
  recommender_linky_id TEXT,
  recommender_whatsapp_id TEXT,
  recommended_linky_id TEXT,
  recommended_whatsapp_id TEXT,
  expiry_date TEXT,
  owner_person TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, recommended_linky_id, fission_date, owner_person)
);

CREATE TABLE IF NOT EXISTS lark_chat_fission_weekly (
  id SERIAL PRIMARY KEY,
  region TEXT NOT NULL,
  week_range TEXT NOT NULL,
  recommender_id TEXT,
  weekly_recommended_count INTEGER,
  weekly_diamond_share TEXT,
  owner_person TEXT,
  guild TEXT,
  data_raw TEXT,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW(),
  UNIQUE(region, week_range, recommender_id, owner_person)
);
`;

// ──────────── 导入函数 ────────────

async function importDailyData(client) {
  console.log("\n━━━ 导入日数据（日数据.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_日数据.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const cat = rows[0] || [];
    const sub = rows[1] || [];
    // 合并 header：sub 非空优先，否则用 cat（前 4 列收入周/人员/公会/收入日 在 cat 里）
    const header = [];
    for (let i = 0; i < Math.max(cat.length, sub.length); i++) {
      const a = (cat[i]||"").trim();
      const b = (sub[i]||"").trim();
      header.push(b || a);
    }
    const directStart  = cat.findIndex(c => normName(c) === "直属");
    const guildStart   = cat.findIndex((c, i) => i > directStart && normName(c) === "公会");
    const fissionStart = cat.findIndex(c => normName(c).includes("裂变"));
    const directEnd = guildStart > 0 ? guildStart : (fissionStart > 0 ? fissionStart : header.length);
    const guildEnd  = fissionStart > 0 ? fissionStart : header.length;

    const c = {
      week:     findCol(header, "收入周"),
      person:   findCol(header, "人员"),
      guild:    findCol(header, "公会"),
      date:     findCol(header, "收入日"),
      newGroupJoins:    findColIn(header, directStart, directEnd, "新人群进群数", "新人群\n进群数"),
      firstPaidCount:   findColIn(header, directStart, directEnd, "投流首提数", "投流\n首提数"),
      firstPaidRate:    findColIn(header, directStart, directEnd, "投流首提率", "投流\n首提率"),
      sUser:            findColIn(header, directStart, directEnd, "S用户数"),
      sPlusUser:        findColIn(header, directStart, directEnd, "S+用户数"),
      totalDaily:       findColIn(header, directStart, directEnd, "总粉日产出", "总粉\n日产出"),
      directDailyOnline:findColIn(header, directStart, directEnd, "总粉日在线", "总粉\n日在线"),
      directMonthly:    findColIn(header, directStart, directEnd, "当月粉日产出", "当月粉\n日产出"),
      guildSUser:       findColIn(header, guildStart, guildEnd, "S用户数"),
      guildSPlusUser:   findColIn(header, guildStart, guildEnd, "S+用户数"),
      guildTotalDaily:  findColIn(header, guildStart, guildEnd, "总粉产出", "总粉\n产出"),
      guildDailyOnline: findColIn(header, guildStart, guildEnd, "总粉在线人数", "总粉\n在线人数"),
      guildMonthly:     findColIn(header, guildStart, guildEnd, "当月粉产出", "当月粉\n产出"),
    };
    const required = ["week","person","guild","date","sUser","totalDaily","guildSUser","guildTotalDaily"];
    const missing = required.filter(k => c[k] < 0);
    if (missing.length) {
      console.log(`  [${region}] 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(2);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_daily (
        region, week_range, date, person, guild,
        new_group_joins, first_paid_count, first_paid_rate,
        s_user_count, s_plus_user_count, total_daily_output,
        direct_daily_online, direct_monthly_output,
        guild_s_user_count, guild_s_plus_user_count, guild_total_daily_output,
        guild_daily_online, guild_monthly_output, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
      ) ON CONFLICT(region, date, person, guild) DO UPDATE SET
        week_range=EXCLUDED.week_range,
        new_group_joins=EXCLUDED.new_group_joins,
        first_paid_count=EXCLUDED.first_paid_count,
        first_paid_rate=EXCLUDED.first_paid_rate,
        s_user_count=EXCLUDED.s_user_count,
        s_plus_user_count=EXCLUDED.s_plus_user_count,
        total_daily_output=EXCLUDED.total_daily_output,
        direct_daily_online=EXCLUDED.direct_daily_online,
        direct_monthly_output=EXCLUDED.direct_monthly_output,
        guild_s_user_count=EXCLUDED.guild_s_user_count,
        guild_s_plus_user_count=EXCLUDED.guild_s_plus_user_count,
        guild_total_daily_output=EXCLUDED.guild_total_daily_output,
        guild_daily_online=EXCLUDED.guild_daily_online,
        guild_monthly_output=EXCLUDED.guild_monthly_output,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const date = parseDate(get(r, c.date));
      const person = cleanStr(get(r, c.person));
      const guild = cleanStr(get(r, c.guild));
      if (!date || !person || !guild) { skipped++; continue; }

      try {
        await client.query(sql, [
          region,
          parseWeekRange(get(r, c.week)),
          date,
          person,
          guild,
          parseIntVal(get(r, c.newGroupJoins)),
          parseIntVal(get(r, c.firstPaidCount)),
          cleanStr(get(r, c.firstPaidRate)),
          parseIntVal(get(r, c.sUser)),
          parseIntVal(get(r, c.sPlusUser)),
          cleanStr(get(r, c.totalDaily)),
          parseIntVal(get(r, c.directDailyOnline)),
          cleanStr(get(r, c.directMonthly)),
          parseIntVal(get(r, c.guildSUser)),
          parseIntVal(get(r, c.guildSPlusUser)),
          cleanStr(get(r, c.guildTotalDaily)),
          parseIntVal(get(r, c.guildDailyOnline)),
          cleanStr(get(r, c.guildMonthly)),
          JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importWeeklyData(client) {
  console.log("\n━━━ 导入周数据（周数据.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_周数据.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const cat = rows[0] || [];
    const header = rows[1] || [];
    const guildStart  = cat.findIndex(c => normName(c) === "公会");
    const directStart = cat.findIndex(c => normName(c) === "直属");
    const guildEnd  = directStart > 0 ? directStart : header.length;
    const directEnd = header.length;

    const c = {
      week:    findCol(header, "收入周"),
      guild:   findCol(header, "公会"),
      person:  findCol(header, "人员"),
      // chat_weekly 的"S用户数"绑的是公会段（看 PG 数据 lark_chat_weekly.s_user_count 印尼1=395，对应 csv 公会S 段）
      sUser:           findColIn(header, guildStart, guildEnd, "S用户数"),
      sPlusUser:       findColIn(header, guildStart, guildEnd, "S+用户数"),
      totalWeekly:     findColIn(header, guildStart, guildEnd, "总粉周产出", "总粉\n周产出"),
      totalWeeklyOnline:findColIn(header, guildStart, guildEnd, "总粉周在线", "总粉\n周在线"),
      currentWeekOutput: findColIn(header, guildStart, guildEnd, "当周注册粉当周产出", "当周注册粉\n当周产出", "当周注册粉\n周产出"),
      currentWeekOnline: findColIn(header, guildStart, guildEnd, "当周注册粉当周在线", "当周注册粉\n当周在线", "当周注册粉\n周在线"),
      nextWeekOutput:    findColIn(header, guildStart, guildEnd, "当周注册粉次周产出", "当周注册粉\n次周产出"),
      nextWeekOnline:    findColIn(header, guildStart, guildEnd, "当周注册粉次周在线", "当周注册粉\n次周在线"),
      nextNextWeekOutput:findColIn(header, guildStart, guildEnd, "当周注册粉次次周产出", "当周注册粉\n次次周产出"),
      nextNextWeekOnline:findColIn(header, guildStart, guildEnd, "当周注册粉次次周在线", "当周注册粉\n次次周在线"),
    };
    const required = ["week","guild","person","sUser","totalWeekly"];
    const missing = required.filter(k => c[k] < 0);
    if (missing.length) {
      console.log(`  [${region}] 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(2);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_weekly (
        region, week_range, guild, person,
        s_user_count, s_plus_user_count, total_weekly_output, total_weekly_online,
        current_week_output, current_week_online, next_week_output, next_week_online,
        next_next_week_output, next_next_week_online, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW()
      ) ON CONFLICT(region, week_range, guild, person) DO UPDATE SET
        s_user_count=EXCLUDED.s_user_count,
        s_plus_user_count=EXCLUDED.s_plus_user_count,
        total_weekly_output=EXCLUDED.total_weekly_output,
        total_weekly_online=EXCLUDED.total_weekly_online,
        current_week_output=EXCLUDED.current_week_output,
        current_week_online=EXCLUDED.current_week_online,
        next_week_output=EXCLUDED.next_week_output,
        next_week_online=EXCLUDED.next_week_online,
        next_next_week_output=EXCLUDED.next_next_week_output,
        next_next_week_online=EXCLUDED.next_next_week_online,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const week = parseWeekRange(get(r, c.week));
      const guild = cleanStr(get(r, c.guild));
      const person = cleanStr(get(r, c.person));
      if (!week || !guild || !person) { skipped++; continue; }

      try {
        await client.query(sql, [
          region, week, guild, person,
          parseIntVal(get(r, c.sUser)), parseIntVal(get(r, c.sPlusUser)), cleanStr(get(r, c.totalWeekly)), parseIntVal(get(r, c.totalWeeklyOnline)),
          cleanStr(get(r, c.currentWeekOutput)), cleanStr(get(r, c.currentWeekOnline)), cleanStr(get(r, c.nextWeekOutput)), cleanStr(get(r, c.nextWeekOnline)),
          cleanStr(get(r, c.nextNextWeekOutput)), cleanStr(get(r, c.nextNextWeekOnline)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importDailySummary(client) {
  console.log("\n━━━ 导入日汇总（日汇总.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_日汇总.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const cat = rows[0] || [];
    const sub = rows[1] || [];
    const header = [];
    for (let i = 0; i < Math.max(cat.length, sub.length); i++) {
      const a = (cat[i]||"").trim();
      const b = (sub[i]||"").trim();
      header.push(b || a);
    }
    const directStart = cat.findIndex(c => normName(c) === "直属");
    const guildStart  = cat.findIndex((c, i) => i > directStart && normName(c) === "公会");
    const directEnd = guildStart > 0 ? guildStart : header.length;
    const guildEnd  = header.length;

    const c = {
      date:     findCol(header, "日期"),
      week:     findCol(header, "周") < 0 ? findCol(header, "对应周") : findCol(header, "周"),
      directExpenseCny: findColIn(header, directStart, directEnd, "今日支出人民币", "支出人民币"),
      sUser:        findColIn(header, directStart, directEnd, "S用户数"),
      sPlusUser:    findColIn(header, directStart, directEnd, "S+用户数"),
      totalOutput:  findColIn(header, directStart, directEnd, "总粉产出", "总粉\n产出"),
      directShare:  findColIn(header, directStart, directEnd, "直属占比", "直属\n占比"),
      totalOnline:  findColIn(header, directStart, directEnd, "总粉在线", "总粉\n在线", "总粉在线人数", "总粉\n在线人数"),
    };
    const required = ["date"];
    const missing = required.filter(k => c[k] < 0);
    if (missing.length) {
      console.log(`  [${region}] 缺关键列: ${missing.join(",")} | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(2);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_daily_summary (
        region, date, week_range, direct_expense_cny,
        s_user_count, s_plus_user_count, total_output, direct_share, total_online, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
      ) ON CONFLICT(region, date) DO UPDATE SET
        week_range=EXCLUDED.week_range,
        direct_expense_cny=EXCLUDED.direct_expense_cny,
        s_user_count=EXCLUDED.s_user_count,
        s_plus_user_count=EXCLUDED.s_plus_user_count,
        total_output=EXCLUDED.total_output,
        direct_share=EXCLUDED.direct_share,
        total_online=EXCLUDED.total_online,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const date = parseDate(get(r, c.date));
      if (!date) { skipped++; continue; }

      try {
        await client.query(sql, [
          region, date,
          parseWeekRange(get(r, c.week)),
          cleanStr(get(r, c.directExpenseCny)),
          parseIntVal(get(r, c.sUser)), parseIntVal(get(r, c.sPlusUser)), cleanStr(get(r, c.totalOutput)),
          cleanStr(get(r, c.directShare)), parseIntVal(get(r, c.totalOnline)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importWeeklySummary(client) {
  console.log("\n━━━ 导入周汇总（周汇总.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_周汇总.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    // 周汇总：1 行表头（4 列）
    const header = rows[0] || [];
    const c = {
      week:        findCol(header, "周"),
      directOutput:findCol(header, "直属产出"),
      directShare: findCol(header, "直属占比"),
      guildOutput: findCol(header, "公会产出"),
    };
    if (c.week < 0) {
      console.log(`  [${region}] 缺关键列 week | header=${JSON.stringify(header)}`);
      continue;
    }
    // 周汇总历史 importer 用 slice(2) 跳了 2 行，但实际只有 1 行表头 → 漏了第 1 行数据
    // 看 PG 数据存在 04/20～04/26 数据，说明历史上是 slice(1)。这里改为 slice(1) 与表头匹配
    const dataRows = rows.slice(1);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_weekly_summary (
        region, week_range, direct_output, direct_share, guild_output, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, NOW()
      ) ON CONFLICT(region, week_range) DO UPDATE SET
        direct_output=EXCLUDED.direct_output,
        direct_share=EXCLUDED.direct_share,
        guild_output=EXCLUDED.guild_output,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const week = parseWeekRange(get(r, c.week));
      if (!week) { skipped++; continue; }

      try {
        await client.query(sql, [
          region, week,
          cleanStr(get(r, c.directOutput)), cleanStr(get(r, c.directShare)), cleanStr(get(r, c.guildOutput)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importIDRecords(client) {
  console.log("\n━━━ 导入ID发放记录（id.csv）━━━");
  let totalInserted = 0;

  const idMap = [
    { file: "印尼聊天_印尼id.csv", region: "indo" },
    { file: "巴西聊天_巴西id.csv", region: "br" },
    { file: "西语聊天_西语id.csv", region: "es" }
  ];

  // 2026-05-02 修：3 个 id CSV 列结构不同（印尼有 expense_form/whatsapp/jumlah/dana，巴西/西语没有），改为按 header 名 fuzzy match
  const findCol = (header, ...names) => {
    for (const name of names) {
      const idx = header.findIndex((h) => (h || "").trim().toLowerCase().includes(name.toLowerCase()));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  for (const { file, region } of idMap) {
    const filePath = path.join(CSV_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    if (rows.length < 2) {
      console.log(`  [${region}] 行数不足 (${rows.length})`);
      continue;
    }

    const header = rows[0];
    const cDate = findCol(header, "日期");
    const cLinkyId = findCol(header, "linky id", "link id");
    const cExpenseForm = findCol(header, "支出形式"); // 印尼 only
    const cWhatsapp = findCol(header, "whatsapp"); // 印尼 only
    const cAmount = findCol(header, "jumlah", "金额"); // 印尼 only
    const cDana = findCol(header, "dana"); // 印尼 only
    const cPerson = findCol(header, "登记人", "归属人", "归属");
    const cGuild = findCol(header, "公会");

    if (cDate < 0 || cLinkyId < 0) {
      console.log(`  [${region}] 表头缺关键列 (date=${cDate} linky_id=${cLinkyId}) 跳过`);
      continue;
    }

    console.log(`  [${region}] 列映射: date=${cDate} linky=${cLinkyId} person=${cPerson} guild=${cGuild}`);

    const dataRows = rows.slice(1);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_id_records (
        region, date, expense_form, linky_id, whatsapp_id, amount, dana_id, person, guild, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
      ) ON CONFLICT(region, linky_id, date) DO UPDATE SET
        expense_form=EXCLUDED.expense_form,
        whatsapp_id=EXCLUDED.whatsapp_id,
        amount=EXCLUDED.amount,
        dana_id=EXCLUDED.dana_id,
        person=EXCLUDED.person,
        guild=EXCLUDED.guild,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;

    const get = (r, idx) => (idx >= 0 ? cleanStr(r[idx]) : "");

    for (const r of dataRows) {
      const date = parseDate(r[cDate]);
      const linkyId = get(r, cLinkyId);
      if (!date || !linkyId) { skipped++; continue; }

      try {
        await client.query(sql, [
          region,
          date,
          get(r, cExpenseForm),
          linkyId,
          get(r, cWhatsapp),
          get(r, cAmount),
          get(r, cDana),
          get(r, cPerson),
          get(r, cGuild),
          JSON.stringify(r),
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importOfficialData(client) {
  console.log("\n━━━ 导入官方数据（官方数据.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_官方数据.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const header = rows[0] || [];
    const c = {
      week:    findCol(header, "create_date(week)", "收入周"),
      date:    findCol(header, "create_date(day)", "收入日"),
      sid:     findCol(header, "sid"),
      country: findCol(header, "country"),
      language:findCol(header, "language"),
      nickname:findCol(header, "nickname"),
      isVerified: findCol(header, "is_verified"),
      conversationType: findCol(header, "conversation_type"),
    };
    if (c.sid < 0) {
      console.log(`  [${region}] 缺关键列 sid | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(1);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_official (
        region, week_range, date, sid, country, language, nickname, is_verified, conversation_type, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
      ) ON CONFLICT(region, sid, date) DO UPDATE SET
        week_range=EXCLUDED.week_range,
        country=EXCLUDED.country,
        language=EXCLUDED.language,
        nickname=EXCLUDED.nickname,
        is_verified=EXCLUDED.is_verified,
        conversation_type=EXCLUDED.conversation_type,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const sid = cleanStr(get(r, c.sid));
      const date = parseDate(get(r, c.date));
      if (!sid) { skipped++; continue; }

      try {
        await client.query(sql, [
          region, parseWeekRange(get(r, c.week)), date, sid,
          cleanStr(get(r, c.country)), cleanStr(get(r, c.language)), cleanStr(get(r, c.nickname)),
          cleanStr(get(r, c.isVerified)), cleanStr(get(r, c.conversationType)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importFissionData(client) {
  console.log("\n━━━ 导入裂变关系（裂变关系.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_裂变关系.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const header = rows[0] || [];
    const c = {
      week:           findCol(header, "对应周"),
      fissionDate:    findCol(header, "裂变日期"),
      recommenderLinky:    findCol(header, "推荐人linky id", "推荐人linkyid"),
      recommenderWhatsapp: findCol(header, "推荐人whatsapp"),
      recommendedLinky:    findCol(header, "被推荐人linky id", "被推荐人\nlinky id", "被推荐人linkyid"),
      recommendedWhatsapp: findCol(header, "被推荐人whatsapp", "被推荐人\nwhatsapp"),
      expiry:              findCol(header, "有效截止日期", "被推荐人\n有效截止日期"),
      ownerPerson:         findCol(header, "归属人", "被推荐人\n归属人"),
    };
    if (c.recommendedLinky < 0) {
      console.log(`  [${region}] 缺关键列 recommendedLinky | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(1);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_fission (
        region, week_range, fission_date, recommender_linky_id, recommender_whatsapp_id,
        recommended_linky_id, recommended_whatsapp_id, expiry_date, owner_person, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()
      ) ON CONFLICT(region, recommended_linky_id, fission_date, owner_person) DO UPDATE SET
        week_range=EXCLUDED.week_range,
        recommender_linky_id=EXCLUDED.recommender_linky_id,
        recommender_whatsapp_id=EXCLUDED.recommender_whatsapp_id,
        recommended_whatsapp_id=EXCLUDED.recommended_whatsapp_id,
        expiry_date=EXCLUDED.expiry_date,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const recommendedId = cleanStr(get(r, c.recommendedLinky));
      if (!recommendedId) { skipped++; continue; }

      try {
        await client.query(sql, [
          region,
          parseWeekRange(get(r, c.week)),
          parseDate(get(r, c.fissionDate)),
          cleanStr(get(r, c.recommenderLinky)), cleanStr(get(r, c.recommenderWhatsapp)),
          recommendedId, cleanStr(get(r, c.recommendedWhatsapp)),
          cleanStr(get(r, c.expiry)), cleanStr(get(r, c.ownerPerson)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

async function importFissionWeekly(client) {
  console.log("\n━━━ 导入裂变周数据（裂变周数据.csv）━━━");
  let totalInserted = 0;

  const regions = [
    { prefix: "印尼聊天", region: "indo" },
    { prefix: "巴西聊天", region: "br" },
    { prefix: "西语聊天", region: "es" }
  ];

  for (const { prefix, region } of regions) {
    const filePath = path.join(CSV_DIR, `${prefix}_裂变周数据.csv`);
    if (!fs.existsSync(filePath)) {
      console.log(`  [${region}] 文件不存在`);
      continue;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
    const rows = parseCSV(cleanContent);
    const header = rows[0] || [];
    const c = {
      week:        findCol(header, "对应周"),
      recommenderId: findCol(header, "推荐人id"),
      weeklyCount: findCol(header, "本周推荐人数", "本周\n推荐人数"),
      diamondShare:findCol(header, "本周获得分成钻石", "本周获得\n分成钻石", "分成钻石"),
      ownerPerson: findCol(header, "归属人"),
      guild:       findCol(header, "公会"),
    };
    if (c.week < 0 || c.recommenderId < 0) {
      console.log(`  [${region}] 缺关键列 week/recommenderId | header=${JSON.stringify(header)}`);
      continue;
    }
    const dataRows = rows.slice(1);
    let inserted = 0, skipped = 0;

    const sql = `
      INSERT INTO lark_chat_fission_weekly (
        region, week_range, recommender_id, weekly_recommended_count, weekly_diamond_share, owner_person, guild, data_raw, "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, NOW()
      ) ON CONFLICT(region, week_range, recommender_id, owner_person) DO UPDATE SET
        weekly_recommended_count=EXCLUDED.weekly_recommended_count,
        weekly_diamond_share=EXCLUDED.weekly_diamond_share,
        guild=EXCLUDED.guild,
        data_raw=EXCLUDED.data_raw,
        "updatedAt"=NOW()
    `;
    const get = (r, idx) => (idx >= 0 ? r[idx] : null);

    for (const r of dataRows) {
      const week = parseWeekRange(get(r, c.week));
      const recId = cleanStr(get(r, c.recommenderId));
      if (!week || !recId) { skipped++; continue; }

      try {
        await client.query(sql, [
          region, week, recId,
          parseIntVal(get(r, c.weeklyCount)), cleanStr(get(r, c.diamondShare)),
          cleanStr(get(r, c.ownerPerson)), cleanStr(get(r, c.guild)), JSON.stringify(r)
        ]);
        inserted++;
      } catch (e) {
        skipped++;
      }
    }

    console.log(`  [${region}] 插入 ${inserted} 条，跳过 ${skipped} 条`);
    totalInserted += inserted;
  }

  return totalInserted;
}

// ──────────── 主程序 ────────────

async function main() {
  const client = new Client(PG_CONFIG);
  try {
    await client.connect();
    console.log("✓ 数据库连接成功");

    // 创建表
    await client.query(DDL);
    console.log("✓ 表结构就绪");

    // 开始导入
    let stats = {
      daily: await importDailyData(client),
      weekly: await importWeeklyData(client),
      daily_summary: await importDailySummary(client),
      weekly_summary: await importWeeklySummary(client),
      id_records: await importIDRecords(client),
      official: await importOfficialData(client),
      fission: await importFissionData(client),
      fission_weekly: await importFissionWeekly(client)
    };

    console.log("\n" + "═".repeat(50));
    console.log("导入完成统计：");
    console.log(`  lark_chat_daily:           ${stats.daily} 条`);
    console.log(`  lark_chat_weekly:          ${stats.weekly} 条`);
    console.log(`  lark_chat_daily_summary:   ${stats.daily_summary} 条`);
    console.log(`  lark_chat_weekly_summary:  ${stats.weekly_summary} 条`);
    console.log(`  lark_chat_id_records:      ${stats.id_records} 条`);
    console.log(`  lark_chat_official:        ${stats.official} 条`);
    console.log(`  lark_chat_fission:         ${stats.fission} 条`);
    console.log(`  lark_chat_fission_weekly:  ${stats.fission_weekly} 条`);
    const total = Object.values(stats).reduce((a, b) => a + b, 0);
    console.log(`  总计：                     ${total} 条`);
    console.log("═".repeat(50));

  } catch (err) {
    console.error("错误:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
