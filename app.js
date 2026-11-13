const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--");
const pct = (n) => (Number.isFinite(n) ? `${n > 0 ? "+" : ""}${n.toFixed(2)}%` : "--");
const tone = (n) => (n >= 0 ? "up" : "down");
const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const ist = (ts, extra = {}) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false, ...extra }).format(new Date(ts * 1000));
// On GitHub Pages there is no server: build_static.py publishes the same responses as JSON files.
const STATIC = document.documentElement.dataset.static === "1";
const marketUrl = (symbol, interval) => (STATIC
  ? (symbol ? `api/${encodeURIComponent(`${symbol}-${interval}`)}.json` : "api/market.json")
  : `/api/market${symbol ? `?${new URLSearchParams({ symbol, interval })}` : ""}`);
const initials = (text) => String(text).replace(/[^A-Za-z ]/g, "").split(" ").filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
const flash = (symbol) => state.moved?.[symbol] || "";
const indexName = (symbol) => ({ NIFTY: "NIFTY 50", BANKNIFTY: "BANK NIFTY" })[symbol] || symbol;
const emptyText =(w, h, text) => `<text x="${w / 2}" y="${h / 2}" text-anchor="middle" class="svg-empty">${esc(text)}</text>`;

function load(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    return Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    toast(`Could not save: ${error.message}`);
    return false;
  }
}

const state = {
  stocks: [], sectors: [], index: null, lastTimestamp: null, loaded: false,
  bias: "all", freshBias: "all", minRR: false, sector: "", query: "", sort: "change",
  detail: null, interval: "5m", charts: {},
  live: { symbol: "NIFTY", quote: null, error: "", busy: null },
  predict: { quotes: [], model: null, loaded: false, error: "", busy: false, prev: {}, seen: new Set() },
  feedback: load("zonescope-feedback", []),
};

let toastTimer;
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/* ---------- market session & feed ---------- */

function marketSession() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
    .formatToParts(new Date()).map((p) => [p.type, p.value]));
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const weekend = parts.weekday === "Sat" || parts.weekday === "Sun";
  // shortcut: ignores NSE trading holidays; add a holiday list if the label matters on those days.
  if (!weekend && minutes >= 555 && minutes < 930) return { open: true, label: "Market open · live", left: 930 - minutes };
  if (!weekend && minutes < 555) return { open: false, label: "Pre-open · opens 09:15" };
  return { open: false, label: `Closed · opens ${parts.weekday === "Fri" || parts.weekday === "Sat" ? "Monday" : "tomorrow"}` };
}

// Top-bar clock: IST date and time, plus the session (with time left while the market is open).
function tickClock() {
  const now = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  $("clock-time").textContent = `${now.replace(",", "").toUpperCase()} IST`;
  const s = marketSession();
  const session = $("clock-session");
  session.textContent = s.open ? `● OPEN ${Math.floor(s.left / 60)}h${String(s.left % 60).padStart(2, "0")}m left` : `● ${s.label.split(" · ")[0].toUpperCase()}`;
  session.className = s.open ? "up" : "muted";
}

// Ticker tape: indices, sectors, then stocks; the list is doubled so the scroll loops seamlessly.
function renderTape() {
  const all = [state.index, state.indexBank, ...state.sectors, ...state.stocks].filter(Boolean);
  if (!all.length) return;
  const items = all.map((q) => `<span class="tape-item"><b>${esc(indexName(q.symbol))}</b> <span class="${flash(q.symbol)}">${fmt(q.price)}</span> <span class="${tone(q.changePercent)}">${q.changePercent >= 0 ? "▲" : "▼"}${pct(q.changePercent)}</span></span>`).join("");
  const track = $("tape-track");
  track.innerHTML = items + `<span aria-hidden="true">${items}</span>`;
  track.style.animationDuration = `${all.length * 1.6}s`;
}

// Home overview strip: the two indices, breadth, best and worst stock, and today's fresh order blocks.
function renderOverview() {
  const cell = (label, body, extra = "") => `<div class="ov-cell ${extra}"><small>${label}</small>${body}</div>`;
  const quote = (q) => q ? `<b class="ov-price ${flash(q.symbol)}">${fmt(q.price)}</b><span class="${tone(q.changePercent)}">${q.changePercent >= 0 ? "▲" : "▼"} ${pct(q.changePercent)}</span>` : "<b>--</b>";
  const ups = state.stocks.filter((s) => s.changePercent >= 0).length;
  const downs = state.stocks.length - ups;
  const sorted = [...state.stocks].sort((a, b) => b.changePercent - a.changePercent);
  const mover = (s) => s ? `<button type="button" class="ov-stock" data-symbol="${esc(s.symbol)}"><b>${esc(s.symbol)}</b> <span class="${tone(s.changePercent)}">${pct(s.changePercent)}</span></button>` : "<b>--</b>";
  const fresh = freshList();
  const freshUp = fresh.filter((s) => biasOf(s) === "bullish").length;
  $("overview").innerHTML = [
    cell("NIFTY 50", quote(state.index)),
    cell("BANK NIFTY", quote(state.indexBank)),
    cell(`ADVANCE / DECLINE · ${state.stocks.length}`, `<b><span class="up">${ups}</span> / <span class="down">${downs}</span></b>
      <span class="ov-bar" aria-hidden="true"><i class="up" style="width:${state.stocks.length ? (ups / state.stocks.length) * 100 : 50}%"></i><i class="down"></i></span>`),
    cell("TOP GAINER", mover(sorted[0])),
    cell("TOP LOSER", mover(sorted.at(-1))),
    cell("FRESH OB TODAY", `<a href="#fresh"><b>${fresh.length}</b> <span class="muted"><span class="up">▲${freshUp}</span> <span class="down">▼${fresh.length - freshUp}</span></span></a>`),
  ].join("");
}

function setFeed(ok, message, source = "") {
  $("feed-dot").className = `dot ${ok ? "ok" : "bad"}`;
  $("feed-label").textContent = ok ? `${source === "Dhan + Yahoo" ? "Live · Dhan" : "Indicative · Yahoo"}${message ? ` · ${message}` : ""}` : "Feed error";
  const banner = $("feed-error");
  banner.hidden = ok;
  if (!ok) banner.textContent = state.loaded
    ? `Refresh failed: ${message} Showing the last data received (${state.lastTimestamp ? ist(state.lastTimestamp) : "--"} IST). Retrying every minute.`
    : `Could not load market data: ${message} Retrying every minute.`;
}

async function refresh() {
  try {
    const response = await fetch(marketUrl(), { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.quotes) throw new Error(data.error?.message || `Market request failed (${response.status}).`);
    const all = Object.values(data.quotes);
    // Prices that changed since the last refresh flash green/red once (see flash()).
    const prev = Object.fromEntries([...state.stocks, ...state.sectors, state.index, state.indexBank].filter(Boolean).map((q) => [q.symbol, q.price]));
    state.moved = Object.fromEntries(all.filter((q) => prev[q.symbol] !== undefined && q.price !== prev[q.symbol])
      .map((q) => [q.symbol, q.price > prev[q.symbol] ? "flash-up" : "flash-down"]));
    const prevPct = Object.fromEntries(state.stocks.map((q) => [q.symbol, q.changePercent]));
    state.stocks = all.filter((q) => q.kind === "stock");
    // Stocks that crossed the previous close since the last refresh get a 4 s flare on the board.
    const now = performance.now();
    state.flares = [...(state.flares || []).filter((f) => f.until > now), ...state.stocks
      .filter((s) => prevPct[s.symbol] !== undefined && (prevPct[s.symbol] >= 0) !== (s.changePercent >= 0))
      .map((s) => ({ symbol: s.symbol, up: s.changePercent >= 0, until: now + 4000 }))];
    state.sectors = all.filter((q) => q.kind === "sector");
    state.index = data.quotes.NIFTY || null;
    state.indexBank = data.quotes.BANKNIFTY || null;
    state.lastTimestamp = Math.max(...all.map((q) => q.timestamp).filter(Number.isFinite));
    state.loaded = true;
    setFeed(true, data.errors?.length ? `${data.errors.length} unavailable` : data.dhan?.enabled && !data.dhan.connected ? "Dhan offline" : "", data.source);
  } catch (error) {
    setFeed(false, error.message);
  }
  renderMarket();
}

function renderMarket() {
  const session = marketSession();
  const pill = $("session-pill");
  pill.classList.toggle("open", session.open);
  pill.querySelector("span").textContent = session.label;
  renderTape();
  renderOverview();
  renderDepth();
  renderMovers();
  renderSectors();
  renderOrderBlock();
  renderFresh();
  if ($("stock-dialog").open) renderStock();
  $("symbol-options").innerHTML = state.stocks.map((s) => `<option value="${esc(s.symbol)}">${esc(s.name)}</option>`).join("");
  $("cmd-options").innerHTML = [
    ...[...document.querySelectorAll("[data-view-link]")].map((a) => [a.textContent.toUpperCase(), "Tab"]),
    ["NIFTY", "NIFTY 50"], ["BANKNIFTY", "Bank Nifty"],
    ...state.sectors.map((s) => [s.symbol, `${s.name} sector`]),
    ...state.stocks.map((s) => [s.symbol, s.name]),
  ].map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join("");
  const select = $("ob-sector");
  if (select.options.length === 1 && state.sectors.length) {
    select.insertAdjacentHTML("beforeend", state.sectors.map((s) => `<option value="${esc(s.symbol)}">${esc(s.name)}</option>`).join(""));
    select.value = state.sector;
  }
  const liveSelect = $("live-symbol");
  if (liveSelect.options.length <= 1 && state.stocks.length) {
    liveSelect.innerHTML = `<option value="NIFTY">NIFTY 50</option><option value="BANKNIFTY">BANK NIFTY</option>${[...state.stocks].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((s) => `<option value="${esc(s.symbol)}">${esc(s.symbol)}</option>`).join("")}`;
    liveSelect.value = state.live.symbol;
    if (liveSelect.value !== state.live.symbol) setLiveSymbol(liveSelect.value = "NIFTY");
  }
}

/* ---------- charts ---------- */

function vwapSeries(candles) {
  let pv = 0;
  let vol = 0;
  return candles.map((c) => {
    pv += ((c.high + c.low + c.close) / 3) * (c.volume || 0);
    vol += c.volume || 0;
    return vol ? pv / vol : null;
  });
}

function chartSvg(candles, analysis, { w = 180, h = 60, axis = false, levels = false, vwap = false, prevClose = null, price = null } = {}) {
  if (!candles?.length) return `<svg viewBox="0 0 ${w} ${h}" class="chart">${emptyText(w, h, "No bars")}</svg>`;
  const pad = axis ? { l: 6, r: 64, t: 12, b: 22 } : { l: 3, r: levels ? 40 : 12, t: 6, b: 6 };
  const zone = analysis?.zone;
  const extra = [zone?.low, zone?.high];
  if (levels || axis) extra.push(analysis?.stop, ...(analysis?.targets || []));
  if (axis) extra.push(prevClose);
  const values = [...candles.flatMap((c) => [c.low, c.high]), ...extra.filter(Number.isFinite)];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const margin = (hi - lo) * 0.06 || hi * 0.001 || 1;
  lo -= margin;
  hi += margin;
  const plotW = w - pad.l - pad.r;
  const X = (i) => pad.l + (candles.length === 1 ? 0.5 : i / (candles.length - 1)) * plotW;
  const Y = (v) => pad.t + ((hi - v) / (hi - lo)) * (h - pad.t - pad.b);
  const bodyW = Math.max(1, (plotW / candles.length) * 0.6);
  let out = "";

  if (axis) {
    for (let i = 0; i <= 4; i += 1) {
      const v = hi - ((hi - lo) * i) / 4;
      out += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${w - pad.r + 6}" y="${Y(v) + 3}" class="axis">${fmt(v)}</text>`;
    }
    const times = [0, Math.floor(candles.length / 2), candles.length - 1];
    const daily = candles.length > 1 && candles[candles.length - 1].timestamp - candles[0].timestamp > 86400 * 1.5;
    for (const i of times) out += `<text x="${X(i)}" y="${h - 6}" text-anchor="${i === 0 ? "start" : i === candles.length - 1 ? "end" : "middle"}" class="axis">${ist(candles[i].timestamp, daily ? { day: "2-digit", month: "short", hour: undefined, minute: undefined } : {})}</text>`;
  }
  if (axis && Number.isFinite(prevClose)) out += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(prevClose)}" y2="${Y(prevClose)}" class="prev-close"/>`;
  if (zone) {
    const start = Math.max(0, candles.findIndex((c) => c.timestamp === zone.timestamp));
    const kind = analysis.bias === "bullish" ? "zone-bull" : "zone-bear";
    out += `<rect x="${X(start) - bodyW}" y="${Y(zone.high)}" width="${w - pad.r - X(start) + bodyW}" height="${Math.max(2, Y(zone.low) - Y(zone.high))}" class="${kind}"/>`;
    out += `<text x="${w - pad.r - 2}" y="${Y(zone.low) + (analysis.bias === "bullish" ? 9 : -3)}" text-anchor="end" class="zone-label ${kind}">OB</text>`;
  }
  if ((levels || axis) && analysis) {
    const marks = [["STOP", analysis.stop, "lvl-stop"], ["T1", analysis.targets[0], "lvl-target"], ["T2", analysis.targets[1], "lvl-target"]];
    for (const [label, v, cls] of marks) {
      if (!Number.isFinite(v)) continue;
      out += `<line x1="${pad.l}" x2="${w - pad.r}" y1="${Y(v)}" y2="${Y(v)}" class="${cls}"/><text x="${w - pad.r + 3}" y="${Y(v) + 3}" class="lvl-text ${cls}">${label}${axis ? ` ${fmt(v)}` : ""}</text>`;
    }
  }
  candles.forEach((c, i) => {
    const cls = c.close >= c.open ? "c-up" : "c-down";
    const top = Math.min(Y(c.open), Y(c.close));
    out += `<line x1="${X(i)}" x2="${X(i)}" y1="${Y(c.high)}" y2="${Y(c.low)}" class="${cls}"/><rect x="${X(i) - bodyW / 2}" y="${top}" width="${bodyW}" height="${Math.max(0.8, Math.abs(Y(c.open) - Y(c.close)))}" class="${cls}"/>`;
  });
  if (vwap) {
    const points = vwapSeries(candles).map((v, i) => (v ? `${X(i).toFixed(1)},${Y(v).toFixed(1)}` : "")).filter(Boolean).join(" ");
    if (points) out += `<polyline points="${points}" class="vwap"/>`;
  }
  const last = Number.isFinite(price) ? price : candles[candles.length - 1].close;
  const lastCls = analysis?.bias === "bearish" ? "down" : "up";
  out += `<line x1="${X(candles.length - 1)}" x2="${w - pad.r + (axis ? 0 : 8)}" y1="${Y(last)}" y2="${Y(last)}" class="last-line ${lastCls}"/><circle cx="${X(candles.length - 1)}" cy="${Y(last)}" r="${axis ? 3.5 : 2.4}" class="last-dot ${lastCls}"/>`;
  return `<svg viewBox="0 0 ${w} ${h}" class="chart" preserveAspectRatio="${axis ? "xMidYMid meet" : "none"}">${out}</svg>`;
}

function renderDepth() {
  const svg = $("depth-chart");
  $("depth-time").textContent = state.lastTimestamp ? ist(state.lastTimestamp) : "--:--";
  const changes = state.stocks.map((s) => s.changePercent).filter(Number.isFinite);
  if (!changes.length) { svg.innerHTML = emptyText(940, 150, state.loaded ? "No stock quotes" : "Waiting for market data…"); return; }
  const range = Math.max(1, Math.ceil(Math.max(...changes.map(Math.abs))));
  const left = 20; const right = 920; const top = 34; const base = 120; const mid = (left + right) / 2;
  const x = (c) => mid - (c / range) * (mid - left);
  const depthAt = (c) => (c >= 0 ? changes.filter((v) => v >= c).length : changes.filter((v) => v <= c).length);
  const bull = changes.filter((v) => v >= 0).length;
  const bear = changes.length - bull;
  const peak = Math.max(bull, bear, 1);
  const h = (n) => (n / peak) * (base - top);
  let bars = "";
  for (let px = left; px <= right; px += 4) {
    const c = ((mid - px) / (mid - left)) * range;
    const n = depthAt(c);
    if (n) bars += `<rect x="${px - 1}" y="${base - h(n)}" width="2.2" height="${h(n)}" class="${c >= 0 ? "bar-up" : "bar-down"}"/>`;
  }
  const step = range / 6;
  const ticks = Array.from({ length: 13 }, (_, i) => range - i * step);
  const line = (side) => ticks.filter((c) => (side ? c >= 0 : c <= 0)).map((c) => `${x(c)},${base - h(depthAt(c === 0 && !side ? -1e-9 : c))}`).join(" ");
  let dots = "";
  let bands = "";
  ticks.forEach((c, i) => {
    const n = c === 0 ? 0 : depthAt(c);
    if (c !== 0) dots += `<circle cx="${x(c)}" cy="${base - h(n)}" r="3.4" class="${c > 0 ? "dot-up" : "dot-down"}"/>`;
    dots += `<text x="${x(c)}" y="${base + 20}" text-anchor="middle" class="axis">${c === 0 ? "0" : `${c > 0 ? "+" : ""}${c.toFixed(1)}%`}</text>`;
    if (i < ticks.length - 1) {
      const hiC = c; const loC = ticks[i + 1];
      const names = state.stocks.filter((s) => s.changePercent <= hiC && s.changePercent > loC).sort((a, b) => b.changePercent - a.changePercent);
      bands += `<rect x="${x(hiC)}" y="${top - 10}" width="${x(loC) - x(hiC)}" height="${base - top + 10}" class="hover-band"><title>${loC.toFixed(1)}% to ${hiC.toFixed(1)}%: ${names.length ? esc(names.map((s) => `${s.symbol} ${pct(s.changePercent)}`).join(", ")) : "none"}</title></rect>`;
    }
  });
  svg.innerHTML = `
    <defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter></defs>
    <circle cx="${mid - 40}" cy="22" r="16" class="glow-up" filter="url(#glow)"/><circle cx="${mid + 40}" cy="40" r="16" class="glow-down" filter="url(#glow)"/>
    <text x="${mid - 12}" y="16" text-anchor="end" class="depth-label up">BULLISH ${bull}</text>
    <text x="${mid + 12}" y="34" class="depth-label down">BEARISH ${bear}</text>
    <line x1="${left}" x2="${right}" y1="${base}" y2="${base}" class="baseline"/>
    ${bars}
    <line x1="${mid}" x2="${mid}" y1="${top - 12}" y2="${base}" class="center-line"/>
    <polyline points="${line(true)}" class="depth-line up"/><polyline points="${line(false)}" class="depth-line down"/>
    ${dots}<rect x="${mid - 4}" y="${base - 4}" width="8" height="8" transform="rotate(45 ${mid} ${base})" class="center-diamond"/>
    ${bands}`;
}

/* ---------- home: movers ---------- */

function rangeBar(s) {
  const a = s.analysis;
  if (!a) return "";
  const pos = clamp(((s.price - a.dayLow) / (a.dayHigh - a.dayLow || 1)) * 100);
  return `<span class="range" title="Day range ${fmt(a.dayLow)} – ${fmt(a.dayHigh)}"><i style="width:${pos}%"></i><b style="left:${pos}%"></b></span>`;
}

function moverRow(s) {
  const t = tone(s.changePercent);
  return `<button type="button" class="mover ${t}" data-symbol="${esc(s.symbol)}" aria-label="${esc(s.symbol)} ${pct(s.changePercent)}, open in Dhan (new tab)">
    <span class="mover-id"><span class="pct-pill ${t}">${pct(s.changePercent)}</span><span class="avatar ${t}">${esc(initials(s.name))}</span></span>
    <span class="mover-info"><span class="mover-name"><b>${esc(s.symbol)}</b><i class="tag ${t}">${t === "up" ? "BULL" : "BEAR"}</i></span><small>${esc(s.name)} · ₹${fmt(s.price)}</small>${rangeBar(s)}</span>
    <span class="mover-chart">${chartSvg(s.candles, s.analysis, { w: 180, h: 62, vwap: true, price: s.price })}</span>
  </button>`;
}

function renderMovers() {
  const sorted = [...state.stocks].sort((a, b) => b.changePercent - a.changePercent);
  const bulls = sorted.filter((s) => s.changePercent >= 0).slice(0, 3);
  const bears = sorted.filter((s) => s.changePercent < 0).reverse().slice(0, 3);
  $("top-bullish").innerHTML = bulls.map(moverRow).join("") || `<p class="empty">${state.loaded ? "No advancing stocks." : "Loading…"}</p>`;
  $("top-bearish").innerHTML = bears.map(moverRow).join("") || `<p class="empty">${state.loaded ? "No declining stocks." : "Loading…"}</p>`;
}

/* ---------- home: sectors ---------- */

// Display smoothing for the flow lines: a median of 3 drops one-bar spikes, then a centred average (up to 7 bars) calms
// the 5-minute noise. The window shrinks at the ends, so the line still starts and ends on the real values.
function calm(v) {
  const n = v.length;
  if (n < 4) return v;
  const med = v.map((x, i) => (i && i < n - 1 ? [v[i - 1], x, v[i + 1]].sort((a, b) => a - b)[1] : x));
  return med.map((_, i) => {
    const r = Math.min(3, i, n - 1 - i);
    let sum = 0;
    for (let j = i - r; j <= i + r; j++) sum += med[j];
    return sum / (2 * r + 1);
  });
}
const series = (q) =>(q.previousClose ? q.candles.map((c) => ((c.close - q.previousClose) / q.previousClose) * 100) : []);
const membersOf = (key) => state.stocks.filter((s) => s.sector === key).sort((a, b) => b.changePercent - a.changePercent);

// Heatmap tile: colour strength follows the % move (full at ±2%), with how many of its stocks are up.
function sectorTile(q) {
  const members = membersOf(q.symbol);
  const ups = members.filter((s) => s.changePercent >= 0).length;
  const strength = clamp(Math.abs(q.changePercent) / 2, 0.08, 1);
  return `<button type="button" class="heat-tile ${tone(q.changePercent)}" style="--heat:${strength.toFixed(2)}" data-sector="${esc(q.symbol)}" aria-label="${esc(q.name)} ${pct(q.changePercent)}, ${ups} of ${members.length} stocks up; show its stocks">
    <b>${esc(q.name)}</b><span class="heat-pct">${pct(q.changePercent)}</span><small>${ups}/${members.length} up · ${fmt(q.price)}</small>
  </button>`;
}

function renderSectors() {
  const sectors = [...state.sectors].sort((a, b) => b.changePercent - a.changePercent);
  const up = sectors.filter((s) => s.changePercent >= 0).length;
  $("sectors-up").textContent = up;
  $("sectors-down").textContent = sectors.length - up;
  $("sector-strip").innerHTML = sectors.map((s) => `<i class="${tone(s.changePercent)}" title="${esc(s.name)} ${pct(s.changePercent)}"></i>`).join("");
  const avg = sectors.length ? sectors.reduce((sum, s) => sum + s.changePercent, 0) / sectors.length : NaN;
  $("sector-avg").textContent = pct(avg);
  $("sector-avg").className = tone(avg);
  $("sector-heat").innerHTML = sectors.map(sectorTile).join("") || `<p class="empty">${state.loaded ? "No sector data." : "Loading…"}</p>`;

  const svg = $("sector-flow");
  const paths = sectors.map((q) => ({ q, s: series(q) })).filter((p) => p.s.length > 1);
  if (!paths.length) { svg.innerHTML = emptyText(440, 170, state.loaded ? "No sector bars" : "Loading…"); return; }
  const first = paths[0].q.candles;
  $("sector-flow-time").textContent = `${ist(first[0].timestamp)} – ${ist(first[first.length - 1].timestamp)} IST`;
  const range = Math.max(0.5, ...paths.flatMap((p) => p.s.map(Math.abs))) * 1.1;
  const L = 10; const R = 300; const T = 10; const B = 150;
  const maxLen = Math.max(...paths.map((p) => p.s.length));
  const X = (i) => L + (i / (maxLen - 1)) * (R - L);
  const Y = (v) => T + ((range - v) / (2 * range)) * (B - T);
  let out = `<rect x="0" y="0" width="${R}" height="${B}" class="heat-bg"/>`;
  out += heatmap(paths.flatMap((p) => pathCells(p.s, p.q.candles)), { L, R, T, B, lo: -range, hi: range, split: 0, cols: 48, rows: 56 });
  out += `<line x1="${L}" x2="${R}" y1="${Y(0)}" y2="${Y(0)}" class="baseline"/><line x1="${R}" x2="${R}" y1="${T}" y2="${B}" class="center-line"/>`;
  out += `<text x="${L}" y="${B + 16}" class="axis">${ist(first[0].timestamp)}</text><text x="${R}" y="${B + 16}" text-anchor="end" class="axis">${ist(first[first.length - 1].timestamp)}</text>`;
  out += `<text x="${L}" y="${T + 8}" class="axis">${pct(range)}</text><text x="${L}" y="${B - 2}" class="axis">${pct(-range)}</text>`;
  for (const { q, s } of paths) {
    out += `<polyline points="${s.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ")}" class="tape-line static"><title>${esc(q.name)} ${pct(q.changePercent)}</title></polyline>`;
  }
  out += `<circle cx="${L}" cy="${Y(0)}" r="4" class="origin"/>`;
  const labelled = [...paths.slice(0, 3), ...paths.slice(-3).filter((p) => paths.indexOf(p) >= 3)];
  labelled.forEach(({ q, s }, i) => {
    const ly = T + 4 + i * ((B - T) / Math.max(labelled.length - 1, 1)) * 0.95;
    const t = tone(q.changePercent);
    out += `<path d="M${X(s.length - 1)},${Y(s[s.length - 1])} L${R + 8},${ly}" class="leader ${t}"/><circle cx="${X(s.length - 1)}" cy="${Y(s[s.length - 1])}" r="2.6" class="last-dot ${t}"/>`;
    out += `<rect x="${R + 10}" y="${ly - 8}" width="128" height="16" rx="3" class="flow-tag ${t}"/><text x="${R + 15}" y="${ly + 3.5}" class="flow-tag-text">${esc(q.name.slice(0, 14).toUpperCase())}</text><text x="${R + 134}" y="${ly + 3.5}" text-anchor="end" class="flow-tag-text ${t}">${pct(q.changePercent)}</text>`;
  });
  svg.innerHTML = out;
}

/* ---------- order block view ---------- */

function biasOf(s) {
  return s.analysis?.bias || (s.changePercent >= 0 ? "bullish" : "bearish");
}

function filteredStocks() {
  const query = state.query.trim().toUpperCase();
  const list = state.stocks.filter((s) => (state.bias === "all" || biasOf(s) === state.bias)
    && (!state.minRR || s.analysis?.rewardRisk >= 2)
    && (!state.sector || s.sector === state.sector)
    && (!query || s.symbol.includes(query) || s.name.toUpperCase().includes(query)));
  const key = {
    change: (s) => Math.abs(s.changePercent),
    rr: (s) => s.analysis?.rewardRisk ?? -1,
    volume: (s) => s.analysis?.volumeRatio ?? -1,
  }[state.sort];
  return list.sort((a, b) => key(b) - key(a));
}

function zoneStatus(s) {
  const zone = s.analysis?.zone;
  if (!zone) return ["NO FRESH OB", "muted"];
  const at = ist(zone.timestamp);
  const ob = zone.weak ? "WEAK OB" : "OB";
  if (s.price >= zone.low && s.price <= zone.high) return [`IN ${ob} ZONE · ${at}`, zone.weak ? "weak" : "hot"];
  const edge = biasOf(s) === "bullish" ? zone.high : zone.low;
  return [`${ob} ${at} · ${(Math.abs(s.price - edge) / s.price * 100).toFixed(2)}% AWAY`, zone.weak ? "weak" : ""];
}

// Reward to T1 per unit of risk; 2R and up is highlighted as worth a look.
function rrLabel(s) {
  const rr = s.analysis?.rewardRisk;
  return Number.isFinite(rr) ? `<span class="rr ${rr >= 2 ? "good" : ""}" title="Reward to T1 ÷ risk to stop">R:R ${rr.toFixed(1)}</span>` : "";
}

function obCard(s) {
  const t = biasOf(s) === "bullish" ? "up" : "down";
  const [status, statusCls] = zoneStatus(s);
  const vr = s.analysis?.volumeRatio;
  return `<button type="button" class="ob-card ${t}" data-symbol="${esc(s.symbol)}">
    <span class="ob-card-head"><b><span class="bias-mark" aria-hidden="true">${t === "up" ? "▲" : "▼"}</span><span class="sr-only">${t === "up" ? "Bullish" : "Bearish"}</span> ${esc(s.symbol)}</b><span class="${tone(s.changePercent)}">${pct(s.changePercent)}</span></span>
    <span class="ob-card-chart">${chartSvg(s.candles, s.analysis, { w: 150, h: 40, price: s.price })}</span>
    <span class="ob-card-foot"><i class="tag mini ${statusCls} ${t}">${status}</i><span class="muted">${rrLabel(s)} <span title="Last bar volume vs session average">${Number.isFinite(vr) ? `VOL ${vr.toFixed(1)}×` : ""}</span></span></span>
  </button>`;
}

function detailCard(s, big) {
  const a = s.analysis;
  const bull = biasOf(s) === "bullish";
  const t = bull ? "up" : "down";
  const levels = a ? [
    [a.zone?.weak ? "WEAK ZONE" : "ZONE", a.zone ? `${fmt(a.zone.low)}–${fmt(a.zone.high)}` : "none"],
    ["FORMED", a.zone ? `${ist(a.zone.timestamp)} IST` : "--"],
    ["STOP", fmt(a.stop)], ["T1", fmt(a.targets[0])], ["T2", fmt(a.targets[1])],
    ["R:R", a.rewardRisk.toFixed(2)], ["RISK", `${a.riskPercent.toFixed(2)}%`],
  ] : [];
  // Risk bar: stop at one end, T2 at the other, price marker in between.
  const span = a ? Math.abs(a.targets[1] - a.stop) || 1 : 1;
  const pricePos = a ? clamp((Math.abs(s.price - a.stop) / span) * 100) : 0;
  const t1Pos = a ? clamp((Math.abs(a.targets[0] - a.stop) / span) * 100) : 0;
  return `<button type="button" class="detail-card ${t} ${big ? "big" : ""}" data-symbol="${esc(s.symbol)}">
    <span class="dc-head"><span class="bias-badge ${t}">${bull ? "BULLISH" : "BEARISH"}</span><b>${esc(s.symbol)}</b><small class="muted">₹${fmt(s.price)}</small><span class="pct-pill ${tone(s.changePercent)} push">${pct(s.changePercent)}</span></span>
    <span class="dc-chart">${chartSvg(s.candles, a, { w: 380, h: big ? 120 : 76, levels: true, vwap: true, price: s.price })}</span>
    <span class="dc-levels">${levels.map(([k, v]) => `<span><small>${k}</small><b>${v}</b></span>`).join("")}</span>
    ${a ? `<span class="risk-bar ${t}" title="Stop → price → targets"><i style="width:${pricePos}%"></i><b style="left:${pricePos}%"></b><u style="left:${t1Pos}%"></u></span>` : ""}
  </button>`;
}

// TapeSurf-style heatmap: each cell {x: 0..1 across time, v: level, w: weight} adds to a grid, and
// cells carry forward with decay so activity at a level leaves a horizontal streak, like resting liquidity.
function heatmap(cells, { L, R, T, B, lo, hi, split, cols, rows }) {
  const heat = Array.from({ length: cols }, () => new Float32Array(rows));
  for (const { x, v, w } of cells) {
    if (x < 0 || x > 1) continue;
    heat[Math.min(cols - 1, Math.floor(x * cols))][clamp(Math.floor(((hi - v) / (hi - lo)) * rows), 0, rows - 1)] += w;
  }
  for (let c = 1; c < cols; c += 1) for (let r = 0; r < rows; r += 1) heat[c][r] += heat[c - 1][r] * 0.82;
  const peak = Math.max(...heat.map((col) => Math.max(...col))) || 1;
  const cw = (R - L) / cols; const rh = (B - T) / rows;
  let out = "";
  heat.forEach((col, c) => col.forEach((h, r) => {
    const t = Math.sqrt(h / peak);
    if (t < 0.06) return;
    // Above the split (previous close): teal → mint. Below: deep red → orange → yellow.
    const fill = hi - ((r + 0.5) / rows) * (hi - lo) >= split ? `hsl(${168 - t * 18} 85% ${10 + t * 52}%)` : `hsl(${t * 55} 95% ${12 + t * 50}%)`;
    out += `<rect x="${(L + c * cw).toFixed(1)}" y="${(T + r * rh).toFixed(1)}" width="${(cw + 0.4).toFixed(1)}" height="${(rh * 0.82).toFixed(1)}" fill="${fill}" opacity="${(0.35 + t * 0.65).toFixed(2)}"/>`;
  }));
  return out;
}

// One heat cell per bar, weighted by relative volume (capped so the closing auction bar cannot wash out the rest).
function pathCells(v, candles, toX = (c, i) => i / v.length) {
  const avgVol = candles.reduce((n, c) => n + (c.volume || 0), 0) / candles.length || 1;
  return v.map((p, i) => ({ x: toX(candles[i], i), v: p, w: 0.4 + Math.min(4, (candles[i].volume || 0) / avgVol) }));
}

// Flow board geometry shared by the flow SVG and the connector overlay (gate width, header/footer bands).
const GATE = { band: 30, col: 0.28 };

// Left half of the board: every stock's % path fanning out of one origin at the open, over a heatmap, into a
// "gate" whose top column collects the bulls and bottom column the bears. Top/bottom name lists rank the extremes.
// Replay: a quote as it stood at time `cut` (its candles up to then; price and % from the last of them).
function clipQuote(q, cut) {
  const candles = q.candles.filter((c) => c.timestamp <= cut);
  const last = candles.at(-1);
  if (!last) return null;
  return { ...q, candles, price: last.close, changePercent: q.previousClose ? ((last.close - q.previousClose) / q.previousClose) * 100 : q.changePercent };
}

// 15-minute momentum in % points (last 3 five-minute bars); drives pulse speed and the "hot" glow.
const momentum = (v) => (v.length > 3 ? v.at(-1) - v.at(-4) : 0);

function boardSvg(allStocks, { W, H, main: fullMain, session, cut }) {
  const T = GATE.band; const B = H - GATE.band; const mid = H / 2;
  // Lines run to the right edge, where drawConnectors picks each one up and carries it into its stock's card.
  const x0 = 16; const gr = W - 4; const gx = gr - 6;
  const colH = (mid - T) * GATE.col;
  // The time axis always spans the whole session, so a replay grows left to right across it.
  const withBars = allStocks.filter((s) => s.candles.length);
  const t0 = Math.min(...withBars.map((s) => s.candles[0].timestamp));
  const t1 = Math.max(...withBars.map((s) => s.candles.at(-1).timestamp), fullMain?.candles.at(-1).timestamp || 0);
  const stocks = cut ? allStocks.map((s) => clipQuote(s, cut)).filter(Boolean) : allStocks;
  const main = cut && fullMain ? clipQuote(fullMain, cut) : fullMain;
  const paths = stocks.map((s) => ({ s, v: series(s) })).filter((p) => p.v.length > 1);
  let out = `<rect x="0" y="0" width="${W}" height="${H}" class="heat-bg"/>`;
  if (!paths.length) return out + emptyText(W, H, state.loaded ? "No stocks match" : "Loading…");
  const mv = main ? series(main) : [];
  // The % scale only widens during a session (per filter/size/live symbol), so the chart doesn't jolt when a move eases back.
  const rangeKey = `${new Date().toDateString()}|${W}x${H}|${main?.symbol}|${paths.map((p) => p.s.symbol).join()}`;
  if (flowRange.key !== rangeKey) Object.assign(flowRange, { key: rangeKey, value: 0 });
  const range = flowRange.value = Math.max(flowRange.value, Math.max(0.5, ...paths.flatMap((p) => p.v.map(Math.abs)), ...mv.map(Math.abs)) * 1.08);
  const Y = (v) => mid - (v / range) * (mid - T);
  const fx = (t) => clamp((t - t0) / (t1 - t0 || 1), 0, 1);
  const X = (t) => x0 + 26 + fx(t) * (gx - x0 - 26);
  state.flowGeo = { x0: x0 + 26, x1: gx, t0, t1, Y };
  const line = (s, v) => [[x0, mid], ...calm(v).map((p, i) => [X(s.candles[i].timestamp), Y(p)])];

  out += heatmap(paths.flatMap((p) => pathCells(p.v, p.s.candles, (c) => fx(c.timestamp))), { L: x0 + 26, R: gx, T, B, lo: -range, hi: range, split: 0, cols: 72, rows: Math.round((B - T) / 4.7) });
  for (const g of [-1, -0.5, 0.5, 1]) out += `<text x="2" y="${Y(range * g * 0.9) + 3}" class="axis">${pct(range * g * 0.9)}</text>`;
  out += `<text x="${x0 + 26}" y="${H - 10}" class="axis">${ist(t0)}</text><text x="${Math.min(gx, gr - 96)}" y="${H - 10}" text-anchor="end" class="axis">${ist(t1)}</text>`;


  // All stock paths, energy into the 3 strongest per side, then the 0% spine from origin through the gate.
  if (cut || !session?.open) out += `<text x="${(x0 + gx) / 2}" y="${mid + 8}" text-anchor="middle" class="flow-watermark">${cut ? `REPLAY ${ist(cut)}` : "MARKET CLOSED · LAST SESSION"}</text>`;
  // "Hot": the 6 fastest movers over the last 15 minutes (at least 0.2% points), so the glow stays rare.
  const hot = new Set(paths.map((p) => ({ k: p.s.symbol, m: Math.abs(momentum(p.v)) })).filter((p) => p.m >= 0.2).sort((a, b) => b.m - a.m).slice(0, 6).map((p) => p.k));
  for (const { s, v } of paths) out += `<path ${smoothAttrs(line(s, v))} class="tape-line ${tone(s.changePercent)}${hot.has(s.symbol) ? " hot" : ""}" pathLength="1" data-symbol="${esc(s.symbol)}" data-key="${esc(s.symbol)}"></path>`;
  // Fresh order blocks: a diamond on the stock's path at the bar where its zone formed.
  const fresh = new Set(freshList().map((s) => s.symbol));
  for (const { s, v } of paths) {
    const z = s.analysis?.zone;
    const i = z && fresh.has(s.symbol) ? s.candles.findIndex((c) => c.timestamp === z.timestamp) : -1;
    if (i < 0) continue;
    const mx = X(z.timestamp); const my = Y(calm(v)[i]);
    out += `<path d="M${mx.toFixed(1)} ${(my - 5).toFixed(1)}l5 5-5 5-5-5z" class="ob-mark ${biasOf(s) === "bullish" ? "up" : "down"}" data-symbol="${esc(s.symbol)}"><title>${esc(s.symbol)}: fresh ${biasOf(s)} order block at ${ist(z.timestamp)}</title></path>`;
  }
  const ranked = [...paths].sort((a, b) => b.s.changePercent - a.s.changePercent);
  const picks = [...ranked.slice(0, 3).filter((p) => p.s.changePercent > 0), ...ranked.slice(-3).filter((p) => p.s.changePercent < 0)];
  // Pulse speed follows the last 15 minutes, so what is moving now races and a stalled leader drifts.
  for (const { s, v } of picks) out += energyPath(line(s, v), tone(s.changePercent), momentum(v) * 6, s.symbol);
  // Zero-line crossings in the last refresh: an expanding ring at the stock's current point.
  const now = performance.now();
  for (const f of (cut ? [] : state.flares || []).filter((f) => f.until > now)) {
    const p = paths.find((x) => x.s.symbol === f.symbol);
    if (!p) continue;
    const [fx2, fy] = line(p.s, p.v).at(-1);
    const delay = -((4000 - (f.until - now)) / 1000).toFixed(2);
    out += `<circle cx="${fx2.toFixed(1)}" cy="${fy.toFixed(1)}" r="6" class="flare ${f.up ? "up" : "down"}" style="animation-delay:${delay}s"/><text x="${(fx2 - 10).toFixed(1)}" y="${(fy - 10).toFixed(1)}" text-anchor="end" class="flow-label ${f.up ? "up" : "down"} flare-label" style="animation-delay:${delay}s">${esc(f.symbol)} ${f.up ? "▲ turned bullish" : "▼ turned bearish"}</text>`;
  }
  const spot = state.spot && performance.now() < state.spot.until && paths.find((p) => p.s.symbol === state.spot.symbol);
  if (spot) out += `<path ${smoothAttrs(line(spot.s, spot.v))} class="spot-line" data-key="${esc(spot.s.symbol)}"/><text x="${(gx - 8).toFixed(1)}" y="${(Y(spot.v.at(-1)) - 10).toFixed(1)}" text-anchor="end" class="flow-label flow">${esc(spot.s.symbol)} ${pct(spot.s.changePercent)}</text>`;
  out += energyPath([[x0, mid], [gr, mid]], "flow", 4);
  out += `<circle cx="${x0}" cy="${mid}" r="5" class="origin-dot"/><circle cx="${gr}" cy="${mid}" r="3" class="spine-dot"/>`;

  // Ranked name lists: strongest bulls from the top edge down, weakest bears from the bottom edge up.
  const rows = clamp(Math.floor((mid - T - colH * 0.2) / 17), 0, 12);
  const maxAbs = Math.max(...paths.map((p) => Math.abs(p.s.changePercent)), 0.01);
  const listRow = (s, y) => {
    const t = tone(s.changePercent);
    return `<g class="flow-row ${t}" data-symbol="${esc(s.symbol)}" data-y="${y}"><rect x="${x0 + 18}" y="${y - 10}" width="138" height="14" rx="2" class="flow-row-bg"/><text x="${x0 + 22}" y="${y}" class="flow-row-name">${esc(s.symbol.slice(0, 10))}</text><line x1="${x0 + 92}" x2="${x0 + 92 + (Math.abs(s.changePercent) / maxAbs) * 34}" y1="${y - 3}" y2="${y - 3}" class="flow-row-bar ${t}"/><text x="${x0 + 152}" y="${y}" text-anchor="end" class="flow-row-pct ${t}">${pct(s.changePercent)}</text></g>`;
  };
  ranked.filter((p) => p.s.changePercent > 0).slice(0, rows).forEach((p, i) => { out += listRow(p.s, T + 12 + i * 17); });
  ranked.filter((p) => p.s.changePercent < 0).reverse().slice(0, rows).forEach((p, i) => { out += listRow(p.s, B - 4 - i * 17); });
  if (mv.length > 1) {
    const ml = line(main, mv);
    const [ex, ey] = ml.at(-1);
    const key = `main:${main.symbol}`;
    out += `<path ${smoothAttrs(ml)} class="main-line" data-key="${esc(key)}"/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" class="live-cursor ${session?.open ? "on" : ""}" data-follow="${esc(key)}"/>`;
    const label = `${indexName(main.symbol)} ${pct(main.changePercent)}`;
    // shortcut: width estimated at 8px per char (13px mono); skip the label when it would cover the ranked name list (the panel header shows it anyway).
    if (ex - 8 - label.length * 8 > x0 + 160) out += `<text x="${ex - 8}" y="${ey - 8}" text-anchor="end" class="flow-label flow" data-follow="${esc(key)}" data-dx="-8" data-dy="-8">${esc(label)}</text>`;
  }
  return out;
}

// Fresh OB tab: today's fresh (>=1.5xATR) zones formed at or after the 09:15 IST open, newest first.
function freshList() {
  const day = (ts) => ist(ts, { year: "numeric", month: "2-digit", day: "2-digit", hour: undefined, minute: undefined });
  const today = day(Date.now() / 1000);
  return state.stocks
    .filter((s) => { const z = s.analysis?.zone; return z && !z.weak && day(z.timestamp) === today && ist(z.timestamp) >= "09:15"; })
    .sort((a, b) => b.analysis.zone.timestamp - a.analysis.zone.timestamp);
}

function renderFresh() {
  const list = freshList();
  const bulls = list.filter((s) => biasOf(s) === "bullish").length;
  $("fresh-all-count").textContent = `(${list.length})`;
  $("fresh-bull-count").textContent = `(${bulls})`;
  $("fresh-bear-count").textContent = `(${list.length - bulls})`;
  const shown = state.freshBias === "all" ? list : list.filter((s) => biasOf(s) === state.freshBias);
  const what = state.freshBias === "all" ? "fresh order block" : `${state.freshBias} fresh order block`;
  $("fresh-summary").textContent = !state.loaded ? "Loading…" : shown.length
    ? `${shown.length} ${what}${shown.length === 1 ? "" : "s"} today, newest first.`
    : list.length ? `No ${what}s yet today.` : "No fresh order blocks yet today. They need about 10 five-minute bars, so the first ones appear after about 10:05 IST.";
  $("fresh-list").innerHTML = shown.map((s) => detailCard(s, false)).join("");
}

// Predictor tab: the server's ML ensemble (predictor.py), fetched only while the tab is open.
async function loadPredict() {
  if (state.predict.busy) return;
  state.predict.busy = true;
  if (!state.predict.loaded) renderPredict();
  try {
    const response = await fetch(STATIC ? "api/predict.json" : "/api/predict", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.predictions) throw new Error(data.error?.message || `Predictor request failed (${response.status}).`);
    state.predict.quotes = Object.values(data.predictions);
    state.predict.model = data;
    state.predict.error = "";
  } catch (error) {
    state.predict.error = error.message;
  }
  state.predict.loaded = true;
  state.predict.busy = false;
  renderPredict();
}

// Ranking is by the most likely *move*, so "Flat" never wins even when it's the single biggest arrow.
const topOutcome = (q) => q.prediction.outcomes.filter((o) => o.key !== "flat").reduce((a, b) => (b.probability > a.probability ? b : a));
const outcomeTone = (key) => (key.endsWith("up") ? "up" : key.endsWith("down") ? "down" : "flat");
const patternMarks = (p) => [...p.pattern].map((c) => `<i class="${c === "U" ? "up" : "down"}">${c === "U" ? "▲" : "▼"}</i>`).join("");

// One source node fanning into five arrows, each as thick as its probability and labelled with it.
function predictFlow(q, big) {
  const W = big ? 760 : 380; const H = big ? 270 : 180; const pad = big ? 26 : 20;
  const sx = big ? 150 : 92; const tx = big ? 470 : 236; const cy = H / 2;
  const top = topOutcome(q);
  const { atr, outcomes, pattern } = q.prediction;
  // Entrance order: least likely first, so the ★ move lands last (the peak); flat ties go before it.
  const order = [...outcomes].sort((a, b) => (a === top) - (b === top) || a.probability - b.probability);
  const prev = state.predict.prev[q.symbol] || {};
  let out = `<rect x="4" y="${cy - (big ? 34 : 26)}" width="${sx - 4}" height="${big ? 68 : 52}" rx="10" class="pr-node"/>
    <text x="${(sx + 4) / 2}" y="${cy - (big ? 6 : 4)}" text-anchor="middle" class="pr-node-name${big ? " big" : ""}">${esc(indexName(q.symbol))}</text>
    <text x="${(sx + 4) / 2}" y="${cy + (big ? 20 : 15)}" text-anchor="middle" class="pr-node-pattern">${[...pattern].map((c) => `<tspan class="${c === "U" ? "up" : "down"}">${c === "U" ? "▲" : "▼"}</tspan>`).join(" ")}</text>`;
  outcomes.forEach((o, i) => {
    const y = pad + (i * (H - 2 * pad)) / (outcomes.length - 1);
    const sw = 1.5 + o.probability * (big ? 44 : 28);
    const head = sw / 2 + 5; const mx = (sx + tx) / 2; const end = tx - 12;
    const cls = `${outcomeTone(o.key)}${o.key.startsWith("strong") ? " strong" : ""}${o === top ? " top" : ""}`;
    const level = o.low !== null && o.high !== null && o.key === "flat"
      ? `${fmt(q.price - 0.2 * atr)}–${fmt(q.price + 0.2 * atr)}`
      : o.key.endsWith("up") ? `≥ ${fmt(q.price + o.low * atr)}` : `≤ ${fmt(q.price + o.high * atr)}`;
    const id = `pr-${q.symbol}-${o.key}`.replace(/[^\w-]/g, "");
    const pctNow = Math.round(o.probability * 100);
    const changed = prev[o.key] !== undefined && prev[o.key] !== pctNow ? ` changed ${pctNow > prev[o.key] ? "rise" : "fall"}` : "";
    // Probability as flow volume: more likely moves carry more dots; dots are staggered by negative begins so they're already spread out.
    const dots = Math.max(1, Math.round(o.probability * 10)); const dur = big ? 1.8 : 1.5;
    const flow = Array.from({ length: dots }, (_, k) => `<circle r="${big ? 3 : 2.2}" class="pr-dot ${cls}"><animateMotion dur="${dur}s" begin="${(-k * dur / dots).toFixed(2)}s" repeatCount="indefinite"><mpath href="#${id}"/></animateMotion></circle>`).join("");
    out += `<g class="pr-out ${cls}" style="--d:${order.indexOf(o)}">
      <path id="${id}" d="M${sx} ${cy} C${mx} ${cy} ${mx} ${y.toFixed(1)} ${end} ${y.toFixed(1)}" pathLength="1" class="pr-arrow ${cls}" stroke-width="${sw.toFixed(1)}"/>
      ${flow}
      <polygon points="${end - 1},${(y - head).toFixed(1)} ${tx},${y.toFixed(1)} ${end - 1},${(y + head).toFixed(1)}" class="pr-head ${cls}"/>
      <text x="${tx + 8}" y="${(y + 5).toFixed(1)}" class="pr-pct ${cls}${big ? " big" : ""}${changed}">${pctNow}%</text>
      <text x="${tx + (big ? 68 : 52)}" y="${(y + (big ? 1 : 4)).toFixed(1)}" class="pr-label ${cls}">${esc(o.label)}${o === top ? " ★" : ""}</text>
      ${big ? `<text x="${tx + 68}" y="${(y + 15).toFixed(1)}" class="pr-level">${level}</text>` : ""}</g>`;
  });
  const words = outcomes.map((o) => `${o.label} ${Math.round(o.probability * 100)}%`).join(", ");
  return `<svg class="pr-flow${big ? " big" : ""}" data-symbol-flow="${esc(q.symbol)}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${q.symbol} next daily candle: ${words}`)}">${out}</svg>`;
}

// Loading skeleton: ghost fans in the same shape as the real flows, so the layout doesn't jump when data lands.
function ghostFlow(big) {
  const W = big ? 760 : 380; const H = big ? 270 : 180; const pad = big ? 26 : 20; const sx = big ? 150 : 92; const tx = big ? 470 : 236; const cy = H / 2; const mx = (sx + tx) / 2;
  const arms = [0, 1, 2, 3, 4].map((i) => { const y = pad + (i * (H - 2 * pad)) / 4; return `<path d="M${sx} ${cy} C${mx} ${cy} ${mx} ${y} ${tx} ${y}"/><rect x="${tx + 8}" y="${y - 6}" width="${big ? 120 : 80}" height="12" rx="2"/>`; }).join("");
  return `<svg class="pr-flow pr-ghost" viewBox="0 0 ${W} ${H}" aria-hidden="true"><rect x="4" y="${cy - 26}" width="${sx - 4}" height="52" rx="10"/>${arms}</svg>`;
}

// Entrance plays once per stock per session, when its flow scrolls into view; later refreshes don't replay it.
const prIntro = "IntersectionObserver" in window ? new IntersectionObserver((entries) => entries.forEach((e) => {
  if (!e.isIntersecting) return;
  prIntro.unobserve(e.target);
  state.predict.seen.add(e.target.dataset.symbolFlow);
  e.target.classList.add("intro");
}), { threshold: 0.35 }) : null;

// Stock-card dots only move while that card is hovered or focused; the two index flows always run.
function wirePredictMotion() {
  document.querySelectorAll("#view-predict .pr-flow:not(.pr-ghost)").forEach((svg) => {
    if (reducedMotion()) { svg.pauseAnimations(); svg.setCurrentTime(0.6); return; }
    if (prIntro && !state.predict.seen.has(svg.dataset.symbolFlow)) prIntro.observe(svg);
    if (!svg.classList.contains("big")) svg.pauseAnimations();
  });
}

function renderPredict() {
  const p = state.predict;
  const stocks = p.quotes.filter((q) => q.kind === "stock").sort((a, b) => topOutcome(b).probability - topOutcome(a).probability);
  const indices = ["NIFTY", "BANKNIFTY"].map((s) => p.quotes.find((q) => q.symbol === s)).filter(Boolean);
  const h = p.model?.holdout; const pc = (n) => `${Math.round(n * 100)}%`;
  $("predict-summary").innerHTML = !p.loaded ? "Training the models on 2 years of daily candles… (first load takes a few seconds)"
    : p.error ? esc(`Could not load predictions: ${p.error}${p.quotes.length ? " Showing the last data received." : ""}`)
    : `${stocks.length} stocks ranked by the probability of their most likely next-day move. Models: ${esc(p.model.models.join(" + "))}, trained on ${p.model.samples.toLocaleString("en-IN")} past days.`
      + (h ? `<br><b>Tested on ${h.rows.toLocaleString("en-IN")} recent days the models never saw:</b> picked the exact outcome ${pc(h.accuracy)} of the time (always guessing the most common one: ${pc(h.baseline)}); called up vs down right ${pc(h.direction)} (coin-flip baseline ${pc(h.directionBaseline)}).` : "");
  if (!p.loaded) {
    $("predict-market").innerHTML = [0, 1].map(() => `<article class="panel pr-market">${ghostFlow(true)}</article>`).join("");
    $("predict-list").innerHTML = Array.from({ length: 6 }, () => `<div class="panel pr-card">${ghostFlow(false)}</div>`).join("");
    return;
  }
  $("predict-market").innerHTML = indices.map((index) => `<article class="panel pr-market">
      <div class="section-head"><h2>${indexName(index.symbol)} · next daily candle</h2><span class="muted">ATR ${fmt(index.prediction.atr)} · close ${fmt(index.price)}</span></div>
      ${predictFlow(index, true)}
    </article>`).join("");
  $("predict-list").innerHTML = stocks.map((q, i) => {
    const t = topOutcome(q);
    return `<button type="button" class="panel pr-card" data-symbol="${esc(q.symbol)}">
      <span class="pr-card-head"><b class="pr-rank">#${i + 1}</b><b>${esc(q.symbol)}</b><span class="muted pr-name">${esc(q.name)}</span>
        <i class="tag mini ${outcomeTone(t.key) === "flat" ? "muted" : outcomeTone(t.key)} push">${esc(t.label)} ${Math.round(t.probability * 100)}%</i></span>
      ${predictFlow(q, false)}
      <span class="muted pr-foot">Last 3 candles ${patternMarks(q.prediction)} · ATR ${fmt(q.prediction.atr)} · close ${fmt(q.price)}</span>
    </button>`;
  }).join("");
  p.prev = Object.fromEntries(p.quotes.map((q) => [q.symbol, Object.fromEntries(q.prediction.outcomes.map((o) => [o.key, Math.round(o.probability * 100)]))]));
  wirePredictMotion();
}

// Mid-column card: OB status, a 5-dot strength meter and a volume-at-price profile with the current price.
function flowCard(s, maxAbs) {
  const t = biasOf(s) === "bullish" ? "up" : "down";
  const [status, statusCls] = zoneStatus(s);
  const dots = clamp(Math.round((Math.abs(s.changePercent) / maxAbs) * 5), 1, 5);
  const closes = s.candles.map((c) => c.close);
  const lo = Math.min(...closes); const hi = Math.max(...closes); const span = hi - lo || 1;
  const bins = Array(16).fill(0);
  s.candles.forEach((c) => { bins[clamp(Math.floor(((hi - c.close) / span) * 16), 0, 15)] += c.volume || 1; });
  const peak = Math.max(...bins) || 1;
  const py = ((hi - clamp(s.price, lo, hi)) / span) * 64 + 3;
  return `<button type="button" class="flow-card ${t}" data-symbol="${esc(s.symbol)}">
    <span class="fc-head"><span class="fc-avatar">${esc(initials(s.name))}</span><span class="bias-mark" aria-hidden="true">${t === "up" ? "▲" : "▼"}</span><span class="sr-only">${t === "up" ? "Bullish" : "Bearish"}</span><b>${esc(s.symbol)}</b><span class="pct-pill ${tone(s.changePercent)} push">${pct(s.changePercent)}</span></span>
    <span class="fc-tags"><i class="tag mini ${statusCls} ${t}">${status}</i>${rrLabel(s)}<span class="fc-dots" aria-label="Strength ${dots} of 5">${"●".repeat(dots)}${"○".repeat(5 - dots)}</span></span>
    <svg class="fc-profile" viewBox="0 0 200 70" preserveAspectRatio="none" aria-hidden="true">${bins.map((b, i) => `<rect x="0" y="${(3 + i * 4).toFixed(1)}" width="${((b / peak) * 170).toFixed(1)}" height="3.2" class="tape-bar ${t}"/>`).join("")}<line x1="0" x2="200" y1="${py.toFixed(1)}" y2="${py.toFixed(1)}" class="fc-price"/></svg>
  </button>`;
}

function renderOrderBlock() {
  const stocks = filteredStocks();
  $("ob-count").textContent = state.loaded ? `${stocks.length} of ${state.stocks.length} stocks` : "";
  const maxAbs = Math.max(...stocks.map((s) => Math.abs(s.changePercent)), 0.01);
  // Strongest first: the top 3 get detail cards, the next 3 profile cards, the next 18 compact cards.
  for (const [side, list] of [["bull", stocks.filter((s) => biasOf(s) === "bullish")], ["bear", stocks.filter((s) => biasOf(s) === "bearish")]]) {
    $(`fb-detail-${side}`).innerHTML = list.slice(0, 3).map((s, i) => detailCard(s, i === 0)).join("") || `<p class="empty">${state.loaded ? `No ${side}ish stocks match` : "Loading…"}</p>`;
    $(`fb-cards-${side}`).innerHTML = `<div class="fb-small">${list.slice(6, 24).map(obCard).join("")}</div><div class="fb-mid">${list.slice(3, 6).map((s) => flowCard(s, maxAbs)).join("")}</div>`;
    // Filter box: pressed when this side is the active filter, dimmed when the other side is; the count bumps when it changes.
    const box = $(`fb-filter-${side}`); const count = box.querySelector(".fb-filter-count");
    box.setAttribute("aria-pressed", String(state.bias === box.dataset.biasBox));
    box.classList.toggle("is-off", state.bias !== "all" && state.bias !== box.dataset.biasBox);
    if (state.loaded && count.textContent && count.textContent !== String(list.length)) { count.classList.remove("bump"); void count.offsetWidth; count.classList.add("bump"); }
    count.textContent = state.loaded ? list.length : "";
  }
  renderCourseLive();
  if (!state.introDone && stocks.length) playIntro();
  renderLive();
  requestAnimationFrame(() => { drawConnectors(); document.querySelectorAll(".fb-small, .fb-mid, .fb-detail").forEach(deckProgress); });
}

// Phone decks: how far along the swipe is, for the glowing line under each deck.
function deckProgress(deck) {
  if (deck.scrollWidth > deck.clientWidth) deck.style.setProperty("--p", ((deck.scrollLeft + deck.clientWidth) / deck.scrollWidth).toFixed(3));
}

// Real examples of the video's steps, picked from today's stocks; each jumps to that stock on the board.
function renderCourseLive() {
  // Teach with fresh blocks only; weak (>=1xATR) zones would muddy the examples.
  const withZone = state.stocks.filter((s) => s.analysis?.zone && !s.analysis.zone.weak);
  const inZone = withZone.filter((s) => s.price >= s.analysis.zone.low && s.price <= s.analysis.zone.high);
  const fresh = [...withZone].sort((a, b) => b.analysis.zone.timestamp - a.analysis.zone.timestamp)[0];
  const zoned = inZone.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent))[0];
  // Prefer a stock not already shown, so the three examples teach with three charts.
  const best = withZone.filter((s) => s !== fresh && s !== zoned).sort((a, b) => b.analysis.rewardRisk - a.analysis.rewardRisk)[0];
  const picks = [
    ["Step 1 · A fresh order block", fresh, "No fresh order block yet today"],
    ["Step 3 · Price in the zone now", zoned, "No stock is inside its zone right now"],
    ["Step 5 · Best reward : risk", best, "No other setup with a zone yet"],
  ];
  $("course-live").innerHTML = picks.map(([label, s, none]) => {
    if (!s) return `<div class="live-example muted"><small>${label}</small><p>${state.loaded ? none : "Loading…"}</p></div>`;
    const a = s.analysis, t = biasOf(s) === "bullish" ? "up" : "down", [status, cls] = zoneStatus(s);
    return `<div class="live-example ${t}">
      <small>${label}</small>
      <div class="live-example-head"><b>${esc(s.symbol)}</b><span class="pct-pill ${tone(s.changePercent)}">${pct(s.changePercent)}</span></div>
      <i class="tag mini ${cls} ${t}">${status}</i>
      <p class="muted">Zone ${fmt(a.zone.low)}–${fmt(a.zone.high)} · stop ${fmt(a.stop)} · T1 ${fmt(a.targets[0])} · R:R ${a.rewardRisk.toFixed(2)}</p>
      <button type="button" class="btn" data-show="${esc(s.symbol)}">Show on the board →</button>
    </div>`;
  }).join("");
}

// Spotlight a stock on the board: its path glows in the flow and its card is scrolled to and outlined.
function showOnBoard(symbol) {
  state.spot = { symbol, until: performance.now() + 6000 };
  goTo("orderblock");
  setTimeout(() => {
    renderLive();
    const card = document.querySelector(`#flowboard .fb-cards [data-symbol="${CSS.escape(symbol)}"], #flowboard .fb-detail [data-symbol="${CSS.escape(symbol)}"]`);
    (card || $("flowboard")).scrollIntoView({ behavior: "smooth", block: "center" });
    card?.classList.add("spotlight");
    setTimeout(() => card?.classList.remove("spotlight"), 4000);
  }, 60);
}

// First load: paths draw out of the open, connectors trace into the cards, cards slide in one by one.
let introUntil = 0;
function playIntro() {
  state.introDone = true;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const board = $("flowboard");
  board.querySelectorAll(".fb-cards [data-symbol], .fb-detail [data-symbol]").forEach((card, i) => card.style.setProperty("--i", i));
  board.classList.add("fb-intro");
  $("live-flow").innerHTML = ""; $("fb-links").innerHTML = ""; // so the first real draw isn't mistaken for one in progress
  introUntil = performance.now() + 2600;
  setTimeout(() => board.classList.remove("fb-intro"), 2600);
}
// While the intro runs, keep what it is animating instead of re-rendering it from scratch.
const introRunning = (el) => performance.now() < introUntil && el.querySelector("[pathLength]") !== null;

// Opening bell: once a day, when the market opens with the page open, a sweep crosses the board and a soft chime plays.
const bell = { on: true, ctx: null, wasOpen: null };
try { bell.on = localStorage.getItem("zonescope-bell") !== "off"; } catch { /* preference is a convenience only */ }
function ringBell() {
  const board = $("flowboard");
  board.classList.remove("fb-open"); void board.offsetWidth; board.classList.add("fb-open");
  setTimeout(() => board.classList.remove("fb-open"), 1800);
  if (!bell.on) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const c = bell.ctx ||= new AC();
  c.resume();
  const t = c.currentTime;
  for (const [f, d] of [[659.25, 0], [987.77, .18]]) { // E5 then B5
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(.16, t + d + .02); g.gain.exponentialRampToValueAtTime(.0001, t + d + 1.6);
    o.connect(g); g.connect(c.destination); o.start(t + d); o.stop(t + d + 1.7);
  }
}
function checkBell(open) {
  if (bell.wasOpen === false && open) {
    const today = new Date().toDateString();
    let rung = null;
    try { rung = localStorage.getItem("zonescope-bell-day"); localStorage.setItem("zonescope-bell-day", today); } catch { /* ring anyway */ }
    if (rung !== today) ringBell();
  }
  bell.wasOpen = open;
}
function setBell(on) {
  bell.on = on;
  try { localStorage.setItem("zonescope-bell", on ? "on" : "off"); } catch { /* preference is a convenience only */ }
  $("open-bell").textContent = on ? "Bell on" : "Bell off";
  $("open-bell").setAttribute("aria-pressed", String(on));
}

// A click flashes the card and surges its connector, then opens Dhan (within the click's activation window).
function fireStock(el, symbol) {
  const link = document.querySelector(`#fb-links [data-link="${CSS.escape(symbol)}"]`);
  el.classList.add("is-firing");
  link?.classList.add("surge");
  setTimeout(() => { el.classList.remove("is-firing"); link?.classList.remove("surge"); }, 900);
  setTimeout(() => openStock(symbol), link ? 420 : 0);
}

// Connector overlay: each stock's line continues from where it ends on the flow straight into its card, with energy
// on the strongest, and the white spine bends from the flow's centre to the line between the bull and bear rows.
function drawConnectors() {
  const board = $("flowboard"); const svg = $("fb-links");
  const box = board.getBoundingClientRect(); const flow = $("fb-flow").getBoundingClientRect();
  const cardsBull = $("fb-cards-bull").getBoundingClientRect(); const cardsBear = $("fb-cards-bear").getBoundingClientRect();
  if (!box.width || cardsBull.left < flow.right) { svg.innerHTML = ""; return; }
  if (introRunning(svg)) return;
  svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
  const sx = flow.right - box.left - 4; const top = flow.top - box.top;
  const mid = top + flow.height / 2;
  // A line's end in board coordinates, from its raw points (data-pts holds where a gliding line will land).
  const live = $("live-flow"); const ctm = live.getScreenCTM();
  const endOf = (symbol) => {
    const el = ctm && live.querySelector(`.tape-line[data-symbol="${CSS.escape(symbol)}"]`);
    if (!el) return [sx, mid];
    const p = parsePts(el.dataset.pts);
    return [ctm.a * p.at(-2) + ctm.e - box.left, ctm.d * p.at(-1) + ctm.f - box.top];
  };
  const divY = (cardsBull.bottom + cardsBear.top) / 2 - box.top;
  const cx = cardsBull.left - box.left;
  const seg = (x1, y1, x2, y2) => { const dx = (x2 - x1) * 0.55; return `C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`; };
  const curve = (x1, y1, x2, y2) => `M${x1.toFixed(1)},${y1.toFixed(1)} ${seg(x1, y1, x2, y2)}`;
  let out = "";
  for (const side of ["bull", "bear"]) {
    const t = side === "bull" ? "up" : "down";
    const cards = [...document.querySelectorAll(`#fb-detail-${side} [data-symbol], #fb-cards-${side} .fb-mid [data-symbol], #fb-cards-${side} .fb-small [data-symbol]`)];
    // Each line enters its side's filter box, crosses it in its own lane (lanes ordered by card height, so few cross), then fans out to its card.
    const f = $(`fb-filter-${side}`).getBoundingClientRect();
    const fl = f.left - box.left; const fr = f.right - box.left;
    const mids = cards.map((card) => { const r = card.getBoundingClientRect(); return r.top + r.height / 2; });
    const lane = new Map([...cards.keys()].sort((a, b) => mids[a] - mids[b]).map((k, n) => [k, n]));
    cards.forEach((card, i) => {
      const r = card.getBoundingClientRect();
      const [ex, ey] = endOf(card.dataset.symbol);
      const ly = f.top - box.top + ((lane.get(i) + 0.5) / cards.length) * f.height;
      const d = `${curve(ex, ey, fl, ly)} H${fr.toFixed(1)} ${seg(fr, ly, r.left - box.left, r.top - box.top + r.height / 2)}`;
      const s = state.stocks.find((x) => x.symbol === card.dataset.symbol);
      out += `<g data-link="${esc(card.dataset.symbol)}">${i < 6 ? energyPath(d, `${t} link`, s?.changePercent || 0) : `<path d="${d}" pathLength="1" class="link-line ${t}"/>`}</g>`;
    });
  }
  out += energyPath(`${curve(sx, mid, cx, divY)} H${box.width - 6}`, "flow link", 4);
  out += `<circle cx="${cx}" cy="${divY}" r="4" class="spine-dot"/><circle cx="${($("fb-detail-bull").getBoundingClientRect().left - box.left - 8).toFixed(1)}" cy="${divY}" r="5" class="origin-dot"/>`;
  svg.innerHTML = out;
}

/* ---------- stock dialog ---------- */

/* ---------- live price flow ---------- */

// Polls 1m bars for one instrument every 5 s; its path is the bright line drawn over the market tape.
async function pollLive() {
  const live = state.live;
  const symbol = live.symbol;
  if (live.busy === symbol || document.hidden || $("view-orderblock").hidden) return;
  live.busy = symbol;
  try {
    const response = await fetch(marketUrl(symbol, "1m"), { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.quote) throw new Error(result.error?.message || `Request failed (${response.status}).`);
    if (symbol !== live.symbol) return;
    // Yahoo's edges sometimes answer with an older snapshot; keep the newer one so price and time never step back.
    if (!(live.quote?.timestamp > result.quote.timestamp)) live.quote = result.quote;
    live.error = "";
  } catch (error) {
    if (symbol === live.symbol) live.error = error.message;
  } finally {
    if (live.busy === symbol) live.busy = null;
  }
  if (symbol === live.symbol) renderLive();
}

function setLiveSymbol(symbol) {
  state.live = { symbol, quote: null, error: "", busy: null };
  delete $("live-price").dataset.value; // a new symbol's price appears directly, not counted from the old one
  try { localStorage.setItem("zonescope-live", symbol); } catch { /* remembered symbol is a convenience only */ }
  renderLive();
  pollLive();
}

// Command box: an exact stock symbol, an index, a sector or a tab name; then a stock name prefix.
function runCommand(text) {
  const q = text.trim().toUpperCase();
  if (!q) return false;
  const showLive = (symbol) => { $("live-symbol").value = symbol; setLiveSymbol(symbol); };
  const index = { NIFTY: "NIFTY", "NIFTY 50": "NIFTY", BANKNIFTY: "BANKNIFTY", "BANK NIFTY": "BANKNIFTY" }[q];
  const stock = state.stocks.find((s) => s.symbol === q);
  const sector = state.sectors.find((s) => s.symbol === q || s.name.toUpperCase() === q);
  const tab = [...document.querySelectorAll("[data-view-link]")].find((a) => a.textContent.toUpperCase() === q || a.dataset.viewLink.toUpperCase() === q);
  const named = state.stocks.find((s) => s.name.toUpperCase().startsWith(q));
  if (stock || (!index && !sector && !tab && named)) {
    const symbol = (stock || named).symbol;
    showLive(symbol);
    showOnBoard(symbol);
  } else if (index) {
    showLive(index);
    goTo("orderblock");
  } else if (sector) {
    state.sector = sector.symbol;
    $("ob-sector").value = sector.symbol;
    renderOrderBlock();
    goTo("orderblock");
  } else if (tab) {
    location.hash = tab.getAttribute("href");
  } else {
    toast(`No stock, index, sector or tab called "${text.trim()}".`);
    return false;
  }
  return true;
}

function renderLive() {
  const { quote: q, error } = state.live;
  const svg = $("live-flow");
  const W = Math.round($("fb-flow").clientWidth); const H = Math.round($("fb-flow").clientHeight);
  const session = marketSession();
  checkBell(session.open);
  $("live-dot").className = `live-dot ${session.open && !error ? "on" : ""}`;
  $("live-state").textContent = error ? `Feed error: ${error}` : session.open ? (STATIC ? "Snapshot · updates every ~5–15 min" : "Live · every 5 s") : "Market closed · last session";
  if (q?.candles.length && q.previousClose) {
    const unit = q.kind === "stock" ? "₹" : "";
    countTo($("live-price"), q.price, unit);
    $("live-change").textContent = pct(q.changePercent);
    $("live-change").className = `pct-pill ${tone(q.changePercent)}`;
    $("live-time").textContent = q.timestamp ? `${ist(q.timestamp, { second: "2-digit" })} IST` : "--";
  }
  if (!W || !H || introRunning(svg)) return;
  const cut = replayCut();
  if (cut) $("live-state").textContent = `Replay · ${ist(cut)} IST`;
  $("flowboard").classList.toggle("fb-closed", !session.open && !cut);
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = boardSvg(filteredStocks(), { W, H, main: q?.candles.length && q.previousClose ? q : null, session, cut });
  // Replay redraws ~12 times a second, so easing would only lag behind it.
  const dims = cut ? "" : `${W}x${H}`;
  if (cut) glide.dims = ""; else glideFlow(svg, dims);
  slideRows(svg, dims);
  applyHover();
  drawConnectors(); // line ends move every refresh, so the connectors follow them
}

// Rank changes: name-list rows slide from their old slot to the new one; newcomers fade in.
const rowSlots = { dims: "", y: {} };
function slideRows(svg, dims) {
  const prev = rowSlots.dims === dims && dims ? rowSlots.y : null;
  rowSlots.dims = dims;
  rowSlots.y = {};
  svg.querySelectorAll(".flow-row").forEach((g) => {
    const y = Number(g.dataset.y);
    rowSlots.y[g.dataset.symbol] = y;
    if (!prev || reducedMotion()) return;
    const was = prev[g.dataset.symbol];
    if (was === undefined) g.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500 });
    else if (was !== y) g.animate([{ transform: `translateY(${was - y}px)` }, { transform: "none" }], { duration: 650, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

// Replay today: the board as it stood at a moment of the session; plays 09:15 → now in 20 s, or scrub the slider.
function replayCut() {
  const r = state.replay;
  const g = state.flowGeo;
  if (!r || !g) return null;
  return Math.round(g.t0 + r.frac * (g.t1 - g.t0));
}

function setReplay(on) {
  clearInterval(state.replay?.timer);
  state.replay = on ? { frac: 0, last: performance.now() } : null;
  $("replay-btn").textContent = on ? "■ Live" : "▶ Replay";
  $("replay-btn").setAttribute("aria-pressed", String(on));
  $("replay-range").hidden = !on;
  if (on) {
    $("replay-range").value = 0;
    state.replay.timer = setInterval(() => {
      const r = state.replay; const now = performance.now();
      r.frac = Math.min(1, r.frac + (now - r.last) / 20000);
      r.last = now;
      $("replay-range").value = Math.round(r.frac * 1000);
      if (r.frac >= 1) clearInterval(r.timer);
      renderLive();
    }, 80);
  }
  renderLive();
  if (!on) renderMarket(); // back to the live header (price, state)
}

const flowRange = { key: "", value: 0 };
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const parsePts = (s) => s.trim().split(/[\s,]+/).map(Number);

// Smooth line through every point (monotone cubic in x, like d3's curveMonotoneX): no corners, and no overshoot past the real highs/lows.
function smooth(f) {
  const n = f.length / 2; const X = (i) => f[2 * i]; const Y = (i) => f[2 * i + 1]; const r = (v) => v.toFixed(1);
  if (n < 3) return f.reduce((d, v, i) => d + (i % 2 ? `,${r(v)}` : `${i ? " L" : "M"}${r(v)}`), "");
  const h = []; const s = [];
  for (let i = 0; i < n - 1; i++) { h[i] = X(i + 1) - X(i) || 1e-6; s[i] = (Y(i + 1) - Y(i)) / h[i]; }
  const m = [s[0]];
  for (let i = 1; i < n - 1; i++) {
    const p = (s[i - 1] * h[i] + s[i] * h[i - 1]) / (h[i - 1] + h[i]);
    m[i] = (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), 0.5 * Math.abs(p)) || 0;
  }
  m[n - 1] = s[n - 2];
  let d = `M${r(X(0))},${r(Y(0))}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    d += ` C${r(X(i) + dx)},${r(Y(i) + dx * m[i])} ${r(X(i + 1) - dx)},${r(Y(i + 1) - dx * m[i + 1])} ${r(X(i + 1))},${r(Y(i + 1))}`;
  }
  return d;
}
// A smooth path's attributes from [[x, y], ...]; data-pts keeps the raw points so glideFlow can ease them.
const smoothAttrs = (pairs) => { const f = pairs.flat(); return `d="${smooth(f)}" data-pts="${f.map((v) => v.toFixed(1)).join(" ")}"`; };

// Glide: the board is redrawn every 5 s, so each line (and the live cursor and label that follow the main line)
// is eased from where it was drawn last to its new shape. A new bar grows out of the old last point.
const glide = { dims: "", pts: {}, raf: 0 };
function glideFlow(svg, dims) {
  const prev = glide.dims === dims ? glide.pts : {};
  glide.dims = dims;
  glide.pts = {};
  cancelAnimationFrame(glide.raf);
  const groups = {};
  svg.querySelectorAll("[data-key]").forEach((el) => (groups[el.dataset.key] ||= []).push(el));
  const jobs = [];
  for (const [key, els] of Object.entries(groups)) {
    const to = parsePts(els[0].dataset.pts);
    glide.pts[key] = to;
    let from = prev[key];
    if (from && from.length === to.length - 2) from = [...from, ...from.slice(-2)];
    if (!from || from.length !== to.length || from.every((v, i) => v === to[i])) continue;
    jobs.push({ key, els, from, to, follow: [...svg.querySelectorAll(`[data-follow="${CSS.escape(key)}"]`)] });
  }
  if (!jobs.length || reducedMotion()) return;
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 700); const e = 1 - (1 - k) ** 3;
    for (const j of jobs) {
      const cur = j.to.map((v, i) => j.from[i] + (v - j.from[i]) * e);
      glide.pts[j.key] = cur; // an interrupted glide restarts from where the line actually is
      const d = smooth(cur);
      j.els.forEach((el) => el.setAttribute("d", d));
      const [x, y] = cur.slice(-2);
      j.follow.forEach((el) => {
        const circle = el.tagName === "circle";
        el.setAttribute(circle ? "cx" : "x", (x + Number(el.dataset.dx || 0)).toFixed(1));
        el.setAttribute(circle ? "cy" : "y", (y + Number(el.dataset.dy || 0)).toFixed(1));
      });
    }
    if (k < 1) glide.raf = requestAnimationFrame(step);
  };
  step(start); // put lines back at their old shape now, so the fresh draw never flashes at the end position
}

// The big live price counts to its new value instead of snapping.
function countTo(el, value, unit) {
  const from = Number(el.dataset.value);
  el.dataset.value = value;
  cancelAnimationFrame(el._raf);
  if (!Number.isFinite(from) || from === value || reducedMotion()) { el.textContent = `${unit}${fmt(value)}`; return; }
  const start = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - start) / 700);
    el.textContent = `${unit}${fmt(from + (value - from) * (1 - (1 - k) ** 3))}`;
    if (k < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// Hover isolation: the stock line nearest the mouse lights up, the rest dim, and a tooltip shows its % at that time.
function nearestLine(e) {
  const g = state.flowGeo; const svg = $("live-flow");
  if (!g) return null;
  const box = svg.getBoundingClientRect();
  const x = e.clientX - box.left; const y = e.clientY - box.top;
  if (x < g.x0 || x > g.x1) return null;
  const t = g.t0 + ((x - g.x0) / (g.x1 - g.x0)) * (g.t1 - g.t0);
  let best = null;
  for (const s of filteredStocks()) {
    const v = series(s);
    if (v.length < 2 || t < s.candles[0].timestamp) continue;
    let i = s.candles.findIndex((c) => c.timestamp > t) - 1;
    if (i < 0) i = s.candles.length - 1;
    const d = Math.abs(g.Y(calm(v)[i]) - y); // match the drawn (smoothed) line; the tooltip still shows the real value
    if (d < 14 && (!best || d < best.d)) best = { s, i, v: v[i], d };
  }
  return best;
}

function applyHover() {
  const svg = $("live-flow");
  svg.classList.toggle("has-hover", Boolean(state.hover));
  svg.querySelectorAll(".is-hover").forEach((el) => el.classList.remove("is-hover"));
  if (state.hover) svg.querySelectorAll(`.tape-line[data-symbol="${CSS.escape(state.hover)}"]`).forEach((el) => el.classList.add("is-hover"));
}

function hoverFlow(e) {
  const hit = e && e.pointerType === "mouse" ? nearestLine(e) : null;
  state.hover = hit?.s.symbol || null;
  applyHover();
  const tip = $("flow-tip");
  tip.hidden = !hit;
  if (!hit) return;
  const box = $("fb-flow").getBoundingClientRect();
  tip.innerHTML = `<b>${esc(hit.s.symbol)}</b> <span class="${tone(hit.v)}">${pct(hit.v)}</span> <span class="muted">at ${ist(hit.s.candles[hit.i].timestamp)}</span><br><small class="muted">now ${pct(hit.s.changePercent)} · click to open on Dhan</small>`;
  const left = e.clientX - box.left + 14;
  tip.style.left = `${Math.min(left, box.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${e.clientY - box.top + 14}px`;
}

// A glowing wire with bright pulses running along it (a point list or an SVG path); bigger % moves flow faster.
// Re-renders replace the SVG every 5 s, so a negative delay keeps each pulse's phase continuous.
function energyPath(points, side, changePercent, key = "") {
  const geo = typeof points === "string" ? `path d="${points}"` : `path ${smoothAttrs(points)}${key ? ` data-key="${esc(key)}"` : ""}`;
  const secs = Math.max(0.5, 2.6 - Math.abs(changePercent) * 0.35);
  const phase = (performance.now() / 1000) % secs;
  return `<${geo} pathLength="1" class="energy-base ${side}"/><${geo} class="energy" style="animation-duration:${secs.toFixed(2)}s;animation-delay:-${phase.toFixed(2)}s"/>`;
}

function stockData() {
  const base = state.stocks.find((s) => s.symbol === state.detail);
  if (!base) return { base: null, data: null };
  if (state.interval === "5m") return { base, data: base };
  const cached = state.charts[`${state.detail}:${state.interval}`];
  return { base, data: cached?.data || null };
}

async function loadInterval(symbol, interval) {
  const key = `${symbol}:${interval}`;
  const cached = state.charts[key];
  if (cached && (cached.loading || Date.now() - cached.at < 60_000)) return;
  state.charts[key] = { ...cached, loading: true };
  $("stock-status").textContent = "Loading bars…";
  try {
    const response = await fetch(marketUrl(symbol, interval), { cache: "no-store" });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.quote) throw new Error(result.error?.message || `Request failed (${response.status}).`);
    state.charts[key] = { at: Date.now(), data: result.quote };
  } catch (error) {
    state.charts[key] = { at: Date.now(), data: cached?.data || null, error: error.message };
  }
  if (state.detail === symbol && state.interval === interval) renderStock();
}

function renderStock() {
  const { base, data } = stockData();
  if (!base) return;
  $("stock-title").textContent = base.symbol;
  $("stock-name").textContent = `${base.name} · ${state.sectors.find((s) => s.symbol === base.sector)?.name || base.sector} · NSE`;
  $("stock-price").textContent = `₹${fmt(base.price)}`;
  $("stock-change").textContent = pct(base.changePercent);
  $("stock-change").className = `pct-pill ${tone(base.changePercent)}`;
  document.querySelectorAll("[data-interval]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.interval === state.interval);
    b.setAttribute("aria-pressed", String(b.dataset.interval === state.interval));
  });
  const entry = state.charts[`${base.symbol}:${state.interval}`];
  if (!data) {
    $("stock-chart").innerHTML = chartSvg([], null, { w: 900, h: 360 });
    if (!entry?.loading) loadInterval(base.symbol, state.interval);
    if (entry?.error) $("stock-status").textContent = `Could not load bars: ${entry.error}`;
    $("stock-levels").innerHTML = "";
    return;
  }
  $("stock-chart").innerHTML = chartSvg(data.candles, data.analysis, { w: 900, h: 360, axis: true, vwap: state.interval === "5m", prevClose: base.previousClose, price: base.price });
  $("stock-status").textContent = `${data.candles.length} ${state.interval} bars · last ${data.timestamp ? ist(data.timestamp, state.interval === "1D" ? { day: "2-digit", month: "short", hour: undefined, minute: undefined } : {}) : "--"} IST · Yahoo Finance, indicative${entry?.error ? ` · refresh failed: ${entry.error}` : ""}${state.interval === "5m" ? " · blue line = VWAP" : ""}`;
  const a = data.analysis;
  $("stock-levels").innerHTML = a ? [
    ["Bias", a.bias === "bullish" ? "Bullish" : "Bearish", a.bias === "bullish" ? "up" : "down"],
    ["Order block", a.zone ? `${fmt(a.zone.low)} – ${fmt(a.zone.high)}${a.zone.weak ? " (weak, ≥1×ATR move)" : ""}` : "No order block", ""],
    ["Stop", fmt(a.stop), "down"],
    ["Target 1", `${fmt(a.targets[0])}`, "up"],
    ["Target 2", `${fmt(a.targets[1])}`, "up"],
    ["Targets from", a.targetSource === "swing" ? "Swing levels" : "R-multiples", ""],
    ["Reward : risk", a.rewardRisk.toFixed(2), ""],
    ["Risk", `${fmt(a.risk)} (${a.riskPercent.toFixed(2)}%)`, ""],
    ["ATR (bar)", fmt(a.atr), ""],
    ["Last bar volume", Number.isFinite(a.volumeRatio) ? `${a.volumeRatio.toFixed(2)}× avg` : "--", ""],
  ].map(([k, v, cls]) => `<div><small>${k}</small><b class="${cls}">${v}</b></div>`).join("") : `<p class="muted">Not enough bars to analyse.</p>`;
}

// TradingView writes M&M / BAJAJ-AUTO as M_M / BAJAJ_AUTO; Dhan asks the user to sign in first.
function openStock(symbol) {
  if (!state.stocks.some((s) => s.symbol === symbol)) return;
  window.open(`https://tv.dhan.co/?symbol=NSE:${symbol.replace(/[^A-Z0-9]/g, "_")}`, "_blank", "noopener");
}

function currentSetup() {
  const { base, data } = stockData();
  return { base, a: data?.analysis || base?.analysis };
}

/* ---------- feedback ---------- */

function timeAgo(iso) {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  for (const [unit, size] of [["d", 86400], ["h", 3600], ["m", 60]]) if (seconds >= size) return `${Math.floor(seconds / size)}${unit} ago`;
  return "";
}

function renderFeedback() {
  $("feedback-list").innerHTML = state.feedback.slice(0, 5).map((f) => `<li><i class="tag outline">${esc(f.kind)}</i> ${esc(f.message)} <small class="muted">${timeAgo(f.createdAt)}</small></li>`).join("");
}

/* ---------- routing & events ---------- */

const VIEWS = ["home", "orderblock", "fresh", "predict", "courses"];
function route() {
  const view = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
  document.querySelectorAll(".view").forEach((section) => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    if (link.dataset.viewLink === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  showCourse(view === "courses");
  if (view === "predict") loadPredict();
  pollLive();
}

// The course video loads on first visit (its narration is several MB) and pauses when you leave the tab.
function showCourse(visible) {
  const frame = $("course-frame");
  if (visible && !frame.src) {
    frame.src = frame.dataset.src;
    frame.addEventListener("load", () => {
      const doc = frame.contentDocument;
      if (!doc) return;
      const fit = () => { frame.style.height = `${doc.documentElement.scrollHeight}px`; };
      new ResizeObserver(fit).observe(doc.documentElement);
      fit();
    }, { once: true });
  }
  const play = !visible && frame.src ? frame.contentDocument?.getElementById("play") : null;
  if (play?.textContent === "Pause") play.click();
}

function goTo(view, focusId) {
  if (location.hash !== `#${view}`) location.hash = view;
  else route();
  if (focusId) requestAnimationFrame(() => $(focusId)?.focus());
}

function initialize() {
  try { state.live.symbol = localStorage.getItem("zonescope-live") || "NIFTY"; } catch { /* optional */ }
  route();
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-symbol], [data-sector], [data-show]");
    if (!target) return;
    const d = target.dataset;
    if (d.show) showOnBoard(d.show);
    else if (d.symbol) fireStock(target, d.symbol);
    else if (d.sector) {
      state.sector = d.sector;
      $("ob-sector").value = d.sector;
      renderOrderBlock();
      goTo("orderblock");
    }
  });

  document.querySelectorAll("[data-bias]").forEach((chip) => chip.addEventListener("click", () => {
    state.bias = chip.dataset.bias;
    document.querySelectorAll("[data-bias]").forEach((c) => { c.classList.toggle("is-active", c === chip); c.setAttribute("aria-pressed", String(c === chip)); });
    renderOrderBlock();
  }));
  // The flow board's filter boxes drive the same bias chips; clicking the active side again shows all.
  document.querySelectorAll("[data-bias-box]").forEach((box) => box.addEventListener("click", () => {
    document.querySelector(`.chip[data-bias="${state.bias === box.dataset.biasBox ? "all" : box.dataset.biasBox}"]`).click();
  }));
  document.querySelectorAll("[data-fresh-bias]").forEach((chip) => chip.addEventListener("click", () => {
    state.freshBias = chip.dataset.freshBias;
    document.querySelectorAll("[data-fresh-bias]").forEach((c) => { c.classList.toggle("is-active", c === chip); c.setAttribute("aria-pressed", String(c === chip)); });
    renderFresh();
  }));
  $("ob-rr").addEventListener("click", (e) => {
    state.minRR = !state.minRR;
    e.currentTarget.classList.toggle("is-active", state.minRR);
    e.currentTarget.setAttribute("aria-pressed", String(state.minRR));
    renderOrderBlock();
  });
  $("ob-sector").addEventListener("change", (e) => { state.sector = e.target.value; renderOrderBlock(); });
  $("ob-sort").addEventListener("change", (e) => { state.sort = e.target.value; renderOrderBlock(); });
  $("ob-search").addEventListener("input", (e) => { state.query = e.target.value; renderOrderBlock(); });
  $("live-symbol").addEventListener("change", (e) => setLiveSymbol(e.target.value));
  setBell(bell.on);
  document.addEventListener("scroll", (e) => { if (e.target.matches?.(".fb-small, .fb-mid, .fb-detail")) deckProgress(e.target); }, true);
  // Turning the bell on previews it, which also lets the browser allow its sound at 09:15.
  $("open-bell").addEventListener("click", () => { setBell(!bell.on); if (bell.on) ringBell(); });

  document.querySelectorAll("[data-interval]").forEach((b) => b.addEventListener("click", () => { state.interval = b.dataset.interval; renderStock(); }));
  $("open-feedback").addEventListener("click", () => { renderFeedback(); $("feedback-dialog").showModal(); });
  $("feedback-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.message.value.trim();
    if (!message) return;
    state.feedback.unshift({ kind: form.kind.value, message, createdAt: new Date().toISOString() });
    if (!save("zonescope-feedback", state.feedback)) { state.feedback.shift(); return; }
    form.message.value = "";
    $("feedback-message").textContent = "Saved.";
    renderFeedback();
  });
  $("feedback-copy").addEventListener("click", async () => {
    const text = state.feedback.map((f) => `[${f.kind}] ${f.createdAt.slice(0, 10)}: ${f.message}`).join("\n");
    try {
      await navigator.clipboard.writeText(text || "(no feedback yet)");
      $("feedback-message").textContent = "Copied to clipboard.";
    } catch (error) {
      $("feedback-message").textContent = `Could not copy: ${error.message}`;
    }
  });

  // Number keys 1-5 switch tabs, like a terminal's function keys (ignored while typing or with modifiers).
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
    if (e.key === "/") { e.preventDefault(); $("cmd-input").focus(); return; }
    const link = document.querySelector(`[data-view-link][data-key="${CSS.escape(e.key)}"]`);
    if (link) { e.preventDefault(); location.hash = link.getAttribute("href"); }
  });
  $("replay-btn").addEventListener("click", () => setReplay(!state.replay));
  $("replay-range").addEventListener("input", (e) => {
    if (!state.replay) return;
    clearInterval(state.replay.timer); // scrubbing pauses the playback
    state.replay.frac = e.target.value / 1000;
    renderLive();
  });
  $("live-flow").addEventListener("pointermove", hoverFlow);
  $("live-flow").addEventListener("pointerleave", () => hoverFlow(null));
  // Clicking near a highlighted line opens it, like clicking the line itself (that case the document handler covers).
  $("live-flow").addEventListener("click", (e) => { if (state.hover && !e.target.closest("[data-symbol]")) openStock(state.hover); });
  $("cmd").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("cmd-input");
    if (runCommand(input.value)) { input.value = ""; input.blur(); }
  });
  tickClock();
  setInterval(tickClock, 1000);

  renderMarket();
  refresh();
  setInterval(refresh, 60_000);
  setInterval(() => { if (location.hash === "#predict") loadPredict(); }, 60_000);
  const cardFlow = (e, run) => {
    const card = e.target.closest?.(".pr-card"); const svg = card?.querySelector(".pr-flow:not(.pr-ghost)");
    if (!svg || card.contains(e.relatedTarget) || reducedMotion()) return;
    if (run) svg.unpauseAnimations(); else svg.pauseAnimations();
  };
  for (const [type, run] of [["pointerover", true], ["focusin", true], ["pointerout", false], ["focusout", false]]) $("predict-list").addEventListener(type, (e) => cardFlow(e, run));
  setInterval(pollLive, 5_000);
  new ResizeObserver(() => { renderLive(); drawConnectors(); }).observe($("flowboard"));
}

initialize();
