// 离线冒烟测试：用最小 DOM stub 跑插件里真实的折线图代码，检查结构/坐标是否合理。
// 用法: node test_chart.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认读同仓库的 lib/client.js；也可用 argv[2] 指定别的路径
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = process.argv[2] || path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')
const start = src.indexOf('/** 轮次轴标签：')
const end = src.indexOf('/** 面板样式只注入一次')
if (start < 0 || end < 0) throw new Error('找不到折线图代码片段')
const code = src.slice(start, end)

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.style = {}; this._text = '' }
  setAttribute(k, v) { this.attrs[k] = v }
  appendChild(c) { this.children.push(c); return c }
  set textContent(v) { this._text = String(v) }
  get textContent() { return this._text }
}
const fakeDoc = { createElementNS: (_ns, tag) => new El(tag) }
const api = new Function('document', code + '\nreturn { sessionCostBuildChart, sessionCostTurnLabel, sessionCostTurnTime, sessionCostAxisAmount };')(fakeDoc)

function flatten(el, out = []) { out.push(el); for (const c of el.children) flatten(c, out); return out }
function stats(svg) {
  const all = flatten(svg)
  const circles = all.filter((e) => e.tag === 'circle')
  const polyline = all.filter((e) => e.tag === 'polyline')[0]
  const polygon = all.filter((e) => e.tag === 'polygon')[0]
  const texts = all.filter((e) => e.tag === 'text')
  const W = Number(svg.attrs.viewBox.split(' ')[2])
  const H = Number(svg.attrs.viewBox.split(' ')[3])
  const pts = polyline ? polyline.attrs.points.split(' ').map((p) => p.split(',').map(Number)) : []
  return { circles, polyline, polygon, texts, W, H, pts, all }
}

const cases = [
  { name: '两轮', turns: [{ turn: 1, cost: 2.78, tokens: 25793238, steps: 149, timeMs: 1790880706536 }, { turn: 3, cost: 0.16, tokens: 5027206, steps: 16, timeMs: 1790882141864 }] },
  { name: '一轮', turns: [{ turn: 1, cost: 1.5, tokens: 100, steps: 3, timeMs: 1790882144033 }] },
  { name: '多轮(8)', turns: Array.from({ length: 8 }, (_, i) => ({ turn: i * 2 + 1, cost: i * 0.37, tokens: 1000 * i, steps: i, timeMs: 1790880706536 + i * 60000 })) },
  { name: '40 轮（点密）', turns: Array.from({ length: 40 }, (_, i) => ({ turn: i + 1, cost: 0.05 + (i % 7) * 0.11, tokens: 9000 * i, steps: i + 1, timeMs: 1790880706536 + i * 30000 })) },
  { name: '零消费', turns: [{ turn: 2, cost: 0, tokens: 0, steps: 0, timeMs: 0 }] },
]

let failed = 0
for (const c of cases) {
  const svg = api.sessionCostBuildChart(c.turns, 300)
  const s = stats(svg)
  const problems = []
  if (s.circles.length !== c.turns.length) problems.push('点数 ' + s.circles.length + ' ≠ 轮数 ' + c.turns.length)
  for (const p of s.pts) {
    if (!(p[0] >= 0 && p[0] <= s.W)) problems.push('x 越界 ' + p[0])
    if (!(p[1] >= 0 && p[1] <= s.H)) problems.push('y 越界 ' + p[1])
  }
  if (c.turns.length > 1 && !s.polyline) problems.push('缺 polyline')
  if (c.turns.length > 1 && !s.polygon) problems.push('缺面积 polygon')
  const yLabels = s.texts.filter((t) => t.textContent.indexOf('¥') === 0).map((t) => t.textContent)
  const turnLabels = s.texts.filter((t) => /^\d+$/.test(t.textContent)).map((t) => t.textContent)
  const axisTag = s.texts.filter((t) => t.textContent === '轮').length
  if (yLabels.length !== 3) problems.push('纵轴刻度数 ' + yLabels.length + ' ≠ 3')
  if (axisTag !== 1) problems.push('缺横轴「轮」标注')
  if (turnLabels.length > 8) problems.push('轮号标签过密 ' + turnLabels.length)
  // 悬停提示必须带该轮的轮号与时间
  const titles = s.circles.map((cc) => (cc.children[0] ? cc.children[0].textContent : ''))
  if (titles.some((x) => x.indexOf('轮：¥') === -1)) problems.push('悬停提示缺轮号')
  console.log((problems.length ? '❌ ' : '✅ ') + c.name
    + '：点=' + s.circles.length + ' 折线段=' + s.pts.length + ' 轮号标签=' + JSON.stringify(turnLabels)
    + ' 纵轴=' + JSON.stringify(yLabels)
    + (problems.length ? '  问题: ' + problems.join('; ') : ''))
  if (problems.length) failed++
  if (c.name === '两轮') console.log('     悬停示例: ' + titles.join(' | '))
}
console.log(failed ? '\n有 ' + failed + ' 个用例未通过' : '\n全部用例通过')
process.exit(failed ? 1 : 0)
