// 离线冒烟测试：用结构化 DOM stub 跑插件里真实的「本轮金额注入」代码，
// 验证：能否按 data-turn-tail 找到动作栏、金额是否插在官方用量按钮右侧、样式类是否沿用、幂等/自愈。
// 用法: node test_turn_cost.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认读同仓库的 lib/client.js；也可用 argv[2] 指定别的路径
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = process.argv[2] || path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')
const start = src.indexOf('function sessionCostUsageTrigger(tail)')
const end = src.indexOf('// React 重渲染会把注入节点挪走/删除')
if (start < 0 || end < 0) throw new Error('找不到每条回复金额的代码片段')
const code = src.slice(start, end)

class Node {
  constructor(tag) {
    this.tag = tag
    this.children = []
    this.parentNode = null
    this.attrs = {}
    this._text = ''
    this.className = ''
    this.title = ''
    this.style = {}
  }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null }
  appendChild(c) {
    if (c.parentNode) {
      const i = c.parentNode.children.indexOf(c)
      if (i >= 0) c.parentNode.children.splice(i, 1)
    }
    c.parentNode = this
    this.children.push(c)
    return c
  }
  insertBefore(c, ref) {
    // 真实 DOM 的语义：插入已存在的节点等于"移动"（先从旧位置摘除）
    if (c.parentNode) {
      const i = c.parentNode.children.indexOf(c)
      if (i >= 0) c.parentNode.children.splice(i, 1)
    }
    c.parentNode = this
    const i = ref ? this.children.indexOf(ref) : -1
    this.children.splice(i < 0 ? this.children.length : i, 0, c)
    return c
  }
  get nextSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.children.indexOf(this)
    return i >= 0 && i + 1 < this.parentNode.children.length ? this.parentNode.children[i + 1] : null
  }
  get previousElementSibling() {
    if (!this.parentNode) return null
    const i = this.parentNode.children.indexOf(this)
    return i > 0 ? this.parentNode.children[i - 1] : null
  }
  set textContent(v) { this._text = String(v) }
  get textContent() { return this._text }
  _all(out) { for (const c of this.children) { out.push(c); c._all(out) } return out }
  querySelectorAll(sel) {
    const all = this._all([])
    if (sel === 'button') return all.filter((n) => n.tag === 'button')
    const m = /^\[([^\]]+)\]$/.exec(sel)
    if (m) return all.filter((n) => n.getAttribute(m[1]) !== null)
    throw new Error('stub 不支持的选择器: ' + sel)
  }
  querySelector(sel) { const r = this.querySelectorAll(sel); return r.length ? r[0] : null }
  closest(sel) {
    const m = /^\[([^\]]+)\]$/.exec(sel)
    let n = this
    while (n) { if (m && n.getAttribute(m[1]) !== null) return n; n = n.parentNode }
    return null
  }
}

const doc = new Node('#document')
function makeActions(turn, usageText, actionClass, session) {
  const holder = new Node('div')
  holder.setAttribute('data-conversation-session', session)
  const tail = new Node('div')
  tail.setAttribute('data-turn-tail', String(turn))
  const actions = new Node('div')
  for (const label of ['copy', 'like', 'dislike', 'share']) {
    const b = new Node('button')
    b.textContent = label
    actions.appendChild(b)
  }
  const usageRoot = new Node('span')
  const usageBtn = new Node('button')
  usageBtn.setAttribute('aria-haspopup', 'dialog')
  usageBtn.className = actionClass
  usageBtn.textContent = usageText
  usageRoot.appendChild(usageBtn)
  actions.appendChild(usageRoot)
  const time = new Node('span')
  time.textContent = '03:17'
  actions.appendChild(time)
  tail.appendChild(actions)
  holder.appendChild(tail)
  doc.appendChild(holder)
  return { holder, tail, actions, usageRoot, usageBtn, time }
}

const fakeDocument = {
  querySelectorAll: (sel) => doc.querySelectorAll(sel),
  createElement: (tag) => new Node(tag),
}

const data = {
  turnCosts: [
    { turn: 1, cost: 0.68516184, steps: 94, tokens: 12121807 },
    { turn: 5, cost: 0.43957124, steps: 22, tokens: 5216828 },
    { turn: 8, cost: 0.19591128, steps: 18, tokens: 6167445 },
  ],
}
// tipSet 的真身定义在截取范围之外（在 sessionCostApply 之前），这里用行为等价的 stub
const tipSetStub = (el, text) => { if (text) el.setAttribute('data-dshsc-tip', String(text)) }
const api = new Function('document', 'sessionCostData', 'sessionCostSession', 'sessionCostDetailAmount', 'tipSet',
  code + '\nreturn { sessionCostMountTurnCosts };')(fakeDocument, data, 'session-abc', (n) => '¥ ' + Number(n).toFixed(4), tipSetStub)

const a1 = makeActions(1, '用量 12.1M tok', 'Rd79tq_trigger', 'session-abc')
const a5 = makeActions(5, 'Usage 5.2M tok', 'Rd79tq_trigger', 'session-abc')
const a99 = makeActions(99, '用量 1.0M tok', 'Rd79tq_trigger', 'session-abc') // 数据里没有这一轮
const other = makeActions(1, '用量 12.1M tok', 'Rd79tq_trigger', 'session-OTHER') // 别的会话

let failed = 0
function check(name, ok, detail) {
  console.log((ok ? '✅ ' : '❌ ') + name + (detail ? '  ' + detail : ''))
  if (!ok) failed++
}
const oursOf = (a) => a.actions.children.filter((n) => n.getAttribute('data-dshsc-turn-cost') !== null)

api.sessionCostMountTurnCosts()

for (const [a, wantTurn, wantText] of [[a1, '1', '¥ 0.6852'], [a5, '5', '¥ 0.4396']]) {
  const list = oursOf(a)
  const after = a.actions.children[a.actions.children.indexOf(a.usageRoot) + 1]
  check('turn ' + wantTurn + '：只注入 1 个节点', list.length === 1, '实际 ' + list.length)
  check('turn ' + wantTurn + '：插在用量按钮右边', !!after && after.getAttribute('data-dshsc-turn-cost') === wantTurn,
    '下一个节点=' + (after ? (after.getAttribute('data-dshsc-turn-cost') || after.textContent) : 'null'))
  check('turn ' + wantTurn + '：文本 ' + wantText, !!after && after.textContent === wantText, '实际=' + (after ? after.textContent : '-'))
  check('turn ' + wantTurn + '：沿用官方类名', !!after && after.className === 'Rd79tq_trigger', '实际=' + (after ? after.className : '-'))
  check('turn ' + wantTurn + '：box-sizing 与官方 button 对齐（高度一致）',
    !!after && after.style.boxSizing === 'border-box', '实际=' + (after ? after.style.boxSizing : '-'))
  check('turn ' + wantTurn + '：时间仍在金额右侧', a.actions.children.indexOf(a.time) === a.actions.children.indexOf(after) + 1)
  check('turn ' + wantTurn + '：tooltip 以「本轮消耗」开头',
    !!after && String(after.getAttribute('data-dshsc-tip') || '').indexOf('本轮消耗') === 0,
    '实际=' + (after ? String(after.getAttribute('data-dshsc-tip') || '') : '-'))
}
check('没有数据的轮次不注入', oursOf(a99).length === 0)
check('别的会话不注入', oursOf(other).length === 0)

// 幂等
const before = a1.actions.children.length
api.sessionCostMountTurnCosts()
check('重复调用不产生重复节点', a1.actions.children.length === before && oursOf(a1).length === 1,
  '子节点 ' + before + ' → ' + a1.actions.children.length + '，金额节点 ' + oursOf(a1).length)

// 自愈 1：React 把我们的节点删掉
const killed = oursOf(a1)[0]
a1.actions.children.splice(a1.actions.children.indexOf(killed), 1)
killed.parentNode = null
api.sessionCostMountTurnCosts()
check('被删掉后能重建', oursOf(a1).length === 1
  && a1.actions.children[a1.actions.children.indexOf(a1.usageRoot) + 1].getAttribute('data-dshsc-turn-cost') === '1')

// 自愈 2：顺序被重排（挪到最前面）
const moved = oursOf(a1)[0]
a1.actions.children.splice(a1.actions.children.indexOf(moved), 1)
a1.actions.children.unshift(moved)
api.sessionCostMountTurnCosts()
check('顺序错乱后能自动归位',
  a1.actions.children[a1.actions.children.indexOf(a1.usageRoot) + 1] === moved && oursOf(a1).length === 1)

console.log(failed ? '\n有 ' + failed + ' 项未通过' : '\n全部检查通过')
process.exit(failed ? 1 : 0)
