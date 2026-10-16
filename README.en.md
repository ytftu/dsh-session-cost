# dsh-session-cost

[简体中文](README.md) | English

Real-time "how much did this cost me" feedback for the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) desktop app: the **session total in the composer footer**, the **cost of each reply in its action bar**, and the **account balance plus today's usage in the top-right corner** (with a peak / off-peak badge).

Amounts are recomputed from DSH's own session logs, so they cover turns from before the plugin was installed — no third-party plugin required.

## Features

| Where | Shows | Interaction |
| --- | --- | --- |
| Composer footer (after the token counter) | `本会话 ¥ 6.42` (switchable to `本会话 12 积分`) | Click for a **per-turn cost chart**; the panel footer switches the footer unit |
| Each reply's action bar (next to DSH's own `用量 N tok` pill) | `¥ 0.28` | Same pill styling as DSH's counter; hover for details |
| Top-right corner (right of the menu bar) | `谷时 余额 ¥ 42.00 · 今日 ¥ 3.21` | Click for a **last-7-days daily usage chart** plus an "Open DeepSeek Platform" button (opens in DSH's sidebar browser, keeping you signed in) |

Hover cards are custom dark overlays (same blurred backdrop as the cost panel), not native tooltips.

### Screenshots

> Amounts in the screenshots below are blurred.

Session total and per-turn cost curve:

![Per-turn cost chart](docs/images/turn-chart.png)

Cost of each reply, next to DSH's own usage pill:

![Per-reply cost](docs/images/turn-amount.png)

Balance / today's usage in the top-right corner, with the peak / off-peak badge:

![Balance and peak](docs/images/peak-and-balance.png)

Last-7-days daily usage panel:

![Last 7 days](docs/images/platform-panel.png)

"Open DeepSeek Platform" goes through DSH's sidebar browser (persistent partition, so you stay signed in):

![Sidebar browser](docs/images/sidebar-open.png)

## Install

> Requires DSH Desktop (developed against `DSH Desktop 2.0.17` on Windows). This is a plain Cordis plugin: one host half and one browser half.

1. Clone the repo into DSH's plugin directory:

   ```powershell
   git clone https://github.com/<you>/dsh-session-cost.git "$env:USERPROFILE\.dsh\plugins\dsh-session-cost"
   ```

   On macOS / Linux this is `~/.dsh/plugins/dsh-session-cost`.

2. Register it in your profile (`~/.dsh/profiles/desktop/package.json`):

   ```jsonc
   {
     "dependencies": {
       // ...other plugins
       "dsh-session-cost": "link:C:/Users/<you>/.dsh/plugins/dsh-session-cost"
     },
     "dsh": {
       "profile": {
         "bundles": [
           // ...other bundles
           "dsh-session-cost"
         ]
       }
     }
   }
   ```

3. Link the package under `~/.dsh/profiles/desktop/node_modules/` (a junction on Windows, a symlink on macOS / Linux; running `npm install` in the profile directory works too):

   ```powershell
   New-Item -ItemType Junction `
     -Path   "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-session-cost" `
     -Target "$env:USERPROFILE\.dsh\plugins\dsh-session-cost"
   ```

4. Restart DSH.

Removing or disabling the plugin just makes the three UI pieces disappear; it never touches your sessions.

### Reloading while developing

**Just restart DSH** — the DSH desktop app has no page-reload entry point:

| Changed | How to apply |
| --- | --- |
| `lib/client.js` (UI half) | Restart DSH. |
| `lib/index.js` (host half) | Restart DSH. |

`Ctrl+R` / `F5` / `Ctrl+Shift+R` do nothing in the DSH desktop app — don't waste time on them. Note that the host caches client scripts it has already served, so even if your environment offers a page reload, restarting is the reliable way to pick up changes to `lib/client.js`.

## Configuration

### `DSH_HOME`

The host half reads `process.env.DSH_HOME`, falling back to `~/.dsh`. Session logs, the usage ledger and custom prices live there.

### Custom prices (optional)

If `.dshw-api.json` exists (the file written by [dsh-whale-widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)), the plugin **read-only** reuses its custom prices and exchange rate:

```jsonc
// ~/.dsh/.dshw-api.json
{
  "models": [
    {
      "id": "deepseek-v4-pro",
      "matchIds": ["deepseek-v4-pro", "v4-pro"],   // each keyword must be ≥ 3 chars
      "price": { "hit": 0.15, "miss": 4.5, "out": 13.5, "cur": "USD", "rate": 7.2 }
    }
  ]
}
```

Prices are per **million tokens**. When `cur` is not `CNY`, `rate` converts to CNY.

### Peak / off-peak and holidays

The price table at the top of `lib/index.js` is the **peak** price; off-peak is ×0.5:

- Peak: weekdays `09:00–12:00` and `14:00–18:00` (Beijing time)
- Off-peak: everything else, plus **weekends** and **public holidays** (`WEEKEND_VALLEY_FROM_SEC` / `HOLIDAY_VALLEY`)

The holiday table is hard-coded (currently through 2026) and **must be updated every year**, otherwise holidays get billed at peak price.

## Pricing model

### Session cost (footer / per reply)

The plugin parses DSH's session log directly instead of relying on in-memory counters, so **turns from before the plugin was installed are included**:

```
~/.dsh/sessions/<workspace-encoded>/<session id>/session.v4.jsonl.zstd
```

- The file is **multi-frame zstd** (magic `28 B5 2F FD`); the code splits it at frame boundaries, decompresses frame by frame, and reads incrementally (only new bytes; a partial frame is kept for the next pass);
- Only `assistant/message` events are used, taking `data.usage.{inputTokens,cacheReadTokens,outputTokens}`, `data.message.source.model` and the event timestamp;
- Entries are deduplicated by `turn:step` (last write wins), matching DSH's own token projection;
- Price: `uncached input × miss + cache read × hit + output × out`, with peak / off-peak (×1 / ×0.5) decided by **the timestamp of that turn**.

### Balance and today's usage (top-right)

- When a `DEEPSEEK_API_KEY` credential is available, it calls the official `GET https://api.deepseek.com/user/balance` (which returns `total_balance` / `currency`);
- Otherwise it falls back to the DSH account balance (top-up + bonus, i.e. the web console figure);
- **Today's usage is accumulated from balance drops**: the balance is sampled every 60 seconds, and only decreases count towards today (top-ups never produce negative usage); at midnight the day's usage is archived into history and the baseline is reset;
- In other words it is "everything charged today across all channels", which is a **different measure** from the footer's `token × price` — do not add them together.

### WorkBuddy credits (optional footer unit)

With [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) installed and WorkBuddy models wired into DSH, the footer can be switched to show the **credits this session consumed** (click the "this session's footer unit: CNY / WorkBuddy credits" row at the bottom of the panel):

- The unit is stored **per session** and defaults to CNY: sessions that never used a WorkBuddy model are not dragged along by a choice made in another session, and sessions do not affect each other (the choice lives in browser local storage);

- It reads the plugin's local read-only endpoint `GET /plugins/dsh-workbuddy-connect/status` (about once a minute) and never touches your WorkBuddy credentials;
- WorkBuddy only exposes an **account-level** quota, with no per-session or per-turn billing, so this is an **estimate**: the deltas between consecutive samples are summed up;
- Reconciliation is done per credit package, so **newly granted credits** are added back and **expired credits** are subtracted instead of being counted as consumption; a quota cycle reset is not counted either;
- Usage of the same account elsewhere (the WorkBuddy desktop app, other DSH sessions) is included, so this figure is an **upper bound**;
- WorkBuddy runs on a subscription quota and the plugin reports a price of zero to DSH, so any `¥` derived from official per-token prices is meaningless there — the credit unit is the more honest one.

## HTTP endpoints

Two read-only routes, both restricted to local hosts (`localhost` / `127.x` / `[::1]`; anything else gets 403) and requiring no authentication:

```
GET /dsh-session-cost/session-cost.json?session=<session id>
→ { ok, session, currency, cost, tokens, steps, turns, models[], days[], turnCosts[], updatedAt }

GET /dsh-session-cost/platform.json[?refresh=1]
→ { ok, balance, currency, source, todayUsage, days[{day,cost}], knownDays,
    peak, peakUntilMs, error, updatedAt }
```

`source` is either `apikey` (official balance API) or `account` (DSH account balance); `days` is the last 7 days in ascending order, zero-filled.

## Layout

```
dsh-session-cost/
├── package.json          # name / exports / dsh.bundle.patch / dsh.client
├── cordis.patch.yml      # bundle-layer declaration
├── lib/
│   ├── index.js          # host: price table, peak/holiday rules, log parsing, ledger, two read-only routes
│   └── client.js         # browser: footer amount, per-turn chart, per-reply amount, top-right balance panel, custom tooltips
├── docs/images/          # screenshots used by the READMEs
└── test/                 # offline tests (they extract the real functions from the sources, no DSH needed)
```

## Development & tests

```powershell
# Any Node.js >= 20 with zstd support works, including the one bundled with DSH:
#   %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe
node test/test_session_cost_plugin.mjs   # routes, log parsing, pricing, client contract
node test/test_platform.mjs              # balance sampling / midnight rollover / last 7 days / peak detection
node test/test_tooltip.mjs               # hover cards
node test/test_turn_cost.mjs             # per-reply amount injection
node test/test_chart.mjs                 # chart coordinates and labels
node test/test_panel_place.mjs           # panel placement
node test/test_workbuddy.mjs             # WorkBuddy credits: snapshots, reconciliation, copy
```

The test scripts extract the **real functions** from `lib/*.js` and run them with stubbed dependencies (`new Function`), so assertions track the implementation immediately.

## Known limitations

- The holiday table must be updated manually every year;
- Log parsing assumes the `session.v4.jsonl.zstd` multi-frame format stays the same (a DSH upgrade may break it); after 3 consecutive failures a frame is skipped;
- The exact meaning of the top-right balance depends on how you signed in to DSH (API key vs. account);
- Only tested on DSH Desktop for Windows; the browser half uses DSH's official client-plugin channel, so other platforms should behave the same;
- WorkBuddy credits are an **account-level estimate** (usage elsewhere on the same account is included), not a per-session bill; without `dsh-workbuddy-connect` installed or signed in, the credit unit shows `本会话 -- 积分`.

## License

[MIT](LICENSE)
