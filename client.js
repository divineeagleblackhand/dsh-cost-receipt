/**
 * 余额花费计 — 客户端插件。
 *
 * 每轮花费 = 该轮 token 用量 × 官方单价（按该轮所在时段）。
 * 账户余额 = 登录账号的充值余额（不含礼金）；有礼金时把礼金另列一项。
 *           两者互不重叠，相加才是钱包总额。
 *
 * 为什么单轮花费不用余额差值算：平台的扣费是分批结算的，一笔钱可能在轮次结束
 * 几十秒后才落账，那时下一轮已经在跑，于是被算到下一轮头上。总量对得上，单轮
 * 归属不可靠。而 token 用量是提供方自己上报的计费依据，逐轮精确，且就存在会话
 * 日志里 —— 页面一加载，所有历史轮次的用量都在，所以本插件不存任何东西。
 *
 * 手写 module-loader 格式，不需要构建。依赖的接口都是从打包代码里读出来的：
 *   - `ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })`
 *     解析为 `{ ok, value }`，value 是
 *     `null | { status: 'ready', value: Wallet[], bonusWallets: Wallet[] } | { status: 'failed' }`，
 *     Wallet 是 `{ currency: 'CNY'|'USD', balance: string }`。
 *   - `conversation.chat.turnTail` 是 ui-chat 声明的 session 作用域 list 座位，
 *     宿主用 `{ turn, seq, openFile }` 渲染它。注意 `turn` 是会话层的整个 Turn 记录
 *     （`{ turn, start, end, status, steps, data }`），不是数字。
 *   - `turn.data.get('turn-tail')` 是该轮的数据
 *     （`{ turn, seq, time, closing, branchUnavailable, tokenUsage? }`），
 *     `tokenUsage` 形状为
 *     `{ uncachedInputTokens, outputTokens, totalTokens, cacheReadTokens?,
 *       cacheWriteTokens?, reasoningTokens?, routes? }`，只有该轮结束后才有。
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-receipt',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 悬停面板要 portal 到 body：否则会被对话滚动容器的 overflow 裁掉，
    // 或者被虚拟列表祖先上的 transform 改掉 position:fixed 的参照系。
    // ui-chat 自己那个「本轮用量」面板用的也是 createPortal。
    let createPortal = null;
    try {
      const reactDom = require('react-dom');
      if (reactDom !== null && typeof reactDom.createPortal === 'function') {
        createPortal = reactDom.createPortal;
      }
    } catch {
      /* 拿不到就退回内联渲染：功能一样，只是可能被祖先容器裁掉 */
    }

    const NS = 'cost-receipt';
    /** 账号 Remote 要的客户端版本号，不能为空。 */
    const CLIENT_VERSION = '0.2.0-rc.2';
    /**
     * 兜底轮询间隔。时效不再靠它（靠账号事件触发即时查询），它只保证
     * "事件流坏掉时余额仍然会自己更新"，所以 30 秒足够；
     * 原来 1 秒的轮询是在用请求量硬顶缓存，方向错了。
     */
    const FALLBACK_POLL_MS = 30000;

    const TERTIARY = 'var(--dsw-alias-label-tertiary, #8b8b8b)';
    /** 角标上的警示色。token 名是 warn 不是 warning —— 写错会掉到兜底色，深色主题下偏暗。 */
    const WARNING = 'var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary, #b7791f))';

    // ------------------------------------------------------------------ 计价 --

    /**
     * 官方单价，人民币元 / 百万 token，**按模型分开**。
     * 高峰 = 北京时间周一至周五 09:00–12:00、14:00–18:00，价格是空闲的两倍。
     * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
     *
     * 官方调价或推出新模型时改这里，然后跑 `test/verify-pricing.mjs` 确认没写坏。
     * 没有收录的模型不会瞎算 —— 角标会直接写出模型名告诉你该更新了。
     */
    const PRICES = {
      'deepseek-flash': {
        offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
        peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      },
      'deepseek-v4-pro': {
        offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
        peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      },
    };

    /**
     * 旧模型名 → 现役模型名的映射，用于查价。
     * 官方文档：`deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 仍可调用，
     * 但对应模型已下线，请求由 DeepSeek-V4.1-Flash 提供服务并按 Flash 价格计费。
     */
    const MODEL_ALIASES = {
      'deepseek-v4-flash': 'deepseek-flash',
      'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    };

    /**
     * 角标上写的模型简称。**按「实际提供服务的模型」写，不按价格档写** ——
     * `deepseek-v4-flash` 虽然按 Flash 价计费，但它仍是官方明确的旧 id，
     * 标成 `flash` 会让人分不清"我到底在用哪个模型"，所以标 `v4-flash`。
     * 计价仍然走 MODEL_ALIASES 归一到 flash 档，两件事互不影响。
     */
    const MODEL_LABELS = {
      'deepseek-flash': 'flash',
      'deepseek-v4-pro': 'v4-pro',
      'deepseek-v4-flash': 'v4-flash',
      'deepseek-v4-flash-vision-exp': 'v4-flash',
    };

    /**
     * 这一轮用的是哪个模型。
     *
     * ⚠️ `tokenUsage.routes` 是**去重后的路由集合**，不是按模型分开的 token 数
     * （见 ui-chat 内联的 `aggregateAttempts`）。所以一轮里混用了多个模型时，
     * token 无法拆到各模型上 —— 只能如实返回 `mixed` 并拒绝计价，不能拿其中一个
     * 模型的单价去套全部 token。
     * @param usage - `turn-tail` 的 tokenUsage。
     * @returns `{ kind: 'one', model }` / `{ kind: 'mixed', models }` / `{ kind: 'none' }`
     */
    function routeOf(usage) {
      const routes = usage === null || usage === void 0 ? void 0 : usage.routes;
      if (!Array.isArray(routes) || routes.length === 0) return { kind: 'none' };
      const models = [...new Set(routes.map((route) => route && route.model).filter(Boolean))];
      if (models.length === 0) return { kind: 'none' };
      if (models.length === 1) return { kind: 'one', model: models[0] };
      return { kind: 'mixed', models };
    }

    /** 查模型单价表，顺带解析旧模型名。没收录返回 null。 */
    function tableFor(model) {
      return PRICES[MODEL_ALIASES[model] ?? model] ?? null;
    }

    /**
     * 需要按空闲价计费的「工作日」—— 也就是法定节假日里落在周一至周五的那些天。
     *
     * 调休上班的周六周日不用列：官方规则是「周一至周五（不含中国法定节假日）」，
     * 调休的周六本来就不在「周一至周五」里，已经按空闲算了。
     *
     * 数据来自国务院办公厅《关于2026年部分节假日安排的通知》
     * （https://www.gov.cn/zhengce/content/202511/content_7047090.htm，
     * 国办发明电〔2025〕7号，2025-11-04 发布）。共 19 天，影响全年 114 个高峰
     * 小时（1.30%），不修正会高估约 0.65%。
     *
     * 节假日由国务院每年公告、不可计算（调休是行政决定），所以只能内置。
     * 刷新方式：跑 `tools/fetch-holidays.mjs <年份> <通知URL>`，它会抓取通知、
     * 解析日期、用原文标注的星期交叉校验，并打印可直接粘贴的常量。
     * 没有该年份数据时，下面查不到就是「不是节假日」，自动退回修正前的行为。
     */
    const HOLIDAYS = new Set([
      '2026-01-01', '2026-01-02', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-23', '2026-04-06', '2026-05-01', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06',
      '2026-10-07',
    ]);

    /**
     * 某个时刻是否落在高峰时段。按北京时间判定，与本机时区无关。
     * @param atMs - 毫秒时间戳。
     * @returns 高峰时段内为 true。
     */
    function isPeak(atMs) {
      const beijing = new Date(atMs + 8 * 3600 * 1000);
      const day = beijing.getUTCDay();
      if (day === 0 || day === 6) return false;
      const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
      const date = String(beijing.getUTCDate()).padStart(2, '0');
      if (HOLIDAYS.has(`${beijing.getUTCFullYear()}-${month}-${date}`)) return false;
      const hour = beijing.getUTCHours() + beijing.getUTCMinutes() / 60;
      return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    }

    /**
     * 四个计费分项及其颜色。颜色取自设计系统的静态色板，明暗主题通用。
     * 缓存写入在 DeepSeek 上几乎总是 0，所以只在真的出现时才画。
     */
    const SLICES = [
      { key: 'cacheRead', color: 'var(--dsw-static-blue-500, #3b82f6)' },
      { key: 'cacheMiss', color: 'var(--dsw-static-amber-500, #f59e0b)' },
      { key: 'cacheWrite', color: 'var(--dsw-static-green-500, #22c55e)' },
      { key: 'output', color: 'var(--dsw-static-red-500, #ef4444)' },
    ];

    /**
     * 把一轮的 token 用量拆成可显示的分项。
     *
     * `priceTurn` 也走这里取总额，所以悬停明细的饼图和角标上的数字**必然是同一个来源**，
     * 不可能出现两处对不上的情况。
     * @param usage - `turn-tail` 的 tokenUsage，未结束时为 null。
     * @param atMs - 该轮计费时刻。
     * @returns `{ parts, totalCost, totalTokens, reasoning }`，或 null 表示算不出来。
     */
    function breakdown(usage, atMs) {
      if (usage === null || usage === void 0) return null;
      // 模型必须唯一且已收录，否则不算 —— 宁可不出数字，也不拿别的模型的单价硬套。
      const route = routeOf(usage);
      const table = route.kind === 'one' ? tableFor(route.model) : null;
      if (table === null) return null;
      const band = isPeak(atMs) ? table.peak : table.offPeak;
      // DeepSeek 没有单独的缓存写入价，写缓存的那部分按未命中输入计费。
      const tokens = {
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheMiss: usage.uncachedInputTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        output: usage.outputTokens ?? 0,
      };
      const rate = {
        cacheRead: band.cacheHit,
        cacheMiss: band.cacheMiss,
        cacheWrite: band.cacheMiss,
        output: band.output,
      };
      const parts = SLICES
        .map((slice) => ({
          key: slice.key,
          color: slice.color,
          tokens: tokens[slice.key],
          cost: tokens[slice.key] * rate[slice.key] / 1e6,
        }))
        .filter((part) => part.tokens > 0);
      let totalCost = 0;
      let totalTokens = 0;
      for (const part of parts) {
        totalCost += part.cost;
        totalTokens += part.tokens;
      }
      return { parts, totalCost, totalTokens, reasoning: usage.reasoningTokens ?? 0 };
    }

    /**
     * 一轮花了多少钱。
     * @param usage - `turn-tail` 的 tokenUsage，未结束时为 null。
     * @param atMs - 该轮计费时刻。
     * @returns 人民币金额，或 null 表示这一轮算不出来。
     */
    function priceTurn(usage, atMs) {
      const detail = breakdown(usage, atMs);
      return detail === null ? null : detail.totalCost;
    }

    /**
     * 这一轮算不出价格的原因，用于在角标上**说明**而不是静默什么都不显示。
     *
     * 静默失效是这类依赖内部实现的插件最难查的问题：DSH 换了模型名或者切到
     * 新模型，角标只是不出现，看不出为什么。这里把原因说出来。
     * @param usage - `turn-tail` 的 tokenUsage。
     * @returns `{ key, params }` 或 null（表示能算，或只是还没结束）。
     */
    function unpriceable(usage) {
      if (usage === null || usage === void 0) return null;
      const route = routeOf(usage);
      if (route.kind === 'mixed') {
        return { key: 'whyMixed', params: { models: route.models.join(' + ') } };
      }
      if (route.kind === 'none') return { key: 'whyNoRoute', params: void 0 };
      if (tableFor(route.model) === null) {
        return { key: 'whyUnknown', params: { model: route.model } };
      }
      return null;
    }

    // ------------------------------------------------------------- 读取轮次 --

    /**
     * 座位拿到的 `turn` 是会话层的整个 Turn 记录，不是编号。
     * `LocationIndex.resolve()` 返回 `{ kind: 'turn', turn }`，其中 `turn` 是
     * `timeline.turns` 里的记录 `{ turn, start, end, status, steps, data }`。
     * 对它直接 `Number()` 会得到 NaN。
     * @param turn - 座位的 turn 属性。
     * @returns 轮次编号，取不到时为 null。
     */
    function turnNumber(turn) {
      const value = turn !== null && typeof turn === 'object' ? turn.turn : turn;
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'bigint') return Number(value);
      return null;
    }

    /** 该轮的 `turn-tail` 数据，读不到时为 null。 */
    function tailOf(turn) {
      try {
        const store = turn !== null && typeof turn === 'object' ? turn.data : null;
        if (store === null || store === void 0 || typeof store.get !== 'function') return null;
        return store.get('turn-tail') ?? null;
      } catch {
        return null;
      }
    }

    /** 该轮的计费时刻，未知时用当下。 */
    function billedAt(tail) {
      const time = tail === null ? void 0 : tail.time;
      if (typeof time === 'number' && Number.isFinite(time)) return time;
      if (typeof time === 'string') {
        const parsed = Date.parse(time);
        if (Number.isFinite(parsed)) return parsed;
      }
      return Date.now();
    }

    // ------------------------------------------------------------------ 状态 --

    const state = {
      /** 账户余额：只算充值余额，不含礼金。null 表示还没读到。 */
      balance: null,
      /** 礼金余额（bonus_wallets 合计），0 表示没有礼金。两者相加才是钱包总额。 */
      bonus: 0,
      /** 'signed-out' | 'failed' | 'network' | null */
      problem: null,
      /**
       * 账户里出现了非人民币钱包。价目表是人民币站点的那一张，其它币种账户的实际
       * 计费与它不同，所以这种情况**一个金额都不显示**，只在最新一轮说明原因。
       * false 同时表示"正常"和"还没读到"。
       */
      currencyUnsupported: false,
      /**
       * 余额**数值上次变化**的时刻（毫秒），**不是**"上次查询的时刻"。
       *
       * 两者必须分开，别混成一个：每次查询都刷新的话，它会变成一个每秒跳动的时钟，
       * 看起来"数据很新"，恰恰掩盖了要暴露的陈旧。所以角标上那个时刻的含义是
       * "自此刻起这个数字没再变过"，文案也按这个意思写（`余额更新于`），而不是"读取于"。
       * 实测踩过：充完钱角标还显示充值前的负数，会被误认为插件坏了。
       */
      readAt: null,
      /**
       * 上一次**成功查到余额**的时刻（毫秒）。只出现在悬停提示里，和 readAt 并排给出：
       * 两个时刻一对就能区分"读数陈旧"（查询一直在走、数字不动）和"余额真的没动"。
       * 查询失败时不更新 —— 那时 problem 会变成 network，角标改显示"不可用"。
       */
      queriedAt: null,
      /**
       * 每个会话各自的「最大已见轮次编号」，键是那一轮的数据仓库（每个会话一个）。
       *
       * 以前的判定是**全局**的："编号等于全局最大值的那个角标才显示余额"。
       * 那在多个会话同时开着时是错的：轮次编号是每个会话各自从 1 开始的，
       * 于是"哪条对话能显示余额"取决于比较顺序 —— 打开另一条对话就可能让
       * 当前这条的余额整块消失。
       *
       * 余额是**账号级**数字，对所有对话都成立，所以正确行为恰好相反：
       * **每条对话都在自己最新的一轮上显示同一个余额**。
       * 用 WeakMap 按轮次 store 分桶即可，不需要 sessionId，也不会堆积（无强引用）。
       */
      latest: new WeakMap(),
      listeners: new Set(),
    };

    function notify() {
      for (const fn of state.listeners) {
        try { fn(); } catch { /* 订阅者出错不能拖垮轮询 */ }
      }
    }

    function sumWallets(wallets) {
      let total = 0;
      for (const wallet of wallets || []) {
        const value = Number(wallet.balance);
        if (Number.isFinite(value)) total += value;
      }
      return total;
    }

    /**
     * 钱包是否全部以人民币计价。
     * 没标注币种的按人民币算（兼容旧数据）；只要出现一个明确的非 CNY 就算不是。
     * @param wallets - `value` 或 `bonusWallets`。
     * @returns 全部为人民币时为 true。
     */
    function cnyOnly(wallets) {
      for (const wallet of wallets || []) {
        if (wallet === null || typeof wallet !== 'object') continue;
        const currency = wallet.currency;
        if (typeof currency === 'string' && currency.toUpperCase() !== 'CNY') return false;
      }
      return true;
    }

    function clientMetadata() {
      return {
        version: CLIENT_VERSION,
        locale: 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      };
    }

    // -------------------------------------------------------------- 余额轮询 --

    let polling = false;
    let inFlight = false;

    async function poll(ctx) {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await ctx.remote.account.getBalance(clientMetadata());
        if (result === void 0 || result === null || !result.ok) {
          state.problem = 'network';
        } else if (result.value === null) {
          state.problem = 'signed-out';
        } else if (result.value.status !== 'ready') {
          state.problem = 'failed';
        } else if (!cnyOnly(result.value.value) || !cnyOnly(result.value.bonusWallets)) {
          // 非人民币账户：一个金额都不显示（见 state.currencyUnsupported）。
          state.problem = null;
          state.currencyUnsupported = true;
          state.balance = null;
          state.bonus = 0;
        } else {
          state.problem = null;
          state.currencyUnsupported = false;
          // value 是充值余额，bonusWallets 是礼金。两者分开列、互不重叠：
          // 「账户余额」只报充值余额，礼金另起一项，相加才是钱包总额。
          const balance = sumWallets(result.value.value);
          const bonus = sumWallets(result.value.bonusWallets);
          // 两个时刻含义不同，别混（见 state 里的注释）：
          //   queriedAt —— 每次成功查到都刷新，只说"宿主刚刚答了"
          //   readAt    —— 只在**数字真的变了**时刷新，说"这个数自此没变过"
          // 角标显示 readAt（诚实，但可能陈旧）；悬停提示里两个都给。
          state.queriedAt = Date.now();
          if (balance !== state.balance || bonus !== state.bonus) state.readAt = Date.now();
          state.balance = balance;
          state.bonus = bonus;
          // 首次读到也要留个时刻，否则第一次读数没有时间可显示。
          if (state.readAt === null) state.readAt = Date.now();
        }
      } catch {
        state.problem = 'network';
      } finally {
        inFlight = false;
        notify();
      }
    }

    function startPolling(ctx) {
      if (polling) return;
      polling = true;
      void poll(ctx);
      ctx.effect(() => {
        // 单纯的时间轮询。**不要在这里加账号事件订阅**：曾按
        // `ctx.remote.account.watch()` 加过一条"事件到达就重查"的链路，
        // 实测无效 —— 宿主缓存账号查询的失效条件是"凭证变化或销毁"，
        // 不是"有事件"，事件后重查拿到的仍是同一个旧快照。
        // 余额的时效上限由宿主缓存决定，客户端无法改善，
        // 只能在界面上把"读数时刻"如实显示出来。
        //
        // 页面不可见时降频到 3 分钟一次：余额只用于显示，不参与任何计算。
        let tick = 0;
        const timer = setInterval(() => {
          tick += 1;
          if (document.visibilityState !== 'visible' && tick % 6 !== 0) return;
          void poll(ctx);
        }, FALLBACK_POLL_MS);
        return () => {
          clearInterval(timer);
          polling = false;
        };
      }, 'cost-receipt: 余额轮询');
    }

    // ------------------------------------------------------------------ 视图 --

    /** 金额格式：小钱保留更多小数。 */
    function money(value) {
      if (value >= 1) return value.toFixed(4);
      if (value >= 0.01) return value.toFixed(5);
      return value.toFixed(6);
    }

    /** 时刻：本地时钟的 HH:MM:SS。余额读数的新鲜度靠它说清楚。 */
    function clock(atMs) {
      if (typeof atMs !== 'number' || !Number.isFinite(atMs)) return '';
      const d = new Date(atMs);
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    /**
     * 取一条文案；**该语言的字典里没有这个键时返回 undefined**，而不是把键名显示出来。
     *
     * 为什么需要它：新加的键要等宿主重新注册字典才生效，而客户端 bundle 是热更新的。
     * 于是存在"代码已是新版、字典还是旧版"的中间态 —— 那时 `t('spentModel', …)`
     * 会原样返回 `spentModel`，角标上就出现一个键名。调用方据此回退拼接。
     */
    function lit(t, key, params) {
      if (typeof t !== 'function') return void 0;
      const out = t(key, params);
      return out === key ? void 0 : out;
    }

    function useBalance() {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        const fn = () => bump((n) => n + 1);
        state.listeners.add(fn);
        return () => { state.listeners.delete(fn); };
      }, []);
    }

    /** 角标那一行的样式。 */
    function rowStyle() {
      return {
        color: TERTIARY,
        fontSize: '12px',
        lineHeight: '18px',
        marginTop: '6px',
        display: 'flex',
        gap: '10px',
        flexWrap: 'wrap',
        alignItems: 'center',
        userSelect: 'text',
      };
    }

    // ------------------------------------------------------------ 悬停明细 --

    /** 面板宽度。固定宽度才能把位置精确夹在视口内。两列并排，所以要够宽。 */
    const PANEL_WIDTH = 420;
    /** 两个环同尺寸：并排对比时尺寸不同会导致行和合计对不齐。 */
    const RING_SIZE = 76;
    /** 悬停多久才弹出。太灵敏会在鼠标划过时闪。 */
    const HOVER_DELAY_MS = 180;
    /** 环上每个扇区之间留的角度缺口（以 pathLength=100 为单位）。 */
    const SLICE_GAP = 1.2;

    /** 是否要求减少动效（系统偏好）。 */
    function eased() {
      try {
        return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return true;
      }
    }

    /** 千分位。 */
    function count(value) {
      return Math.round(value).toLocaleString('zh-CN');
    }

    /**
     * 按快照缓存聚合结果。
     *
     * 选择器必须返回**同一个引用**，否则 `useChat` 每次比较都认为变了，会把组件
     * 推进无限重渲染。用 WeakMap 按快照做键：同一个快照拿到同一个对象，快照换了
     * 才重算，而且多个会话同时在屏幕上时互不干扰。
     */
    const aggregateCache = new WeakMap();

    /**
     * 本次对话的花费聚合 —— 把每一轮的分项按类别加起来。
     *
     * 每轮的花费已经由 token 用量算准了，所以会话总额就是它们的和，会话构成就是
     * 各类别之和。这不需要余额差值，因此没有结算延迟、不需要基线，也不会和单轮数字
     * 打架（会话总额就是本轮数字逐轮相加）。
     *
     * **会话构成和单轮构成确实会不同**：缓存未命中的占比在会话级别明显更高，
     * 因为对话开头的系统提示词与工具定义都是未命中。这是单轮饼图看不到的信息。
     *
     * 覆盖范围是聊天快照里的轮次表。DSH 在会话很长时会分页、按需加载更早的历史，
     * 尚未装载进来的轮次这里算不到 —— 极长会话里这两个数都会偏低。
     * @param snapshot - 聊天快照。
     * @returns `{ parts, totalCost, totalTokens }`，没有任何一轮可计价时为 null。
     */
    function chatBreakdown(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return null;
      const cached = aggregateCache.get(snapshot);
      if (cached !== void 0) return cached;
      const value = computeChatBreakdown(snapshot);
      aggregateCache.set(snapshot, value);
      return value;
    }

    /** 真正做加总的那一步，只由 chatBreakdown 在缓存未命中时调用。 */
    function computeChatBreakdown(snapshot) {
      const turns = snapshot.timeline?.turns;
      if (turns === null || turns === void 0 || typeof turns.values !== 'function') return null;
      const totals = new Map();
      let turnsSeen = 0;
      let turnsCounted = 0;
      let turnsUnpriced = 0;
      for (const turn of turns.values()) {
        turnsSeen += 1;
        const tail = tailOf(turn);
        const detail = breakdown(tail === null ? null : tail.tokenUsage, billedAt(tail));
        if (detail === null) {
          // 有 token 用量却算不出价 —— 这才是真正需要提示的漏算。
          // 没有用量的轮次（历史未装载）不算漏，那是另一回事。
          if (tail !== null && tail.tokenUsage !== void 0) turnsUnpriced += 1;
          continue;
        }
        turnsCounted += 1;
        for (const part of detail.parts) {
          const seen = totals.get(part.key);
          if (seen === void 0) totals.set(part.key, { ...part });
          else {
            seen.tokens += part.tokens;
            seen.cost += part.cost;
          }
        }
      }
      if (totals.size === 0) return null;
      // 按 SLICES 的顺序取，两个饼图的配色和扇区顺序才会一致。
      const parts = SLICES.map((slice) => totals.get(slice.key)).filter(Boolean);
      let totalCost = 0;
      let totalTokens = 0;
      for (const part of parts) {
        totalCost += part.cost;
        totalTokens += part.tokens;
      }
      return { parts, totalCost, totalTokens, turnsSeen, turnsCounted, turnsUnpriced };
    }

    /**
     * 悬停弹出的用量明细：一个按**花费**占比画的环，加一份图例。
     *
     * 环画的是花费占比而不是 token 占比，因为两者差得极远 —— 缓存命中通常占 99% 的
     * token 却只占不到四成花费，输出常常不到 1% 的 token 却吃掉一半以上的钱。
     * token 数放在图例里，两个口径都能看到。
     * @param props - `{ detail, t, left, top }`。
     * @returns 定位好的面板。
     */
    function CostDetail(props) {
      const { detail, sessionBreakdown, t, left, top } = props;
      const animate = eased();
      // 先以初始态挂载，下一帧再切终态，CSS transition 才会真的跑起来。
      const [shown, setShown] = React.useState(false);
      React.useEffect(() => {
        const raf = requestAnimationFrame(() => setShown(true));
        return () => cancelAnimationFrame(raf);
      }, []);

      // 同一套渲染逻辑给两个作用域复用：本轮 84px、本次对话 64px。
      const ringFor = (group, size) => {
        let cursor = 0;
        const slices = group.parts.map((part) => {
          const share = group.totalCost > 0 ? part.cost / group.totalCost * 100 : 0;
          const slice = { ...part, share, start: cursor };
          cursor += share;
          return slice;
        });
        const gap = slices.length > 1 ? SLICE_GAP : 0;
        const radius = size / 2 - 9;
        return h('svg', {
          width: size, height: size,
          viewBox: `${-size / 2} ${-size / 2} ${size} ${size}`,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('circle', {
          r: radius, fill: 'none', stroke: 'var(--dsw-alias-border-l2, #e5e5e5)', strokeWidth: 12,
        }),
        h('g', { transform: 'rotate(-90)' }, slices.map((slice, index) => h('circle', {
          key: slice.key,
          r: radius,
          fill: 'none',
          stroke: slice.color,
          strokeWidth: 12,
          // pathLength=100 让 dasharray 的单位直接是百分比，动画和缺口都好算。
          pathLength: 100,
          strokeDasharray: `${shown ? Math.max(slice.share - gap, 0.4) : 0} 100`,
          strokeDashoffset: -slice.start,
          style: {
            transition: animate
              ? `stroke-dasharray 520ms cubic-bezier(.22,1,.36,1) ${index * 70}ms`
              : 'none',
          },
        }))));
      };

      /** 图例。本轮带 token 数，会话级不带 —— 那一列在会话尺度上没多大用，省下的高度留给第二个环。 */
      const legendFor = (group, withTokens) => {
        let cursor = 0;
        return group.parts.map((part) => {
          const share = group.totalCost > 0 ? part.cost / group.totalCost * 100 : 0;
          const row = { ...part, share };
          cursor += share;
          return h('div',
            { key: row.key, style: { display: 'flex', gap: 8, alignItems: 'flex-start' } },
            h('span', {
              style: {
                marginTop: 5, width: 8, height: 8, flex: 'none',
                borderRadius: 2, background: row.color,
              },
            }),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { display: 'flex', gap: 8, justifyContent: 'space-between' } },
                h('span', null, t(`slice.${row.key}`)),
                h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, `${row.share.toFixed(0)}%`)),
              withTokens ? h('div', {
                style: {
                  color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
                  fontVariantNumeric: 'tabular-nums',
                },
              }, `${count(row.tokens)} tok · ¥${money(row.cost)}`) : null));
        });
      };

      const tertiary = { color: 'var(--dsw-alias-label-tertiary, #8b8b8b)' };

      /**
       * 一列：作用域标题 + 环 + 图例 + 合计行。
       *
       * 列自己必须被拉伸到行高，合计行的 `marginTop: auto` 才有空间可推、两列的合计
       * 才会横向对齐。所以外面那层 wrapper 必须是 flex 容器 —— 否则列高塌缩成内容
       * 高度，`flex: 1` 被忽略，左列合计会浮在中间。
       */
      const column = (label, group, withTokens, totalLabel, totalText, note) => h('div', {
        style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      },
      h('div', {
        style: {
          color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
          fontSize: 11,
          lineHeight: '16px',
        },
      }, label),
      h('div', { style: { display: 'flex', justifyContent: 'center' } }, ringFor(group, RING_SIZE)),
      h('div', {
        style: { display: 'flex', flexDirection: 'column', gap: withTokens ? 8 : 6 },
      }, legendFor(group, withTokens)),
      h('div', {
        style: {
          marginTop: 'auto', paddingTop: 8,
          borderTop: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)',
          display: 'flex', flexDirection: 'column', gap: 1,
        },
      },
      // 标签和金额各占一行、都左对齐。放在同一行时列宽不够会换行，
      // 标签和数字被拆到两行，看起来就像数字属于旁边那一列。
      h('div', {
        style: {
          color: 'var(--dsw-alias-label-secondary, #6b6b6b)',
          fontSize: 11, lineHeight: '15px', whiteSpace: 'nowrap',
        },
      }, totalLabel),
      h('div', {
        style: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      }, totalText),
      note === void 0 || note === null ? null : h('div', {
        style: {
          color: 'var(--dsw-alias-label-caption, #a0a0a0)',
          fontSize: 11, lineHeight: '15px', whiteSpace: 'nowrap',
        },
      }, note)));

      const turnColumn = column(
        t('scopeTurn'),
        { parts: detail.parts, totalCost: detail.totalCost },
        true,
        t('detailTotal'),
        `${count(detail.totalTokens)} tok · ¥${money(detail.totalCost)}`,
      );

      const sessionColumn = sessionBreakdown === null ? null : column(
        t('scopeSession'),
        sessionBreakdown,
        false,
        t('sessionTotal'),
        // 整场的 token 总量也列出来：和左列对称，而且它和金额的反差本身就有信息
        // —— 几千万 token 只花几块钱，说明量的大头是便宜的缓存命中。
        `${count(sessionBreakdown.totalTokens)} tok · ¥${money(sessionBreakdown.totalCost)}`,
        // 有轮次算不出价时明说，避免「整场累计」静默少算。
        sessionBreakdown.turnsUnpriced > 0
          ? t('unpriced', { count: sessionBreakdown.turnsUnpriced }) : null,
      );

      // 本次问答在左、整场对话在右：查本轮更常用，放左边顺手。
      const body = sessionColumn === null ? turnColumn : h('div', {
        style: { display: 'flex', alignItems: 'stretch', marginTop: 8 },
      },
      h('div', {
        style: {
          flex: 1, minWidth: 0, display: 'flex', paddingRight: 14,
          borderRight: '0.5px solid var(--dsw-alias-border-l2, #e5e5e5)',
        },
      }, turnColumn),
      h('div', { style: { flex: 1, minWidth: 0, display: 'flex', paddingLeft: 14 } }, sessionColumn));

      return h('div', {
        style: {
          position: 'fixed',
          left, top,
          transform: 'translate(-50%, -100%)',
          marginTop: -10,
          zIndex: 2000,
          pointerEvents: 'none',
        },
      }, h('div', {
        style: {
          boxSizing: 'border-box',
          width: PANEL_WIDTH,
          // 窗口比面板窄时收缩，而不是溢出屏幕。
          maxWidth: 'calc(100vw - 16px)',
          padding: '12px 14px',
          borderRadius: 'var(--dsw-radius-lg, 16px)',
          background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, Canvas))',
          backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
          boxShadow: 'var(--dsw-elevation-prominent, 0 8px 32px rgba(0, 0, 0, .18))',
          color: 'var(--dsw-alias-label-primary, CanvasText)',
          fontSize: 12,
          lineHeight: '18px',
          opacity: shown ? 1 : 0,
          transform: shown ? 'translateY(0) scale(1)' : 'translateY(6px) scale(.97)',
          transition: animate ? 'opacity 180ms ease-out, transform 240ms cubic-bezier(.22,1,.36,1)' : 'none',
        },
      },
      // 两个环画的都是钱不是 token，图例里又同时有 token 数，所以先把口径说清楚。
      h('div', {
        style: {
          marginBottom: 2,
          color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
          fontSize: 11,
          lineHeight: '16px',
        },
      }, t('detailScope')),
      body,
      // 推理注释放在两列之外：放进右列会把右列的合计行往上顶，两列的合计就对不齐了。
      detail.reasoning > 0 ? h('div', {
        style: {
          marginTop: 8,
          color: 'var(--dsw-alias-label-caption, #a0a0a0)',
          fontSize: 11,
          lineHeight: '15px',
        },
      }, t('detailReasoning', { tokens: count(detail.reasoning) })) : null));
    }

    function CostBadge(props) {
      const turn = props.turn;
      useBalance();

      const number = turnNumber(turn);
      // 该轮所在会话的数据仓库：同一个会话的每一轮共享它，所以用它分桶。
      const turns = turn !== null && typeof turn === 'object' ? turn.data : null;
      React.useEffect(() => {
        if (number === null || turns === null || typeof turns !== 'object') return;
        const seen = state.latest.get(turns);
        if (seen === void 0 || number > seen) {
          state.latest.set(turns, number);
          notify();
        }
      }, [number, turns]);

      // 注册了 locale 命名空间后组件会收到 t；取不到时回退英文，不能让整个座位崩掉。
      const t = typeof props.t === 'function' ? props.t : (key, params) => {
        const text = en[key] ?? key;
        return params === void 0 ? text
          : text.replace(/\{(\w+)\}/g, (match, name) => String(params[name] ?? match));
      };

      const tail = tailOf(turn);
      const usage = tail === null ? null : tail.tokenUsage;
      const detail = breakdown(usage, billedAt(tail));
      const cost = detail === null ? null : detail.totalCost;
      // 算不出来的原因。静默留空最难查，所以直接把原因写在角标上。
      const why = cost === null ? unpriceable(usage) : null;
      // 每条对话**各自**在自己最新的一轮上显示余额（见 state.latest 的注释）：
      // 余额是账号级数字，对所有对话都成立；而"最新"必须按会话判定，
      // 因为轮次编号每个会话各从 1 开始，用全局最大值会让别的对话把当前这条挤掉。
      // 历史轮次不显示：它们应当保留当时的记录，不能显示此刻的钱。
      const showBalance = number !== null && turns !== null
        && typeof turns === 'object' && state.latest.get(turns) === number;

      // useChat 是这个槽位发给每个组件的标准 props（见官方插槽目录的 standardProps）。
      // 用它读整张轮次表，而不是把渲染出来的几个角标相加 —— 列表是虚拟化的，
      // 累加渲染结果只会算到看得见的那几轮。
      // 取不到时退回一个恒返回 null 的函数：hook 调用次数在渲染之间保持恒定。
      const useChat = typeof props.useChat === 'function' ? props.useChat : () => null;
      const sessionBreakdown = useChat(chatBreakdown);

      const [hovering, setHovering] = React.useState(false);
      const [popup, setPopup] = React.useState(null);
      const anchor = React.useRef(null);
      const timer = React.useRef(null);

      const leave = React.useCallback(() => {
        if (timer.current !== null) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        setHovering(false);
        setPopup(null);
      }, []);

      const enter = React.useCallback(() => {
        setHovering(true);
        if (detail === null || anchor.current === null) return;
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          const node = anchor.current;
          if (node === null) return;
          const rect = node.getBoundingClientRect();
          const half = PANEL_WIDTH / 2;
          // 夹在视口内，否则贴边的回复会把面板推出屏幕。
          const centre = Math.min(
            Math.max(rect.left + rect.width / 2, half + 8),
            Math.max(window.innerWidth - half - 8, half + 8),
          );
          setPopup({ left: centre, top: rect.top });
        }, HOVER_DELAY_MS);
      }, [detail]);

      React.useEffect(() => () => {
        if (timer.current !== null) clearTimeout(timer.current);
      }, []);

      // 非人民币账户：所有轮次都不出金额，只在每条对话最新一轮的位置说明原因。
      // 用人民币价目表算出来的钱对别的币种账户来说是错的，宁可什么都不显示。
      if (state.currencyUnsupported === true) {
        if (!showBalance) return null;
        return h('div', {
          ref: anchor,
          'data-cost-receipt': String(number ?? ''),
          style: rowStyle(),
        }, h('span', { style: { color: WARNING } }, t('nonCny')));
      }

      if (cost === null && why === null && !showBalance) return null;

      const children = [];
      if (cost !== null) {
        // 标出这一轮用的是哪个模型：不标的话，切到 v4-pro 之后只能靠金额反推，
        // 而两个模型的单价差了 3.4 倍，金额本身说不出"这是哪个模型的钱"。
        const route = routeOf(usage);
        const model = route.kind === 'one'
          ? (MODEL_LABELS[route.model] ?? route.model)
          : route.kind === 'mixed' ? route.models.map((m) => MODEL_LABELS[m] ?? m).join(' + ') : '';
        children.push(h('span', {
          style: {
            cursor: 'help',
            padding: '0 4px',
            margin: '0 -4px',
            borderRadius: 'var(--dsw-radius-xs, 4px)',
            background: hovering ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent',
            transition: eased() ? 'background-color 120ms' : 'none',
          },
        // 标签本身也做同一条回退：字典是旧版时照样把模型名标出来（原生标题栏会显示完整读数时间）。
        }, lit(t, 'spentModel', { amount: money(cost), model })
          ?? (model === ''
            ? (lit(t, 'spent', { amount: money(cost) }) ?? `This exchange ¥${money(cost)}`)
            : `${lit(t, 'spent', { amount: money(cost) }) ?? 'This exchange'} · ${model}`)));
      } else if (why !== null) {
        children.push(h('span', { style: { color: WARNING } }, t(why.key, why.params)));
      }
      if (showBalance) {
        // 余额可能为负（透支）：用警示色写出来，别让它看起来像正常数字。
        const owed = state.balance !== null && state.balance < 0;
        const text = state.problem === null
          ? (state.balance === null ? t('loading') : t('balance', { amount: money(state.balance) }))
          : t('unavailable');
        // 读数时刻直接跟在余额后面，**只在数字真的变了时才更新**（见 poll()）。
        // 它是一条诚实的信息，不是一个结论：时刻不动 = 这个数字没变过。
        // **不要**在这里推断"是不是过期"—— 已试过用"90 秒没变就染警示色"，
        // 结论是证据不足：账户闲着的时候余额本来就该纹丝不动，那时也会误报，
        // 而 `getBalance` 不返回任何版本或时间信息，客户端无法区分
        // "陈旧"与"钱真的没动"。所以只如实报时刻，把判断留给看的人。
        const readAt = clock(state.readAt);
        // 悬停时两个时刻都给：readAt 说"数字自此刻没变"，queriedAt 说"宿主最后一次答话"。
        // 只有 readAt 的话，无法区分"读数被宿主缓存住了"和"账户闲着、余额本来就没动"。
        const queried = clock(state.queriedAt) || readAt;
        children.push(h('span', {
          title: readAt === '' ? void 0
            : (lit(t, 'readAt', { time: readAt, queried })
              ?? `Balance last updated at ${readAt} and unchanged since; last queried at ${queried}. Platform sync delays may make this amount non-current`),
          style: {
            opacity: 0.75,
            cursor: readAt === '' ? void 0 : 'help',
            color: state.problem !== null || owed ? WARNING : TERTIARY,
          },
        }, readAt === '' ? text : `${text} · ${readAt}`));
        // 有礼金才列这一项。两个数字互不重叠，相加才是钱包总额。
        if (state.problem === null && state.bonus > 0) {
          children.push(h('span', { style: { opacity: 0.75 } }, t('bonus', { amount: money(state.bonus) })));
        }
      }

      const panel = popup === null || detail === null ? null : h(CostDetail, {
        detail, sessionBreakdown, t, left: popup.left, top: popup.top,
      });

      return h('div', {
        ref: anchor,
        'data-cost-receipt': String(number ?? ''),
        style: rowStyle(),
        onMouseEnter: enter,
        onMouseLeave: leave,
      },
      children,
      panel === null ? null : (createPortal === null ? panel : createPortal(panel, document.body)));
    }

    // ------------------------------------------------------------------ 文案 --

    const zh = {
      spent: '本次问答花费 ¥{amount}',
      spentModel: '本次问答花费 ¥{amount} · {model}',
      readAt: '余额更新于 {time}，此后未变；最后一次查询 {queried}。受平台同步延迟影响，该金额可能非实时值',
      balance: '账户余额 ¥{amount}',
      bonus: '礼金余额 ¥{amount}',
      loading: '账户余额读取中…',
      unavailable: '余额不可用',
      nonCny: '仅支持人民币账户',
      'slice.cacheRead': '缓存命中输入',
      'slice.cacheMiss': '未缓存输入',
      'slice.cacheWrite': '缓存写入',
      'slice.output': '输出',
      detailTotal: '本次问答合计',
      detailScope: '费用构成 · 按计费金额占比（非 token 数量）',
      detailReasoning: '输出中含推理 {tokens} tok',
      sessionTotal: '整场累计',
      scopeTurn: '本次问答',
      scopeSession: '整场对话',
      // 算不出价时说明原因，而不是静默留空。
      whyUnknown: '未收录模型 {model}',
      whyMixed: '混用多模型（{models}）',
      whyNoRoute: '用量未标注模型',
      unpriced: '其中 {count} 轮未计价',
    };
    const en = {
      spent: 'This exchange ¥{amount}',
      spentModel: 'This exchange ¥{amount} · {model}',
      readAt: 'Balance last updated at {time} and unchanged since; last queried at {queried}. Platform sync delays may make this amount non-current',
      balance: 'Account balance ¥{amount}',
      bonus: 'Bonus balance ¥{amount}',
      loading: 'reading balance…',
      unavailable: 'balance unavailable',
      nonCny: 'CNY accounts only',
      'slice.cacheRead': 'Cached input',
      'slice.cacheMiss': 'Uncached input',
      'slice.cacheWrite': 'Cache write',
      'slice.output': 'Output',
      detailTotal: 'Exchange total',
      detailScope: 'Cost breakdown · share of billed amount, not tokens',
      detailReasoning: 'output includes {tokens} tok reasoning',
      sessionTotal: 'Conversation total',
      scopeTurn: 'This exchange',
      scopeSession: 'Whole conversation',
      whyUnknown: 'model {model} not in price table',
      whyMixed: 'mixed models ({models})',
      whyNoRoute: 'usage reports no model',
      unpriced: '{count} turn(s) unpriced',
    };

    return {
      inject: ['slots', 'locale', 'remote', 'remote.account'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cost-receipt: 词典');
        startPolling(ctx);
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'cost-receipt',
          order: 50,
          locale: NS,
        }, CostBadge));
      },
    };
  },
});
