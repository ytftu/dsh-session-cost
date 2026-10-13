// test_tooltip.mjs —— 自绘悬停小窗（原生 title 的替代品）的渲染、定位与滚动重定位
// 从 C:\Users\我\.dsh\plugins\dsh-session-cost\lib\client.js 里截取真身函数跑，DOM/window 用 stub。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')
const start = src.indexOf('    // ===== 自绘 tooltip')
const end = src.indexOf('    function sessionCostApply(text, tip) {')
if (start < 0 || end <= start) {
  console.error('未能从插件源码里截取 tooltip 段（起点/终点标记没找到）')
  process.exit(1)
}
const code = src.slice(start, end)

let pass = 0
let fail = 0
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  ' + extra : '')) }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class El {
  constructor(tag) {
    this.tag = tag
    this.style = {}
    this.children = []
    this.attrs = {}
    this.listeners = {}
    this.className = ''
    this.textContent = ''
    this._w = 200
    this._h = 60
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn) }
  get firstChild() { return this.children[0] || null }
  getBoundingClientRect() { return this._rect }
  get offsetWidth() { return this._w }
  get offsetHeight() { return this._h }
}

const head = new El('head')
const body = new El('body')
const fakeDocument = {
  head,
  body,
  documentElement: body,
  createElement: (t) => new El(t),
  querySelector: () => null,
  querySelectorAll: () => [],
}
const winHandlers = {}
const fakeWindow = {
  innerWidth: 1000,
  innerHeight: 800,
  addEventListener: (t, fn) => { (winHandlers[t] = winHandlers[t] || []).push(fn) },
}

const api = new Function('document', 'window',
  code + '\nreturn { tipSet, tipShow, tipPlace, tipHide, layer: function () { return tipEl } };'
)(fakeDocument, fakeWindow)

const btn = new El('button')
api.tipSet(btn, '第一行\n第二行\n第三行', 'top')
check('tipSet 把多行内容写进 data-dshsc-tip',
  btn.getAttribute('data-dshsc-tip') === '第一行\n第二行\n第三行', '实际=' + JSON.stringify(btn.getAttribute('data-dshsc-tip')))
check('tipSet 绑定了悬停/聚焦/mousemove 兜底',
  ['mouseenter', 'mouseleave', 'focus', 'blur', 'mousemove'].every((t) => Array.isArray(btn.listeners[t])))
check('tipSet 幂等（不重复绑定）', (function () {
  api.tipSet(btn, '第一行\n第二行\n第三行', 'top')
  return btn.listeners.mouseenter.length === 1
})())

btn._rect = { left: 400, top: 300, right: 500, bottom: 320, width: 100, height: 20 }
btn.listeners.mouseenter[0]()
const layer = api.layer()
check('tipShow 渲染出 3 行', layer.children.length === 3, '实际=' + layer.children.length)
check('首行带强调类', String(layer.children[0].className).indexOf('dshsc-tip-lead') >= 0)
const tipStyle = head.children.filter((c) => c.getAttribute('data-dshsc-css') === 'tip')[0]
check('小窗背景与会话面板一致（带背景模糊 backdrop-filter）',
  !!tipStyle && tipStyle.textContent.indexOf('backdrop-filter:var(--dsw-menu-backdrop-filter') >= 0)
check('小窗圆角与面板同级（--dsw-radius-lg）',
  !!tipStyle && tipStyle.textContent.indexOf('border-radius:var(--dsw-radius-lg') >= 0)
check('显示态 data-show=1', layer.getAttribute('data-show') === '1')
check('上方定位：top = 300-60-8，水平居中 = 450-100',
  layer.style.top === '232px' && layer.style.left === '350px',
  'top=' + layer.style.top + ' left=' + layer.style.left)

api.tipPlace(btn, 'bottom')
check('placement=bottom：top = 320+8', layer.style.top === '328px', 'top=' + layer.style.top)

btn._rect = { left: 400, top: 10, right: 500, bottom: 30, width: 100, height: 20 }
api.tipPlace(btn, 'top')
check('上方放不下时自动翻到下方', layer.style.top === '38px', 'top=' + layer.style.top)

btn._rect = { left: 0, top: 300, right: 100, bottom: 320, width: 100, height: 20 }
api.tipPlace(btn, 'top')
check('左侧收进视口（最小 12px）', layer.style.left === '12px', 'left=' + layer.style.left)

btn._rect = { left: 950, top: 300, right: 1050, bottom: 320, width: 100, height: 20 }
api.tipPlace(btn, 'top')
check('右侧收进视口（1000-12-200=788）', layer.style.left === '788px', 'left=' + layer.style.left)

btn._rect = { left: 400, top: 700, right: 500, bottom: 720, width: 100, height: 20 }
api.tipPlace(btn, 'bottom')
check('下方贴边但没溢出时保持原位（720+8=728，底 788 = 视口-12）', layer.style.top === '728px', 'top=' + layer.style.top)

btn._rect = { left: 400, top: 760, right: 500, bottom: 780, width: 100, height: 20 }
api.tipPlace(btn, 'bottom')
check('下方溢出时翻回上方（780+8 会超出 ⇒ 760-60-8=692）', layer.style.top === '692px', 'top=' + layer.style.top)

// 滚动：DSH 聊天区在流式输出时几乎每帧都在滚，绝不能一滚就藏起来 ⇒ 应跟着重定位
check('注册了 scroll/resize 重定位（而不是隐藏）',
  Array.isArray(winHandlers.scroll) && Array.isArray(winHandlers.resize))
btn._rect = { left: 400, top: 300, right: 500, bottom: 320, width: 100, height: 20 }
btn.listeners.mouseenter[0]()
check('滚动前处于显示态', layer.getAttribute('data-show') === '1')
btn._rect = { left: 200, top: 260, right: 300, bottom: 280, width: 100, height: 20 }
winHandlers.scroll.forEach((fn) => fn())
await sleep(140)
check('滚动后仍然显示（没有被 hide 掉）', layer.getAttribute('data-show') === '1')
check('滚动后按新位置重定位（200+50-100=150）', layer.style.left === '150px', 'left=' + layer.style.left)

btn.isConnected = false
winHandlers.scroll.forEach((fn) => fn())
await sleep(140)
check('宿主元素被移除后自动收起', layer.getAttribute('data-show') === '0')

btn.isConnected = true
api.tipHide()
check('tipHide 后回到隐藏态', layer.getAttribute('data-show') === '0')

console.log('')
console.log(fail === 0 ? `全部通过（${pass} 项）` : `${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
