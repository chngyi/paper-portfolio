# paper-portfolio

A local paper-trading account for perpetual-futures-style positions, modelled on
how stock perps behave on Hyperliquid. Everything runs in the browser and saves
to `localStorage` — there is no backend, no wallet, no API key, and no order is
ever sent anywhere.

## What it models

- **Decimal position sizing.** Perps are not share lots, so sizes carry a
  size-decimal precision (4 dp) and the floor is a **$10 minimum order value**
  rather than a whole-unit rule. `0.637` is as valid a size as `12`.
- **Isolated margin.** Each position posts its own margin at 1×–20× leverage and
  can lose only that. Opening debits `notional / leverage`, not the full
  notional, and both longs *and* shorts draw on the same collateral.
- **Liquidation.** Maintenance margin is half the initial margin at max
  leverage, so a position liquidates where
  `margin + (mark − entry) × size = mm × mark × size`. Positions really do get
  wiped when the mark crosses that price, forfeiting their margin.
- **Account equity** = free collateral + posted margin + unrealized PNL, which
  is always deposits plus total PNL. ROE is measured against margin posted, not
  notional.
- **Deposits and withdrawals** move cash and cost basis together, so adding
  money never registers as profit.

## Sizing by capital

The order ticket sizes either way round: type a size, or type the margin you
want to commit and it derives `size = (margin × leverage) / price`, floored to
the market's precision so the order never exceeds the budget.

## Live prices

The price feed has three modes — **Manual** (you click marks and set them),
**Simulated** (marks random-walk locally), and **Live**, the default.

Live polls Hyperliquid's public `info` endpoint every 5s for two sets of mids:
core perps, and the HIP-3 stock perps on the `xyz` dex. They are merged keyed by
plain ticker, so `MU`, `AMD`, `NVDA`, `GOLD` and `BTC` all resolve to a mark.
Tickers are validated against that list, so you cannot open a position on a name
the feed cannot price. These are mids on a 5s poll — no bid/ask spread, no
slippage, no tick-level accuracy.

## Running it

```
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces a static bundle;
`npm run lint` runs Oxlint.

Note that state is scoped per origin, so `npm run dev` (5173) and
`npm run preview` (4173) keep separate accounts.

## Disclaimer

This is an unofficial hobby project. It is **not affiliated with, endorsed by,
or connected to Hyperliquid, trade.xyz, or any exchange or venue.** Those names
are used only to describe where the public market data comes from.

It is a simulator: no real orders are placed, no funds are at risk, and nothing
here is financial advice. Prices are read from a public API for display only and
may be delayed, wrong, or unavailable. Do not use it to make trading decisions.

## License

Copyright © 2026 chngyi. All rights reserved.

No license is granted. You may view this code on GitHub, but it may not be
copied, modified, distributed, or used without permission.
