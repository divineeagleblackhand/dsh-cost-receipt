# dsh-cost-receipt

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）每条回复下面加一行：**本次问答花了多少钱**，以及账户余额。

```
本次问答花费 ¥0.165824    账户余额 ¥6.2164    礼金余额 ¥1.5366
```

## 特点

- **按"一问一答"计价**：每条回复下面一行，看的是刚才这一问花了多少。历史轮次也有数字，按它当时的时段定价，打开旧会话照样算得出来。
- **余额拆成两个数**：`账户余额`只算充值余额，`礼金余额`另起一项，相加才是钱包总额。没有礼金时第二项不显示。余额只出现在每条对话的最新一轮（历史轮次显示当时的钱没有意义）。
- **悬停看费用构成**：本次问答与整场对话**并排两个环，按花费占比画**，不是 token 占比。因为缓存命中的 token 通常占 99%，却只占不到四成花费；按 token 画会退化成一个看不见的细弧。
- **算不出价就写明原因**，绝不静默出错：角标会直接写 `未收录模型 xxx`、`混用多模型（a + b）`、`用量未标注模型`。拿别的模型的单价硬套会错好几倍，而且看不出来。
- **余额的读取时刻如实显示**：宿主会缓存账号查询，所以角标上带着"读取于 HH:MM:SS"。时刻不动＝数字没变过，不是"刚刚读过"。

## 安装

在 dsh 插件页的「添加插件」里填仓库地址：

```
https://github.com/divineeagleblackhand/dsh-cost-receipt
```

或者命令行（桌面版的 profile 名是 `desktop`）：

```
dsh plugin --profile desktop add https://github.com/divineeagleblackhand/dsh-cost-receipt
```

装完刷新页面。若角标没出现，完全退出并重启桌面版。

> 若直连 GitHub 困难：先把仓库克隆到本地，再用绝对路径安装即可，效果一样。

## 隐私

- **零网络请求**：插件自己不发起任何外部请求。余额通过 dsh 宿主的 `account/getBalance` 取得，是进程内调用。
- **零存储**：不写任何文件，不用 localStorage。
- **零凭据访问**：不读 API Key，不读任何配置文件。
- 唯一读取的数据是当前会话的 token 用量，也就是 dsh 自己「本轮用量」面板用的那一份。

## 计价口径与边界

| 项 | 口径 |
|---|---|
| 一轮 | 一次问答：一条用户消息 → 最终回复 |
| 计价 | 缓存命中输入 / 未缓存输入 / 缓存写入 / 输出 四桶分别乘单价。缓存写入按未命中输入计价（官方没有单独的缓存写入价） |
| 单价 | 人民币 / 百万 token，按模型分开，取自官方价目表 |
| 时段 | 高峰＝北京时间周一至周五 9:00–12:00、14:00–18:00，**不含法定节假日**，其余时间空闲价。判定与你的系统时区无关 |
| 节假日 | 内置国务院 2026 年安排（19 天）。未收录的年份退回"不修正"，不会给错答案，只是不再修正 |
| 币种 | **只支持人民币账户**。检测到非人民币钱包时一个金额都不显示，只提示「仅支持人民币账户」 |

已知误差：

- **跨峰谷边界的轮次**按该轮结束时刻整轮定价，最坏偏 50%（一轮 5 分钟跨界的概率约 1.4%）。
- **整场累计**只覆盖已加载进视图的轮次；超长会话分页时这个数会偏低。
- **单价表与节假日表会随官方更新**，需要手动改常量（见下）。

## 兼容性

- 需要 **dsh 0.2.0-rc.2**：插件依赖它内部的 turn-tail 数据与 account Remote。dsh 升级后如果角标消失，第一个要怀疑的就是这里。
- Web 版与桌面版均可，Windows 与 macOS 均可（纯客户端插件，不碰文件系统，也没有平台分支）。
- 非人民币账户不显示金额（见上）。

## 开发

```
npm test
```

测试脚本会**从 `client.js` 里切片抽出真实的计价代码来执行**，而不是复制一份——避免"测的和跑的不是同一份"。覆盖：峰谷时段边界、节假日、三项拆解对账、饼图与角标同源、会话累计、悬停面板结构、币种判定、中英字典对齐。

- 改价格表：`client.js` 顶部的 `PRICES`
- 刷新节假日表：`node tools/fetch-holidays.mjs <年份>`（可再传国务院通知原文 URL 做交叉校验）

## 许可

MIT

---

**English** — A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that adds one line under every reply showing what that exchange cost, priced from the turn's own token usage at the official peak/off-peak CNY rates, together with the account and bonus balances. Hover for a cost breakdown of the exchange versus the whole conversation. When a price cannot be computed it says why instead of guessing. No network requests, no storage, no credentials. Requires dsh 0.2.0-rc.2; CNY accounts only.
