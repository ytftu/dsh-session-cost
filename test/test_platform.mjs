/**
 * dsh-session-cost 平台半边（官方开放平台：余额 / 今日用量 / 近七日）的离线回归测试。
 *
 * 测试对象是**从插件源码里截取出来的真身函数**（不是复制一份实现），
 * 这样函数改名/改逻辑时测试会跟着失败，而不是静默通过。
 *
 * 覆盖：
 *  ① 余额采样记账：首笔只当基准、只累计「余额减少」、充值不计成负数、跨天结转；
 *  ② history 裁剪到最近 60 天；
 *  ③ platformPayload：近 7 天升序、缺失日补 0；
 *  ④ 从小鲸鱼账本一次性迁移历史（非法日期/负金额丢弃、不重复迁移）；
 *  ⑤ 按日折线图：坐标范围、折线/面积、标签不叠字且末尾日期优先保留。
 *
 * 运行（任意 Node.js ≥ 20，需带 zstd 支持）：
 *   node test_platform.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.join(HERE, '..')
const hostSrc = fs.readFileSync(path.join(PLUGIN, 'lib/index.js'), 'utf8')
const clientSrc = fs.readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8')

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')) }
}

/** 截取 [startMark, endMark) 之间的源码；标记找不到就直接报错（避免静默测了个空函数）。 */
function slice(src, startMark, endMark) {
  const a = src.indexOf(startMark)
  const b = src.indexOf(endMark)
  if (a === -1 || b === -1 || b <= a) throw new Error('截取源码失败：' + startMark + ' … ' + endMark)
  return src.slice(a, b)
}

// ---------- 组装宿主侧真身函数 ----------
const srcMoney = slice(hostSrc, 'const SCALE = 100000000', 'const PEAK_HOURS')
const srcDay = slice(hostSrc, 'function beijingDay(', 'const PEAK_HOURS')
const srcPeakConst = slice(hostSrc, 'const PEAK_HOURS', 'const BASE_PRICE')
const srcPeakRule = slice(hostSrc, 'const WEEKEND_VALLEY_FROM_SEC', '// ===== 自定义单价（只读兼容）')
const srcSwitch = slice(hostSrc, 'function nextPeakSwitchMs(', 'function platformPayload(')
const srcMigrate = slice(hostSrc, 'function importLegacyHistory(', 'function trimHistory(')
const srcSample = slice(hostSrc, 'function trimHistory(', '/** 取官方余额')
const srcPayload = slice(hostSrc, 'function platformPayload(', 'export default')

function loadHost(legacyCandidates) {
  // platformLastError 是模块级状态（声明在 refreshPlatformLedger 附近，不在截取范围内），这里补一个空值
  const body = 'let platformLastError = "";\n'
    + [srcMoney, srcDay, srcPeakConst, srcPeakRule, srcMigrate, srcSample, srcSwitch, srcPayload].join('\n')
    + '\nreturn { moneyUnits, preciseMoney, addMoney, beijingDay, isPeakTime, nextPeakSwitchMs, importLegacyHistory, trimHistory, platformSample, platformPayload }'
  return new Function('fs', 'PLATFORM_HISTORY_MAX', 'PLATFORM_PANEL_DAYS', 'DAY_MS', 'LEGACY_LEDGER_CANDIDATES', body)(
    fs, 60, 7, 24 * 60 * 60 * 1000, legacyCandidates,
  )
}
const H = loadHost([])
console.log('[1] 余额采样记账（只累计余额减少，充值不计负）')
const T1 = Date.parse('2026-10-13T12:00:00+08:00')
const led = { version: 1, date: '2026-10-13', lastBalance: null, todayUsage: 0, history: {}, currency: 'CNY', source: null, updatedAt: 0 }
H.platformSample(led, 10, T1)
ok('首笔只当基准（今日仍为 0）', led.todayUsage === 0 && led.lastBalance === 10, 'today=' + led.todayUsage + ' last=' + led.lastBalance)
H.platformSample(led, 9.5, T1 + 60000)
ok('余额减少 0.5 → 今日 0.5', Math.abs(led.todayUsage - 0.5) < 1e-9, String(led.todayUsage))
H.platformSample(led, 9.25, T1 + 120000)
ok('再减少 0.25 → 今日 0.75', Math.abs(led.todayUsage - 0.75) < 1e-9, String(led.todayUsage))
H.platformSample(led, 19.25, T1 + 180000)
ok('充值 10 元不计成负数', Math.abs(led.todayUsage - 0.75) < 1e-9, String(led.todayUsage))
ok('充值后基准跟到新余额', Math.abs(led.lastBalance - 19.25) < 1e-9, String(led.lastBalance))
H.platformSample(led, 19.15, T1 + 240000)
ok('充值后继续减少 → 0.85', Math.abs(led.todayUsage - 0.85) < 1e-9, String(led.todayUsage))
ok('当天结果已写进 history', Math.abs(led.history['2026-10-13'] - 0.85) < 1e-9, String(led.history['2026-10-13']))

console.log('\n[2] 跨天结转')
const T2 = Date.parse('2026-10-14T09:00:00+08:00')
H.platformSample(led, 19.0, T2)
ok('跨天首笔只当基准（昨天 0.15 的差不算进今天）', led.todayUsage === 0 && led.date === '2026-10-14', 'date=' + led.date + ' today=' + led.todayUsage)
ok('昨天结果已保留在 history', Math.abs(led.history['2026-10-13'] - 0.85) < 1e-9, String(led.history['2026-10-13']))
H.platformSample(led, 18.9, T2 + 60000)
ok('今天的差值正常累加', Math.abs(led.todayUsage - 0.1) < 1e-9, String(led.todayUsage))

console.log('\n[3] history 裁剪')
const ledTrim = { history: {} }
for (let i = 0; i < 70; i++) {
  const day = new Date(Date.UTC(2026, 6, 1) + i * 86400000).toISOString().slice(0, 10)
  ledTrim.history[day] = 1
}
H.trimHistory(ledTrim)
const trimDays = Object.keys(ledTrim.history).sort()
ok('最多保留 60 天', trimDays.length === 60, String(trimDays.length))
ok('删的是最旧的、留的是最新的', !ledTrim.history['2026-07-01'] && !!ledTrim.history[trimDays[59]], trimDays[0] + ' … ' + trimDays[59])

console.log('\n[4] 近七日 payload')
const today = H.beijingDay(Date.now())
const ledPayload = { date: today, lastBalance: 5.230945, todayUsage: 3.058338, history: {}, currency: 'CNY', source: 'account', updatedAt: Date.now() }
ledPayload.history[today] = 3.058338
const payload = H.platformPayload(ledPayload)
ok('固定返回 7 天', Array.isArray(payload.days) && payload.days.length === 7, String(payload.days.length))
ok('按日期升序', payload.days.every((d, i, a) => i === 0 || a[i - 1].day < d.day), payload.days[0].day + ' … ' + payload.days[6].day)
ok('最后一天就是今天（北京时区口径）', payload.days[6].day === today, payload.days[6].day + ' / ' + today)
ok('今天的花费带回 payload', Math.abs(payload.days[6].cost - 3.058338) < 1e-9, String(payload.days[6].cost))
ok('没有记录的日期补 0', payload.days[0].cost === 0 && payload.days[1].cost === 0)
ok('余额与来源一并返回', Math.abs(payload.balance - 5.230945) < 1e-6 && payload.source === 'account', String(payload.balance) + ' / ' + payload.source)

console.log('\n[5] 小鲸鱼账本一次性迁移')
const tmp = path.join(os.tmpdir(), 'dshsc-legacy-' + process.pid + '.json')
fs.writeFileSync(tmp, JSON.stringify({ history: { '2026-09-30': 3.731449, '2026-10-01': -5, 'bad-day': 1, '2026-10-02': 0 } }))
const H2 = loadHost([tmp])
const ledMig = { date: H2.beijingDay(Date.now()), lastBalance: null, todayUsage: 0, history: {} }
ok('导入成功', H2.importLegacyHistory(ledMig) === true)
ok('合法历史被导入', Math.abs(ledMig.history['2026-09-30'] - 3.731449) < 1e-9, String(ledMig.history['2026-09-30']))
ok('非法日期被丢弃', !('bad-day' in ledMig.history))
ok('负数被丢弃', !('2026-10-01' in ledMig.history))
ok('0 值不写进去（省空间）', !('2026-10-02' in ledMig.history))
ok('打了迁移标记', typeof ledMig.importedFrom === 'string' && ledMig.importedFrom.length > 0, ledMig.importedFrom)
ok('已有历史时不再迁移（不会覆盖本插件数据）', H2.importLegacyHistory(ledMig) === false)
try { fs.unlinkSync(tmp) } catch (err) {}

// ---------- 按日折线图 ----------
console.log('\n[6] 近七日折线图（SVG）')
function makeEl(tag) {
  const el = { tagName: tag, children: [], attrs: {}, style: {}, textContent: '' }
  el.setAttribute = (k, v) => { el.attrs[k] = String(v) }
  el.getAttribute = (k) => el.attrs[k]
  el.appendChild = (c) => { el.children.push(c); return c }
  return el
}
globalThis.document = { createElementNS: (ns, tag) => makeEl(tag), createElement: (tag) => makeEl(tag) }
const srcAxis = slice(clientSrc, 'function sessionCostAxisAmount(', 'function sessionCostBuildChart(')
const srcDayChart = slice(clientSrc, 'function sessionCostBuildDayChart(', '/** 启动：DOM 观察')
const buildDayChart = new Function('document', srcAxis + '\n' + srcDayChart + '\nreturn sessionCostBuildDayChart;')(globalThis.document)

function collect(el, tag, out) {
  if (!el || !el.children) return out
  for (const c of el.children) {
    if (c.tagName === tag) out.push(c)
    collect(c, tag, out)
  }
  return out
}
const days7 = []
for (let i = 6; i >= 0; i--) {
  days7.push({ day: new Date(Date.now() - i * 86400000).toISOString().slice(0, 10), cost: i === 3 ? 3.5 : i * 0.4 })
}
const svg = buildDayChart(days7, 268)
ok('viewBox 与实测宽度一致（坐标 1:1）', svg.attrs.viewBox === '0 0 268 132', svg.attrs.viewBox)
const dots = collect(svg, 'circle', [])
ok('7 天 7 个数据点', dots.length === 7, String(dots.length))
const dotX = dots.map((d) => Number(d.attrs.cx))
ok('点都在绘图区内且不越界', dotX.every((x) => x >= 44 && x <= 258), dotX.map((x) => Math.round(x)).join(','))
const polys = collect(svg, 'polyline', [])
ok('有折线', polys.length === 1 && polys[0].attrs.points.split(' ').length === 7)
const areas = collect(svg, 'polygon', [])
ok('有面积填充', areas.length === 1 && areas[0].attrs.opacity === '0.12')
const texts = collect(svg, 'text', [])
const labels = texts.filter((t) => /^\d{2}-\d{2}$/.test(String(t.textContent)))
ok('日期标签数量克制（不叠字）', labels.length >= 3 && labels.length <= 7, labels.map((t) => t.textContent).join(','))
ok('末尾日期一定有标签', labels.some((t) => t.textContent === days7[6].day.slice(5)), labels.map((t) => t.textContent).join(','))
ok('横轴有「日」标注', texts.some((t) => t.textContent === '日'))
const tips = collect(svg, 'title', [])
ok('每个点都有悬停提示（日期+金额）', tips.length === 7 && tips.every((t) => /^\d{4}-\d{2}-\d{2}：¥\d+\.\d{4}$/.test(String(t.textContent))), String(tips[0] && tips[0].textContent))
ok('纵轴刻度带 ¥', texts.some((t) => String(t.textContent).indexOf('¥') === 0))

// ---------- 峰谷（顶部条标签 + 与计价同一套规则） ----------
console.log('\n[7] 峰谷规则（与计价共用 isPeakTime）')
const bjDow = (ms) => new Date(ms + 8 * 3600000).getUTCDay()
/** 取「北京时间的某个星期几 + 几点」的时刻：锚在 2026-11-09 北京 00:00 上往后推。
 *  特意选 11 月 —— 2026-10-01…10-07 是国庆长假，整段都是谷价，拿 10 月当锚点会误判。 */
const bjAt = (dow, hour) => {
  let t = Date.parse('2026-11-09T00:00:00+08:00')
  while (bjDow(t) !== dow) t += 86400000
  return t + hour * 3600000
}
ok('工作日 10:00 = 高峰', H.isPeakTime(Math.floor(bjAt(1, 10) / 1000)) === true)
ok('工作日 12:30 = 空闲（午休谷价）', H.isPeakTime(Math.floor(bjAt(1, 12.5) / 1000)) === false)
ok('工作日 17:59 = 高峰', H.isPeakTime(Math.floor(bjAt(1, 17.98) / 1000)) === true)
ok('工作日 18:30 = 空闲', H.isPeakTime(Math.floor(bjAt(1, 18.5) / 1000)) === false)
ok('工作日 08:30 = 空闲', H.isPeakTime(Math.floor(bjAt(1, 8.5) / 1000)) === false)
ok('周六 10:00 = 空闲（周末全天谷价）', H.isPeakTime(Math.floor(bjAt(6, 10) / 1000)) === false)
ok('周日 15:00 = 空闲', H.isPeakTime(Math.floor(bjAt(0, 15) / 1000)) === false)

const anyT = bjAt(1, 10)
const anyPeak = H.isPeakTime(Math.floor(anyT / 1000))
const until = H.nextPeakSwitchMs(anyT)
ok('切换点在将来且不超过 8 天', until > anyT && until <= anyT + 8 * 86400000, new Date(until).toISOString())
ok('切换点当刻状态确实翻转', H.isPeakTime(Math.floor(until / 1000)) !== anyPeak)
ok('切换点前一分钟仍是原状态', H.isPeakTime(Math.floor((until - 60000) / 1000)) === anyPeak)
ok('切换点是整分钟', until % 60000 === 0)
ok('payload 带出 peak 布尔值', payload.peak === true || payload.peak === false, String(payload.peak))
ok('payload 带出下次切换时刻', payload.peakUntilMs === 0 || payload.peakUntilMs > Date.now(), String(payload.peakUntilMs))

console.log('\n[8] 顶部条峰谷标签')
const srcPeakUi = slice(clientSrc, 'function platformSwitchText(', 'function platformApplyText(')
const peakUi = new Function(srcPeakUi + '\nreturn { platformSwitchText, platformApplyPeak, platformPeakTip };')()
function makeTag() {
  const t = { textContent: '', attrs: {} }
  t.setAttribute = (k, v) => { t.attrs[k] = String(v) }
  t.getAttribute = (k) => (k in t.attrs ? t.attrs[k] : null)
  return t
}
const tag = makeTag()
tag.setAttribute('data-state', 'none')
peakUi.platformApplyPeak(tag, { peak: false })
ok('谷时 → 标签「谷时」+ valley', tag.textContent === '谷时' && tag.attrs['data-state'] === 'valley')
peakUi.platformApplyPeak(tag, { peak: true })
ok('峰时 → 标签「峰时」+ peak', tag.textContent === '峰时' && tag.attrs['data-state'] === 'peak')
peakUi.platformApplyPeak(tag, null)
ok('没有数据时隐藏标签', tag.attrs['data-state'] === 'none' && tag.textContent === '')
ok('峰时 tooltip 说明价格 ×2', peakUi.platformPeakTip({ peak: true, peakUntilMs: Date.now() + 3600000 }).indexOf('高峰时段（价格 ×2）') >= 0)
ok('谷时 tooltip 说明价格 ×0.5', peakUi.platformPeakTip({ peak: false, peakUntilMs: Date.now() + 3600000 }).indexOf('空闲时段（价格 ×0.5）') >= 0)
ok('倒计时：小时 + 分钟', peakUi.platformSwitchText(Date.now() + 2 * 3600000 + 30 * 60000) === '2 小时 30 分钟后切换', peakUi.platformSwitchText(Date.now() + 2 * 3600000 + 30 * 60000))
ok('倒计时：整小时不带分钟', peakUi.platformSwitchText(Date.now() + 3 * 3600000) === '3 小时后切换', peakUi.platformSwitchText(Date.now() + 3 * 3600000))
ok('倒计时：不足一小时只报分钟', peakUi.platformSwitchText(Date.now() + 25 * 60000) === '25 分钟后切换', peakUi.platformSwitchText(Date.now() + 25 * 60000))
ok('倒计时：已过去/无效值返回空串', peakUi.platformSwitchText(Date.now() - 1000) === '' && peakUi.platformSwitchText(NaN) === '')

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败')
process.exit(fail === 0 ? 0 : 1)
