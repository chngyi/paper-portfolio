import React, { useState, useEffect, useRef, useCallback } from "react";

const STORE_KEY = "paper-portfolio-v1";
const START_CASH = 100000;

// Perp sizing, not share lots: each market has a size-decimal precision and the
// real floor is a minimum order value, so 0.637 is as valid a size as 12.
const SZ_DECIMALS = 4;
const MIN_NOTIONAL = 10;

// Hyperliquid's public info endpoint — no key, no backend, CORS open to any
// origin. "xyz" is the trade.xyz HIP-3 dex, where the stock perps live.
const HL_API = "https://api.hyperliquid.xyz/info";
const HL_DEX = "xyz";
const POLL_MS = 5000;

// Isolated margin: every position posts its own margin and can lose only that.
const MAX_LEVERAGE = 20;
const LEV_CHOICES = [1, 2, 3, 5, 10, 20];
// Maintenance margin is half the initial margin at max leverage, as on HL.
const MM_FRAC = 1 / (2 * MAX_LEVERAGE);

const fmt = (n, d = 2) =>
  (n < 0 ? "-" : "") +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const usd = (n, d = 2) => (n < 0 ? "-$" : "$") + fmt(Math.abs(n), d);
const signed = (n, d = 2) => (n >= 0 ? "+" : "-") + "$" + fmt(Math.abs(n), d);

// Sizes print at their own precision, trailing zeros trimmed: 12, 0.637, 1.25.
const fmtSize = (n) =>
  (n < 0 ? "-" : "") +
  Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: SZ_DECIMALS,
  });
// Round *down* to the market's precision so a size never exceeds the budget.
const floorTo = (n, d) => Math.floor(n * 10 ** d) / 10 ** d;

const uid = () => Math.random().toString(36).slice(2, 10);

// datetime-local wants "YYYY-MM-DDTHH:mm" in local time, not an ISO UTC string.
const toLocalInput = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
};

// Price at which the position's own margin no longer covers maintenance:
//   margin + (mark - entry) * size = MM_FRAC * mark * size   (long)
// solved for mark. A 1x long bottoms out at zero, so there is nothing to show.
const liqPrice = (p) => {
  const perUnit = p.margin / p.size;
  const px =
    p.side === "long"
      ? (p.entry - perUnit) / (1 - MM_FRAC)
      : (p.entry + perUnit) / (1 + MM_FRAC);
  return px > 0 ? px : null;
};
const isLiquidated = (p) => {
  const lp = liqPrice(p);
  if (lp == null) return false;
  return p.side === "long" ? p.mark <= lp : p.mark >= lp;
};
// Effective leverage of a position, after any adds at different leverage.
const levOf = (p) => (p.entry * p.size) / p.margin;

export default function PaperPortfolio() {
  const [cash, setCash] = useState(START_CASH);
  const [deposits, setDeposits] = useState(START_CASH);
  const [positions, setPositions] = useState([]);
  const [fills, setFills] = useState([]);
  const [curve, setCurve] = useState([START_CASH]);
  const [tab, setTab] = useState("positions");
  const [feed, setFeed] = useState("live"); // "off" | "sim" | "live"
  const [mids, setMids] = useState({});
  const [feedErr, setFeedErr] = useState("");
  const [lastTick, setLastTick] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [flash, setFlash] = useState({});
  const [editing, setEditing] = useState(null);
  const [editingTime, setEditingTime] = useState(null);
  const [xferOpen, setXferOpen] = useState(false);
  const [xfer, setXfer] = useState("");
  const [xferErr, setXferErr] = useState("");
  const [now, setNow] = useState(Date.now());
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const [sym, setSym] = useState("");
  const [size, setSize] = useState("");
  const [price, setPrice] = useState("");
  const [mode, setMode] = useState("shares"); // "shares" | "capital"
  const [capital, setCapital] = useState("");
  const [lev, setLev] = useState(1);

  // ---- persistence -------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(STORE_KEY);
        if (r?.value) {
          const s = JSON.parse(r.value);
          setCash(s.cash ?? START_CASH);
          setDeposits(s.deposits ?? START_CASH);
          // Positions saved before margin existed were effectively 1x.
          setPositions(
            (s.positions ?? []).map((p) => ({ ...p, margin: p.margin ?? p.entry * p.size }))
          );
          setFills(s.fills ?? []);
          setCurve(s.curve?.length ? s.curve : [START_CASH]);
        }
      } catch (e) {
        /* first run — nothing saved yet */
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      window.storage
        ?.set(
          STORE_KEY,
          JSON.stringify({ cash, deposits, positions, fills, curve: curve.slice(-400) })
        )
        .catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [cash, deposits, positions, fills, curve, loaded]);

  // ---- math --------------------------------------------------------------
  const upnl = (p) => (p.side === "long" ? p.mark - p.entry : p.entry - p.mark) * p.size;
  const notional = positions.reduce((a, p) => a + p.size * p.mark, 0);
  const marginUsed = positions.reduce((a, p) => a + p.margin, 0);
  const totalUpnl = positions.reduce((a, p) => a + upnl(p), 0);
  // Free collateral + margin locked in positions + what those positions are worth.
  const equity = cash + marginUsed + totalUpnl;
  const allTime = equity - deposits;

  // Newest first, re-derived so an edited timestamp moves the row into place.
  const history = [...fills].sort((a, b) => b.time - a.time);

  // How long ago the feed last answered. Past 15s the clock turns red rather
  // than quietly showing prices that stopped moving.
  const tickAge =
    feed === "live" && lastTick ? Math.max(0, Math.round((now - lastTick) / 1000)) : null;
  const stale = feed === "live" && (!!feedErr || (tickAge != null && tickAge > 15));

  const pushCurve = useCallback((v) => setCurve((c) => [...c.slice(-399), v]), []);

  useEffect(() => {
    if (loaded) pushCurve(equity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions.length, cash, loaded]);

  // ---- simulated ticks ---------------------------------------------------
  useEffect(() => {
    if (feed !== "sim" || positions.length === 0) return;
    const iv = setInterval(() => {
      setPositions((ps) => {
        const f = {};
        const next = ps.map((p) => {
          const drift = (Math.random() - 0.5) * 0.004;
          const mark = Math.max(0.01, +(p.mark * (1 + drift)).toFixed(2));
          f[p.id] = mark >= p.mark ? "up" : "down";
          return { ...p, mark };
        });
        setFlash(f);
        setTimeout(() => setFlash({}), 400);
        return next;
      });
    }, 1400);
    return () => clearInterval(iv);
  }, [feed, positions.length]);

  // ---- live prices -------------------------------------------------------
  // Polls the core perp mids and the trade.xyz stock-perp mids, keyed by plain
  // ticker so "MU" resolves whether it is a stock perp or a crypto perp.
  useEffect(() => {
    if (feed !== "live") return;
    const ac = new AbortController();
    let stopped = false;

    const ask = (body) =>
      fetch(HL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      });

    const poll = async () => {
      try {
        const [core, dex] = await Promise.all([
          ask({ type: "allMids" }),
          ask({ type: "allMids", dex: HL_DEX }),
        ]);
        if (stopped) return;
        const m = {};
        // Core perps are plain names; "@n" and "#n" keys are spot pairs.
        for (const [k, v] of Object.entries(core)) {
          if (!k.startsWith("@") && !k.startsWith("#") && !k.includes("/")) m[k] = +v;
        }
        // Stock perps arrive prefixed and win any name clash.
        for (const [k, v] of Object.entries(dex)) m[k.replace(/^.*:/, "")] = +v;
        setMids(m);
        setFeedErr("");
        setLastTick(Date.now());
      } catch (e) {
        if (!stopped && e.name !== "AbortError")
          setFeedErr(`Price feed unreachable (${e.message}) — retrying.`);
      }
    };

    poll();
    const iv = setInterval(poll, POLL_MS);
    return () => {
      stopped = true;
      ac.abort();
      clearInterval(iv);
    };
  }, [feed]);

  // Apply whatever the feed last returned to any position holding that ticker.
  useEffect(() => {
    if (feed !== "live") return;
    setPositions((ps) => {
      const f = {};
      let changed = false;
      const next = ps.map((p) => {
        const m = mids[p.symbol];
        if (m == null || !(m > 0) || m === p.mark) return p;
        changed = true;
        f[p.id] = m >= p.mark ? "up" : "down";
        return { ...p, mark: m };
      });
      if (!changed) return ps;
      setFlash(f);
      setTimeout(() => setFlash({}), 400);
      return next;
    });
  }, [mids, feed]);

  useEffect(() => {
    if (feed === "off") return;
    const iv = setInterval(() => pushCurve(cash + marginUsed + totalUpnl), 1400);
    return () => clearInterval(iv);
  }, [feed, cash, marginUsed, totalUpnl, pushCurve]);

  // ---- liquidation -------------------------------------------------------
  // Any mark move — a live tick or a hand-typed price — can wipe a position.
  // The isolated margin is forfeited in full; nothing returns to free cash.
  useEffect(() => {
    const dead = positions.filter(isLiquidated);
    if (dead.length === 0) return;
    setPositions((ps) => ps.filter((p) => !dead.some((d) => d.id === p.id)));
    setFills((f) => [
      ...dead.map((p) => ({
        id: uid(),
        symbol: p.symbol,
        side: p.side === "long" ? "short" : "long",
        size: p.size,
        price: liqPrice(p),
        value: p.size * liqPrice(p),
        margin: p.margin,
        lev: levOf(p),
        time: Date.now(),
        kind: "Liquidated",
        pnl: -p.margin,
      })),
      ...f,
    ]);
  }, [positions]);

  // ---- order sizing ------------------------------------------------------
  // Capital mode is driven by the margin you commit: that margin buys
  // capital x leverage of notional, and the size follows from the price.
  const pxIn = parseFloat(price) || 0;
  const capIn = parseFloat(capital) || 0;
  // The mids map doubles as the market list — its keys are every tradable
  // name. Empty means the feed has not answered yet, so we cannot judge a
  // ticker and must not block one.
  const symUp = sym.trim().toUpperCase();
  const marketNames = Object.keys(mids);
  const unknownSym = marketNames.length > 0 && symUp !== "" && mids[symUp] == null;
  const suggestions = marketNames
    .filter((n) => symUp === "" || n.startsWith(symUp))
    .sort()
    .slice(0, 24);
  // The feed's current mid for whatever ticker is typed, if it knows it.
  const liveMid = mids[symUp] ?? null;
  const qty =
    mode === "capital"
      ? pxIn > 0
        ? floorTo((capIn * lev) / pxIn, SZ_DECIMALS)
        : 0
      : floorTo(parseFloat(size) || 0, SZ_DECIMALS);
  const orderValue = qty * pxIn;
  const marginReq = orderValue / lev;
  // Whatever the precision rounding shaved off — cents, not a share's worth.
  const dust = mode === "capital" ? Math.max(0, capIn - marginReq) : 0;
  // What the ticket would liquidate at, before it exists as a position.
  const previewLiq =
    qty > 0 && pxIn > 0
      ? liqPrice({ side: "long", entry: pxIn, size: qty, margin: marginReq })
      : null;
  const previewLiqShort =
    qty > 0 && pxIn > 0
      ? liqPrice({ side: "short", entry: pxIn, size: qty, margin: marginReq })
      : null;

  // ---- actions -----------------------------------------------------------
  const open = (side) => {
    const s = sym.trim().toUpperCase();
    const q = qty;
    const px = pxIn;
    if (!s) return setErr("Enter a ticker.");
    // A name the feed cannot mark would sit frozen at its entry price.
    if (feed === "live" && marketNames.length > 0 && mids[s] == null)
      return setErr(
        `${s} is not a market on Hyperliquid. Check the ticker, or switch the` +
          ` price feed to Manual to track it yourself.`
      );
    if (!(px > 0)) return setErr("Entry price must be greater than zero.");
    if (mode === "capital" && !(capIn > 0)) return setErr("Enter the capital to deploy.");
    if (!(q > 0)) return setErr("Size must be greater than zero.");
    if (q * px < MIN_NOTIONAL)
      return setErr(`Minimum order value is ${usd(MIN_NOTIONAL)} — this order is ${usd(q * px)}.`);
    // Both sides post margin: a short is not a source of free collateral.
    const req = (q * px) / lev;
    if (req > cash)
      return setErr(`Not enough margin. ${usd(req)} required, ${usd(cash)} available.`);

    setErr("");
    const existing = positions.find((p) => p.symbol === s && p.side === side);
    if (existing) {
      const newSize = floorTo(existing.size + q, SZ_DECIMALS);
      const newEntry = (existing.entry * existing.size + px * q) / newSize;
      setPositions((ps) =>
        ps.map((p) =>
          p.id === existing.id
            ? { ...p, size: newSize, entry: newEntry, margin: p.margin + req }
            : p
        )
      );
    } else {
      setPositions((ps) => [
        ...ps,
        { id: uid(), symbol: s, side, size: q, entry: px, mark: px, margin: req, opened: Date.now() },
      ]);
    }
    setCash((c) => c - req);
    setFills((f) => [
      {
        id: uid(),
        symbol: s,
        side,
        size: q,
        price: px,
        value: q * px,
        margin: req,
        lev,
        time: Date.now(),
        kind: "Open",
        pnl: null,
      },
      ...f,
    ]);
    setSize("");
    setPrice("");
    setCapital("");
  };

  const close = (p) => {
    const pnl = upnl(p);
    // The posted margin comes back, plus or minus what the position made.
    setCash((c) => c + p.margin + pnl);
    setPositions((ps) => ps.filter((x) => x.id !== p.id));
    setFills((f) => [
      {
        id: uid(),
        symbol: p.symbol,
        side: p.side === "long" ? "short" : "long",
        size: p.size,
        price: p.mark,
        value: p.size * p.mark,
        margin: p.margin,
        lev: levOf(p),
        time: Date.now(),
        kind: "Close",
        pnl,
      },
      ...f,
    ]);
  };

  // Backdate or correct a fill. Value comes from a datetime-local input, which
  // parses in the browser's own timezone — same basis the table prints in.
  const setFillTime = (id, v) => {
    const t = new Date(v).getTime();
    if (Number.isNaN(t)) return;
    setFills((f) => f.map((x) => (x.id === id ? { ...x, time: t } : x)));
  };

  const setMark = (id, v) => {
    const m = parseFloat(v);
    if (!(m > 0)) return;
    setPositions((ps) => ps.map((p) => (p.id === id ? { ...p, mark: m } : p)));
  };

  // Money in or out. Cash and deposits move together, so a transfer never
  // registers as PNL — all-time return still measures trading only.
  const transfer = (dir) => {
    const amt = parseFloat(xfer);
    if (!(amt > 0)) return setXferErr("Enter an amount greater than zero.");
    if (dir === "out" && amt > cash)
      return setXferErr(`Only ${usd(cash)} is free — the rest is posted as margin.`);

    const d = dir === "in" ? amt : -amt;
    setCash((c) => c + d);
    setDeposits((v) => v + d);
    setFills((f) => [
      {
        id: uid(),
        symbol: "USDC",
        side: null,
        size: null,
        price: null,
        value: amt,
        margin: null,
        lev: null,
        time: Date.now(),
        kind: dir === "in" ? "Deposit" : "Withdraw",
        pnl: null,
      },
      ...f,
    ]);
    setXfer("");
    setXferErr("");
    setXferOpen(false);
  };

  const reset = () => {
    setCash(START_CASH);
    setDeposits(START_CASH);
    setPositions([]);
    setFills([]);
    setCurve([START_CASH]);
    setFeed("live");
    setErr("");
  };

  // ---- sparkline ---------------------------------------------------------
  const pts = curve.slice(-160);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const span = hi - lo || 1;
  const path = pts
    .map((v, i) => `${(i / Math.max(1, pts.length - 1)) * 100},${28 - ((v - lo) / span) * 26}`)
    .join(" ");

  const C = {
    mint: "#50d2c1",
    green: "#1fa67d",
    red: "#ed7088",
    text: "#d9e5e3",
    dim: "#7d918e",
  };
  const pnlColor = (v) => (v > 0 ? C.mint : v < 0 ? C.red : C.dim);

  return (
    <div className="hlroot">
      <style>{`
        .hlroot{--bg:#06100f;--panel:#0b1c1a;--line:#16302d;--mint:#50d2c1;--green:#1fa67d;
          --red:#ed7088;--text:#d9e5e3;--dim:#7d918e;
          background:var(--bg);color:var(--text);min-height:100%;padding:10px;
          font-family:ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:12px;}
        .hlroot *{box-sizing:border-box;}
        .mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;}
        .lbl{font-size:9px;letter-spacing:.11em;text-transform:uppercase;color:var(--dim);}
        .panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;}
        .grid{display:grid;grid-template-columns:1fr 258px;gap:10px;align-items:start;}
        @media(max-width:760px){.grid{grid-template-columns:1fr;}}
        .stat{padding:9px 14px;border-right:1px solid var(--line);}
        .stat:last-child{border-right:none;}
        .statv{font-size:15px;margin-top:3px;}
        .fld{width:100%;background:#06100f;border:1px solid var(--line);border-radius:4px;
          color:var(--text);padding:7px 9px;font-size:12px;outline:none;}
        .fld:focus{border-color:var(--mint);}
        .fld::placeholder{color:#4c605d;}
        .fld::-webkit-calendar-picker-indicator{filter:invert(.65);cursor:pointer;}
        .btn{flex:1;border:none;border-radius:4px;padding:9px 0;font-size:12px;font-weight:600;
          color:#04120f;cursor:pointer;letter-spacing:.02em;transition:filter .12s;}
        .btn:hover{filter:brightness(1.12);}
        .btn:focus-visible,.fld:focus-visible,.tab:focus-visible,.mini:focus-visible{
          outline:1px solid var(--mint);outline-offset:1px;}
        .tab{background:none;border:none;color:var(--dim);padding:8px 13px;font-size:11px;
          cursor:pointer;border-bottom:1px solid transparent;}
        .tab.on{color:var(--text);border-bottom-color:var(--mint);}
        table{width:100%;border-collapse:collapse;}
        th{text-align:right;font-weight:400;font-size:9px;letter-spacing:.1em;
          text-transform:uppercase;color:var(--dim);padding:8px 12px;border-bottom:1px solid var(--line);}
        th:first-child,td:first-child{text-align:left;}
        td{text-align:right;padding:9px 12px;border-bottom:1px solid #0f2422;font-size:12px;}
        tbody tr:hover{background:#0d211f;}
        .mini{background:none;border:1px solid var(--line);color:var(--dim);border-radius:3px;
          padding:3px 8px;font-size:10px;cursor:pointer;}
        .mini:hover{border-color:var(--red);color:var(--red);}
        .chip{background:none;border:1px solid var(--line);color:var(--dim);border-radius:3px;
          padding:3px 0;font-size:10px;cursor:pointer;font-family:inherit;}
        .chip:hover{border-color:var(--mint);color:var(--mint);}
        .chip.on{background:rgba(80,210,193,.13);border-color:var(--mint);color:var(--mint);}
        .chip:focus-visible{outline:1px solid var(--mint);outline-offset:1px;}
        .linkbtn{background:none;border:none;padding:0;font-size:10px;cursor:pointer;
          color:var(--mint);font-family:inherit;}
        .linkbtn:hover{text-decoration:underline;}
        /* No font shorthand here — .statv and .mono own the type, and "font:
           inherit" would silently undo both of them. */
        .linkplain{background:none;border:none;padding:0;color:inherit;cursor:pointer;
          text-align:left;line-height:inherit;border-bottom:1px dotted #2a4a46;}
        .linkplain:hover{color:var(--mint);}
        .linkplain:focus-visible{outline:1px solid var(--mint);outline-offset:2px;}
        .levtag{margin-left:6px;font-size:9px;color:var(--dim);border:1px solid var(--line);
          border-radius:3px;padding:1px 4px;}
        .seg{display:flex;gap:0;border:1px solid var(--line);border-radius:4px;overflow:hidden;}
        .seg button{flex:1;background:none;border:none;color:var(--dim);padding:6px 0;
          font-size:11px;cursor:pointer;font-family:inherit;}
        .seg button+button{border-left:1px solid var(--line);}
        .seg button:hover{color:var(--text);}
        .seg button.on{background:rgba(80,210,193,.13);color:var(--mint);}
        .seg button:focus-visible{outline:1px solid var(--mint);outline-offset:-2px;}
        .up{color:var(--mint);}.down{color:var(--red);}
        .flashup{animation:fu .4s ease-out;}.flashdn{animation:fd .4s ease-out;}
        @keyframes fu{from{background:rgba(80,210,193,.16)}to{background:transparent}}
        @keyframes fd{from{background:rgba(237,112,136,.16)}to{background:transparent}}
        @media(prefers-reduced-motion:reduce){.flashup,.flashdn{animation:none;}}
        .empty{padding:34px 14px;text-align:center;color:var(--dim);}
        .dot{width:5px;height:5px;border-radius:50%;display:inline-block;margin-right:6px;}
      `}</style>

      {/* header */}
      <div className="panel" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <div className="stat" style={{ minWidth: 150 }}>
          <div className="lbl">Account equity</div>
          <div className="statv mono">{usd(equity)}</div>
        </div>
        <div className="stat">
          <div className="lbl">Unrealized PNL</div>
          <div className="statv mono" style={{ color: pnlColor(totalUpnl) }}>{signed(totalUpnl)}</div>
        </div>
        <div className="stat">
          <div className="lbl">All-time</div>
          <div className="statv mono" style={{ color: pnlColor(allTime) }}>
            {signed(allTime)}{" "}
            {/* Withdrawing more than you put in makes the basis meaningless. */}
            {deposits > 0 && (
              <span style={{ fontSize: 11 }}>({fmt((allTime / deposits) * 100)}%)</span>
            )}
          </div>
        </div>
        <div className="stat">
          <div className="lbl">Available</div>
          <button className="statv mono linkplain" onClick={() => setXferOpen((o) => !o)}
            title="Deposit or withdraw USDC">
            {usd(cash)}
          </button>
        </div>
        <div className="stat">
          <div className="lbl">Margin used</div>
          <div className="statv mono">{usd(marginUsed)}</div>
        </div>
        <div className="stat" title="Total position value at mark — your market exposure">
          <div className="lbl">Notional</div>
          <div className="statv mono">{usd(notional)}</div>
        </div>
        <div className="stat" style={{ flex: 1, minWidth: 160 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <span className="lbl">Equity curve</span>
            <span className="mono" style={{ fontSize: 10, color: stale ? C.red : C.dim }}
              title={feed === "live"
                ? "Local time, and how long ago the price feed last answered"
                : "Local time"}>
              {feed === "live" && (
                <span className="dot" style={{ background: feedErr || stale ? C.red : C.mint }} />
              )}
              {new Date(now).toLocaleString("en-US", {
                month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                second: "2-digit", hour12: false,
              })}
              {feed === "live" && tickAge != null && ` · ${tickAge}s ago`}
            </span>
          </div>
          <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: "100%", height: 30, marginTop: 2 }}>
            <polyline points={path} fill="none" stroke={allTime >= 0 ? C.mint : C.red} strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
      </div>

      <div className="grid">
        {/* left: tables */}
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #16302d" }}>
            <button className={`tab ${tab === "positions" ? "on" : ""}`} onClick={() => setTab("positions")}>
              Positions ({positions.length})
            </button>
            <button className={`tab ${tab === "history" ? "on" : ""}`} onClick={() => setTab("history")}>
              History ({fills.length})
            </button>
            <div style={{ marginLeft: "auto", paddingRight: 10 }}>
              <button className="chip" style={{ padding: "3px 8px" }}
                onClick={() => setXferOpen((o) => !o)}>
                Deposit / Withdraw
              </button>
            </div>
          </div>

          {xferOpen && (
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap",
              padding: "9px 12px", borderBottom: "1px solid #16302d", background: "#081714" }}>
              <span className="lbl">Amount (USDC)</span>
              <input className="fld mono" style={{ width: 130 }} placeholder="10000"
                inputMode="decimal" autoFocus value={xfer}
                onChange={(e) => { setXfer(e.target.value); setXferErr(""); }}
                onKeyDown={(e) => e.key === "Enter" && transfer("in")} />
              <button className="chip" style={{ padding: "5px 12px" }} onClick={() => transfer("in")}>
                Deposit
              </button>
              <button className="chip" style={{ padding: "5px 12px" }} onClick={() => transfer("out")}>
                Withdraw
              </button>
              <span className="mono" style={{ fontSize: 10, color: xferErr ? C.red : "#54706c" }}>
                {xferErr || "Moves cash and cost basis together, so PNL is unaffected."}
              </span>
            </div>
          )}

          {tab === "positions" ? (
            positions.length === 0 ? (
              <div className="empty">No open positions. Enter a ticker, size and price to place your first trade.</div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ticker</th><th>Size</th>
                      <th title="Size-weighted average of every fill that built this position">
                        Avg entry
                      </th>
                      <th>Mark</th>
                      <th title="Price at which this position's margin is wiped out">Liq price</th>
                      <th>Margin</th>
                      <th>Value</th>
                      <th title="PNL as a return on the margin posted, not on notional">
                        PNL (ROE %)
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => {
                      const v = upnl(p);
                      const roe = (v / p.margin) * 100;
                      const lp = liqPrice(p);
                      // How close the mark is to that price, as a warning cue.
                      const near = lp != null && Math.abs(p.mark - lp) / p.mark < 0.05;
                      return (
                        <tr key={p.id}>
                          <td>
                            <span className="dot" style={{ background: p.side === "long" ? C.green : C.red }} />
                            <span style={{ fontWeight: 600 }}>{p.symbol}</span>
                            <span style={{ color: C.dim, marginLeft: 7, fontSize: 10, textTransform: "uppercase" }}>
                              {p.side}
                            </span>
                            <span className="levtag mono">{fmt(levOf(p), levOf(p) < 10 ? 1 : 0)}×</span>
                          </td>
                          <td className="mono">{fmtSize(p.size)}</td>
                          <td className="mono" style={{ color: C.dim }}>{fmt(p.entry)}</td>
                          <td className={`mono ${flash[p.id] === "up" ? "flashup" : flash[p.id] === "down" ? "flashdn" : ""}`}>
                            {feed === "live" ? (
                              // The feed owns the mark; typing over it would be undone.
                              fmt(p.mark)
                            ) : editing === p.id ? (
                              <input
                                className="fld mono"
                                style={{ width: 80, textAlign: "right", padding: "3px 6px" }}
                                autoFocus
                                defaultValue={p.mark}
                                onBlur={(e) => { setMark(p.id, e.target.value); setEditing(null); }}
                                onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
                              />
                            ) : (
                              <button
                                onClick={() => setEditing(p.id)}
                                title="Click to set the current price"
                                style={{ background: "none", border: "none", borderBottom: "1px dotted #2a4a46", color: "inherit", font: "inherit", cursor: "pointer", padding: 0 }}
                                className="mono"
                              >
                                {fmt(p.mark)}
                              </button>
                            )}
                          </td>
                          <td className="mono" style={{ color: near ? C.red : C.dim }}>
                            {lp == null ? "—" : fmt(lp)}
                          </td>
                          <td className="mono" style={{ color: C.dim }}>{usd(p.margin)}</td>
                          <td className="mono">{usd(p.size * p.mark)}</td>
                          <td className="mono" style={{ color: pnlColor(v) }}>
                            {signed(v)} <span style={{ fontSize: 10 }}>({fmt(roe)}%)</span>
                          </td>
                          <td><button className="mini" onClick={() => close(p)}>Close</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : fills.length === 0 ? (
            <div className="empty">No trades yet.</div>
          ) : (
            <div style={{ overflowX: "auto", maxHeight: 380 }}>
              <table>
                <thead>
                  <tr>
                    <th>Time</th><th>Ticker</th><th>Action</th><th>Size</th><th>Price</th>
                    <th title="Notional bought or sold: size x price">Value</th>
                    <th title="Margin posted on an open, or released on a close">Margin</th>
                    <th>Realized PNL</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((f) => {
                    // Fills recorded before margin existed carry neither field.
                    const val = f.value ?? f.size * f.price;
                    return (
                      <tr key={f.id}>
                        <td className="mono" style={{ color: C.dim }}>
                          {editingTime === f.id ? (
                            <input
                              className="fld mono"
                              style={{ width: 172, padding: "3px 6px" }}
                              type="datetime-local"
                              autoFocus
                              defaultValue={toLocalInput(f.time)}
                              onBlur={(e) => { setFillTime(f.id, e.target.value); setEditingTime(null); }}
                              onKeyDown={(e) => e.key === "Enter" && e.target.blur()}
                            />
                          ) : (
                            <button
                              onClick={() => setEditingTime(f.id)}
                              title="Click to change the date and time of this fill"
                              style={{ background: "none", border: "none", borderBottom: "1px dotted #2a4a46", color: "inherit", font: "inherit", cursor: "pointer", padding: 0 }}
                              className="mono"
                            >
                              {new Date(f.time).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </button>
                          )}
                        </td>
                        <td style={{ fontWeight: 600 }}>{f.symbol}</td>
                        <td style={{
                          color:
                            f.kind === "Liquidated" ? C.red
                              : f.side == null ? C.text
                              : f.side === "long" ? C.mint
                              : C.red,
                          textTransform: "capitalize",
                        }}>
                          {f.kind} {f.side ?? ""}
                        </td>
                        <td className="mono">{f.size == null ? "—" : fmtSize(f.size)}</td>
                        <td className="mono">{f.price == null ? "—" : fmt(f.price)}</td>
                        <td className="mono">{usd(val)}</td>
                        <td className="mono" style={{ color: C.dim }}>
                          {f.margin == null ? "—" : usd(f.margin)}
                          {f.lev != null && (
                            <span className="levtag mono">{fmt(f.lev, f.lev < 10 ? 1 : 0)}×</span>
                          )}
                        </td>
                        <td className="mono" style={{ color: f.pnl == null ? C.dim : pnlColor(f.pnl) }}>
                          {f.pnl == null ? "—" : signed(f.pnl)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* right: order ticket */}
        <div className="panel" style={{ padding: 12 }}>
          <div className="lbl" style={{ marginBottom: 10 }}>Place trade</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="lbl">Ticker</span>
                {marketNames.length > 0 && (
                  <span className="lbl">{marketNames.length} markets</span>
                )}
              </div>
              <input className="fld mono" placeholder="NVDA" value={sym} list="hl-markets"
                onChange={(e) => setSym(e.target.value.toUpperCase())} maxLength={12} />
              <datalist id="hl-markets">
                {suggestions.map((n) => (
                  <option key={n} value={n}>{fmt(mids[n])}</option>
                ))}
              </datalist>
              {unknownSym && (
                <div className="mono" style={{ fontSize: 10, marginTop: 4, lineHeight: 1.4,
                  color: feed === "live" ? C.red : "#54706c" }}>
                  {feed === "live"
                    ? "Not a Hyperliquid market."
                    : "Not a Hyperliquid market — its mark will not track if you go Live."}
                </div>
              )}
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="lbl">Leverage</span>
                <span className="lbl">Max {MAX_LEVERAGE}×</span>
              </div>
              <div style={{ display: "flex", gap: 4 }}>
                {LEV_CHOICES.map((l) => (
                  <button key={l} className={`chip ${lev === l ? "on" : ""}`} style={{ flex: 1 }}
                    onClick={() => setLev(l)}>
                    {l}×
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="lbl" style={{ marginBottom: 4 }}>Size by</div>
              <div className="seg">
                <button className={mode === "shares" ? "on" : ""} onClick={() => setMode("shares")}>
                  Shares
                </button>
                <button className={mode === "capital" ? "on" : ""} onClick={() => setMode("capital")}>
                  Capital $
                </button>
              </div>
            </div>

            {mode === "shares" ? (
              <div>
                <div className="lbl" style={{ marginBottom: 4 }}>Size</div>
                <input className="fld mono" placeholder="0.0" inputMode="decimal" value={size}
                  onChange={(e) => setSize(e.target.value)} />
              </div>
            ) : (
              <div>
                <div className="lbl" style={{ marginBottom: 4 }}>Margin to commit (USD)</div>
                <input className="fld mono" placeholder="8000" inputMode="decimal" value={capital}
                  onChange={(e) => setCapital(e.target.value)} />
                <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                  {[0.25, 0.5, 0.75, 1].map((f) => (
                    <button key={f} className="chip" style={{ flex: 1 }}
                      onClick={() => setCapital((cash * f).toFixed(2))}>
                      {f === 1 ? "Max" : `${f * 100}%`}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span className="lbl">Price per share</span>
                {liveMid != null && (
                  <button className="linkbtn mono" onClick={() => setPrice(String(liveMid))}
                    title="Use the current Hyperliquid mid">
                    mid {fmt(liveMid)} ↵
                  </button>
                )}
              </div>
              <input className="fld mono" placeholder="0.00" inputMode="decimal" value={price}
                onChange={(e) => setPrice(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && open("long")} />
            </div>
          </div>

          {mode === "capital" && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 11 }}>
              <span className="lbl">Size</span>
              <span className="mono" style={{ color: qty > 0 ? C.mint : C.dim }}>
                {fmtSize(qty)}
              </span>
            </div>
          )}

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 7, color: C.dim }}>
            <span className="lbl">Notional</span>
            <span className="mono">{usd(orderValue)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, color: C.dim }}>
            <span className="lbl">Margin required</span>
            <span className="mono" style={{ color: marginReq > cash ? C.red : C.text }}>
              {usd(marginReq)}
            </span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", margin: "5px 0 9px", color: C.dim }}>
            <span className="lbl">Est. liq price L / S</span>
            <span className="mono">
              {previewLiq == null ? "—" : fmt(previewLiq)}
              {" / "}
              {previewLiqShort == null ? "—" : fmt(previewLiqShort)}
            </span>
          </div>

          {mode === "capital" && qty > 0 && dust >= 0.01 && (
            <div className="mono" style={{ color: C.dim, fontSize: 10, marginTop: -5, marginBottom: 9 }}>
              {usd(dust)} of your margin left unused — size is rounded down to {SZ_DECIMALS} decimals.
            </div>
          )}

          {err && (
            <div className="mono" style={{ color: C.red, fontSize: 11, marginBottom: 8, lineHeight: 1.4 }}>{err}</div>
          )}

          <div style={{ display: "flex", gap: 7 }}>
            <button className="btn" style={{ background: C.green }} onClick={() => open("long")}>Buy / Long</button>
            <button className="btn" style={{ background: C.red }} onClick={() => open("short")}>Sell / Short</button>
          </div>

          <div style={{ borderTop: "1px solid #16302d", marginTop: 13, paddingTop: 11 }}>
            <div className="lbl" style={{ marginBottom: 5 }}>Price feed</div>
            <div className="seg">
              <button className={feed === "off" ? "on" : ""} onClick={() => setFeed("off")}>Manual</button>
              <button className={feed === "sim" ? "on" : ""} onClick={() => setFeed("sim")}>Simulated</button>
              <button className={feed === "live" ? "on" : ""} onClick={() => setFeed("live")}>Live</button>
            </div>

            {feed === "live" && (
              <div className="mono" style={{ fontSize: 10, marginTop: 7, lineHeight: 1.5,
                color: feedErr ? C.red : C.dim }}>
                {feedErr ? (
                  feedErr
                ) : lastTick ? (
                  <>
                    <span className="dot" style={{ background: C.mint }} />
                    {Object.keys(mids).length} markets ·{" "}
                    {new Date(lastTick).toLocaleTimeString("en-US", { hour12: false })}
                  </>
                ) : (
                  "Connecting to Hyperliquid…"
                )}
              </div>
            )}

            <div style={{ color: "#54706c", fontSize: 10, marginTop: 7, lineHeight: 1.5 }}>
              {feed === "live"
                ? `Mids polled every ${POLL_MS / 1000}s from Hyperliquid's public API — core perps plus the trade.xyz stock perps. Marks are read-only while live. Orders stay local; nothing is sent to a real venue.`
                : feed === "sim"
                ? "Marks random-walk locally so you can watch PNL and liquidations move. No market data involved."
                : "Prices are yours to set — click any mark price in the table to update it. Switch to Live to pull real Hyperliquid mids."}
            </div>
          </div>

          {/* Destructive, so it lives at the far end of the panel and asks first. */}
          <div style={{ borderTop: "1px solid #16302d", marginTop: 13, paddingTop: 11,
            display: "flex", alignItems: "center", gap: 7 }}>
            {confirmReset ? (
              <>
                <span className="mono" style={{ fontSize: 10, color: C.red, lineHeight: 1.4 }}>
                  Wipe all positions, history and deposits?
                </span>
                <button className="chip" style={{ marginLeft: "auto", padding: "3px 8px" }}
                  onClick={() => setConfirmReset(false)}>
                  Cancel
                </button>
                <button className="mini" onClick={() => { reset(); setConfirmReset(false); }}>
                  Reset
                </button>
              </>
            ) : (
              <>
                <span className="lbl">Account</span>
                <button className="mini" style={{ marginLeft: "auto" }}
                  onClick={() => setConfirmReset(true)}
                  title="Clear everything and start over">
                  Reset account
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
