/**
 * dsh-session-cost 独立插件的离线集成测试。
 *
 * 覆盖：
 *  ① 宿主半边能被加载、插件体能注册路由（fake cordis root）；
 *  ② 用**真实会话日志**走一遍路由，检查返回结构、金额量级、轮次分桶；
 *  ③ 来源校验：非本机 Host 一律 403；
 *  ④ 找不到会话时返回 NO_SESSION，而不是抛异常；
 *  ⑤ 浏览器半边能被 ModuleLoader 装载、factory 可执行并导出 apply/inject。
 *
 * 运行（任意 Node.js ≥ 20，需带 zstd 支持）：
 *   node test_session_cost_plugin.mjs
 *
 * 第 [2]/[3] 段要读一份真实会话日志；默认自动挑 sessions 目录里最近写过的那个。
 * 也可以用 `node test_session_cost_plugin.mjs <会话 id>` 或环境变量 DSH_TEST_SESSION 指定；
 * 找不到会话时会跳过这两段（不算失败）。
 */
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const SESSION_LOG = 'session.v4.jsonl.zstd'

// 自动探测：遍历 <DSH_HOME>/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd，取最近写入的那个
function detectSession() {
  const root = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions')
  let best = ''
  let bestTime = 0
  let workspaces = []
  try { workspaces = fs.readdirSync(root) } catch (err) { return '' }
  for (const ws of workspaces) {
    let ids = []
    try { ids = fs.readdirSync(path.join(root, ws)) } catch (err) { continue }
    for (const id of ids) {
      try {
        const st = fs.statSync(path.join(root, ws, id, SESSION_LOG))
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = id }
      } catch (err) { /* 不是会话目录，跳过 */ }
    }
  }
  return best
}

const SESSION = process.env.DSH_TEST_SESSION || process.argv[2] || detectSession()

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

// ---------- 宿主半边 ----------
console.log('[1] 宿主半边加载与路由注册')
const registered = []
const effects = []
const root = {
  inject(services, cb) {
    ok('apply 只注入 webServer', Array.isArray(services) && services.length === 1 && services[0] === 'webServer', JSON.stringify(services))
    cb({
      webServer: { register(route) { registered.push(route); return () => {} } },
      effect(fn) { effects.push(fn) },
    })
  },
}
const host = await import(pathToFileURL(path.join(PLUGIN, 'lib/index.js')).href)
ok('宿主默认导出是插件对象', host.default && typeof host.default.apply === 'function')
ok('插件名 = session-cost', host.default.name === 'session-cost', String(host.default.name))
host.default.apply(root)
ok('注册了 2 条路由（会话 + 平台）', registered.length === 2, String(registered.length))
ok('路由路径正确', registered[0] && registered[0].path === '/dsh-session-cost/session-cost.json', registered[0] && registered[0].path)
ok('注册了清理 effect', effects.length === 1)

function call(url, hostHeader, index) {
  let out = null
  let code = 0
  const res = {
    writeHead(c) { code = c },
    end(body) { try { out = JSON.parse(body) } catch (err) { out = { raw: String(body).slice(0, 120) } } },
  }
  registered[index || 0].handler({ url, headers: { host: hostHeader } }, res)
  return { code, body: out }
}

/** 平台的 handler 是 async（要取余额），必须等它把 res.end 走完。 */
async function callAsync(url, hostHeader, index) {
  let out = null
  let code = 0
  const res = {
    writeHead(c) { code = c },
    end(body) { try { out = JSON.parse(body) } catch (err) { out = { raw: String(body).slice(0, 120) } } },
  }
  await registered[index || 0].handler({ url, headers: { host: hostHeader } }, res)
  return { code, body: out }
}

if (!SESSION) console.log('\n[2] 真实会话日志：跳过（本机没有可用的会话日志；可用 DSH_TEST_SESSION 指定）')
else console.log('\n[2] 真实会话日志（' + SESSION + '）')
const r = SESSION ? call('/dsh-session-cost/session-cost.json?session=' + SESSION, '127.0.0.1:19387') : { code: 0, body: null }
if (SESSION) {
  ok('HTTP 200', r.code === 200, String(r.code))
  ok('ok=true', r.body && r.body.ok === true, JSON.stringify(r.body).slice(0, 200))
}
if (r.body && r.body.ok) {
  const b = r.body
  ok('currency=CNY', b.currency === 'CNY')
  ok('cost 是正数', isFinite(b.cost) && b.cost > 0, '¥' + b.cost)
  ok('tokens 是正数', isFinite(b.tokens) && b.tokens > 0, String(b.tokens) + ' tokens')
  ok('turns ≥ 1', isFinite(b.turns) && b.turns >= 1, String(b.turns) + ' 轮')
  ok('turnCosts 条数 = 轮数', Array.isArray(b.turnCosts) && b.turnCosts.length === b.turns, b.turnCosts && b.turnCosts.length + ' / ' + b.turns)
  ok('turnCosts 按轮次升序', Array.isArray(b.turnCosts) && b.turnCosts.every((t, i, a) => i === 0 || a[i - 1].turn <= t.turn))
  const sum = (b.turnCosts || []).reduce((s, t) => s + Number(t.cost), 0)
  ok('分轮金额之和 = 总额（±0.0001）', Math.abs(sum - Number(b.cost)) < 0.0001, sum.toFixed(4) + ' vs ' + Number(b.cost).toFixed(4))
  ok('每条都带 timeMs', (b.turnCosts || []).every((t) => Number(t.timeMs) > 0), '第一条 ' + new Date(b.turnCosts[0].timeMs).toISOString())
  ok('models 非空且按花费降序', Array.isArray(b.models) && b.models.length > 0
    && b.models.every((m, i, a) => i === 0 || a[i - 1].cost >= m.cost), JSON.stringify(b.models.map((m) => m.model + '=' + m.cost)))
  const modSum = (b.models || []).reduce((s, m) => s + Number(m.cost), 0)
  ok('分模型金额之和 = 总额（±0.0001）', Math.abs(modSum - Number(b.cost)) < 0.0001, modSum.toFixed(4))
  console.log('  · 明细：' + JSON.stringify(b.turnCosts.map((t) => 'r' + t.turn + '=¥' + t.cost.toFixed(4))))
}

console.log('\n[3] 安全性 / 边界')
const bad = call('/dsh-session-cost/session-cost.json?session=' + (SESSION || 'session-any'), 'evil.example.com')
ok('伪造 Host 被拒（403）', bad.code === 403 && bad.body && bad.body.code === 'FORBIDDEN', JSON.stringify(bad.body))
const traversal = call('/dsh-session-cost/session-cost.json?session=../../etc/passwd', '127.0.0.1:19387')
ok('会话 id 含路径穿越 → NO_SESSION', traversal.body && traversal.body.code === 'NO_SESSION', JSON.stringify(traversal.body))
const none = call('/dsh-session-cost/session-cost.json?session=session-does-not-exist', 'localhost:19387')
ok('不存在的会话 → NO_SESSION', none.body && none.body.code === 'NO_SESSION', JSON.stringify(none.body))
const noParam = call('/dsh-session-cost/session-cost.json', '127.0.0.1:19387')
ok('缺 session 参数 → NO_SESSION', noParam.body && noParam.body.code === 'NO_SESSION')
if (SESSION) {
  const localhost6 = call('/dsh-session-cost/session-cost.json?session=' + SESSION, '[::1]:19387')
  ok('IPv6 回环 Host 放行', localhost6.code === 200, String(localhost6.code))
}

// ---------- 平台半边（余额 / 今日用量 / 近七日） ----------
console.log('\n[4] 平台半边（余额 / 今日用量 / 近七日）')
const paths = registered.map((x) => x.path)
ok('注册了平台路由', paths.indexOf('/dsh-session-cost/platform.json') !== -1, JSON.stringify(paths))
const pBad = await callAsync('/dsh-session-cost/platform.json', 'evil.example.com', 1)
ok('平台路由：伪造 Host 被拒（403）', pBad.code === 403 && pBad.body && pBad.body.code === 'FORBIDDEN', JSON.stringify(pBad.body))
// fake ctx 里没有 credentials / deepseekAccount：余额取不到，但接口本身必须照常返回结构（前端据此显示 --）
const pOk = await callAsync('/dsh-session-cost/platform.json', '127.0.0.1:19387', 1)
ok('平台路由：HTTP 200 且 ok=true', pOk.code === 200 && pOk.body && pOk.body.ok === true, JSON.stringify(pOk.body).slice(0, 200))
ok('近七日固定 7 项', pOk.body && Array.isArray(pOk.body.days) && pOk.body.days.length === 7, pOk.body && pOk.body.days && pOk.body.days.length)
ok('近七日按日期升序且日期合法', pOk.body && pOk.body.days.every((d, i, a) => /^\d{4}-\d{2}-\d{2}$/.test(d.day) && (i === 0 || a[i - 1].day < d.day)))
ok('todayUsage 是非负数', pOk.body && isFinite(pOk.body.todayUsage) && pOk.body.todayUsage >= 0, String(pOk.body && pOk.body.todayUsage))
ok('balance 字段存在（取不到时可为 null）', pOk.body && Object.prototype.hasOwnProperty.call(pOk.body, 'balance'), String(pOk.body && pOk.body.balance))
ok('取不到余额时给出 error 文案', pOk.body && pOk.body.balance === null ? typeof pOk.body.error === 'string' && pOk.body.error.length > 0 : true, String(pOk.body && pOk.body.error))

// ---------- 浏览器半边 ----------
console.log('\n[5] 浏览器半边（ModuleLoader 契约）')
let loaded = null
globalThis.window = { __ModuleLoader__: { load(cfg) { loaded = cfg } } }
const clientSrc = fs.readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8')
await import(pathToFileURL(path.join(PLUGIN, 'lib/client.js')).href)
ok('调用了 __ModuleLoader__.load', loaded !== null)
ok('插件 id = dsh-session-cost', loaded && loaded.id === 'dsh-session-cost', loaded && loaded.id)
const clientExports = loaded && loaded.factory()
ok('factory 返回 apply', clientExports && typeof clientExports.apply === 'function')
ok('inject 为空数组（不依赖客户端服务）', Array.isArray(clientExports.inject) && clientExports.inject.length === 0)
ok('源码里没有残留的鲸鱼命名空间', !/\bdshw[A-Z_]|__dshWhaleWidget|dsh-whale\//.test(clientSrc))
ok('接口前缀指向新插件', clientSrc.indexOf("/dsh-session-cost/session-cost.json") !== -1)
ok('四个注入点属性齐全（会话金额 / 弹窗 / 每条回复金额 / 顶部条）',
  clientSrc.indexOf('data-dshsc-session-cost') !== -1
  && clientSrc.indexOf('data-dshsc-turn-cost') !== -1
  && clientSrc.indexOf('data-dshsc-session-cost-panel') !== -1
  && clientSrc.indexOf('data-dshsc-platform') !== -1)
ok('顶部条点击后走侧栏浏览器（sidebarRight.openTab）', /openTab\('browser'/.test(clientSrc))
ok('近七日按日折线图存在', clientSrc.indexOf('function sessionCostBuildDayChart(') !== -1)
// 无 document 的环境里 apply 必须安全返回（SSR/提前加载）
let threw = false
try { clientExports.apply({ effect() {} }) } catch (err) { threw = true }
ok('无 document 时 apply 不抛异常', !threw)

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
