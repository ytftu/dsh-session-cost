// test_workbuddy.mjs —— 底栏「WorkBuddy 积分」口径：快照拍平、积分差值对账、文案与本地存储
// 从 ..\lib\client.js 里截取真身函数跑；localStorage / fetch / DOM 用 stub。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')
const start = src.indexOf('    // ===== 底栏金额口径')
const end = src.indexOf('    /** 取一次当前会话的消费数据')
if (start < 0 || end <= start) {
  console.error('未能从插件源码里截取积分段（起点/终点标记没找到）')
  process.exit(1)
}
const code = src.slice(start, end)
// 积分相关的状态/常量声明在文件头部（截取区间之外），同样从真身源码里取，避免测试与实现漂移
const headStart = src.indexOf('    /** WorkBuddy 连接插件的只读状态接口')
const headMark = "    var wbMode = 'money';"
const headEnd = src.indexOf(headMark)
if (headStart < 0 || headEnd <= headStart) {
  console.error('未能从插件源码里截取积分状态声明')
  process.exit(1)
}
const head = src.slice(headStart, headEnd + headMark.length)

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}

/** 内存版 localStorage：wbPruneStates 会用到 length / key()。 */
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)) },
    removeItem: (k) => { map.delete(String(k)) },
    key: (i) => {
      const keys = Array.from(map.keys())
      return i >= 0 && i < keys.length ? keys[i] : null
    },
    get length() { return map.size },
  }
}

function makeApi(storage, sid, sessionData, applied) {
  return new Function(
    'localStorage', 'sessionCostSession', 'sessionCostData', 'sessionCostAmountText', 'sessionCostApply', 'fetch',
    head + '\n' + code + `
return {
  wbAccountKey: wbAccountKey,
  wbSnapshot: wbSnapshot,
  wbConsumeDelta: wbConsumeDelta,
  wbCreditsText: wbCreditsText,
  wbStateFor: wbStateFor,
  wbApplyCredits: wbApplyCredits,
  wbSaveMode: wbSaveMode,
  wbLoadMode: wbLoadMode,
  wbPruneStates: wbPruneStates,
  sessionCostBottomText: sessionCostBottomText,
  mode: function () { return wbMode },
  consumed: function () { return wbConsumed },
  setData: function (d) { wbData = d },
};`
  )(
    storage,
    sid,
    sessionData,
    (n) => '¥ ' + Number(n).toFixed(4),
    (t, tip) => applied.push({ t: t, tip: tip }),
    () => Promise.reject(new Error('测试里不发网络请求'))
  )
}

/** 造一份快照：P(总剩余, [[包键, 剩余], ...])。 */
const P = (total, list) => ({
  t: 0,
  total: total,
  accounts: list.map((row) => ({ k: row[0], remain: row[1], end: 0 })),
})

const storage = makeStorage()
const applied = []
const api = makeApi(storage, 'sess-1', { turns: 3, tokens: 1234, cost: 6.42 }, applied)

console.log('— 快照拍平 —')
const snap = api.wbSnapshot({
  total: 1000,
  accounts: [
    { packageName: 'A', endTimeMs: 111, remain: 900, size: 1000 },
    { packageName: 'B', endTimeMs: 222, remain: 100, size: 100 },
  ],
})
check('wbSnapshot 保留 total 与各套餐包', snap.total === 1000 && snap.accounts.length === 2, 'total=' + snap.total + ' n=' + snap.accounts.length)
check('包键 = 套餐名@到期时间', snap.accounts[0].k === 'A@111' && snap.accounts[1].k === 'B@222', snap.accounts.map((a) => a.k).join(','))
check('包键能区分同名的不同期', api.wbAccountKey({ packageName: 'A', endTimeMs: 1 }) !== api.wbAccountKey({ packageName: 'A', endTimeMs: 2 }))
check('没有 accounts 字段时给空数组', api.wbSnapshot({ total: 5 }).accounts.length === 0)
check('缺字段不炸：remain 缺失按 0', api.wbSnapshot({ accounts: [{ packageName: 'A' }] }).accounts[0].remain === 0)

console.log('— 差值对账（本会话消耗） —')
check('纯消耗：1000 → 990 = 10', api.wbConsumeDelta(P(1000, [['A@1', 1000]]), P(990, [['A@1', 990]])) === 10)
check('中途发放的积分不算负消耗', api.wbConsumeDelta(P(1000, [['A@1', 1000]]), P(1090, [['A@1', 990], ['B@2', 100]])) === 10)
check('到期作废的积分不算消耗', api.wbConsumeDelta(P(1050, [['A@1', 1000], ['C@3', 50]]), P(990, [['A@1', 990]])) === 10)
check('消耗 + 到期 + 发放混在一起', api.wbConsumeDelta(P(1050, [['A@1', 1000], ['C@3', 50]]), P(1085, [['A@1', 985], ['B@2', 100]])) === 15)
check('两次采样完全一致时为 0', api.wbConsumeDelta(P(1000, [['A@1', 1000]]), P(1000, [['A@1', 1000]])) === 0)
check('周期重置（旧包全失效并重发）不算消耗', api.wbConsumeDelta(P(1000, [['A@1', 1000]]), P(1000, [['B@2', 1000]])) === 0)
check('没有上一次快照时返回 0', api.wbConsumeDelta(null, P(1, [])) === 0)

console.log('— 数字格式 —')
check('整数不带小数点', api.wbCreditsText(12) === '12' && api.wbCreditsText(12.02) === '12')
check('非整数留 1 位小数', api.wbCreditsText(12.44) === '12.4')
check('非法值显示 --', api.wbCreditsText('x') === '--' && api.wbCreditsText(undefined) === '--')

console.log('— 跨采样累计与换会话隔离 —')
api.wbApplyCredits(P(1000, [['A@1', 1000]]))
api.wbApplyCredits(P(990, [['A@1', 990]]))
api.wbApplyCredits(P(985, [['A@1', 985]]))
check('三次采样累计 15 积分', api.consumed() === 15, '实际=' + api.consumed())
check('累计写进了本会话的存储槽', (function () {
  const raw = storage.getItem('dsh-session-cost:wb:sess-1')
  if (!raw) return false
  const st = JSON.parse(raw)
  return st.consumed === 15 && st.last && st.last.total === 985
})())
const other = makeApi(storage, 'sess-2', null, [])
other.wbApplyCredits(P(500, [['A@1', 500]]))
check('另一个会话从零开始，不继承 sess-1 的累计', other.consumed() === 0, '实际=' + other.consumed())
check('两个会话各存各的', storage.getItem('dsh-session-cost:wb:sess-1') !== storage.getItem('dsh-session-cost:wb:sess-2'))

console.log('— 设置读写 —')
api.wbSaveMode('credits')
check('口径写入 localStorage', storage.getItem('dsh-session-cost:bottom-mode') === 'credits')
api.wbSaveMode('money')
api.wbLoadMode()
check('口径读回', api.mode() === 'money')
api.wbSaveMode('乱写')
check('非法值回落到人民币', api.mode() === 'money')

console.log('— 底栏文案 —')
api.wbSaveMode('credits')
check('积分模式 + 有数据 → 本会话 15 积分', api.sessionCostBottomText(null).text === '本会话 15 积分', api.sessionCostBottomText(null).text)
check('积分模式的悬停说明交代了口径与限制', (function () {
  const tip = api.sessionCostBottomText(null).tip
  return tip.indexOf('已排除赠分与到期作废') >= 0 && tip.indexOf('当前账号剩余') >= 0 && tip.indexOf('其它客户端') >= 0
})())
api.setData(null)
check('积分模式 + 读不到账号积分 → 显示 --', api.sessionCostBottomText(null).text === '本会话 -- 积分', api.sessionCostBottomText(null).text)
check('积分模式 + 读不到账号积分时提示要装插件', api.sessionCostBottomText(null).tip.indexOf('dsh-workbuddy-connect') >= 0)
api.wbSaveMode('money')
check('人民币模式仍显示金额', api.sessionCostBottomText(6.42).text === '本会话 ¥ 6.4200', api.sessionCostBottomText(6.42).text)
check('人民币模式没有金额时收起（null）', api.sessionCostBottomText(null) === null)
check('人民币模式的悬停保留轮次与 token 数', api.sessionCostBottomText(6.42).tip.indexOf('共 3 轮 · 1234 tokens') >= 0)

console.log('— 本地存储清理 —')
for (let i = 0; i < 35; i++) storage.setItem('dsh-session-cost:wb:old' + i, JSON.stringify({ consumed: i, updatedAt: i }))
api.wbPruneStates()
let left = 0
for (let i = 0; i < storage.length; i++) {
  const k = storage.key(i)
  if (k && k.indexOf('dsh-session-cost:wb:') === 0) left++
}
check('只保留最近 30 个会话的积分状态', left === 30, '实际=' + left)

console.log('\n' + (fail === 0 ? '✅' : '❌') + ' 通过 ' + pass + ' 项，失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
