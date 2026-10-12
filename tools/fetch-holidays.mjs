// 取某一年的「需要按空闲价计费的工作日」，也就是法定节假日里落在周一至周五的那些天。
//
// 为什么只要工作日：官方计价规则是「周一至周五（不含中国法定节假日）9:00-12:00、
// 14:00-18:00 为高峰」，所以调休上班的周六周日本来就不在「周一至周五」里，已经按
// 空闲算，不需要额外处理。真正要修的是「工作日但是节假日」那些天。
//
// 两个数据源，按 URL 自动识别：
//   不传 URL  -> 节假日 API（JSON，省事）
//   传 URL    -> 国务院办公厅通知原文（HTML，权威，且原文自带星期标注可交叉校验）
//
// 用法：
//   node fetch-holidays.mjs 2027
//   node fetch-holidays.mjs 2027 "https://www.gov.cn/zhengce/content/.../content_xxxxxxx.htm"

const YEAR = Number(process.argv[2] ?? new Date().getFullYear());
const explicitUrl = process.argv[3];
const url = explicitUrl ?? `https://timor.tech/api/holiday/year/${YEAR}`;

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const isWeekend = (iso) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

// 合规说明：中国政府网的 robots.txt 没有禁止 /zhengce/ 路径（它 Disallow 的都是
// /2016xxx/ 这类旧版路径），这个页面是政府主动公开的规范性文件。本脚本一年只跑一次、
// 由人手动触发、只取 19 个日期（事实数据）而不转载正文，User-Agent 如实标识自己。
const res = await fetch(url, {
  headers: {
    'user-agent': 'dsh-fare-meter/1.0 (personal cost meter; one request per year)',
    accept: 'application/json,text/html,*/*',
  },
  signal: AbortSignal.timeout(20000),
});
const body = await res.text();
if (!res.ok) { console.error(`HTTP ${res.status}，取不到数据`); process.exit(1); }

/** 解析结果：ISO 日期数组（只含周一至周五）。 */
let dates = [];
/** 校验记录，非空则全部通过才可信。 */
const checks = [];
let source = url;

if (body.trimStart().startsWith('{')) {
  // ---------------------------------------------------------- 节假日 API --
  const data = JSON.parse(body);
  if (data.code !== 0) { console.error(`API 返回 code=${data.code}`); process.exit(1); }
  const entries = Object.entries(data.holiday ?? {});
  if (entries.length === 0) { console.error('API 没有返回任何条目'); process.exit(1); }
  const off = entries.filter(([, v]) => v.holiday === true);
  const work = entries.filter(([, v]) => v.holiday === false);
  dates = off.map(([, v]) => v.date).filter((d) => d.startsWith(String(YEAR)) && !isWeekend(d)).sort();
  console.log(`数据源：节假日 API`);
  console.log(`  条目 ${entries.length}：放假 ${off.length}，调休上班 ${work.length}`);
  console.log(`  调休上班的日期（**不需要**写进表里）：${work.map(([, v]) => v.date).sort().join(' ')}`);
} else {
  // ------------------------------------------------------ 国务院通知原文 --
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
  const titleYear = Number((text.match(/关于(\d{4})年\s*部分节假日安排的通知/) ?? [])[1]);
  if (Number.isFinite(titleYear) && titleYear !== YEAR) {
    console.error(`警告：页面标题是 ${titleYear} 年，你要的是 ${YEAR} 年`);
  }
  const start = text.indexOf('通知如下');
  const end = text.indexOf('鼓励单位和个人');
  if (start < 0 || end <= start) { console.error('找不到通知正文'); process.exit(1); }

  console.log(`数据源：国务院办公厅通知原文`);
  const found = new Set();
  for (const sentence of text.slice(start, end).split('。')) {
    const head = sentence.match(/(\d{1,2})月(\d{1,2})日(?:\s*（([^）]*)）)?\s*至\s*(?:(\d{1,2})月)?(\d{1,2})日(?:\s*（([^）]*)）)?/);
    if (head === null) continue;
    const sm = Number(head[1]);
    const sd = Number(head[2]);
    const em = head[4] === void 0 ? sm : Number(head[4]);
    const ed = Number(head[5]);
    // 原文自己标了星期，拿来交叉校验日期展开是否正确。
    for (const [spot, month, day, stated] of [['起', sm, sd, head[3]], ['止', em, ed, head[6]]]) {
      if (stated === void 0) continue;
      const actual = WEEK[new Date(Date.UTC(YEAR, month - 1, day)).getUTCDay()];
      checks.push({ month, day, spot, stated, actual, ok: stated.includes(actual) });
    }
    const cursor = new Date(Date.UTC(YEAR, sm - 1, sd));
    const last = new Date(Date.UTC(YEAR, em - 1, ed));
    if (last < cursor) { console.error('区间倒置：', sentence.trim()); continue; }
    for (; cursor <= last; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const day = cursor.getUTCDay();
      if (day === 0 || day === 6) continue;
      found.add(cursor.toISOString().slice(0, 10));
    }
  }
  dates = [...found].sort();

  console.log(`\n--- 原文星期标注校验 ---`);
  let bad = 0;
  for (const row of checks) {
    if (!row.ok) bad += 1;
    console.log(`  ${String(row.month).padStart(2)}月${String(row.day).padStart(2)}日 ${row.spot}  原文「${row.stated}」 实算「${row.actual}」  ${row.ok ? '✓' : '✗'}`);
  }
  console.log(bad === 0
    ? `  全部一致（${checks.length} 个边界日期）—— 日期展开可信`
    : `  ⚠ ${bad} 个不一致，解析可能有问题，先别用这份结果`);
  if (bad > 0) process.exit(1);
}

// ------------------------------------------------------------------ 输出 --
const peakHours = dates.length * 6;
console.log(`\n=== ${YEAR} 年「工作日但放假」共 ${dates.length} 天 ===`);
console.log(dates.join('  '));
console.log(`\n影响高峰时段：${dates.length} 天 × 6 小时 = ${peakHours} 小时`);
console.log(`占全年 8760 小时的 ${(100 * peakHours / 8760).toFixed(2)}%`);
console.log(`不修正会高估总花费约 ${(100 * peakHours / 8760 * 0.5).toFixed(2)}%`);

console.log(`\n=== 粘进 client.js 的 HOLIDAYS 常量 ===`);
console.log(`    const HOLIDAYS = new Set([`);
let line = '      ';
for (const date of dates) {
  const piece = `'${date}', `;
  if (line.length + piece.length > 96) { console.log(line.trimEnd()); line = '      '; }
  line += piece;
}
if (line.trim() !== '') console.log(line.trimEnd());
console.log(`    ]);`);
console.log(`\n（来源：${source}）`);
