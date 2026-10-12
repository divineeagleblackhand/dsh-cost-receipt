/**
 * 余额花费计的 Host 半边 —— 有意留空。
 *
 * 单轮花费由 token 用量乘以官方单价算出，token 用量和余额都能从浏览器侧拿到
 * （`turn.data.get('turn-tail').tokenUsage` 和 `account/getBalance` Remote），
 * 所以这个插件不需要任何主进程代码。空 apply 只是为了给 bundle 一个可激活的行。
 *
 * 代价与边界：单轮的「真实扣费」在客户端无法可靠获得，因为平台分批结算；要读账户
 * 的累计消费计数器 `total_costs` 就必须走这里，而那会把账号 token 暴露给一个运行
 * 在主进程、不受工作区沙箱限制的插件 —— 收益不值这个代价。
 */

/** @param ctx - Host 插件上下文。 */
export function apply() {}
