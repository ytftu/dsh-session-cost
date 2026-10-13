// 离线回归：会话消费弹窗的定位（sessionCostPlacePanel）
// 只做一件事：把面板摆到触发按钮上方，并且**左边缘贴齐按钮左边缘**（官方统计弹窗同款），
// 右边放不下时收进视口内，上方放不下时翻到下方。
// 直接从插件源码里截取函数体运行，保证测的就是线上跑的那份实现。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 默认读同仓库的 lib/client.js；也可用 argv[2] 指定别的路径
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = process.argv[2] || path.join(HERE, '..', 'lib', 'client.js')
const src = fs.readFileSync(CLIENT, 'utf8')

const start = src.indexOf('function sessionCostPlacePanel()')
const end = src.indexOf('/** 用最近一次接口数据重建明细', start)
if (start < 0 || end < 0) {
  console.error('未能从插件源码里截取 sessionCostPlacePanel')
  process.exit(1)
}
const fnSrc = src.slice(start, end)
console.log('截取函数体字节数:', fnSrc.length)

let pass = 0
let fail = 0
const check = (name, got, want) => {
  const ok = got === want
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} => ${got}${ok ? '' : ' (期望 ' + want + ')'}`)
}

const makePanel = (w, h) => ({ parentNode: {}, style: {}, offsetWidth: w, offsetHeight: h })
const makeTrigger = (r) => ({ getBoundingClientRect: () => r })

// 函数体内部读取的是模块级变量（sessionCostPanelEl / sessionCostEl / window），
// 这里用一个包装函数把它们注进作用域，再调用真身。
const run = (panel, trigger, win) => {
  const wrapper = new Function(
    'panel', 'trigger', 'win',
    'var sessionCostPanelEl = panel; var sessionCostEl = trigger; var window = win;'
    + fnSrc + '\nsessionCostPlacePanel(); return panel'
  )
  return wrapper(panel, trigger, win)
}

// 场景 1：常规窗口（1400 宽），按钮 left=700 —— 面板左边缘应为 700
{
  const panel = makePanel(440, 160)
  run(panel, makeTrigger({ left: 700, top: 800, right: 820, bottom: 828, width: 120 }), { innerWidth: 1400, innerHeight: 900 })
  check('左对齐按钮左边缘', panel.style.left, '700px')
  check('摆到按钮上方（gap 8）', panel.style.top, String(Math.round(800 - 8 - 160)) + 'px')
}

// 场景 2：按钮靠右，左对齐会溢出 ⇒ 收回视口内（右边缘留 12px）
{
  const panel = makePanel(440, 160)
  run(panel, makeTrigger({ left: 1300, top: 800, right: 1420, bottom: 828, width: 120 }), { innerWidth: 1400, innerHeight: 900 })
  check('右侧溢出时收进视口', panel.style.left, '948px') // 1400 - 12 - 440
}

// 场景 3：按钮贴左边 ⇒ 至少留 12px 边距
{
  const panel = makePanel(440, 160)
  run(panel, makeTrigger({ left: 3, top: 800, right: 100, bottom: 828, width: 97 }), { innerWidth: 1400, innerHeight: 900 })
  check('左侧最小边距', panel.style.left, '12px')
}

// 场景 4：上方放不下 ⇒ 翻到按钮下方
{
  const panel = makePanel(440, 160)
  run(panel, makeTrigger({ left: 700, top: 40, right: 820, bottom: 68, width: 120 }), { innerWidth: 1400, innerHeight: 900 })
  check('上方放不下翻到下方', panel.style.top, String(68 + 8) + 'px')
  check('翻到下方后仍左对齐', panel.style.left, '700px')
}

// 场景 5：窄窗口（800 宽，面板 300 宽），按钮 left=500 —— 左对齐会略微溢出（500+300>788）
// ⇒ 收到视口内 488px；关键是**不是居中**（居中会是 500+60-150=410）
{
  const panel = makePanel(300, 200)
  run(panel, makeTrigger({ left: 500, top: 600, right: 620, bottom: 628, width: 120 }), { innerWidth: 800, innerHeight: 700 })
  check('窄窗口下左对齐（溢出时收进视口）', panel.style.left, '488px')
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
process.exit(fail ? 1 : 0)
