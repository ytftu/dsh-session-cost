/**
 * dsh-session-cost 浏览器半边 —— 三个界面元素：
 *   ① 输入框底栏、DSH 自带 token 消耗 pill 之后的「本会话 ¥ x」（点击弹明细）
 *   ② 明细小窗：按**每次对话（轮）**消费的折线图
 *   ③ 每条回复动作栏里、官方「用量 x tok」按钮右侧的「本轮金额」
 *
 * 数据来自宿主半边（读会话日志现算），本文件只负责取数、渲染与幂等地摆回 DOM。
 * 宿主解析、计价口径见 lib/index.js；金额接口：GET /dsh-session-cost/session-cost.json?session=<id>
 *
 * 与 dsh-whale-widget 无关：本插件自带全套逻辑，鲸鱼插件被禁用/卸载也不影响。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-cost',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;

    /** 消费数据接口（宿主半边提供，只读）。 */
    var SESSION_COST_URL = '/dsh-session-cost/session-cost.json';
    /** 官方开放平台（余额 / 今日用量 / 近七日）接口。 */
    var PLATFORM_URL = '/dsh-session-cost/platform.json';
    /** 面板里「进入官网」按钮打开的地址（开放平台的用量页）。 */
    var PLATFORM_PAGE = 'https://platform.deepseek.com/usage';
    /** 余额是秒级变化不大的数据：每 15 个 tick（15 秒）取一次。 */
    var PLATFORM_TICK = 15;
    /** 底栏金额 pill 节点。 */
    var sessionCostEl = null;
    /** 当前已取数的会话 id（切换会话时用它判断要不要丢弃旧数据）。 */
    var sessionCostSession = '';
    var sessionCostTipText = '';
    /** 轮询计时器：挂在 1 秒的 tick 上，每 2 次发一次请求。 */
    var sessionCostTick = 0;
    /** 面板与最近一次接口数据。 */
    var sessionCostPanelEl = null;
    var sessionCostOpen = false;
    var sessionCostData = null;
    var sessionCostPanelHandlers = null;
    /** 我们自己创建的资源（退出时清理）。 */
    var sessionCostObserver = null;
    var sessionCostTimer = null;
    var sessionCostMountTimer = null;
    /** 顶部条（余额 + 今日用量）与它的面板。 */
    var platformEl = null;
    var platformPanelEl = null;
    var platformOpen = false;
    var platformData = null;
    var platformTick = 0;
    var platformPanelHandlers = null;
    /** cordis 上下文（apply 时保存）：点「进入官网」时用它把网址交给侧栏浏览器。 */
    var dshCtx = null;
    /** WorkBuddy 连接插件的只读状态接口：同源相对路径，省得自己去猜宿主端口。 */
    var WB_STATUS_URL = '/plugins/dsh-workbuddy-connect/status';
    /** 底栏金额口径的存储键前缀：'money' 人民币（默认）| 'credits' WorkBuddy 积分。
     *  实际键是「前缀 + ':' + 会话 id」—— 每个会话各存一份、互不影响：
     *  没用 WorkBuddy 模型的会话不该被别的会话的选择带偏。 */
    var WB_MODE_KEY = 'dsh-session-cost:bottom-mode';
    /** 每个会话的积分消耗状态（localStorage，键后缀是会话 id）。 */
    var WB_STATE_PREFIX = 'dsh-session-cost:wb:';
    /** 积分采样间隔：挂在 1 秒 tick 上，每 60 次（约 1 分钟）取一次。
     *  取数会真实打 WorkBuddy 的计费接口，间隔不宜太短。 */
    var WB_TICK = 60;
    var wbTick = 0;
    /** 最近一次积分快照（null = WorkBuddy 插件不在或未登录）。 */
    var wbData = null;
    /** 本会话累计消耗的积分（差值累计）。 */
    var wbConsumed = 0;
    /** 底栏金额口径。 */
    var wbMode = 'money';

    /** 金额显示：不足 1 元给 4 位小数（小额会话不至于显示成 0.00），否则 2 位。 */
    function sessionCostAmountText(n) {
      var v = Number(n);
      if (!isFinite(v)) return '--';
      return '¥ ' + (v > 0 && v < 1 ? v.toFixed(4) : v.toFixed(2));
    }
    /** 明细里统一 4 位小数：分项相加正好等于总额，便于核对。 */
    function sessionCostDetailAmount(n) {
      var v = Number(n);
      if (!isFinite(v)) return '--';
      return '¥ ' + v.toFixed(4);
    }
    /** 沿用 DSH 同排 pill 的类名 ⇒ 字号/颜色/间距与 token 消耗 pill 完全一致（类名带哈希，不能写死）。 */
    function sessionCostPillClass(anchor) {
      try {
        var sample = anchor.querySelector('button') || anchor.querySelector('span');
        if (sample && typeof sample.className === 'string' && sample.className) return sample.className;
        if (typeof anchor.className === 'string' && anchor.className) return anchor.className;
      } catch (err) {}
      return '';
    }
    /** 定位 DSH 统计 pill 那一行（token 用量 / 用时）。页面上可能同时存在多个会话视图
     *（例如侧栏里的子会话），这里优先取"可见的最后一个"，即当前正在显示的那个。 */
    function sessionCostAnchor() {
      try {
        var list = document.querySelectorAll('[data-composer-stats]');
        for (var i = list.length - 1; i >= 0; i--) {
          var el = list[i];
          if (el.getClientRects().length > 0) return el;
        }
        return list.length ? list[0] : null;
      } catch (err) { return null; }
    }
    /** 把节点摆到统计行的下一个位置；统计行不在（空会话）时收起自己并返回 null。 */
    function sessionCostMount() {
      try {
        // 快速路径：节点还在原位（前一个兄弟就是统计行）⇒ 只做一次属性判断，不触发强制布局。
        // 流式输出时 DOM 每秒变很多次，这条路径决定了这个功能的常驻开销可以忽略。
        if (sessionCostEl && sessionCostEl.parentNode && sessionCostEl.previousElementSibling
          && sessionCostEl.previousElementSibling.isConnected !== false
          && sessionCostEl.previousElementSibling.getAttribute('data-composer-stats') !== null) {
          return sessionCostEl;
        }
        var anchor = sessionCostAnchor();
        if (!anchor || !anchor.parentNode) {
          sessionCostClosePanel(); // 统计行都不在了（换会话/离开主界面）⇒ 明细小窗也收掉
          if (sessionCostEl && sessionCostEl.parentNode) sessionCostEl.parentNode.removeChild(sessionCostEl);
          return null;
        }
        if (!sessionCostEl) {
          // 用 button 而不是 span：跟官方统计 pill 一样可聚焦、可点击、有 hover 反馈，
          // 类名沿用官方 pill ⇒ 交互观感完全一致。
          sessionCostEl = document.createElement('button');
          sessionCostEl.type = 'button';
          sessionCostEl.setAttribute('data-dshsc-session-cost', '1');
          sessionCostEl.setAttribute('aria-haspopup', 'dialog');
          sessionCostEl.setAttribute('aria-expanded', 'false');
          // 我们的节点是官方统计行（.iq1doa_root）的兄弟，继承不到它那行 calc() 字号/行高，
          // 这里按官方 CSS 逐字对齐，保证和左边的 token/用时 pill 完全一致。
          sessionCostEl.style.fontSize = 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)';
          sessionCostEl.style.lineHeight = 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))';
          sessionCostEl.style.display = 'none'; // 拿到金额前不占位
          sessionCostEl.addEventListener('click', function (e) {
            try {
              e.preventDefault();
              sessionCostTogglePanel();
            } catch (err) {}
          });
        }
        if (!sessionCostEl.className) sessionCostEl.className = sessionCostPillClass(anchor);
        if (sessionCostEl.parentNode !== anchor.parentNode || sessionCostEl.previousElementSibling !== anchor) {
          anchor.parentNode.insertBefore(sessionCostEl, anchor.nextSibling);
        }
        return sessionCostEl;
      } catch (err) { return null; }
    }
    // ===== 自绘 tooltip（原生 title 的系统样式与深色界面不搭） =====
    var tipEl = null;
    var tipBound = false;
    var tipHost = null;
    var tipReflowTimer = null;
    var tipCssInjected = false;
    /** tooltip 样式只注入一次；配色/圆角/阴影对齐官方浮层。 */
    function tipEnsureCss() {
      try {
        if (tipCssInjected || document.querySelector('style[data-dshsc-css="tip"]')) { tipCssInjected = true; return; }
        var style = document.createElement('style');
        style.setAttribute('data-dshsc-css', 'tip');
        style.textContent = '.dshsc-tip{position:fixed;left:0;top:0;z-index:1200;pointer-events:none;'
          + 'max-width:min(360px,100vw - 24px);padding:8px 12px;box-sizing:border-box;'
          // 背景与会话消费面板（.dshsc-cost-panel）完全一致：同一套菜单底色 + 同一套背景模糊
          + 'border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-specific-menu,rgba(40,42,48,.98));'
          + 'backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));'
          + '-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px) saturate(1.4));'
          + 'box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.35));'
          + 'color:var(--dsw-alias-label-secondary,#9aa0aa);font-size:12px;line-height:18px;'
          + 'opacity:0;transition:opacity .12s ease}'
          + '.dshsc-tip[data-show="1"]{opacity:1}'
          + '.dshsc-tip-line{white-space:nowrap}'
          + '.dshsc-tip-lead{color:var(--dsw-alias-label-primary,#e6e8eb);font-weight:500}';
        (document.head || document.documentElement).appendChild(style);
        tipCssInjected = true;
      } catch (err) {}
    }
    /** 贴到元素旁边：默认上方（底栏用），placement='bottom' 显示在下方（顶部条用）。 */
    function tipPlace(el, placement) {
      try {
        var r = el.getBoundingClientRect();
        var w = tipEl.offsetWidth;
        var h = tipEl.offsetHeight;
        var margin = 12;
        var gap = 8;
        var left = Math.round(r.left + r.width / 2 - w / 2);
        left = Math.max(margin, Math.min(left, window.innerWidth - margin - w));
        var top = placement === 'bottom' ? r.bottom + gap : r.top - h - gap;
        if (top < margin) top = r.bottom + gap; // 上方放不下 ⇒ 翻到下方
        if (top + h > window.innerHeight - margin) top = Math.max(margin, r.top - h - gap);
        tipEl.style.left = left + 'px';
        tipEl.style.top = Math.round(top) + 'px';
      } catch (err) {}
    }
    function tipHide() {
      try {
        tipHost = null;
        if (tipEl) tipEl.setAttribute('data-show', '0');
      } catch (err) {}
    }
    /** 页面滚动时重新贴合宿主（DSH 聊天区在流式输出时几乎每帧都在滚，
     *  直接 hide 会让 tooltip 刚出现就消失 ⇒ 这里改成跟着重定位）。 */
    function tipReflow() {
      try {
        if (!tipHost || !tipEl) return;
        if (tipHost.isConnected === false) { tipHide(); return; }
        if (tipEl.getAttribute('data-show') !== '1') return;
        tipPlace(tipHost, tipHost.__dshscTipPlacement);
      } catch (err) {}
    }
    function tipOnReflow() {
      if (tipReflowTimer !== null) return;
      tipReflowTimer = setTimeout(function () { tipReflowTimer = null; tipReflow(); }, 60);
    }
    function tipShow(el, placement) {
      try {
        var text = el && el.getAttribute ? el.getAttribute('data-dshsc-tip') : '';
        if (!text) return;
        tipEnsureCss();
        if (!tipEl) {
          tipEl = document.createElement('div');
          tipEl.className = 'dshsc-tip';
          tipEl.setAttribute('data-dshsc-tip-layer', '1');
          (document.body || document.documentElement).appendChild(tipEl);
        }
        if (!tipBound) {
          tipBound = true;
          window.addEventListener('scroll', tipOnReflow, true);
          window.addEventListener('resize', tipOnReflow);
        }
        tipHost = el;
        var lines = String(text).split('\n');
        while (tipEl.firstChild) tipEl.removeChild(tipEl.firstChild);
        for (var i = 0; i < lines.length; i++) {
          var line = document.createElement('div');
          line.className = 'dshsc-tip-line' + (i === 0 ? ' dshsc-tip-lead' : '');
          line.textContent = lines[i];
          tipEl.appendChild(line);
        }
        tipEl.setAttribute('data-show', '1');
        tipPlace(el, placement);
      } catch (err) {}
    }
    /** 给元素挂 tooltip：内容写进 data-dshsc-tip（多行用换行符），悬停/聚焦时显示。 */
    function tipSet(el, text, placement) {
      try {
        if (!el) return;
        if (text) el.setAttribute('data-dshsc-tip', String(text));
        else el.removeAttribute('data-dshsc-tip');
        if (!el.__dshscTipBound && el.addEventListener) {
          el.__dshscTipBound = true;
          el.__dshscTipPlacement = placement;
          el.addEventListener('mouseenter', function () { tipShow(el, placement); });
          // mousemove 兜底：合成指针移动时 mouseenter 有可能被跳过，这里补一手
          el.addEventListener('mousemove', function () { if (tipHost !== el) tipShow(el, placement); });
          el.addEventListener('mouseleave', tipHide);
          el.addEventListener('focus', function () { tipShow(el, placement); });
          el.addEventListener('blur', tipHide);
        }
      } catch (err) {}
    }
    function sessionCostApply(text, tip) {
      try {
        var el = sessionCostMount();
        if (!el) return;
        if (!text) {
          el.style.display = 'none';
          if (el.textContent) el.textContent = '';
          return;
        }
        if (el.textContent !== text) el.textContent = text;
        el.style.display = '';
        if (tip && tip !== sessionCostTipText) {
          sessionCostTipText = tip;
          tipSet(el, tip, 'top');
        }
      } catch (err) {}
    }
    // ===== 底栏金额口径：人民币 / WorkBuddy 积分 =====
    /** 本地存储里每个会话一条积分状态，只留最近 30 个，免得越攒越多。 */
    function wbPruneStates() {
      try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(WB_STATE_PREFIX) === 0) keys.push(k);
        }
        if (keys.length <= 30) return;
        var rows = [];
        for (var j = 0; j < keys.length; j++) {
          var t = 0;
          try { t = Number(JSON.parse(localStorage.getItem(keys[j]) || '{}').updatedAt) || 0; } catch (err) {}
          rows.push({ k: keys[j], t: t });
        }
        rows.sort(function (a, b) { return b.t - a.t; });
        for (var m = 30; m < rows.length; m++) localStorage.removeItem(rows[m].k);
      } catch (err) {}
    }
    /** 某个会话的口径存储键。 */
    function wbModeKeyFor(sid) {
      return WB_MODE_KEY + ':' + String(sid || '');
    }
    /** 读取该会话的底栏口径（没存过就是人民币）。 */
    function wbLoadMode(sid) {
      try {
        var v = localStorage.getItem(wbModeKeyFor(sid));
        wbMode = (v === 'credits' || v === 'money') ? v : 'money';
      } catch (err) { wbMode = 'money'; }
      return wbMode;
    }
    /** 保存该会话的底栏口径（只影响这个会话）。 */
    function wbSaveMode(sid, v) {
      wbMode = v === 'credits' ? 'credits' : 'money';
      try { localStorage.setItem(wbModeKeyFor(sid), wbMode); } catch (err) {}
      return wbMode;
    }
    /** 套餐包的唯一键：套餐名 + 到期时间（同名包可能有多期）。 */
    function wbAccountKey(a) {
      return String((a && a.packageName) || '') + '@' + String((a && a.endTimeMs) || 0);
    }
    /** 把计费接口的 credits 拍平成快照：只留算差值需要的字段。 */
    function wbSnapshot(credits) {
      var src = credits && Array.isArray(credits.accounts) ? credits.accounts : [];
      var accounts = [];
      for (var i = 0; i < src.length; i++) {
        var a = src[i] || {};
        accounts.push({
          k: wbAccountKey(a),
          remain: Number(a.remain) || 0,
          end: Number(a.endTimeMs) || 0,
        });
      }
      return { t: Date.now(), total: Number(credits && credits.total) || 0, accounts: accounts };
    }
    /** 两次采样之间的净消耗。
     *  直接用「上次剩余 − 本次剩余」会把新发放的积分和到期作废的积分都算成消耗，
     *  所以按套餐包逐个对账：新出现的包加回来，消失的包扣掉。 */
    function wbConsumeDelta(prev, now) {
      if (!prev || !now) return 0;
      var prevMap = {};
      var nowMap = {};
      var i;
      for (i = 0; i < prev.accounts.length; i++) prevMap[prev.accounts[i].k] = (prevMap[prev.accounts[i].k] || 0) + prev.accounts[i].remain;
      for (i = 0; i < now.accounts.length; i++) nowMap[now.accounts[i].k] = (nowMap[now.accounts[i].k] || 0) + now.accounts[i].remain;
      var added = 0;
      var expired = 0;
      var k;
      for (k in nowMap) if (!(k in prevMap)) added += nowMap[k];
      for (k in prevMap) if (!(k in nowMap)) expired += prevMap[k];
      return prev.total - now.total + added - expired;
    }
    /** 积分显示：整数不带小数点，非整数留 1 位。 */
    function wbCreditsText(n) {
      var v = Number(n);
      if (!isFinite(v)) return '--';
      if (Math.abs(v - Math.round(v)) < 0.05) return String(Math.round(v));
      return v.toFixed(1);
    }
    /** 本会话的积分状态（localStorage 按会话 id 存，换会话各自独立）。 */
    function wbStateFor(sid) {
      var key = WB_STATE_PREFIX + sid;
      var st = null;
      try { st = JSON.parse(localStorage.getItem(key) || 'null'); } catch (err) {}
      if (!st || typeof st !== 'object') st = { last: null, consumed: 0, updatedAt: 0 };
      return { key: key, state: st };
    }
    /** 拿到一次积分快照：与上次对账后把消耗累计到本会话。 */
    function wbApplyCredits(snap) {
      wbData = snap;
      var sid = sessionCostSession;
      if (!sid) { wbRefreshBottom(); return; }
      var box = wbStateFor(sid);
      var st = box.state;
      if (st.last) {
        var d = wbConsumeDelta(st.last, snap);
        // 差值算法已排除赠分与到期；仍为负说明有未识别的账变（例如周期重置），不计入
        if (d > 0) st.consumed = (Number(st.consumed) || 0) + d;
      }
      st.last = snap;
      st.updatedAt = Date.now();
      try { localStorage.setItem(box.key, JSON.stringify(st)); } catch (err) {}
      wbConsumed = Number(st.consumed) || 0;
      wbRefreshBottom();
    }
    /** 取一次 WorkBuddy 积分（约 1 分钟一次；插件不在或未登录时静默）。 */
    function pollWorkBuddy(force) {
      try {
        wbTick += 1;
        if (!force && wbTick % WB_TICK !== 0) return;
        fetch(WB_STATUS_URL, { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (!d || d.status !== 'signed-in' || !d.credits) { wbData = null; wbRefreshBottom(); return; }
            wbApplyCredits(wbSnapshot(d.credits));
          })
          .catch(function () { wbData = null; });
      } catch (err) {}
    }
    /** 底栏文案（按当前口径给文本 + 悬停说明）；cost 为 null 表示本会话还没算出金额。 */
    function sessionCostBottomText(cost) {
      if (wbMode === 'credits') {
        if (!wbData) {
          return {
            text: '本会话 -- 积分',
            tip: 'WorkBuddy 积分：没读到账号积分\n'
              + '需要安装并登录 dsh-workbuddy-connect；账号积分是账号级数据，只作估算',
          };
        }
        return {
          text: '本会话 ' + wbCreditsText(wbConsumed) + ' 积分',
          tip: '本会话累计消耗 ' + wbCreditsText(wbConsumed) + ' 积分\n'
            + '按 WorkBuddy 账号积分的减少量估算（已排除赠分与到期作废）\n'
            + '当前账号剩余 ' + wbCreditsText(wbData.total) + ' 积分\n'
            + '同账号其它客户端的消耗也会计入，约每分钟刷新一次',
        };
      }
      if (cost === null) return null;
      var d = sessionCostData || {};
      return {
        text: '本会话 ' + sessionCostAmountText(cost),
        tip: '本会话累计消费 ' + sessionCostAmountText(cost) + '\n'
          + '按会话日志逐轮 × 官方单价估算（含本插件加载前的历史轮次）\n'
          + '共 ' + (Number(d.turns) || 0) + ' 轮 · ' + (Number(d.tokens) || 0) + ' tokens\n'
          + '点击查看每轮消费曲线',
      };
    }
    /** 按当前口径刷新底栏（数据没到就收起）。 */
    function wbRefreshBottom() {
      try {
        var d = sessionCostData;
        var cost = d && isFinite(Number(d.cost)) ? Number(d.cost) : null;
        var t = sessionCostBottomText(cost);
        if (!t) { sessionCostApply('', ''); return; }
        sessionCostApply(t.text, t.tip);
      } catch (err) {}
    }

    /** 取一次当前会话的消费数据；force=true 时不受"每 2 秒一次"的节流限制。 */
    function pollSessionCost(force) {
      try {
        sessionCostTick += 1;
        if (!force && sessionCostTick % 2 !== 0) return;
        var el = sessionCostMount();
        if (!el) return;
        var holder = el.parentNode && el.parentNode.closest ? el.parentNode.closest('[data-conversation-session]') : null;
        var sid = holder ? String(holder.getAttribute('data-conversation-session') || '') : '';
        if (!sid) { sessionCostApply('', ''); return; }
        if (sid !== sessionCostSession) {
          sessionCostSession = sid;
          sessionCostData = null; // 换会话先丢掉上一个会话的明细
          sessionCostClosePanel(); // 明细小窗跟着会话走，不能停在上一个会话的数字上
          sessionCostApply('', ''); // 换会话先收起，避免短暂显示上一个会话的金额
          // 积分消耗按会话各记各的：换回来时把该会话自己的累计读回来
          try { wbConsumed = Number(wbStateFor(sid).state.consumed) || 0; } catch (err) { wbConsumed = 0; }
          // 底栏口径也按会话各记各的：切到没设过的会话自动回到人民币
          try { wbLoadMode(sid); } catch (err) { wbMode = 'money'; }
        }
        fetch(SESSION_COST_URL + '?session=' + encodeURIComponent(sid), { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok || sessionCostSession !== sid) return;
            sessionCostData = d;
            // 文案按当前口径给（人民币 / 积分）：没数据时它自己收起
            wbRefreshBottom();
            // 面板开着的时候，后台刷新到的数据要立刻反映到图里
            if (sessionCostOpen) sessionCostRenderPanel();
            // 每条回复右侧的本轮金额也跟着刷新（新的轮次/金额一到位就贴上）
            try { sessionCostMountTurnCosts(); } catch (err) {}
          })
          .catch(function () {});
      } catch (err) {}
    }

    // ===== 明细小窗 =====
    /** 轮次轴标签：轮号可能不连续（被中止、没有用量的轮次不会进数据），直接显示真实轮号更诚实。 */
    function sessionCostTurnLabel(turn) {
      var n = Number(turn);
      return isFinite(n) ? String(n) : '?';
    }
    /** 悬停里附带的轮次时间：'10-02 03:25'；没有时间戳时返回空串。 */
    function sessionCostTurnTime(timeMs) {
      var t = Number(timeMs);
      if (!isFinite(t) || t <= 0) return '';
      try {
        var d = new Date(t);
        var p = function (v) { return (v < 10 ? '0' : '') + v; };
        return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
      } catch (err) { return ''; }
    }
    /** 纵轴金额刻度：小额多给几位，免得一列都是 0.00。 */
    function sessionCostAxisAmount(n) {
      var v = Number(n);
      if (!isFinite(v) || v === 0) return '0';
      if (v < 0.01) return v.toFixed(4);
      if (v < 1) return v.toFixed(3);
      return v.toFixed(2);
    }
    /** 按轮次（每次对话）消费折线图（纯 SVG，不引第三方库）。
     *  宽度按面板实测像素传入并写进 viewBox ⇒ 坐标 1:1，文字不会被缩放拉伸。 */
    function sessionCostBuildChart(turns, width) {
      var ns = 'http://www.w3.org/2000/svg';
      var W = Math.max(200, Math.round(width || 268));
      var H = 132;
      var padLeft = 44;
      var padRight = 10;
      var padTop = 12;
      var padBottom = 22;
      var plotW = Math.max(1, W - padLeft - padRight);
      var plotH = Math.max(1, H - padTop - padBottom);
      var brand = 'var(--dsw-alias-brand-primary, #4D6BFE)';
      var gridColor = 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))';
      var textColor = 'var(--dsw-alias-label-tertiary, #8a8f98)';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '每轮对话消费折线图');
      svg.style.display = 'block';

      var list = (turns || []).filter(function (d) { return d && isFinite(Number(d.cost)); });
      var max = 0;
      for (var i = 0; i < list.length; i++) max = Math.max(max, Number(list[i].cost) || 0);
      var yMax = max > 0 ? max * 1.15 : 1; // 顶部留 15% 余量，最高点不贴边

      function px(idx) {
        if (list.length <= 1) return padLeft + plotW / 2;
        return padLeft + (idx * plotW) / (list.length - 1);
      }
      function py(v) {
        return padTop + plotH - (Math.max(0, Number(v) || 0) / yMax) * plotH;
      }

      // 三条横向网格线（0 / 一半 / 最高）+ 左侧金额刻度
      var ticks = [0, max / 2, max];
      for (var t = 0; t < ticks.length; t++) {
        var y = py(ticks[t]);
        var line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(padLeft));
        line.setAttribute('x2', String(padLeft + plotW));
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('stroke', gridColor);
        line.setAttribute('stroke-width', '1');
        if (t > 0) line.setAttribute('stroke-dasharray', '3 4');
        svg.appendChild(line);
        var lab = document.createElementNS(ns, 'text');
        lab.setAttribute('x', String(padLeft - 6));
        lab.setAttribute('y', String(y + 3.5));
        lab.setAttribute('text-anchor', 'end');
        lab.setAttribute('font-size', '10');
        lab.setAttribute('fill', textColor);
        lab.textContent = '¥' + sessionCostAxisAmount(ticks[t]);
        svg.appendChild(lab);
      }

      if (list.length) {
        var pts = [];
        for (var p = 0; p < list.length; p++) pts.push(px(p) + ',' + py(list[p].cost));
        if (list.length > 1) {
          var area = document.createElementNS(ns, 'polygon');
          area.setAttribute('points', padLeft + ',' + py(0) + ' ' + pts.join(' ') + ' ' + (padLeft + plotW) + ',' + py(0));
          area.setAttribute('fill', brand);
          area.setAttribute('opacity', '0.12');
          svg.appendChild(area);
          var poly = document.createElementNS(ns, 'polyline');
          poly.setAttribute('points', pts.join(' '));
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', brand);
          poly.setAttribute('stroke-width', '1.6');
          poly.setAttribute('stroke-linejoin', 'round');
          poly.setAttribute('stroke-linecap', 'round');
          svg.appendChild(poly);
        }
        // 左下角标一下横轴是什么（纵轴已有 ¥ 刻度）
        var axisTag = document.createElementNS(ns, 'text');
        axisTag.setAttribute('x', '4');
        axisTag.setAttribute('y', String(H - 6));
        axisTag.setAttribute('font-size', '10');
        axisTag.setAttribute('fill', textColor);
        axisTag.textContent = '轮';
        svg.appendChild(axisTag);
        // 数据点（悬停显示该轮金额/步数/token/时间）+ 底部轮号标签（点多时隔一个显示，避免挤在一起）
        // 轮次多的时候点会重叠，半径跟着收小
        var dotR = list.length > 30 ? 1.4 : (list.length > 12 ? 2 : 2.6);
        var step = list.length > 6 ? Math.ceil(list.length / 6) : 1;
        // 轮号标签：先按 step 挑候选，再按像素间距过滤。
        // 轮号本身不连续（中止或无用量的轮次不进数据），末尾两轮常常挨得极近（例如 14、15），
        // 只按 step 抽稀会出现叠字，所以这里按估算的标签宽度做一次碰撞检测；
        // 挤在一起时优先保留第一个和**最后一个**轮号（末尾那轮读者最关心）。
        var showLabel = {};
        (function () {
          var wanted = [];
          for (var s = 0; s < list.length; s += step) wanted.push(s);
          if (wanted[wanted.length - 1] !== list.length - 1) wanted.push(list.length - 1);
          var kept = [];
          var prevRight = -1e9;
          for (var w = 0; w < wanted.length; w++) {
            var idx = wanted[w];
            var label = String(sessionCostTurnLabel(list[idx].turn));
            var width = label.length * 5.8; // 10px 字号下数字约 5.8px 宽
            var left = idx === 0 ? px(idx) : (idx === list.length - 1 ? px(idx) - width : px(idx) - width / 2);
            if (left < prevRight + 4) {
              if (idx !== list.length - 1 || kept.length < 2) continue;
              kept.pop(); // 撤掉前一个中段标签，给末尾轮号让位
              prevRight = kept.length ? kept[kept.length - 1].right : -1e9;
              if (left < prevRight + 4) continue;
            }
            kept.push({ idx: idx, right: left + width });
            prevRight = left + width;
          }
          for (var k = 0; k < kept.length; k++) showLabel[kept[k].idx] = true;
        })();
        for (var q = 0; q < list.length; q++) {
          var d = list[q];
          var cx = px(q);
          var cy = py(d.cost);
          var dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', String(cx));
          dot.setAttribute('cy', String(cy));
          dot.setAttribute('r', String(dotR));
          dot.setAttribute('fill', brand);
          var when = sessionCostTurnTime(d.timeMs);
          var tip = document.createElementNS(ns, 'title');
          tip.textContent = '第 ' + sessionCostTurnLabel(d.turn) + ' 轮：¥' + Number(d.cost).toFixed(4)
            + '（' + (Number(d.steps) || 0) + ' 步 · ' + (Number(d.tokens) || 0) + ' tokens'
            + (when ? ' · ' + when : '') + '）';
          dot.appendChild(tip);
          svg.appendChild(dot);
          if (showLabel[q]) {
            var dl = document.createElementNS(ns, 'text');
            dl.setAttribute('x', String(cx));
            dl.setAttribute('y', String(H - 6));
            dl.setAttribute('font-size', '10');
            dl.setAttribute('fill', textColor);
            dl.setAttribute('text-anchor', q === 0 ? 'start' : (q === list.length - 1 ? 'end' : 'middle'));
            dl.textContent = sessionCostTurnLabel(d.turn);
            svg.appendChild(dl);
          }
        }
      }
      return svg;
    }
    /** 面板样式只注入一次；数值与官方面板一一对应（换肤/字体缩放的 CSS 变量也共用）。 */
    function sessionCostEnsurePanelCss() {
      try {
        if (document.querySelector('style[data-dshsc-css="session-cost"]')) return;
        var style = document.createElement('style');
        style.setAttribute('data-dshsc-css', 'session-cost');
        style.textContent = [
          '.dshsc-cost-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}',
          '.dshsc-cost-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex}',
          '.dshsc-cost-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}',
          '.dshsc-cost-title-value{font-variant-numeric:tabular-nums}',
          '.dshsc-cost-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}',
          '.dshsc-cost-title-label svg{flex:none;width:14px;height:14px}',
          '.dshsc-cost-chart{margin-top:2px}',
          '.dshsc-cost-empty{color:var(--dsw-alias-label-tertiary)}',
          '.dshsc-cost-mode{margin-top:10px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);cursor:pointer;user-select:none}',
          '.dshsc-cost-mode:hover{color:var(--dsw-alias-label-primary)}'
        ].join('');
        document.head.appendChild(style);
      } catch (err) {}
    }
    /** 标题左侧的小图标（¥ 圆环），尺寸与官方标题图标一致（14px，currentColor）。 */
    function sessionCostIcon() {
      try {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        var circle = document.createElementNS(ns, 'circle');
        circle.setAttribute('cx', '8');
        circle.setAttribute('cy', '8');
        circle.setAttribute('r', '6.4');
        circle.setAttribute('fill', 'none');
        circle.setAttribute('stroke', 'currentColor');
        circle.setAttribute('stroke-width', '1.3');
        svg.appendChild(circle);
        var text = document.createElementNS(ns, 'text');
        text.setAttribute('x', '8');
        text.setAttribute('y', '11.3');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '9');
        text.setAttribute('fill', 'currentColor');
        text.textContent = '¥';
        svg.appendChild(text);
        return svg;
      } catch (err) { return null; }
    }
    /** 把面板摆到触发器上方（与官方三个统计弹窗同款：side=top、gap=8、视口边距 12；放不下翻下方）。
     *  水平方向左对齐：面板左边缘贴齐触发按钮左边缘，只有右边放不下时才往左收进视口内。 */
    function sessionCostPlacePanel() {
      try {
        var panel = sessionCostPanelEl;
        var trigger = sessionCostEl;
        if (!panel || !trigger || !panel.parentNode) return;
        panel.style.visibility = 'hidden';
        panel.style.left = '0px';
        panel.style.top = '0px';
        var r = trigger.getBoundingClientRect();
        var pw = panel.offsetWidth;
        var ph = panel.offsetHeight;
        var margin = 12;
        var gap = 8;
        var left = r.left;
        var maxLeft = Math.max(margin, window.innerWidth - margin - pw);
        if (left > maxLeft) left = maxLeft;
        if (left < margin) left = margin;
        var top = r.top - gap - ph;
        if (top < margin) top = Math.min(r.bottom + gap, Math.max(margin, window.innerHeight - margin - ph));
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        panel.style.visibility = '';
      } catch (err) {}
    }
    /** 用最近一次接口数据重建明细（行数很少，重建比 diff 更省心）。 */
    function sessionCostRenderPanel() {
      try {
        var box = sessionCostPanelEl;
        if (!box) return;
        if (!box.querySelector('.dshsc-cost-title')) {
          var head = document.createElement('div');
          head.className = 'dshsc-cost-title';
          var label = document.createElement('span');
          label.className = 'dshsc-cost-title-label';
          var icon = sessionCostIcon();
          if (icon) label.appendChild(icon);
          label.appendChild(document.createTextNode('本会话消费'));
          head.appendChild(label);
          var value = document.createElement('span');
          value.className = 'dshsc-cost-title-value';
          head.appendChild(value);
          box.appendChild(head);
          var rule = document.createElement('div');
          rule.className = 'dshsc-cost-rule';
          box.appendChild(rule);
        }
        var d = sessionCostData;
        var total = d && isFinite(Number(d.cost)) ? Number(d.cost) : null;
        var valueEl = box.querySelector('.dshsc-cost-title-value');
        if (valueEl) valueEl.textContent = total === null ? '--' : sessionCostDetailAmount(total);
        var old = box.querySelector('.dshsc-cost-chart');
        if (old) box.removeChild(old);
        var oldEmpty = box.querySelector('.dshsc-cost-empty');
        if (oldEmpty) box.removeChild(oldEmpty);
        // 折线图数据源：每次对话（turn）产生的消费，而不是按日期
        var turns = d && Array.isArray(d.turnCosts) ? d.turnCosts : [];
        if (!turns.length) {
          var empty = document.createElement('div');
          empty.className = 'dshsc-cost-empty';
          empty.textContent = '这个会话还没有可统计的消费';
          box.appendChild(empty);
        } else {
          var chart = document.createElement('div');
          chart.className = 'dshsc-cost-chart';
          box.appendChild(chart); // 先挂进文档，才量得到真实宽度（面板宽度随内容/视口变）
          chart.appendChild(sessionCostBuildChart(turns, chart.clientWidth || 268));
        }
        // 底栏口径开关：人民币 / WorkBuddy 积分
        // （会话走订阅制的 WorkBuddy 模型时，按官方单价算出来的 ¥ 没有真实依据）
        // 每次都把它挪回面板末尾：渲染流程会反复 append 图表，不挪就会被挤到标题和图表之间；
        // 贴在末尾还有个好处 —— 面板高度随数据变化时，它的位置相对底栏是稳定的。
        var modeRow = box.querySelector('.dshsc-cost-mode');
        if (!modeRow) {
          modeRow = document.createElement('div');
          modeRow.className = 'dshsc-cost-mode';
          modeRow.setAttribute('data-dshsc-bound', '1');
          modeRow.addEventListener('click', function () {
            wbSaveMode(sessionCostSession, wbMode === 'credits' ? 'money' : 'credits');
            if (wbMode === 'credits') { try { pollWorkBuddy(true); } catch (err) {} }
            try { sessionCostRenderPanel(); } catch (err) {}
            wbRefreshBottom();
          });
        }
        box.appendChild(modeRow);
        modeRow.textContent = '本会话底栏金额：' + (wbMode === 'credits' ? 'WorkBuddy 积分' : '人民币') + '（点击切换）';
        sessionCostPlacePanel();
      } catch (err) {}
    }
    function sessionCostBindDismiss() {
      sessionCostUnbindDismiss();
      var onPointer = function (e) {
        try {
          var t = e.target;
          if (sessionCostPanelEl && sessionCostPanelEl.contains(t)) return;
          if (sessionCostEl && sessionCostEl.contains(t)) return;
          sessionCostClosePanel();
        } catch (err) {}
      };
      var onKey = function (e) {
        if (e.key === 'Escape') sessionCostClosePanel();
      };
      var onReflow = function () { sessionCostPlacePanel(); };
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onReflow, true);
      window.addEventListener('resize', onReflow);
      sessionCostPanelHandlers = { onPointer: onPointer, onKey: onKey, onReflow: onReflow };
    }
    function sessionCostUnbindDismiss() {
      var h = sessionCostPanelHandlers;
      if (!h) return;
      sessionCostPanelHandlers = null;
      try { document.removeEventListener('pointerdown', h.onPointer, true); } catch (err) {}
      try { document.removeEventListener('keydown', h.onKey, true); } catch (err) {}
      try { window.removeEventListener('scroll', h.onReflow, true); } catch (err) {}
      try { window.removeEventListener('resize', h.onReflow); } catch (err) {}
    }
    function sessionCostOpenPanel() {
      try {
        if (sessionCostOpen) return;
        sessionCostEnsurePanelCss();
        sessionCostPanelEl = document.createElement('div');
        sessionCostPanelEl.className = 'dshsc-cost-panel';
        sessionCostPanelEl.setAttribute('data-dshsc-session-cost-panel', '1');
        sessionCostPanelEl.setAttribute('role', 'dialog');
        sessionCostPanelEl.setAttribute('aria-label', '本会话消费');
        document.body.appendChild(sessionCostPanelEl);
        sessionCostOpen = true;
        if (sessionCostEl) sessionCostEl.setAttribute('aria-expanded', 'true');
        sessionCostRenderPanel();
        sessionCostBindDismiss();
        // 先渲染缓存数据，再顺手拉一次最新金额（拉回来会通过 sessionCostRenderPanel 刷新明细）
        try { pollSessionCost(true); } catch (err) {}
      } catch (err) {}
    }
    function sessionCostClosePanel() {
      try {
        sessionCostUnbindDismiss();
        if (sessionCostPanelEl && sessionCostPanelEl.parentNode) sessionCostPanelEl.parentNode.removeChild(sessionCostPanelEl);
        sessionCostPanelEl = null;
        sessionCostOpen = false;
        if (sessionCostEl) sessionCostEl.setAttribute('aria-expanded', 'false');
      } catch (err) {}
    }
    function sessionCostTogglePanel() {
      if (sessionCostOpen) sessionCostClosePanel();
      else sessionCostOpenPanel();
    }

    // ===== 每条回复（turn）下方的「本轮消耗金额」 =====
    /** 在动作栏里找官方「用量 X tok」按钮（用它和复制/赞/踩/分享区分开）。 */
    function sessionCostUsageTrigger(tail) {
      try {
        var btns = tail.querySelectorAll('button');
        for (var i = 0; i < btns.length; i++) {
          var b = btns[i];
          if (b.getAttribute('aria-haspopup') !== 'dialog') continue;
          // 官方本轮用量按钮的文案是「用量 {n} tok」/「Usage {n} tok」，以此和其它按钮区分
          var txt = String(b.textContent || '').replace(/\s+/g, ' ').trim();
          if (/tok$/i.test(txt)) return b;
        }
      } catch (err) {}
      return null;
    }
    function sessionCostTurnAmountText(cost) {
      var v = Number(cost);
      if (!isFinite(v)) return '--';
      return '¥ ' + (v > 0 && v < 1 ? v.toFixed(4) : v.toFixed(2));
    }
    /** 把每轮金额贴到对应回复的用量按钮右侧；每一轮只插一次，位置不对就摆回去（幂等）。 */
    function sessionCostMountTurnCosts() {
      try {
        var d = sessionCostData;
        var list = d && Array.isArray(d.turnCosts) ? d.turnCosts : null;
        if (!list || !list.length) return;
        var byTurn = {};
        for (var i = 0; i < list.length; i++) byTurn[String(list[i].turn)] = list[i];
        var tails = document.querySelectorAll('[data-turn-tail]');
        for (var t = 0; t < tails.length; t++) {
          var tail = tails[t];
          var key = String(tail.getAttribute('data-turn-tail') || '');
          if (!key) continue;
          // 只认当前会话的回复，免得侧栏里其它会话被贴上本会话的数字
          var holder = tail.closest ? tail.closest('[data-conversation-session]') : null;
          var sid = holder ? String(holder.getAttribute('data-conversation-session') || '') : '';
          if (sid && sessionCostSession && sid !== sessionCostSession) continue;
          var row = byTurn[key];
          if (!row) continue;
          var btn = sessionCostUsageTrigger(tail);
          if (!btn) continue;
          var host = btn.parentNode;
          if (!host || !host.parentNode) continue;
          var el = tail.querySelector('[data-dshsc-turn-cost]');
          if (!el) {
            // 用 span 而不是 button：这块只是展示，不该有点击语义；但官方是 button，
            // 浏览器对 button 默认 box-sizing:border-box —— 不补这一条，同一套类名下的
            // height:28px + padding:6px 8px 会被算成 40px，比官方高出一截（用户报过）。
            el = document.createElement('span');
            el.setAttribute('data-dshsc-turn-cost', key);
            el.className = btn.className; // 与官方用量按钮同一套类名 ⇒ 字号/间距/颜色一致
            el.style.boxSizing = 'border-box';
          }
          if (el.style.boxSizing !== 'border-box') el.style.boxSizing = 'border-box';
          if (el.previousElementSibling !== host) host.parentNode.insertBefore(el, host.nextSibling);
          var text = sessionCostTurnAmountText(row.cost);
          if (el.textContent !== text) el.textContent = text;
          var tip = '本轮消耗 ' + sessionCostDetailAmount(row.cost)
            + '（' + (Number(row.steps) || 0) + ' 步 · ' + (Number(row.tokens) || 0) + ' tokens）';
          tipSet(el, tip, 'top');
        }
      } catch (err) {}
    }
    // React 重渲染会把注入节点挪走/删除 ⇒ 用 MutationObserver 低成本地摆回去（节流 300ms）。
    function sessionCostMountSoon() {
      if (sessionCostMountTimer !== null) return;
      sessionCostMountTimer = setTimeout(function () {
        sessionCostMountTimer = null;
        try { sessionCostMount(); } catch (err) {}
        try { sessionCostMountTurnCosts(); } catch (err) {}
      }, 300);
    }

    // ===== 窗口顶行：官方开放平台「余额 + 今日用量」（点击弹近七日折线图） =====
    /** 顶部条样式（只注入一次）：贴在窗口标题栏那一行的右侧、避开 DSH 自己的按钮群。
     *  容器 pointer-events:none，只有按钮可点 —— 空白处仍能拖动窗口（顶栏是拖拽区）。 */
    function platformEnsureCss() {
      try {
        if (document.querySelector('style[data-dshsc-css="platform"]')) return;
        var style = document.createElement('style');
        style.setAttribute('data-dshsc-css', 'platform');
        style.textContent = [
          '.dshsc-plat-bar{position:fixed;top:0;right:150px;height:38px;display:flex;align-items:center;justify-content:flex-end;z-index:1200;pointer-events:none;-webkit-app-region:no-drag;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
          '.dshsc-plat-btn{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;font-variant-numeric:tabular-nums;-webkit-app-region:no-drag}',
          '.dshsc-plat-btn:hover{background:rgba(127,127,127,.16)}',
          '.dshsc-plat-btn[aria-expanded="true"]{background:rgba(127,127,127,.16)}',
          // 峰谷标签：谷时（便宜）走品牌蓝，高峰（价格 ×2）走暖橙，一眼能分清
          '.dshsc-plat-peak{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;'
            + 'font-size:11px;line-height:16px;white-space:nowrap;border:1px solid transparent}',
          '.dshsc-plat-peak[data-state="valley"]{color:var(--dsw-alias-brand-primary,#4D6BFE);background:rgba(77,107,254,.16);border-color:rgba(77,107,254,.35)}',
          '.dshsc-plat-peak[data-state="peak"]{color:#e8a33d;background:rgba(232,163,61,.16);border-color:rgba(232,163,61,.35)}',
          '.dshsc-plat-peak[data-state="none"]{display:none}',
          '.dshsc-plat-action{margin-top:12px;display:flex;justify-content:center}',
          '.dshsc-plat-link{pointer-events:auto;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;height:28px;padding:0 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums}',
          '.dshsc-plat-link:hover{background:rgba(127,127,127,.16)}'
        ].join('');
        document.head.appendChild(style);
      } catch (err) {}
    }
    /** 顶部条节点：整条只创建一次，之后只更新文案与 tooltip。 */
    function platformMount() {
      try {
        if (platformEl && platformEl.parentNode) return platformEl;
        platformEnsureCss();
        platformEl = document.createElement('div');
        platformEl.className = 'dshsc-plat-bar';
        platformEl.setAttribute('data-dshsc-platform', '1');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dshsc-plat-btn';
        btn.setAttribute('data-dshsc-platform-trigger', '1');
        btn.setAttribute('aria-haspopup', 'dialog');
        btn.setAttribute('aria-expanded', 'false');
        // 峰谷标签固定在余额文案左侧；文案单独占一个 span —— 否则给按钮赋 textContent 会把标签冲掉
        var peakTag = document.createElement('span');
        peakTag.className = 'dshsc-plat-peak';
        peakTag.setAttribute('data-dshsc-platform-peak', '1');
        peakTag.setAttribute('data-state', 'none');
        btn.appendChild(peakTag);
        var textSpan = document.createElement('span');
        textSpan.setAttribute('data-dshsc-platform-text', '1');
        btn.appendChild(textSpan);
        btn.addEventListener('click', function (e) {
          try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
          platformToggle();
        });
        platformEl.appendChild(btn);
        (document.body || document.documentElement).appendChild(platformEl);
        platformApplyText('');
        return platformEl;
      } catch (err) { return null; }
    }
    /** 顶部条文案：'余额 ¥x · 今日 ¥y'；拿不到数据就显示 --，原因写进 tooltip。 */
    /** 距下次峰谷切换还有多久：'约 9 小时 15 分钟后切换'；无效返回空串。 */
    function platformSwitchText(ms) {
      try {
        var diff = Number(ms) - Date.now();
        if (!isFinite(diff) || diff <= 0) return '';
        var min = Math.round(diff / 60000);
        if (min < 1) return '马上切换';
        if (min < 60) return min + ' 分钟后切换';
        var h = Math.floor(min / 60);
        var m = min % 60;
        return h + ' 小时' + (m > 0 ? ' ' + m + ' 分钟' : '') + '后切换';
      } catch (err) { return ''; }
    }
    /** 余额左侧的峰谷标签：谷时（品牌蓝）／峰时（暖橙）；没数据时隐藏。 */
    function platformApplyPeak(tag, d) {
      try {
        if (!tag) return;
        if (!d || (d.peak !== true && d.peak !== false)) {
          if (tag.getAttribute('data-state') !== 'none') tag.setAttribute('data-state', 'none');
          if (tag.textContent !== '') tag.textContent = '';
          return;
        }
        var label = d.peak === true ? '峰时' : '谷时';
        var state = d.peak === true ? 'peak' : 'valley';
        if (tag.textContent !== label) tag.textContent = label;
        if (tag.getAttribute('data-state') !== state) tag.setAttribute('data-state', state);
      } catch (err) {}
    }
    /** 峰谷那一行的 tooltip 文案：与 isPeakTime 的规则口径一致（谷价 = 峰价的一半）。 */
    function platformPeakTip(d) {
      try {
        if (!d || (d.peak !== true && d.peak !== false)) return '';
        var head = d.peak === true
          ? '峰谷：高峰时段（价格 ×2）'
          : '峰谷：空闲时段（价格 ×0.5）';
        var when = platformSwitchText(d.peakUntilMs);
        return head + (when ? '（' + when + '）' : '');
      } catch (err) { return ''; }
    }
    function platformApplyText(errorText) {
      try {
        var btn = platformEl && platformEl.querySelector ? platformEl.querySelector('[data-dshsc-platform-trigger]') : null;
        if (!btn) return;
        var peakTag = btn.querySelector ? btn.querySelector('[data-dshsc-platform-peak]') : null;
        var textSpan = btn.querySelector ? btn.querySelector('[data-dshsc-platform-text]') : null;
        var setText = function (value) {
          if (textSpan) { if (textSpan.textContent !== value) textSpan.textContent = value; }
          else if (btn.textContent !== value) btn.textContent = value;
        };
        var d = platformData;
        if (!d && errorText) {
          setText('余额 -- · 今日 --');
          platformApplyPeak(peakTag, null);
          tipSet(btn, '余额 -- · 今日 --\n' + String(errorText), 'bottom');
          return;
        }
        if (!d) {
          setText('余额 … · 今日 …');
          platformApplyPeak(peakTag, null);
          tipSet(btn, '正在读取官方开放平台…', 'bottom');
          return;
        }
        var bal = d.balance === null || d.balance === undefined ? NaN : Number(d.balance);
        var today = Number(d.todayUsage);
        var text = '余额 ' + (isFinite(bal) ? sessionCostAmountText(bal) : '--')
          + ' · 今日 ' + (isFinite(today) ? sessionCostAmountText(today) : '--');
        setText(text);
        platformApplyPeak(peakTag, d);
        var sourceText = d.source === 'apikey' ? '（开放平台 API key 口径）' : (d.source === 'account' ? '（DSH 账号余额口径）' : '');
        var peakTip = platformPeakTip(d);
        var tip = 'DeepSeek 开放平台' + sourceText
          + '\n余额 ' + (isFinite(bal) ? sessionCostAmountText(bal) : '--')
          + '\n今日用量 ' + (isFinite(today) ? sessionCostDetailAmount(today) : '--')
          + (peakTip ? '\n' + peakTip : '')
          + (d.error ? '\n' + String(d.error) : '')
          + '\n点击查看近七日用量';
        tipSet(btn, tip, 'bottom');
      } catch (err) {}
    }
    /** 取平台数据；余额变化不快，默认每 15 秒一次（force=true 立即取）。 */
    function pollPlatform(force) {
      try {
        platformTick += 1;
        if (!force && platformTick % PLATFORM_TICK !== 0) return;
        platformMount();
        fetch(PLATFORM_URL, { cache: 'no-store' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (!d || !d.ok) {
              platformApplyText((d && d.error) || '官方开放平台数据不可用');
              return;
            }
            platformData = d;
            platformApplyText('');
            if (platformOpen) platformRenderPanel();
          })
          .catch(function () {});
      } catch (err) {}
    }
    /** 面板：标题「近七日用量」+ 合计值 + 按日折线图 + 「进入官网」按钮。 */
    function platformRenderPanel() {
      try {
        var box = platformPanelEl;
        if (!box) return;
        if (!box.querySelector('.dshsc-cost-title')) {
          var head = document.createElement('div');
          head.className = 'dshsc-cost-title';
          var label = document.createElement('span');
          label.className = 'dshsc-cost-title-label';
          var icon = sessionCostIcon();
          if (icon) label.appendChild(icon);
          label.appendChild(document.createTextNode('近七日用量'));
          head.appendChild(label);
          var value = document.createElement('span');
          value.className = 'dshsc-cost-title-value';
          head.appendChild(value);
          box.appendChild(head);
          var rule = document.createElement('div');
          rule.className = 'dshsc-cost-rule';
          box.appendChild(rule);
        }
        var days = platformData && Array.isArray(platformData.days) ? platformData.days : [];
        var sum = 0;
        for (var i = 0; i < days.length; i++) sum += Number(days[i].cost) || 0;
        var valueEl = box.querySelector('.dshsc-cost-title-value');
        if (valueEl) valueEl.textContent = days.length ? sessionCostDetailAmount(sum) : '--';
        var oldChart = box.querySelector('.dshsc-cost-chart');
        if (oldChart) box.removeChild(oldChart);
        var oldEmpty = box.querySelector('.dshsc-cost-empty');
        if (oldEmpty) box.removeChild(oldEmpty);
        // 图/空状态必须插在「进入官网」按钮**前面**（按钮固定在面板最下方）。
        // appendChild 会无条件加到末尾，面板刷新一次顺序就会反过来。
        var actHost = box.querySelector('.dshsc-plat-action');
        var appendAboveAction = function (node) {
          if (actHost && actHost.parentNode === box) box.insertBefore(node, actHost);
          else box.appendChild(node);
        };
        if (!days.length) {
          var empty = document.createElement('div');
          empty.className = 'dshsc-cost-empty';
          empty.textContent = platformData ? '还没有读到用量数据' : '正在读取官方开放平台…';
          appendAboveAction(empty);
        } else {
          var chart = document.createElement('div');
          chart.className = 'dshsc-cost-chart';
          appendAboveAction(chart); // 先挂进文档才量得到真实宽度
          chart.appendChild(sessionCostBuildDayChart(days, chart.clientWidth || 268));
        }
        if (!box.querySelector('.dshsc-plat-action')) {
          var act = document.createElement('div');
          act.className = 'dshsc-plat-action';
          var link = document.createElement('button');
          link.type = 'button';
          link.className = 'dshsc-plat-link';
          link.setAttribute('data-dshsc-platform-open', '1');
          link.textContent = '进入 DeepSeek 开放平台';
          link.addEventListener('click', function (e) {
            try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
            platformOpenSite();
          });
          act.appendChild(link);
          box.appendChild(act);
        }
        platformPlacePanel();
      } catch (err) {}
    }
    /** 顶部条在窗口最上方 ⇒ 面板只能向下展开；水平方向右对齐触发器右边缘。 */
    function platformPlacePanel() {
      try {
        var panel = platformPanelEl;
        var trigger = platformEl;
        if (!panel || !trigger || !panel.parentNode) return;
        panel.style.visibility = 'hidden';
        panel.style.left = '0px';
        panel.style.top = '0px';
        var r = trigger.getBoundingClientRect();
        var pw = panel.offsetWidth;
        var ph = panel.offsetHeight;
        var margin = 12;
        var gap = 8;
        var left = r.left + r.width - pw;
        var maxLeft = Math.max(margin, window.innerWidth - margin - pw);
        if (left > maxLeft) left = maxLeft;
        if (left < margin) left = margin;
        var top = r.bottom + gap;
        if (top + ph > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - ph);
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
        panel.style.visibility = '';
      } catch (err) {}
    }
    function platformBindDismiss() {
      platformUnbindDismiss();
      var onPointer = function (e) {
        try {
          var t = e.target;
          if (platformPanelEl && platformPanelEl.contains(t)) return;
          if (platformEl && platformEl.contains(t)) return;
          platformClosePanel();
        } catch (err) {}
      };
      var onKey = function (e) {
        if (e.key === 'Escape') platformClosePanel();
      };
      var onReflow = function () { platformPlacePanel(); };
      document.addEventListener('pointerdown', onPointer, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onReflow, true);
      window.addEventListener('resize', onReflow);
      platformPanelHandlers = { onPointer: onPointer, onKey: onKey, onReflow: onReflow };
    }
    function platformUnbindDismiss() {
      var h = platformPanelHandlers;
      if (!h) return;
      platformPanelHandlers = null;
      try { document.removeEventListener('pointerdown', h.onPointer, true); } catch (err) {}
      try { document.removeEventListener('keydown', h.onKey, true); } catch (err) {}
      try { window.removeEventListener('scroll', h.onReflow, true); } catch (err) {}
      try { window.removeEventListener('resize', h.onReflow); } catch (err) {}
    }
    function platformOpenPanel() {
      try {
        if (platformOpen) return;
        platformEnsureCss();
        // 面板本体（.dshsc-cost-panel）的样式与会话消费面板共用一套，必须一起注入
        sessionCostEnsurePanelCss();
        platformPanelEl = document.createElement('div');
        platformPanelEl.className = 'dshsc-cost-panel';
        platformPanelEl.setAttribute('data-dshsc-platform-panel', '1');
        platformPanelEl.setAttribute('role', 'dialog');
        platformPanelEl.setAttribute('aria-label', '近七日用量');
        document.body.appendChild(platformPanelEl);
        platformOpen = true;
        var btn = platformEl && platformEl.querySelector ? platformEl.querySelector('[data-dshsc-platform-trigger]') : null;
        if (btn) btn.setAttribute('aria-expanded', 'true');
        platformRenderPanel();
        platformBindDismiss();
        try { pollPlatform(true); } catch (err) {}
      } catch (err) {}
    }
    function platformClosePanel() {
      try {
        platformUnbindDismiss();
        if (platformPanelEl && platformPanelEl.parentNode) platformPanelEl.parentNode.removeChild(platformPanelEl);
        platformPanelEl = null;
        platformOpen = false;
        var btn = platformEl && platformEl.querySelector ? platformEl.querySelector('[data-dshsc-platform-trigger]') : null;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      } catch (err) {}
    }
    function platformToggle() {
      if (platformOpen) platformClosePanel();
      else platformOpenPanel();
    }
    /** 「进入官网」：交给 DSH 的**侧栏浏览器**打开（持久分区 ⇒ 登录状态保留）；
     *  侧栏服务不可用时退回新标签页打开。 */
    function platformOpenSite() {
      var url = PLATFORM_PAGE;
      try {
        var api = dshCtx && typeof dshCtx.get === 'function' ? dshCtx.get('sidebarRight') : null;
        if (api && typeof api.openTab === 'function') {
          api.openTab('browser', { params: { url: url } });
          platformClosePanel();
          return;
        }
      } catch (err) {}
      try { window.open(url, '_blank', 'noopener,noreferrer'); } catch (err) {}
    }
    /** 近七日（按天）消费折线图：与轮次图同一套版式，横轴换成 MM-DD。 */
    function sessionCostBuildDayChart(days, width) {
      var ns = 'http://www.w3.org/2000/svg';
      var W = Math.max(200, Math.round(width || 268));
      var H = 132;
      var padLeft = 44;
      var padRight = 10;
      var padTop = 12;
      var padBottom = 22;
      var plotW = Math.max(1, W - padLeft - padRight);
      var plotH = Math.max(1, H - padTop - padBottom);
      var brand = 'var(--dsw-alias-brand-primary, #4D6BFE)';
      var gridColor = 'var(--dsw-alias-border-l2, rgba(127,127,127,.25))';
      var textColor = 'var(--dsw-alias-label-tertiary, #8a8f98)';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '近七日每日用量折线图');
      svg.style.display = 'block';

      var list = (days || []).filter(function (d) { return d && isFinite(Number(d.cost)); });
      var max = 0;
      for (var i = 0; i < list.length; i++) max = Math.max(max, Number(list[i].cost) || 0);
      var yMax = max > 0 ? max * 1.15 : 1;

      function px(idx) {
        if (list.length <= 1) return padLeft + plotW / 2;
        return padLeft + (idx * plotW) / (list.length - 1);
      }
      function py(v) {
        return padTop + plotH - (Math.max(0, Number(v) || 0) / yMax) * plotH;
      }
      function dayLabel(day) {
        var s = String(day || '');
        return s.length >= 10 ? s.slice(5) : s;
      }

      var ticks = [0, max / 2, max];
      for (var t = 0; t < ticks.length; t++) {
        var y = py(ticks[t]);
        var line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', String(padLeft));
        line.setAttribute('x2', String(padLeft + plotW));
        line.setAttribute('y1', String(y));
        line.setAttribute('y2', String(y));
        line.setAttribute('stroke', gridColor);
        line.setAttribute('stroke-width', '1');
        if (t > 0) line.setAttribute('stroke-dasharray', '3 4');
        svg.appendChild(line);
        var lab = document.createElementNS(ns, 'text');
        lab.setAttribute('x', String(padLeft - 6));
        lab.setAttribute('y', String(y + 3.5));
        lab.setAttribute('text-anchor', 'end');
        lab.setAttribute('font-size', '10');
        lab.setAttribute('fill', textColor);
        lab.textContent = '¥' + sessionCostAxisAmount(ticks[t]);
        svg.appendChild(lab);
      }

      if (list.length) {
        var pts = [];
        for (var p = 0; p < list.length; p++) pts.push(px(p) + ',' + py(list[p].cost));
        if (list.length > 1) {
          var area = document.createElementNS(ns, 'polygon');
          area.setAttribute('points', padLeft + ',' + py(0) + ' ' + pts.join(' ') + ' ' + (padLeft + plotW) + ',' + py(0));
          area.setAttribute('fill', brand);
          area.setAttribute('opacity', '0.12');
          svg.appendChild(area);
          var poly = document.createElementNS(ns, 'polyline');
          poly.setAttribute('points', pts.join(' '));
          poly.setAttribute('fill', 'none');
          poly.setAttribute('stroke', brand);
          poly.setAttribute('stroke-width', '1.6');
          poly.setAttribute('stroke-linejoin', 'round');
          poly.setAttribute('stroke-linecap', 'round');
          svg.appendChild(poly);
        }
        var axisTag = document.createElementNS(ns, 'text');
        axisTag.setAttribute('x', '4');
        axisTag.setAttribute('y', String(H - 6));
        axisTag.setAttribute('font-size', '10');
        axisTag.setAttribute('fill', textColor);
        axisTag.textContent = '日';
        svg.appendChild(axisTag);
        // 日期标签同样做一次像素级碰撞检测：7 天挨得近时不会叠字，末尾那天优先保留
        var dotR = list.length > 20 ? 1.6 : 2.4;
        var showLabel = {};
        (function () {
          var prevRight = -1e9;
          for (var s = 0; s < list.length; s++) {
            var label = dayLabel(list[s].day);
            var w = label.length * 5.8;
            var left = s === 0 ? px(s) : (s === list.length - 1 ? px(s) - w : px(s) - w / 2);
            if (left < prevRight + 4) continue;
            showLabel[s] = true;
            prevRight = left + w;
          }
          // 末尾那天一定要有标签：和倒数第二个冲突时让前一个让位
          var last = list.length - 1;
          if (last > 0 && !showLabel[last]) {
            for (var k = last - 1; k > 0; k--) {
              if (showLabel[k]) { delete showLabel[k]; break; }
            }
            showLabel[last] = true;
          }
        })();
        for (var q = 0; q < list.length; q++) {
          var d = list[q];
          var cx = px(q);
          var cy = py(d.cost);
          var dot = document.createElementNS(ns, 'circle');
          dot.setAttribute('cx', String(cx));
          dot.setAttribute('cy', String(cy));
          dot.setAttribute('r', String(dotR));
          dot.setAttribute('fill', brand);
          var tip = document.createElementNS(ns, 'title');
          tip.textContent = String(d.day || '') + '：¥' + Number(d.cost).toFixed(4);
          dot.appendChild(tip);
          svg.appendChild(dot);
          if (showLabel[q]) {
            var dl = document.createElementNS(ns, 'text');
            dl.setAttribute('x', String(cx));
            dl.setAttribute('y', String(H - 6));
            dl.setAttribute('font-size', '10');
            dl.setAttribute('fill', textColor);
            dl.setAttribute('text-anchor', q === 0 ? 'start' : (q === list.length - 1 ? 'end' : 'middle'));
            dl.textContent = dayLabel(d.day);
            svg.appendChild(dl);
          }
        }
      }
      return svg;
    }

    /** 启动：DOM 观察 + 每秒轮询（数据每 2 秒取一次）。 */
    function start() {
      if (sessionCostTimer !== null) return;
      try { wbPruneStates(); } catch (err) {}
      try {
        if (typeof MutationObserver === 'function') {
          sessionCostObserver = new MutationObserver(sessionCostMountSoon);
          sessionCostObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
        }
      } catch (err) {}
      sessionCostTimer = setInterval(function () {
        try { pollSessionCost(false); } catch (err) {}
        try { pollPlatform(false); } catch (err) {}
        try { pollWorkBuddy(false); } catch (err) {}
      }, 1000);
      try { sessionCostMount(); } catch (err) {}
      try { platformMount(); } catch (err) {}
      try { pollSessionCost(true); } catch (err) {}
      try { pollPlatform(true); } catch (err) {}
      try { pollWorkBuddy(true); } catch (err) {}
    }
    /** 退出：清掉定时器、观察器、注入节点与面板。 */
    function stop() {
      try { if (sessionCostTimer !== null) clearInterval(sessionCostTimer); } catch (err) {}
      sessionCostTimer = null;
      try { if (sessionCostMountTimer !== null) clearTimeout(sessionCostMountTimer); } catch (err) {}
      sessionCostMountTimer = null;
      try { if (sessionCostObserver) sessionCostObserver.disconnect(); } catch (err) {}
      sessionCostObserver = null;
      sessionCostClosePanel();
      platformClosePanel();
      try {
        if (sessionCostEl && sessionCostEl.parentNode) sessionCostEl.parentNode.removeChild(sessionCostEl);
      } catch (err) {}
      sessionCostEl = null;
      try {
        if (platformEl && platformEl.parentNode) platformEl.parentNode.removeChild(platformEl);
      } catch (err) {}
      platformEl = null;
    }

    function apply(ctx) {
      if (typeof document === 'undefined' || document === null) return;
      // 侧栏浏览器（点「进入官网」时用）通过 ctx.get('sidebarRight') 延迟取，
      // 因此 inject 仍为空数组：服务不存在也不会让整个插件不生效。
      dshCtx = ctx === undefined ? null : ctx;
      if (document.body === null || document.body === undefined) {
        // 插件加载早于 body 就绪时，等 DOM 可用再启动
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
      if (ctx !== null && ctx !== undefined && typeof ctx.effect === 'function') {
        ctx.effect(() => () => { stop(); }, 'session-cost: 会话消费显示');
      }
    }

    exports.apply = apply;
    /** 只用标准 DOM API + 宿主路由，不需要任何 DSH 客户端服务。 */
    exports.inject = [];
    return module.exports;
  }
});
