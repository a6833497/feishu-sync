const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const CSV_PATH = path.join(__dirname, "lark-exports", "周核心指标.csv");
const PG_CONFIG = { host: "127.0.0.1", port: 5432, database: "nova_dashboard", user: "nova_app", password: "Nova2026pg!" };

function parseCSV(content) {
  let rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (inQuotes && content[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (c === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if (c === "\n" && !inQuotes) {
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else if (c === "\r" && !inQuotes) {
      // skip
    } else {
      field += c;
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

function parseNumber(val) {
  if (!val || val.trim() === "" || val.includes("DIV") || val.includes("REF") || val.includes("N/A")) return null;
  // 去掉万、逗号、空格
  let s = val.trim().replace(/,/g, "").replace(/ /g, "");
  // 如果包含百分号或万，保留原值作为 TEXT
  return s;
}

function parseIntVal(val) {
  if (!val || val.trim() === "") return null;
  let s = val.trim().replace(/,/g, "").replace(/ /g, "");
  if (s.includes("DIV") || s.includes("REF") || s.includes("N/A")) return null;
  // 处理 "万" 单位
  if (s.includes("万")) {
    const num = parseFloat(s.replace("万", ""));
    return isNaN(num) ? null : Math.round(num * 10000);
  }
  const num = parseInt(s, 10);
  return isNaN(num) ? null : num;
}

(async () => {
  console.log("读取 CSV:", CSV_PATH);
  const content = fs.readFileSync(CSV_PATH, "utf8");
  const rows = parseCSV(content);
  console.log("总行数:", rows.length, "(含2行表头)");

  // 跳过前2行表头
  const dataRows = rows.slice(2);
  console.log("数据行:", dataRows.length);

  const client = new Client(PG_CONFIG);
  await client.connect();

  const upsertSQL = `
    INSERT INTO lark_weekly_kpi (
      week, "guildAlias",
      "plannedRegistrations", "actualRegistrations", "registrationRate", "groupJoins", "groupJoinRate",
      "firstPaidCount", "firstPaidRate", "directSUserCount", "directSPlusUserCount",
      "directTotalWeeklyOutput", "directDailyAvgOutput", "directCurrentWeekOutput",
      "guildSUserCount", "guildSPlusUserCount", "guildTotalWeeklyOutput", "guildWeeklyOnline", "guildDailyAvgOutput",
      "currentWeekRegOutput", "currentWeekRegOnline", "currentWeekRegOnlineRate", "currentWeekRegPerCapita",
      "nextWeekOutput", "nextWeekOnline", "nextWeekOnlineRate", "nextWeekPerCapita", "nextWeekRetentionPct",
      "nextNextWeekOutput", "nextNextWeekOnline", "nextNextWeekOnlineRate", "nextNextWeekPerCapita", "nextNextWeekRetentionPct",
      "updatedAt"
    ) VALUES (
      $1, $2,
      $3, $4, $5, $6, $7,
      $8, $9, $10, $11,
      $12, $13, $14,
      $15, $16, $17, $18, $19,
      $20, $21, $22, $23,
      $24, $25, $26, $27, $28,
      $29, $30, $31, $32, $33,
      NOW()
    )
    ON CONFLICT(week, "guildAlias") DO UPDATE SET
      "plannedRegistrations" = EXCLUDED."plannedRegistrations",
      "actualRegistrations" = EXCLUDED."actualRegistrations",
      "registrationRate" = EXCLUDED."registrationRate",
      "groupJoins" = EXCLUDED."groupJoins",
      "groupJoinRate" = EXCLUDED."groupJoinRate",
      "firstPaidCount" = EXCLUDED."firstPaidCount",
      "firstPaidRate" = EXCLUDED."firstPaidRate",
      "directSUserCount" = EXCLUDED."directSUserCount",
      "directSPlusUserCount" = EXCLUDED."directSPlusUserCount",
      "directTotalWeeklyOutput" = EXCLUDED."directTotalWeeklyOutput",
      "directDailyAvgOutput" = EXCLUDED."directDailyAvgOutput",
      "directCurrentWeekOutput" = EXCLUDED."directCurrentWeekOutput",
      "guildSUserCount" = EXCLUDED."guildSUserCount",
      "guildSPlusUserCount" = EXCLUDED."guildSPlusUserCount",
      "guildTotalWeeklyOutput" = EXCLUDED."guildTotalWeeklyOutput",
      "guildWeeklyOnline" = EXCLUDED."guildWeeklyOnline",
      "guildDailyAvgOutput" = EXCLUDED."guildDailyAvgOutput",
      "currentWeekRegOutput" = EXCLUDED."currentWeekRegOutput",
      "currentWeekRegOnline" = EXCLUDED."currentWeekRegOnline",
      "currentWeekRegOnlineRate" = EXCLUDED."currentWeekRegOnlineRate",
      "currentWeekRegPerCapita" = EXCLUDED."currentWeekRegPerCapita",
      "nextWeekOutput" = EXCLUDED."nextWeekOutput",
      "nextWeekOnline" = EXCLUDED."nextWeekOnline",
      "nextWeekOnlineRate" = EXCLUDED."nextWeekOnlineRate",
      "nextWeekPerCapita" = EXCLUDED."nextWeekPerCapita",
      "nextWeekRetentionPct" = EXCLUDED."nextWeekRetentionPct",
      "nextNextWeekOutput" = EXCLUDED."nextNextWeekOutput",
      "nextNextWeekOnline" = EXCLUDED."nextNextWeekOnline",
      "nextNextWeekOnlineRate" = EXCLUDED."nextNextWeekOnlineRate",
      "nextNextWeekPerCapita" = EXCLUDED."nextNextWeekPerCapita",
      "nextNextWeekRetentionPct" = EXCLUDED."nextNextWeekRetentionPct",
      "updatedAt" = NOW()
  `;

  let inserted = 0, skipped = 0;

  await client.query("BEGIN");
  try {
    for (const r of dataRows) {
      const week = (r[0] || "").trim();
      const guild = (r[1] || "").trim();

      if (!week || !guild) {
        skipped++;
        continue;
      }

      const params = [
        week, guild,
        parseIntVal(r[2]), parseIntVal(r[3]), parseNumber(r[4]), parseIntVal(r[5]), parseNumber(r[6]),
        parseIntVal(r[7]), parseNumber(r[8]), parseIntVal(r[9]), parseIntVal(r[10]),
        parseNumber(r[11]), parseNumber(r[12]), parseNumber(r[13]),
        parseIntVal(r[14]), parseIntVal(r[15]), parseNumber(r[16]), parseIntVal(r[17]), parseNumber(r[18]),
        parseNumber(r[19]), parseIntVal(r[20]), parseNumber(r[21]), parseNumber(r[22]),
        parseNumber(r[23]), parseIntVal(r[24]), parseNumber(r[25]), parseNumber(r[26]), parseNumber(r[27]),
        parseNumber(r[28]), parseIntVal(r[29]), parseNumber(r[30]), parseNumber(r[31]), parseNumber(r[32]),
      ];

      await client.query(upsertSQL, params);
      inserted++;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }

  console.log("\n导入完成:");
  console.log("  插入/更新:", inserted, "行");
  console.log("  跳过:", skipped, "行");

  // 验证
  const { rows: countRows } = await client.query("SELECT COUNT(*) as cnt FROM lark_weekly_kpi");
  console.log("  表中总行数:", countRows[0].cnt);

  const { rows: sample } = await client.query('SELECT * FROM lark_weekly_kpi WHERE "actualRegistrations" IS NOT NULL ORDER BY week DESC LIMIT 5');
  console.log("\n最新5条记录:");
  for (const s of sample) {
    console.log("  " + s.week + " | " + s.guildAlias + " | 注册=" + s.actualRegistrations + " | 进群=" + s.groupJoins + " | 首提=" + s.firstPaidCount + " | 公会周产出=" + s.guildTotalWeeklyOutput);
  }

  await client.end();
})();
