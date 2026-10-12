// 直接抽取 client.js 里的 PRICES / HOLIDAYS / isPeak / priceTurn 真实代码来跑，
// 不是复制一份，避免「测的和跑的不是同一份」。
import fs from 'node:fs';

const file = new URL('../client.js', import.meta.url);
const code = fs.readFileSync(file, 'utf8');
const start = code.indexOf('const PRICES = {');
const end = code.indexOf('// ------------------------------------------------------------- 读取轮次 --');
if (start < 0 || end <= start) { console.error('抽取失败'); process.exit(1); }
const extracted = code.slice(start, end);
console.log('已抽取', extracted.length, '字符（PRICES + HOLIDAYS + isPeak + priceTurn）\n');

const { isPeak, priceTurn, breakdown, HOLIDAYS, SLICES, routeOf, tableFor, unpriceable, MODEL_ALIASES, PRICES } = new Function(
  `${extracted}\nreturn { PRICES, MODEL_ALIASES, HOLIDAYS, SLICES, isPeak, priceTurn, breakdown, routeOf, tableFor, unpriceable };`,
)();
console.log('内置节假日天数 =', HOLIDAYS.size, '\n');

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
// 北京时间某天的某点 -> 毫秒时间戳
const bjAt = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);
const label = (ms) => {
  const t = new Date(ms + 8 * 3600 * 1000);
  return `${t.toISOString().slice(0, 10)} ${WEEK[t.getUTCDay()]} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
};

console.log('=== 工作日时段边界（2026-10-08 周四，非节假日）===');
for (const [h, m] of [[8, 59], [9, 0], [11, 59], [12, 0], [13, 59], [14, 0], [17, 59], [18, 0]]) {
  const t = bjAt(2026, 10, 8, h, m);
  console.log(`  ${label(t)}  ->  ${isPeak(t) ? '高峰' : '空闲'}`);
}

console.log('\n=== 节假日覆盖测试（都取上午 10:00，本应高峰）===');
const cases = [
  [2026, 1, 1, '元旦（周四，节假日）', false],
  [2026, 1, 2, '元旦（周五，节假日）', false],
  [2026, 1, 5, '元旦后第一个周一（非节假日）', true],
  [2026, 2, 16, '春节（周一，节假日）', false],
  [2026, 2, 23, '春节最后一天（周一，节假日）', false],
  [2026, 2, 24, '春节后第一个工作日（周二）', true],
  [2026, 5, 1, '劳动节（周五，节假日）', false],
  [2026, 10, 1, '国庆（周四，节假日）', false],
  [2026, 10, 7, '国庆最后一天（周三，节假日）', false],
  [2026, 10, 8, '国庆后第一个工作日（周四）', true],
  [2026, 10, 11, '周日（周末，非节假日）', false],
];
let ok = 0;
for (const [y, m, d, name, expectPeak] of cases) {
  const got = isPeak(bjAt(y, m, d, 10, 0));
  const good = got === expectPeak;
  if (good) ok += 1;
  console.log(`  ${label(bjAt(y, m, d, 10, 0))}  ${name.padEnd(26)} 期望${expectPeak ? '高峰' : '空闲'} 实际${got ? '高峰' : '空闲'}  ${good ? '✓' : '✗'}`);
}
console.log(`  ${ok}/${cases.length} 通过`);

console.log('\n=== 当前时刻 ===');
console.log(`  ${label(Date.now())}  ->  ${isPeak(Date.now()) ? '高峰' : '空闲'}`);

console.log('\n=== 计价：一轮典型用量，三项拆解 ===');
// 计价要求「模型唯一且已收录」，所以每份测试用量都带上 routes。
// 这不是为了迁就测试 —— 实际运行中 routes 由 ui-chat 的 aggregateAttempts 填入，
// 缺了它就无法判断该用哪张价目表，插件会如实报「用量未标注模型」而不是瞎猜。
const FLASH_ROUTE = [{ provider: 'deepseek-account', model: 'deepseek-flash' }];
const asFlash = (u) => ({ ...u, routes: FLASH_ROUTE });

const usage = asFlash({ uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576 });
const off = { cacheHit: 0.02, cacheMiss: 1, output: 4 };
const hit = usage.cacheReadTokens * off.cacheHit / 1e6;
const miss = (usage.uncachedInputTokens + usage.cacheWriteTokens) * off.cacheMiss / 1e6;
const out = usage.outputTokens * off.output / 1e6;
const offAt = bjAt(2026, 10, 11, 10, 0);
console.log(`  输入·缓存命中 ${usage.cacheReadTokens} tok × ¥0.02/M = ¥${hit.toFixed(6)}`);
console.log(`  输入·未命中   ${usage.uncachedInputTokens} tok × ¥1/M    = ¥${miss.toFixed(6)}`);
console.log(`  输出          ${usage.outputTokens} tok × ¥4/M    = ¥${out.toFixed(6)}`);
console.log(`  相加 ¥${(hit + miss + out).toFixed(6)}   priceTurn = ¥${priceTurn(usage, offAt).toFixed(6)}`);
console.log(`  高峰价（2026-10-08 周四 10:00）= ¥${priceTurn(usage, bjAt(2026, 10, 8, 10, 0)).toFixed(6)}`);

// ---------------------------------------------------------------------------
// 悬停明细的饼图必须和角标上的数字同源。这两条不变量保证它们不可能对不上。
console.log('\n=== 悬停明细：饼图与角标的一致性 ===');
let ok2 = 0;
const cases2 = [
  ['缓存命中为主的一轮', asFlash({ uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576, reasoningTokens: 8192 }), offAt],
  ['只有输出', asFlash({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5000 }), offAt],
  ['只有缓存命中', asFlash({ uncachedInputTokens: 0, cacheReadTokens: 1000000, cacheWriteTokens: 0, outputTokens: 0 }), offAt],
  ['含缓存写入', asFlash({ uncachedInputTokens: 100, cacheReadTokens: 200000, cacheWriteTokens: 5, outputTokens: 50 }), offAt],
  ['全为零', asFlash({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }), offAt],
  ['高峰时段', asFlash({ uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576 }), bjAt(2026, 10, 8, 10, 0)],
];
for (const [name, use, at] of cases2) {
  const detail = breakdown(use, at);
  const total = priceTurn(use, at);
  const sumParts = detail.parts.reduce((s, p) => s + p.cost, 0);
  const shares = detail.parts.map((p) => (detail.totalCost > 0 ? p.cost / detail.totalCost * 100 : 0));
  const shareSum = shares.reduce((s, v) => s + v, 0);
  const noEmpty = detail.parts.every((p) => p.tokens > 0);
  const sameTotal = Math.abs(sumParts - detail.totalCost) < 1e-12 && Math.abs(detail.totalCost - total) < 1e-12;
  const sharesOk = detail.parts.length === 0 || Math.abs(shareSum - 100) < 1e-9;
  const pass = sameTotal && sharesOk && noEmpty;
  if (pass) ok2 += 1;
  console.log(`  ${name.padEnd(12)} 分项 ${detail.parts.length} 项  合计份额 ${shareSum.toFixed(6)}%`
    + `  分项和=¥${sumParts.toFixed(6)} totalCost=¥${detail.totalCost.toFixed(6)} priceTurn=¥${total.toFixed(6)}`
    + `  ${pass ? '✓' : '✗'}`);
}
console.log(`  ${ok2}/${cases2.length} 通过`);

console.log('\n=== 明细示例（缓存命中为主的一轮，空闲时段）===');
const sample = breakdown(cases2[0][1], offAt);
console.log(`  ${'分类'.padEnd(14)}${'token'.padStart(12)}   ${'花费'.padStart(12)}   占比`);
for (const part of sample.parts) {
  const share = part.cost / sample.totalCost * 100;
  console.log(`  ${part.key.padEnd(14)}${part.tokens.toLocaleString('en-US').padStart(12)}   ¥${part.cost.toFixed(6).padStart(11)}   ${share.toFixed(1)}%`);
}
console.log(`  ${'合计'.padEnd(14)}${sample.totalTokens.toLocaleString('en-US').padStart(12)}   ¥${sample.totalCost.toFixed(6).padStart(11)}   100.0%`);
console.log(`  （其中推理 ${sample.reasoning.toLocaleString('en-US')} tok，属于输出的一部分，不单独占扇区）`);

// ---------------------------------------------------------------------------
// 会话累计必须遍历整张轮次表，而不是累加渲染出来的角标（列表是虚拟化的）。
console.log('\n=== 会话累计：整张轮次表求和 ===');

/** 从源码里按括号配平切出一个 `function NAME(...) { ... }`。 */
function sliceFunction(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return null;
}

const parts = ['tailOf', 'billedAt', 'computeChatBreakdown', 'chatBreakdown']
  .map((name) => sliceFunction(code, name));
if (parts.some((part) => part === null)) {
  console.log('  ⚠ 找不到 tailOf / billedAt / computeChatBreakdown / chatBreakdown，跳过');
} else {
  // 这几个函数在真实模块里闭包引用 breakdown / SLICES / aggregateCache，
  // 这里把依赖注入进去，跑的仍是同一份实现。
  const cacheLine = 'const aggregateCache = new WeakMap();';
  const chatBreakdown = new Function(
    'breakdown', 'SLICES',
    `${cacheLine}\n${parts.join('\n')}\nreturn chatBreakdown;`,
  )(breakdown, SLICES);

  /** 造一个 Turn 记录：轮次数据里带着 tokenUsage。 */
  const mkTurn = (number, usage, time) => ({
    turn: number,
    data: { get: (key) => (key === 'turn-tail' ? { turn: number, time, tokenUsage: usage } : void 0) },
  });
  /** 造一个「历史没装载全」的 Turn：有轮次但没有 turn-tail 数据。 */
  const mkBareTurn = (number) => ({ turn: number, data: { get: () => void 0 } });

  const u1 = asFlash({ uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576 });
  const u2 = asFlash({ uncachedInputTokens: 100, cacheReadTokens: 100000, cacheWriteTokens: 0, outputTokens: 500 });
  const at = Date.UTC(2026, 9, 11, 4, 0);

  const cases3 = [
    ['两轮', new Map([[1, mkTurn(1, u1, at)], [2, mkTurn(2, u2, at)]]),
      priceTurn(u1, at) + priceTurn(u2, at)],
    ['单轮', new Map([[1, mkTurn(1, u1, at)]]), priceTurn(u1, at)],
    ['含未装载轮次', new Map([[1, mkTurn(1, u1, at)], [2, mkBareTurn(2)]]), priceTurn(u1, at)],
    ['全未装载', new Map([[1, mkBareTurn(1)]]), null],
    ['空表', new Map(), null],
    ['没有 timeline', void 0, null],
  ];
  let ok3 = 0;
  for (const [name, turns, expect] of cases3) {
    const snapshot = turns === void 0 ? {} : { timeline: { turns } };
    const got = chatBreakdown(snapshot);
    const total = got === null ? null : got.totalCost;
    const pass = expect === null
      ? total === null
      : (total !== null && Math.abs(total - expect) < 1e-12);
    if (pass) ok3 += 1;
    console.log(`  ${name.padEnd(14)} 期望 ${expect === null ? 'null' : '¥' + expect.toFixed(6)}`
      + `  实际 ${total === null ? 'null' : '¥' + total.toFixed(6)}  ${pass ? '✓' : '✗'}`);
  }
  console.log(`  ${ok3}/${cases3.length} 通过`);

  // ---- 聚合本身的不变量 ----
  const twoTurns = new Map([[1, mkTurn(1, u1, at)], [2, mkTurn(2, u2, at)]]);
  const agg = chatBreakdown({ timeline: { turns: twoTurns } });
  const partSum = agg.parts.reduce((s, p) => s + p.cost, 0);
  const tokenSum = agg.parts.reduce((s, p) => s + p.tokens, 0);
  const perTurn = priceTurn(u1, at) + priceTurn(u2, at);
  console.log(`  分项和=¥${partSum.toFixed(6)} totalCost=¥${agg.totalCost.toFixed(6)}`
    + ` 各轮之和=¥${perTurn.toFixed(6)}  ${Math.abs(partSum - agg.totalCost) < 1e-12 && Math.abs(agg.totalCost - perTurn) < 1e-12 ? '✓' : '✗'}`);
  console.log(`  token 合计=${tokenSum.toLocaleString('en-US')} totalTokens=${agg.totalTokens.toLocaleString('en-US')}`
    + `  ${tokenSum === agg.totalTokens ? '✓' : '✗'}`);
  const order = agg.parts.map((p) => p.key).join(',');
  const wanted = SLICES.filter((s) => agg.parts.some((p) => p.key === s.key)).map((s) => s.key).join(',');
  console.log(`  扇区顺序=${order}（应为 ${wanted}）  ${order === wanted ? '✓' : '✗'}`);

  // ---- 缓存必须返回同一引用，否则 useChat 会把组件推进无限重渲染 ----
  const sA = { timeline: { turns: twoTurns } };
  const sB = { timeline: { turns: new Map([[1, mkTurn(1, u1, at)]]) } };
  const sameRef = chatBreakdown(sA) === chatBreakdown(sA);
  const diffRef = chatBreakdown(sA) !== chatBreakdown(sB);
  console.log(`  同一快照返回同一引用：${sameRef ? '✓' : '✗（会触发无限重渲染）'}`);
  console.log(`  不同快照返回不同引用：${diffRef ? '✓' : '✗'}`);
  const nullRef = chatBreakdown({}) === chatBreakdown({});
  console.log(`  无 timeline 时稳定返回 null：${nullRef ? '✓' : '✗'}`);

  // ---- 会话累计必须 ≥ 任何单轮 ----
  const orderOk = agg.totalCost >= priceTurn(u1, at) && agg.totalCost >= priceTurn(u2, at);
  console.log(`  会话累计 ≥ 任一单轮：¥${agg.totalCost.toFixed(6)} ≥ ¥${priceTurn(u1, at).toFixed(6)}  ${orderOk ? '✓' : '✗'}`);

  // ---- 会话构成与单轮构成确实不同（这正是第二个饼图的意义） ----
  const big = asFlash({ uncachedInputTokens: 300000, cacheReadTokens: 500000, cacheWriteTokens: 0, outputTokens: 20000 });
  const small = asFlash({ uncachedInputTokens: 100, cacheReadTokens: 2000000, cacheWriteTokens: 0, outputTokens: 30000 });
  const mix = chatBreakdown({ timeline: { turns: new Map([[1, mkTurn(1, big, at)], [2, mkTurn(2, small, at)]]) } });
  const shareOf = (group, key) => {
    const part = group.parts.find((p) => p.key === key);
    return part === void 0 ? 0 : part.cost / group.totalCost * 100;
  };
  const oneTurn = breakdown(small, at);
  console.log(`  会话级未缓存输入占比 ${shareOf(mix, 'cacheMiss').toFixed(1)}%`
    + ` vs 单轮 ${shareOf(oneTurn, 'cacheMiss').toFixed(1)}%`
    + `  ${Math.abs(shareOf(mix, 'cacheMiss') - shareOf(oneTurn, 'cacheMiss')) > 1 ? '✓ 确实不同' : '⚠ 差异过小'}`);
}

// ---------------------------------------------------------------------------
// 多模型：每个模型一张价目表；算不出来时必须说得出原因，不能静默留空。
console.log('\n=== 多模型计价与「算不出来」的原因 ===');
{
  const u = { uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576 };
  const withModel = (model, usage = u) => ({ ...usage, routes: [{ provider: 'deepseek-account', model }] });
  const offAt2 = Date.UTC(2026, 9, 11, 4, 0);
  const peakAt = Date.UTC(2026, 9, 8, 2, 0);   // 2026-10-08 周四 10:00 北京 = 高峰

  const pro = PRICES['deepseek-v4-pro'];
  const expectPro = (band) => (u.cacheReadTokens * band.cacheHit
    + u.uncachedInputTokens * band.cacheMiss + u.outputTokens * band.output) / 1e6;

  const rows = [
    ['flash 空闲', priceTurn(withModel('deepseek-flash'), offAt2), priceTurn(withModel('deepseek-flash'), offAt2)],
    ['pro 空闲', priceTurn(withModel('deepseek-v4-pro'), offAt2), expectPro(pro.offPeak)],
    ['pro 高峰 = 空闲 ×2', priceTurn(withModel('deepseek-v4-pro'), peakAt), expectPro(pro.peak)],
    ['别名 v4-flash 按 flash 计价',
      priceTurn(withModel('deepseek-v4-flash'), offAt2), priceTurn(withModel('deepseek-flash'), offAt2)],
  ];
  let ok4 = 0;
  for (const [name, got, want] of rows) {
    const pass = got !== null && Math.abs(got - want) < 1e-12;
    if (pass) ok4 += 1;
    console.log(`  ${name.padEnd(26)} ¥${(got ?? NaN).toFixed(6)}  期望 ¥${want.toFixed(6)}  ${pass ? '✓' : '✗'}`);
  }
  // pro 比 flash 贵，且高峰正好是空闲的两倍 —— 这两条断了就说明价目表写错了。
  const cheaper = priceTurn(withModel('deepseek-flash'), offAt2) < priceTurn(withModel('deepseek-v4-pro'), offAt2);
  const doubled = Math.abs(priceTurn(withModel('deepseek-v4-pro'), peakAt) / priceTurn(withModel('deepseek-v4-pro'), offAt2) - 2) < 1e-9;
  if (cheaper) ok4 += 1;
  if (doubled) ok4 += 1;
  console.log(`  pro 比 flash 贵：${cheaper ? '✓' : '✗'}`);
  console.log(`  高峰正好是空闲两倍：${doubled ? '✓' : '✗'}`);

  // 算不出来的四种情形：必须返回 null，而且必须给得出原因。
  const reasons = [
    ['未收录模型', withModel('deepseek-v5'), 'whyUnknown'],
    ['混用多模型', { ...u, routes: [{ model: 'deepseek-flash' }, { model: 'deepseek-v4-pro' }] }, 'whyMixed'],
    ['用量无路由', { ...u, routes: [] }, 'whyNoRoute'],
    ['routes 缺失', { ...u }, 'whyNoRoute'],
  ];
  for (const [name, usage, wantKey] of reasons) {
    const priced = priceTurn(usage, offAt2);
    const why = unpriceable(usage);
    const pass = priced === null && why !== null && why.key === wantKey;
    if (pass) ok4 += 1;
    console.log(`  ${name.padEnd(26)} 计价=${priced === null ? 'null' : '¥' + priced.toFixed(6)}`
      + ` 原因=${why === null ? '无' : why.key} 期望 ${wantKey}  ${pass ? '✓' : '✗'}`);
  }
  // 能算的时候不能给原因，否则角标会同时显示金额和「算不出来」。
  const quiet = unpriceable(withModel('deepseek-flash')) === null;
  if (quiet) ok4 += 1;
  console.log(`  能计价时不报原因：${quiet ? '✓' : '✗'}`);
  console.log(`  ${ok4}/${rows.length + 2 + reasons.length + 1} 通过`);
}

// ---------------------------------------------------------------------------
// 悬停面板的结构检查：把 React.createElement 换成假的，直接把组件树建出来，
// 断言左列装的是「本次对话」、右列装的是「本轮」。这是唯一能验证渲染结构的办法
// —— 没有浏览器控制，看不见真实页面。
console.log('\n=== 悬停面板结构（两列各装了什么）===');

function sliceConst(source, name) {
  const at = source.indexOf(`const ${name} = `);
  if (at < 0) return null;
  return source.slice(at, source.indexOf(';', at) + 1);
}

const panelSrc = [
  sliceConst(code, 'PANEL_WIDTH'),
  sliceConst(code, 'RING_SIZE'),
  sliceConst(code, 'SLICE_GAP'),
  sliceFunction(code, 'eased'),
  sliceFunction(code, 'count'),
  sliceFunction(code, 'money'),
  sliceFunction(code, 'CostDetail'),
];
if (panelSrc.some((piece) => piece === null || piece === void 0)) {
  console.log('  ⚠ 面板相关片段抽取失败，跳过');
} else {
  const ReactStub = {
    useState: (init) => [init, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (init) => ({ current: init }),
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== void 0 && c !== false),
    }),
  };
  globalThis.window = { matchMedia: () => ({ matches: false }), innerWidth: 1400 };
  globalThis.requestAnimationFrame = (fn) => fn();

  const CostDetailFn = new Function(
    'React', 'h',
    `${panelSrc.join('\n')}\nreturn CostDetail;`,
  )(ReactStub, ReactStub.createElement);

  // t 直接返回键名，断言就落在键上，不受翻译文案影响。
  const identify = (key) => key;

  const turnUsage = asFlash({ uncachedInputTokens: 5120, cacheReadTokens: 3120000, cacheWriteTokens: 0, outputTokens: 24576, reasoningTokens: 8192 });
  const atMs = Date.UTC(2026, 9, 11, 4, 0);
  const turnDetail = breakdown(turnUsage, atMs);
  // 会话聚合直接构造：数值取本轮的 3 倍，两列一旦装反立刻看得出来。
  const sessionParts = turnDetail.parts.map((part) => ({
    ...part, tokens: part.tokens * 3, cost: part.cost * 3,
  }));
  const sessionAgg = {
    parts: sessionParts,
    totalCost: sessionParts.reduce((sum, part) => sum + part.cost, 0),
    totalTokens: sessionParts.reduce((sum, part) => sum + part.tokens, 0),
  };

  const tree = CostDetailFn({ detail: turnDetail, sessionBreakdown: sessionAgg, t: identify, left: 700, top: 400 });

  /** 收集一个节点下的所有文本。 */
  const textsOf = (node, out = []) => {
    if (node === null || node === void 0 || node === false) return out;
    if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const child of node) textsOf(child, out); return out; }
    if (typeof node === 'object') for (const child of node.children ?? []) textsOf(child, out);
    return out;
  };

  // 面板内容 = [口径说明, 两列并排的 body]
  const panel = tree.children[0];
  const body = panel.children.find((child) => child !== null && typeof child === 'object'
    && child.props?.style?.display === 'flex' && (child.children ?? []).length === 2);

  if (body === void 0) {
    console.log('  ✗ 找不到两列并排的容器 —— 布局结构和预期不符');
  } else {
    const left = textsOf(body.children[0]);
    const right = textsOf(body.children[1]);
    const leftHas = (key) => left.includes(key);
    const rightHas = (key) => right.includes(key);
    console.log(`  左列：${left.join(' | ')}`);
    console.log(`  右列：${right.join(' | ')}`);
    const checks = [
      ['左列是「本次问答」', leftHas('scopeTurn') && !leftHas('scopeSession')],
      ['右列是「整场对话」', rightHas('scopeSession') && !rightHas('scopeTurn')],
      ['左列合计标注「本次问答合计」', leftHas('detailTotal') && !leftHas('sessionTotal')],
      ['右列合计标注「整场累计」', rightHas('sessionTotal') && !rightHas('detailTotal')],
      ['左列金额是本次问答金额', left.some((s) => s.includes(turnDetail.totalCost.toFixed(5)))],
      // money() 在金额小于 ¥1 时输出 5 位小数，左右两列按同一精度比较。
      ['右列金额是整场总额', right.some((s) => s.includes(sessionAgg.totalCost.toFixed(5)))],
      // 两列应当对称：各自都列出 token 总量与金额。
      ['左列合计带 token 总量', left.some((s) => s.includes('tok · ¥')
        && s.includes(turnDetail.totalTokens.toLocaleString('zh-CN')))],
      ['右列合计带 token 总量', right.some((s) => s.includes('tok · ¥')
        && s.includes(sessionAgg.totalTokens.toLocaleString('zh-CN')))],
      // 两列必须等高，否则合计行的 marginTop:auto 没有空间可推，两列合计会一高一低。
      ['两列 wrapper 都是 flex（列才会被拉伸）',
        body.children.every((child) => child.props?.style?.display === 'flex')],
      ['两列自己都是纵向 flex', body.children.every((child) => (child.children ?? [])
        .some((inner) => inner.props?.style?.display === 'flex'
          && inner.props?.style?.flexDirection === 'column'))],
      // 推理注释必须在两列之外：放进右列会顶高右列，两列合计又对不齐。
      ['推理注释不在任何一列里',
        !leftHas('detailReasoning') && !rightHas('detailReasoning')
        && textsOf(panel).includes('detailReasoning')],
      // 合计行必须是竖排且禁止换行：标签和金额挤在一行时列宽不够会换行，
      // 数字被推到下一行，看起来就像属于旁边那一列。
      ['两个合计行都是竖排且不换行', (() => {
        const rows = [];
        const walk = (node) => {
          if (node === null || typeof node !== 'object') return;
          if (Array.isArray(node)) { for (const child of node) walk(child); return; }
          const style = node.props?.style;
          if (style?.marginTop === 'auto' && style?.flexDirection === 'column') rows.push(node);
          for (const child of node.children ?? []) walk(child);
        };
        walk(panel);
        if (rows.length !== 2) return false;
        return rows.every((row) => (row.children ?? []).length === 2
          && row.children.every((cell) => cell.props?.style?.whiteSpace === 'nowrap'));
      })()],
    ];
    let okPanel = 0;
    for (const [name, pass] of checks) {
      if (pass) okPanel += 1;
      console.log(`    ${name}：${pass ? '✓' : '✗'}`);
    }
    console.log(`  ${okPanel}/${checks.length} 通过`);
  }
}

// ---------------------------------------------------------------------------
// 币种：价目表是人民币站点的那一张，别的币种账户拿它算出来的钱是错的，
// 所以判定为非人民币时一个金额都不出（client.js 的 state.currencyUnsupported）。
console.log('\n=== 币种判定：非人民币账户一律不出金额 ===');
{
  const cnyOnlySrc = sliceFunction(code, 'cnyOnly');
  if (cnyOnlySrc === null) {
    console.log('  ⚠ 抽不到 cnyOnly，跳过');
  } else {
    const cnyOnlyFn = new Function(`${cnyOnlySrc}\nreturn cnyOnly;`)();
    const cases = [
      ['空钱包表', [], true],
      ['人民币钱包', [{ currency: 'CNY', balance: '6.2164' }], true],
      ['未标注币种（旧数据）', [{ balance: '6.2164' }], true],
      ['美元钱包', [{ currency: 'USD', balance: '5.00' }], false],
      ['小写 usd', [{ currency: 'usd', balance: '5.00' }], false],
      ['人民币与美元混装', [{ currency: 'CNY', balance: '1' }, { currency: 'USD', balance: '1' }], false],
      ['表里有坏元素', [null, { currency: 'CNY', balance: '1' }], true],
    ];
    let okCur = 0;
    for (const [name, wallets, want] of cases) {
      const got = cnyOnlyFn(wallets);
      const pass = got === want;
      if (pass) okCur += 1;
      console.log(`  ${name.padEnd(20)} ${got ? '人民币' : '非人民币'}  期望${want ? '人民币' : '非人民币'}  ${pass ? '✓' : '✗'}`);
    }
    console.log(`  ${okCur}/${cases.length} 通过`);
  }
}

// ---------------------------------------------------------------------------
// 中英文字典必须完全对齐：缺一个键，切到那个语言时角标会直接把键名显示出来。
console.log('\n=== 本地化字典对齐 ===');

/** 从源码里按括号配平切出一个 `const NAME = { ... }` 字面量。 */
function sliceLiteral(source, name) {
  const at = source.indexOf(`const ${name} = {`);
  if (at < 0) return null;
  let depth = 0;
  for (let i = source.indexOf('{', at); i < source.length; i++) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(at, i + 1);
    }
  }
  return null;
}

const zhSrc = sliceLiteral(code, 'zh');
const enSrc = sliceLiteral(code, 'en');
if (zhSrc === null || enSrc === null) {
  console.log('  ⚠ 找不到 zh / en 字典，跳过');
} else {
  const zhDict = new Function(`${zhSrc}\nreturn zh;`)();
  const enDict = new Function(`${enSrc}\nreturn en;`)();
  const zhKeys = Object.keys(zhDict);
  const enKeys = Object.keys(enDict);
  const onlyZh = zhKeys.filter((key) => !enKeys.includes(key));
  const onlyEn = enKeys.filter((key) => !zhKeys.includes(key));
  const blanks = [...zhKeys, ...enKeys]
    .filter((key) => !String(zhDict[key] ?? enDict[key] ?? '').trim());
  const placeholders = (dict) => Object.fromEntries(Object.entries(dict).map(
    ([key, value]) => [key, [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')],
  ));
  const zhPh = placeholders(zhDict);
  const enPh = placeholders(enDict);
  const mismatched = zhKeys.filter((key) => zhPh[key] !== enPh[key]);

  console.log(`  zh ${zhKeys.length} 键 / en ${enKeys.length} 键`);
  console.log(`  只在中文字典：${onlyZh.length === 0 ? '无' : onlyZh.join(', ')}`);
  console.log(`  只在英文字典：${onlyEn.length === 0 ? '无' : onlyEn.join(', ')}`);
  console.log(`  空文案：${blanks.length === 0 ? '无' : blanks.join(', ')}`);
  console.log(`  占位符不一致：${mismatched.length === 0 ? '无' : mismatched.join(', ')}`);
  const aligned = onlyZh.length === 0 && onlyEn.length === 0
    && blanks.length === 0 && mismatched.length === 0;
  console.log(aligned
    ? '  ✓ 两个字典对齐，切换语言不会露出键名'
    : '  ✗ 存在缺口：切到对应语言时会直接把键名显示出来');
  console.log(`\n  中文说明行：${zhDict.detailScope}`);
  console.log(`  英文说明行：${enDict.detailScope}`);
}
