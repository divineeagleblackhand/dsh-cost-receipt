# dsh-cost-receipt

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/divineeagleblackhand/dsh-cost-receipt)

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that adds one line under every reply telling you what that exchange cost, plus the account balance. Hover for a pie chart of the cost breakdown, drawn by cost share.

```
This exchange ¥0.165824    Account balance ¥6.2164    Bonus balance ¥1.5366
```

## What it does

- **Priced per exchange**: one line under every reply, showing what the exchange you just had cost. Historical turns carry their own numbers too, priced at the rate of their own time window, so opening an old session still computes.
- **The balance is two numbers**: `account balance` counts top-up funds only, `bonus balance` gets its own line, and only their sum is the wallet total. The second line disappears when there is no bonus. Balances appear only on the newest turn of a conversation, because showing historical balances would be meaningless.
- **Hover for the breakdown**: the current exchange and the whole conversation are drawn as **two rings side by side, by cost share, not by token share**. Cached tokens are usually ~99% of the token count but under 40% of the cost; a token-based chart collapses into an invisible sliver.
- **When a price cannot be computed it says why**, never silently: the badge reads `unpriced model xxx`, `mixed models (a + b)`, `usage without a model`. Applying another model's unit price would be off by several times and invisible.
- **The timestamp on the badge means "unchanged", not "just read"**: the host caches account queries, so that `HH:MM:SS` is **when the balance last changed** — a still timestamp means the number has not moved. Hovering also shows the last query time, so comparing the two tells you whether the reading is stale or the balance genuinely did not change.

## Install

From npm (recommended: shorter name, and you can pin a version):

```
dsh plugin --profile desktop add dsh-cost-receipt
```

Or straight from the GitHub repository:

```
dsh plugin --profile desktop add https://github.com/divineeagleblackhand/dsh-cost-receipt
```

You can also paste either address into "Add plugin" on the dsh plugin page (on desktop the profile is named `desktop`).

Refresh the page after installing. If the badge does not appear, fully quit and restart the desktop app.

> If GitHub is hard to reach, use the npm command, or clone the repository and install from its absolute path.

## Privacy and network

- **The plugin makes no network calls of its own**: `client.js` / `index.js` contain no `fetch`, `XMLHttpRequest` or WebSocket calls — you can check line by line.
- **The balance is read through the host**: the plugin asks the dsh host for `account/getBalance` (the same path as your account settings page), which means **one account query every 30 seconds, dropping to every 3 minutes while the page is hidden**. That is its only outward-facing action, and it goes through dsh's own account feature; the account token never leaves the host.
- **No storage**: it writes no files and uses no localStorage.
- **No credential access**: it does not read your API key or any configuration file.
- The only local data it reads is the current session's token usage — the same data behind dsh's own "turn usage" panel.

> `tools/fetch-holidays.mjs` in the repository is a **maintenance script** that refreshes the built-in holiday table. It needs the network (a third-party holiday API by default, or the URL of the State Council notice for cross-checking), is run manually **once a year** by the maintainer, and **is not shipped in the npm package** (the `files` whitelist only carries what the plugin needs at runtime).

## Pricing scope and limits

| Item | Basis |
|---|---|
| One exchange | one user message → the final reply |
| Calculation | cached input / uncached input / cache write / output are priced separately. Cache write is billed as uncached input (there is no separate cache-write price) |
| Unit prices | per million tokens, **per currency and per model**: CNY and USD each have their own official list, priced independently — nothing is converted |
| Time window | peak = Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00, **excluding statutory holidays**; everything else is off-peak. Evaluation is independent of your system time zone |
| Holidays | the State Council's 2026 schedule is built in (19 days). Years outside the table fall back to "no correction" — it does not give a wrong answer, it just stops correcting |
| Currency | **CNY and USD accounts.** The wallet's currency picks the price list and amounts are shown in that currency; a mixed or any other currency shows no amounts at all, just a notice that only CNY and USD are supported |
| Search and fetch | **outside the table above.** `web_search` retrieves on the server side (a separate model request), and those tokens never reach this session's usage; the Search/Fetch APIs also bill per request (¥0.005 / $0.00075 each from 2026-11-01). Text returned by `web_fetch` **is** included |

Known margins:

- **Turns that cross a peak/off-peak boundary** are priced entirely by their end time, worst case about 50% off (a 5-minute turn straddling a boundary is roughly a 1.4% case).
- **The conversation total** only covers turns already loaded into the view; on a paginated very long session it reads low.
- **The price table and holiday table follow the official ones**, which change — they are constants you edit by hand (see below).
- **Turns that used search read low**: the server-side retrieval of `web_search` consumes tokens in another model request, which the host does not report and the plugin cannot see; the per-request Search/Fetch fee is likewise out of reach. The amount on the panel is therefore a **lower bound** — it under-reports, never over-reports. Text returned by `web_fetch` is counted normally.
- **Historical turns use the current currency**: if an account changed currency mid-session (very rare), older turns are priced with the present table, which is not what was actually charged.

## Compatibility

- Requires **dsh 0.2.0-rc.2 or newer**: the plugin depends on the host's turn-tail data and account Remote. Those two interfaces were checked on **0.2.1-rc.2 and 0.2.1-rc.3**; if the badge disappears after a dsh upgrade, this is the first thing to suspect.
- Web and desktop, Windows and macOS (a pure client plugin: it touches no filesystem and has no platform branches).
- Non-CNY accounts show no amounts (see above).

## Development

```
npm test
```

The test script **slices the real pricing code out of `client.js` and runs it** rather than copying it — so "what is tested" and "what runs" cannot drift apart. Coverage: peak/off-peak boundaries, holidays, the three-way breakdown reconciliation, ring and badge reading the same numbers, session totals, panel structure, amount formatting tiers, currency detection, the search-fee exclusion notice, and zh/en dictionary parity.

- Change unit prices: `PRICES` at the top of `client.js`
- Refresh the holiday table: `node tools/fetch-holidays.mjs <year>` (optionally pass the State Council notice URL for cross-checking)

## License

MIT
