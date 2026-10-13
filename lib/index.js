/**
 * dsh-session-cost —— 宿主半边：按 DSH 自己的会话日志算「当前会话总消费（人民币）」。
 *
 * 设计要点：
 * - **不依赖 dsh-whale-widget**：价目表、峰谷规则、法定节假日清单、金额精度、日志解析全部自带，
 *   本插件单独安装、单独启用也能工作（这正是当初从鲸鱼插件里抽出来的原因）。
 * - 数据源是 DSH 自己的会话日志 <DSH_HOME>/sessions/<工作区编码>/<会话 id>/session.v4.jsonl.zstd。
 *   它是**多帧拼接**的 zstd（每追加一批数据就新起一帧），而 Node 的 zstdDecompressSync 只认第一帧，
 *   所以这里按 zstd 魔数切帧、逐帧解压，并把已解析位置（永远停在帧边界）缓存起来做增量解析。
 * - 计费口径：每条 assistant/message 的 usage × 该条**写入时刻**的峰谷单价；同一 (turn, step)
 *   只保留最后一次（重试替换，不重复计费），与 DSH 前端的 tokenUsage 投影同口径。
 * - 只对外暴露一条**只读**路由 /dsh-session-cost/session-cost.json，且只接受本机来源的请求。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

/** 包根目录：lib/index.js -> 包根（安装到 node_modules 或本机 link 都可重定位）。 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** DSH 数据根：默认 ~/.dsh（桌面版）；装了多份 DSH 时由 DSH_HOME 覆盖。 */
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// ===== 金额：与官方账本同口径，以 1e-8 元为最小单位做整数累加，避免浮点误差堆积 =====
const SCALE = 100000000
function moneyUnits(value) {
  const n = Number(value)
  const units = Math.round(n * SCALE)
  if (!Number.isFinite(n) || !Number.isSafeInteger(units)) throw new Error('金额无效或超出可记账范围')
  return units
}
function preciseMoney(value) { return moneyUnits(value) / SCALE }
function addMoney(a, b) {
  const units = moneyUnits(a) + moneyUnits(b)
  if (!Number.isSafeInteger(units)) throw new Error('金额合计超出可记账范围')
  return units / SCALE
}
/** 北京时间（UTC+8）的日历日 'YYYY-MM-DD'，与峰谷计价的时区口径一致。 */
function beijingDay(time = Date.now()) {
  const d = new Date(Number(time) + 8 * 3600000)
  if (!Number.isFinite(d.getTime())) throw new Error('无效的观测时间')
  return d.toISOString().slice(0, 10)
}

// ===== 价目表（元 / 百万 token），数组下标 [0]=空闲时段价、[1]=高峰时段价 =====
// 高峰时段（官方 2026-09-19 说明）：**北京时间周一至周五（不含中国法定节假日）9:00–12:00、14:00–18:00**；
// 其余时段 —— 包括周末、调休上班的周末、以及法定节假日全天 —— 一律按空闲时段计费。
// 价格来源：官方 https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// 2026-09-10 起 Flash 系列降价：缓存命中 0.05→0.02、未命中 1.5→1、输出 4.5→4（高峰 = 空闲 × 2）。
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]
// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
// Pro 为 Flash 的 3 倍价（官方 2026-08-17 生效）。官方 2026-09-14 公告：V4 Pro 继续提供 API 服务、
// 计费方式保持不变（"9/14 12:00 起 pro 路由到 V4.1 Flash"的安排已取消），因此不做按日期的降级切换。
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 旧名已下线，请求由 V4.1-Flash 提供，按 Flash 价计费
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}
// 2026-08-23 00:00（北京时间）起周末全天按谷价；生效时刻之前的历史分桶仍按旧规则计价。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
// ===== 法定节假日全天谷价（官方 2026-09-19 说明）=====
// 依据：《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）。
// 只需列**放假**的日期：调休上班日全部落在周末（2026 年为 1/4、2/14、2/28、5/9、9/20、10/10），
// 按"周末也算谷价"的规则本来就是谷价，无需单列。
// ⚠️ **每年 11 月国务院发布次年安排后，必须在这里补下一年的日期**。
const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
}
// 这条规则自 2026-09-19 00:00 起生效（此前历史分桶按旧规则计价）。
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000)
function isHolidayValley(bjDate) {
  try {
    return !!HOLIDAY_VALLEY[bjDate.toISOString().slice(0, 10)]
  } catch (err) { return false }
}
/** 某个时刻（epoch 秒）是否落在高峰时段；周末与法定节假日全天一律谷价。 */
function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // 0=周日 6=周六（bj 按 UTC 读即为北京日历日）
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// ===== 自定义单价（只读兼容）：用户在「自定义 API 模型」里填的单价存在鲸鱼插件的注册表文件里 ====
// 这里只读不改；文件不存在（没装鲸鱼插件）时退回内置价目表，功能不受影响。
const API_FILE_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-api.json'),
]
const API_BUILTIN_ID = 'deepseek'
let CUSTOM_PRICES = {}
// 自定义单价的币种/汇率（与 CUSTOM_PRICES 同键）：按美元填写时用用户填的汇率折算成人民币
let CUSTOM_PRICE_META = {}
let customPriceAt = 0
/** 读注册表刷新自定义单价表（10 秒节流，避免每次请求都读盘）。 */
function refreshCustomPrices() {
  const now = Date.now()
  if (now - customPriceAt < 10000) return
  customPriceAt = now
  try {
    let reg = null
    for (const p of API_FILE_CANDIDATES) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (parsed && Array.isArray(parsed.models)) { reg = parsed; break }
      } catch (err) {}
    }
    const map = {}
    const metaMap = {}
    const models = reg ? reg.models : []
    for (const m of models) {
      // 内置模型（DeepSeek）跳过：它有自己的峰谷价表，不能被自定义单价覆盖
      if (!m || m.id === API_BUILTIN_ID) continue
      const pr = m && m.price
      if (!pr) continue
      const hit = Number(pr.hit), miss = Number(pr.miss), out = Number(pr.out)
      const ok = (v) => (isFinite(v) ? v : 0)
      if (!isFinite(hit) && !isFinite(miss) && !isFinite(out)) continue
      const table = { hit: [ok(hit), ok(hit)], miss: [ok(miss), ok(miss)], out: [ok(out), ok(out)] }
      const meta = {
        cur: String(pr.cur || 'CNY').toUpperCase(),
        rate: isFinite(Number(pr.rate)) ? Number(pr.rate) : 0,
      }
      const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
      for (const s of ids) {
        const k = String(s || '').toLowerCase().trim()
        // 关键字过短（< 3 字符，如 pro/flash）极易误伤其它模型，直接忽略
        if (k && k.length >= 3) { map[k] = table; metaMap[k] = meta }
      }
    }
    CUSTOM_PRICES = map
    CUSTOM_PRICE_META = metaMap
  } catch (err) {}
}
function customPriceMetaFor(model) {
  const m = String(model || '').toLowerCase()
  // 按键长降序：最长命中优先，避免短关键字（如 pro）误伤别的模型
  for (const key of Object.keys(CUSTOM_PRICE_META).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICE_META[key]
  }
  return null
}
function priceFor(model) {
  const m = String(model || '').toLowerCase()
  for (const key of Object.keys(CUSTOM_PRICES).sort((a, b) => b.length - a.length)) {
    if (key && m.indexOf(key) !== -1) return CUSTOM_PRICES[key]
  }
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  return PRICING._default
}

// ===== 会话日志解析 =====
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
// 会话 id 只用来拼路径 ⇒ 先过白名单，杜绝 ../ 之类的路径穿越
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/
const SESSION_COST_FRAME_FAILS = 3
const SESSION_COST_CACHE_MAX = 24
// file -> { offset: 已解析到的字节位置(必在帧边界), entries: Map<turn:step, {...}>, bad: {offset,count} }
const sessionCostCache = new Map()

/**
 * 会话 id 对应的日志文件。目录结构是 sessions/<工作区编码>/<会话 id>/session.v4.jsonl.zstd，
 * 目录名即会话 id；个别历史目录带/不带 `session-` 前缀，两种都试。
 * @param sessionId - 前端从 data-conversation-session 读到的会话 id。
 * @returns 日志文件绝对路径，找不到时 null。
 */
function sessionLogFile(sessionId) {
  const id = String(sessionId || '')
  if (!SESSION_ID_PATTERN.test(id)) return null
  let workspaces = []
  try {
    workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch (err) {
    return null
  }
  const names = [id, id.startsWith('session-') ? id.slice(8) : 'session-' + id]
  for (const ws of workspaces) {
    for (const name of names) {
      const p = path.join(SESSIONS_ROOT, ws, name, SESSION_LOG_NAME)
      try {
        if (fs.statSync(p).isFile()) return p
      } catch (err) {}
    }
  }
  return null
}

/**
 * 一条 usage 的人民币金额与计费 token 数（缓存命中/未命中/输出三档；
 * reasoning 已含在 outputTokens 里，不重复计）。
 * @param model - 该条消息的模型名。
 * @param usage - 会话日志里的 usage 对象。
 * @param atMs - 该条的写入时刻（epoch 毫秒），用于取当时时段的峰谷价。
 * @returns { cost, tokens }。
 */
function sessionUsagePrice(model, usage, atMs) {
  const input = Number(usage.inputTokens) || 0
  const cache = Number(usage.cacheReadTokens) || 0
  const output = Number(usage.outputTokens) || 0
  const p = priceFor(model)
  const off = isPeakTime(Math.floor((Number(atMs) || Date.now()) / 1000)) ? 1 : 0
  let cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
  // 自定义单价若按美元填写，按用户填的汇率换算成人民币（账本统一按 CNY）
  const meta = customPriceMetaFor(model)
  if (meta && meta.cur === 'USD' && Number(meta.rate) > 0) cost = cost * Number(meta.rate)
  return { cost: isFinite(cost) ? cost : 0, tokens: input + cache + output }
}

/**
 * 解析一段新增的日志文本，把每条 assistant/message 的计费结果写进 entries。
 * @param text - 解压出来的一段 jsonl 文本（可能只含若干完整行）。
 * @param entries - 累积表，键为 `turn:step`。
 */
function sessionCostFold(text, entries) {
  let fallback = 0
  for (const line of text.split('\n')) {
    if (line.length < 2 || line.charCodeAt(0) !== 0x7b /* { */) continue
    let obj
    try {
      obj = JSON.parse(line)
    } catch (err) {
      continue
    }
    if (!obj || obj.type !== 'assistant/message') continue
    const data = obj.data || {}
    const usage = data.usage
    if (!usage || typeof usage !== 'object') continue
    const model = (data.message && data.message.source && data.message.source.model) || ''
    const priced = sessionUsagePrice(model, usage, obj.time)
    const turn = Number(data.turn)
    const step = Number(data.step)
    // 与 DSH 的 tokenUsage 投影同口径：同一 (turn, step) 的多次尝试只保留最后一次（重试替换）
    const key = (isFinite(turn) ? turn : 'x') + ':' + (isFinite(step) ? step : 'x' + (fallback++))
    let day = ''
    try {
      day = beijingDay(Number(obj.time) || Date.now())
    } catch (err) {
      day = ''
    }
    entries.set(key, {
      cost: priced.cost,
      tokens: priced.tokens,
      turn: isFinite(turn) ? turn : 0,
      model,
      day,
      time: Number(obj.time) || 0,
    })
  }
}

/**
 * 增量读取一个会话日志并汇总消费。文件没变时直接复用缓存；
 * 只有新增的**完整帧**才会被解压解析，半帧留给下次。
 * @param file - 会话日志文件路径。
 * @returns { cost, tokens, steps, turns, models, days, turnCosts }，无法读取时 null。
 */
function sessionCostFromLog(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch (err) {
    return null
  }
  let cache = sessionCostCache.get(file)
  // 首次见到、或文件被重写变短（会话重塑/迁移）⇒ 全量重来
  if (!cache || st.size < cache.offset) {
    cache = { offset: 0, entries: new Map(), bad: { offset: -1, count: 0 } }
    sessionCostCache.delete(file)
    sessionCostCache.set(file, cache)
    while (sessionCostCache.size > SESSION_COST_CACHE_MAX) {
      const oldest = sessionCostCache.keys().next()
      if (oldest.done || oldest.value === file) break
      sessionCostCache.delete(oldest.value)
    }
  }
  if (st.size <= cache.offset) return sessionCostSummary(cache.entries)
  // Node 的 zstd 同步解压在 23.8 之前不存在；宿主不支持时前端不显示（而不是显示 0）
  if (typeof zlib.zstdDecompressSync !== 'function') return null
  // 只读上次之后的新增字节（offset 永远停在帧边界）⇒ 长会话每次轮询的 IO 也是恒定的 O(新增量)
  const tail = Buffer.alloc(st.size - cache.offset)
  try {
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, tail, 0, tail.length, cache.offset)
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    return sessionCostSummary(cache.entries)
  }
  const at = tail.indexOf(ZSTD_MAGIC)
  if (at === -1) return sessionCostSummary(cache.entries)
  const base = cache.offset + at // tail[0] 在文件里的绝对偏移（at 通常为 0，非 0 只是兜底对齐）
  const starts = []
  let scan = at
  while (scan !== -1) {
    starts.push(scan)
    scan = tail.indexOf(ZSTD_MAGIC, scan + 4)
  }
  starts.push(tail.length) // 末帧的临时终点（可能只写了一半）
  let consumed = base
  for (let i = 0; i < starts.length - 1; i++) {
    const frameStart = starts[i]
    const frameEnd = starts[i + 1]
    let frameText = null
    try {
      frameText = zlib.zstdDecompressSync(tail.subarray(frameStart, frameEnd)).toString('utf8')
    } catch (err) {
      frameText = null
    }
    if (frameText === null) {
      // 半帧（正在写入）或损坏：连续失败够多次才跳过，否则停在它前面等下次
      const absStart = base + frameStart
      if (cache.bad.offset === absStart) cache.bad.count += 1
      else {
        cache.bad.offset = absStart
        cache.bad.count = 1
      }
      if (cache.bad.count < SESSION_COST_FRAME_FAILS) break
      consumed = base + frameEnd
      continue
    }
    sessionCostFold(frameText, cache.entries)
    consumed = base + frameEnd
  }
  cache.offset = consumed
  return sessionCostSummary(cache.entries)
}

/**
 * 汇总累积表为展示用数字，并按模型 / 日期 / 轮次分组。
 * @param entries - sessionCostFold 写入的累积表。
 * @returns { cost, tokens, steps, turns, models, days, turnCosts }；
 *   models 按花费降序，days 按日期升序，turnCosts 按轮次升序（供每条回复下方显示本轮金额）。
 */
function sessionCostSummary(entries) {
  let cost = 0
  let tokens = 0
  let steps = 0
  const turns = new Set()
  const byModel = new Map()
  const byDay = new Map()
  const byTurn = new Map()
  const addRow = (map, key, e) => {
    const row = map.get(key) || { cost: 0, tokens: 0, steps: 0 }
    try {
      row.cost = addMoney(row.cost, e.cost)
    } catch (err) {
      row.cost += e.cost
    }
    row.tokens += e.tokens
    row.steps += 1
    map.set(key, row)
    return row
  }
  for (const e of entries.values()) {
    try {
      cost = addMoney(cost, e.cost)
    } catch (err) {
      cost += e.cost
    }
    tokens += e.tokens
    steps += 1
    turns.add(e.turn)
    // 未标注模型的（极少数历史条目）归到 '未知'，不让它悄悄漏掉
    const name = String(e.model || '').trim() || '未知'
    const row = addRow(byModel, name, e)
    row.model = name
    // 按北京时间的日期分桶（与峰谷计价的时区口径一致）
    const day = String(e.day || '').trim() || '未知'
    const dayRow = addRow(byDay, day, e)
    dayRow.day = day
    // 按轮次分桶：DSH 每条回复下方的动作栏带 data-turn-tail=<turn>，前端据此把金额贴到对应回复上
    const turnRow = addRow(byTurn, e.turn, e)
    turnRow.turn = e.turn
    turnRow.timeMs = Math.max(turnRow.timeMs || 0, Number(e.time) || 0)
  }
  const models = [...byModel.values()]
    .map((r) => ({ ...r, cost: preciseMoney(r.cost) }))
    .sort((a, b) => (b.cost - a.cost) || (b.tokens - a.tokens))
  const days = [...byDay.values()]
    .map((r) => ({ ...r, cost: preciseMoney(r.cost) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  const turnCosts = [...byTurn.values()]
    .map((r) => ({ ...r, cost: preciseMoney(r.cost), timeMs: r.timeMs || 0 }))
    .sort((a, b) => a.turn - b.turn)
  return { cost: preciseMoney(cost), tokens, steps, turns: turns.size, models, days, turnCosts }
}

// ===== 插件体 =====
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
}

/** 只接受本机（回环）来源的请求：伪造 Host 的跨站请求一律 403。 */
function isLocalRequest(req) {
  try {
    const host = String((req.headers && (req.headers.host || req.headers.HOST)) || '').toLowerCase()
    const hn = host.replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '')
    if (!hn) return false
    if (hn === 'localhost' || hn.endsWith('.localhost')) return true
    if (hn === '::1') return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hn)
    if (!m) return false
    return m[1] === '127'
  } catch (err) {
    return false
  }
}

// ===== 官方开放平台：余额 + 每日用量账本 =====
// 余额有两路来源（与官方/DSH 自己的口径一致，API key 优先）：
//   ① API key：GET https://api.deepseek.com/user/balance（Authorization: Bearer <key>）
//   ② DSH 账号登录态：deepseekAccount.getBalance()
// 「今日用量 / 近七日用量」按**官方余额的变化**统计：只把余额减少计入消费，充值（余额增加）不计负数。
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_LEDGER_CANDIDATES = [
  path.join(DSH_HOME, '.dsh-session-cost-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dsh-session-cost-usage.json'),
]
/** 迁移种子：小鲸鱼插件的历史账本。只在本插件账本还没有历史时导入一次，之后完全独立。 */
const LEGACY_LEDGER_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-usage.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-usage.json'),
]
const PLATFORM_SAMPLE_MS = 60 * 1000
const PLATFORM_REFRESH_MS = 20 * 1000
const PLATFORM_HISTORY_MAX = 60
const PLATFORM_PANEL_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

/** 从官方余额响应里挑出第一个有 total_balance 的钱包。 */
function pickBalanceInfo(list) {
  if (!Array.isArray(list)) return null
  for (const w of list) {
    if (w && Number.isFinite(Number(w.total_balance))) return w
  }
  return null
}

function emptyPlatformLedger() {
  return {
    version: 1,
    date: beijingDay(),
    lastBalance: null,
    todayUsage: 0,
    history: {},
    currency: 'CNY',
    source: null,
    updatedAt: 0,
  }
}

/** 读盘：字段缺失/类型不对时补默认值（不清空已有历史，坏文件不覆盖）。 */
function normalizePlatformLedger(raw) {
  const led = emptyPlatformLedger()
  if (raw && typeof raw === 'object') {
    if (typeof raw.date === 'string') led.date = raw.date
    const lb = Number(raw.lastBalance)
    led.lastBalance = Number.isFinite(lb) ? preciseMoney(lb) : null
    const tu = Number(raw.todayUsage)
    led.todayUsage = Number.isFinite(tu) && tu > 0 ? preciseMoney(tu) : 0
    if (raw.history && typeof raw.history === 'object') {
      for (const [day, amount] of Object.entries(raw.history)) {
        const n = Number(amount)
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(n) && n > 0) led.history[day] = preciseMoney(n)
      }
    }
    if (typeof raw.currency === 'string' && raw.currency) led.currency = raw.currency
    if (typeof raw.source === 'string') led.source = raw.source
    const ua = Number(raw.updatedAt)
    if (Number.isFinite(ua)) led.updatedAt = ua
    if (typeof raw.importedFrom === 'string') led.importedFrom = raw.importedFrom
  }
  return led
}

function readPlatformLedger() {
  for (const p of USAGE_LEDGER_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && typeof parsed === 'object') return { file: p, ledger: normalizePlatformLedger(parsed) }
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        // 解析失败：照旧返回空账本，但绝不覆盖原文件（写盘时也只写另一份候选路径）
      }
    }
  }
  return { file: USAGE_LEDGER_CANDIDATES[0], ledger: emptyPlatformLedger() }
}

function writePlatformLedger(file, ledger) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(ledger))
    fs.renameSync(tmp, file)
    return true
  } catch (err) {
    return false
  }
}

/** 新账本还没有历史时，从小鲸鱼账本导入一次（换插件不丢历史）。 */
function importLegacyHistory(ledger) {
  if (Object.keys(ledger.history).length > 0) return false
  for (const p of LEGACY_LEDGER_CANDIDATES) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
      const hist = raw && raw.history
      if (!hist || typeof hist !== 'object') continue
      let n = 0
      for (const [day, amount] of Object.entries(hist)) {
        const v = Number(amount)
        if (/^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(v) && v > 0) {
          ledger.history[day] = preciseMoney(v)
          n++
        }
      }
      if (n > 0) {
        ledger.importedFrom = 'dsh-whale-widget'
        ledger.todayUsage = preciseMoney(ledger.history[ledger.date] || 0)
        return true
      }
    } catch (err) {}
  }
  return false
}

function trimHistory(ledger) {
  const days = Object.keys(ledger.history).sort()
  while (days.length > PLATFORM_HISTORY_MAX) {
    delete ledger.history[days.shift()]
  }
}

/** 一次余额采样：跨天结转、只累计「余额减少」、写当日 history。 */
function platformSample(ledger, balance, atMs) {
  const day = beijingDay(atMs)
  if (ledger.date !== day) {
    if (ledger.date) ledger.history[ledger.date] = preciseMoney(ledger.todayUsage)
    ledger.date = day
    ledger.todayUsage = 0
    // 跨天后第一笔只当基准：否则会把「昨晚到今早」的余额差整段算进今天
    ledger.lastBalance = null
  }
  const b = preciseMoney(balance)
  if (ledger.lastBalance === null || ledger.lastBalance === undefined) {
    ledger.lastBalance = b
  } else {
    const diff = ledger.lastBalance - b
    if (diff > 0) ledger.todayUsage = preciseMoney(addMoney(ledger.todayUsage, diff))
    ledger.lastBalance = b
  }
  ledger.history[day] = preciseMoney(ledger.todayUsage)
  ledger.updatedAt = atMs
  trimHistory(ledger)
  return ledger
}

/** 取官方余额：API key 优先，其次 DSH 账号登录态；都不可用返回 null。 */
async function fetchPlatformBalance(ctx) {
  // ① API key 路（官方开放平台）
  let cred = null
  try {
    const credentials = ctx && typeof ctx.get === 'function' ? ctx.get('credentials') : null
    if (credentials && typeof credentials.resolve === 'function') cred = await credentials.resolve('DEEPSEEK_API_KEY')
  } catch (err) {
    cred = null
  }
  if (cred && cred.value) {
    try {
      const res = await fetch(BALANCE_URL, {
        headers: { Authorization: 'Bearer ' + cred.value },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const data = await res.json()
        const info = pickBalanceInfo(data && data.balance_infos)
        if (info) {
          return {
            totalBalance: Number(info.total_balance),
            currency: String(info.currency || 'CNY').toUpperCase(),
            source: 'apikey',
          }
        }
      }
    } catch (err) {}
  }
  // ② DSH 账号登录态（充值 + 赠金，与 API key 的 total_balance 同口径）
  try {
    const account = ctx && typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
    if (account && typeof account.getBalance === 'function') {
      const result = await account.getBalance({
        version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
        locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (result && result.status === 'ready' && Array.isArray(result.value) && result.value.length > 0) {
        const wallets = result.value.filter((w) => w && Number.isFinite(Number(w.balance)))
        if (wallets.length > 0) {
          const currency = wallets.some((w) => String(w.currency || '').toUpperCase() === 'CNY')
            ? 'CNY'
            : String((wallets[0] && wallets[0].currency) || 'CNY').toUpperCase()
          const sumOf = (list) => (Array.isArray(list) ? list : [])
            .filter((w) => w && String(w.currency || 'CNY').toUpperCase() === currency && Number.isFinite(Number(w.balance)))
            .reduce((s, w) => s + Number(w.balance), 0)
          return { totalBalance: sumOf(result.value) + sumOf(result.bonusWallets), currency, source: 'account' }
        }
      }
    }
  } catch (err) {}
  return null
}

// 进程内缓存：账本 + 上次尝试时间（余额拿不到时也要节流，避免每秒打网络）
let platformLedger = null
let platformFile = null
let platformLastAttempt = 0
let platformLastError = ''

async function refreshPlatformLedger(ctx, force) {
  const now = Date.now()
  const fresh = platformLedger !== null && now - platformLastAttempt < (force ? 5000 : PLATFORM_REFRESH_MS)
  if (fresh) return platformLedger
  platformLastAttempt = now
  if (platformLedger === null) {
    const read = readPlatformLedger()
    platformFile = read.file
    platformLedger = read.ledger
    if (importLegacyHistory(platformLedger)) writePlatformLedger(platformFile, platformLedger)
  }
  let snap = null
  try {
    snap = await fetchPlatformBalance(ctx)
  } catch (err) {
    snap = null
  }
  if (snap && Number.isFinite(snap.totalBalance)) {
    platformLedger.currency = snap.currency || platformLedger.currency
    platformLedger.source = snap.source
    platformSample(platformLedger, snap.totalBalance, now)
    writePlatformLedger(platformFile, platformLedger)
    platformLastError = ''
  } else if (!platformLastError) {
    platformLastError = '余额获取失败：既没有可用的 DEEPSEEK_API_KEY，DSH 账号余额也不可用'
  }
  return platformLedger
}

/** 下一次峰谷切换的时刻（毫秒）：从 atMs 起按分钟步进找状态翻转点，最多往后找 8 天（够覆盖长假）；
 *  纯粹为了顶部条提示「约 X 后切换」，找不到（理论上不会）返回 0。 */
function nextPeakSwitchMs(atMs) {
  const base = Number(atMs) || Date.now()
  const stepMs = 60000
  const nowPeak = isPeakTime(Math.floor(base / 1000))
  const limit = base + 8 * 24 * 60 * stepMs
  for (let t = base + stepMs; t <= limit; t += stepMs) {
    if (isPeakTime(Math.floor(t / 1000)) !== nowPeak) return t
  }
  return 0
}

/** 给前端的面板数据：近 7 天（含今天）升序补零。 */
function platformPayload(ledger) {
  const days = []
  const now = Date.now()
  for (let i = PLATFORM_PANEL_DAYS - 1; i >= 0; i--) {
    const day = beijingDay(now - i * DAY_MS)
    const v = Number(ledger.history[day])
    days.push({ day, cost: Number.isFinite(v) && v > 0 ? preciseMoney(v) : 0 })
  }
  return {
    ok: true,
    balance: ledger.lastBalance === null || ledger.lastBalance === undefined ? null : preciseMoney(ledger.lastBalance),
    currency: ledger.currency || 'CNY',
    source: ledger.source || null,
    todayUsage: preciseMoney(Number(ledger.todayUsage) || 0),
    // 峰谷状态与计价用的是同一套规则（isPeakTime）：前端只负责显示，不重复实现规则
    peak: isPeakTime(Math.floor(now / 1000)),
    peakUntilMs: nextPeakSwitchMs(now),
    days,
    knownDays: Object.keys(ledger.history).length,
    error: platformLastError || null,
    updatedAt: ledger.updatedAt || 0,
  }
}

export default {
  name: 'session-cost',
  apply(root) {
    // 等 webServer 就绪后再注册路由（只依赖这一个服务）
    root.inject(['webServer'], (ctx) => {
      const disposers = []
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-cost/session-cost.json',
        handler: (req, res) => {
          const send = (obj, code) => {
            res.writeHead(code || 200, JSON_HEADERS)
            res.end(JSON.stringify(obj))
          }
          if (!isLocalRequest(req)) return send({ ok: false, code: 'FORBIDDEN', error: '只接受本机请求' }, 403)
          let sessionId = ''
          try {
            sessionId = new URL(req.url || '/', 'http://localhost').searchParams.get('session') || ''
          } catch (err) {}
          // 自定义单价表可能有变动（10 秒节流），计价前先刷新一次
          try { refreshCustomPrices() } catch (err) {}
          try {
            const file = sessionLogFile(sessionId)
            if (!file) return send({ ok: false, code: 'NO_SESSION', error: '找不到该会话的日志' })
            const summary = sessionCostFromLog(file)
            if (!summary) return send({ ok: false, code: 'UNAVAILABLE', error: '当前运行时无法解压会话日志' })
            send({
              ok: true,
              session: sessionId,
              currency: 'CNY',
              cost: summary.cost,
              tokens: summary.tokens,
              steps: summary.steps,
              turns: summary.turns,
              models: summary.models,
              days: summary.days,
              turnCosts: summary.turnCosts,
              updatedAt: Date.now(),
            })
          } catch (err) {
            send({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
          }
        },
      }))
      // 官方开放平台：余额 + 今日用量 + 近七日每日用量
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-session-cost/platform.json',
        handler: async (req, res) => {
          const send = (obj, code) => {
            res.writeHead(code || 200, JSON_HEADERS)
            res.end(JSON.stringify(obj))
          }
          if (!isLocalRequest(req)) return send({ ok: false, code: 'FORBIDDEN', error: '只接受本机请求' }, 403)
          let force = false
          try {
            force = new URL(req.url || '/', 'http://localhost').searchParams.get('refresh') === '1'
          } catch (err) {}
          try {
            const ledger = await refreshPlatformLedger(ctx, force)
            send(platformPayload(ledger))
          } catch (err) {
            send({ ok: false, code: 'ERROR', error: String((err && err.message) || err).slice(0, 200) })
          }
        },
      }))
      // 后台采样：「今日用量」来自余额变化，采样越密越准（充值不会计成负数）
      const sampleTimer = setInterval(() => {
        refreshPlatformLedger(ctx, false).catch(() => {})
      }, PLATFORM_SAMPLE_MS)
      if (sampleTimer && typeof sampleTimer.unref === 'function') sampleTimer.unref()
      disposers.push(() => clearInterval(sampleTimer))
      ctx.effect(() => () => {
        for (const d of disposers) {
          try { d() } catch (err) {}
        }
      })
    })
  },
}
