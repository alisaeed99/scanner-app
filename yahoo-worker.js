// =====================================================================
// nabd-yahoo — a tiny Cloudflare Worker that fetches Yahoo Finance data
// for the dashboard's Support/Resistance panel and adds the CORS header
// the browser needs. The maths is a copy of /api/daily-closes and
// /api/intraday-structure from server.js, so the panel shows the same
// numbers it did when the Render server was doing this job.
//
// No keys, no secrets, nothing stored. Deploy it from the Cloudflare
// dashboard (Workers & Pages -> Create -> Create Worker -> paste this).
// =====================================================================

// Only pages served from these addresses may use this Worker from a browser.
// (This stops other websites using your Worker; it is not a password —
// someone typing the URL directly can still call it, which is harmless
// because it only returns public price data.)
const ALLOWED_ORIGINS = [
  "https://my-scanner-app.a-acm96.workers.dev",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

const YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const SYMBOL_RE = /^[A-Za-z0-9.^=-]{1,15}$/;

function jsonResponse(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

// Yahoo chart request. cacheTtl lets Cloudflare reuse a recent answer for the
// same symbol, which keeps repeat clicks fast and Yahoo requests few.
async function yahooChart(symbol, query, cacheTtl) {
  const url = `${YAHOO_CHART}${encodeURIComponent(symbol)}?${query}`;
  return fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    cf: { cacheTtl, cacheEverything: true },
  });
}

function firstResult(json) {
  return json && json.chart && json.chart.result && json.chart.result[0];
}
function errDescription(json) {
  return json && json.chart && json.chart.error && json.chart.error.description;
}

// ---------------------------------------------------------------- daily ----
async function dailyCloses(symbol, cors) {
  const upstreamRes = await yahooChart(symbol, "range=1y&interval=1d", 600);
  if (!upstreamRes.ok) {
    return jsonResponse({ error: `Yahoo Finance returned ${upstreamRes.status}` }, 502, cors);
  }
  const json = await upstreamRes.json();
  const result = firstResult(json);
  if (!result) {
    return jsonResponse({ error: errDescription(json) || "No data for this symbol" }, 404, cors);
  }
  const timestamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const highArr = quote.high || [], lowArr = quote.low || [], closeArr = quote.close || [];
  const bars = timestamps
    .map((t, i) => ({ t, high: highArr[i], low: lowArr[i], close: closeArr[i] }))
    .filter((b) => typeof b.close === "number");
  if (bars.length < 5) {
    return jsonResponse({ error: `Only ${bars.length} valid trading day(s) of data available, need at least 5` }, 422, cors);
  }
  const dateStr = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const lastFive = bars.slice(-5);

  const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const lastBarDateEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(bars[bars.length - 1].t * 1000));
  const yesterdayBar = (lastBarDateEastern === todayEastern && bars.length >= 2) ? bars[bars.length - 2] : bars[bars.length - 1];

  const yesterdayIdx = bars.indexOf(yesterdayBar);
  function windowHighLow(tradingDays) {
    const w = bars.slice(Math.max(0, yesterdayIdx - tradingDays + 1), yesterdayIdx + 1);
    const highs = w.map((b) => b.high).filter((v) => typeof v === "number");
    const lows = w.map((b) => b.low).filter((v) => typeof v === "number");
    if (!highs.length || !lows.length) return null;
    return { high: Math.max(...highs), low: Math.min(...lows) };
  }

  return jsonResponse({
    symbol: symbol.toUpperCase(),
    closes: lastFive.map((b) => ({ date: dateStr(b.t), close: b.close })),
    yesterday: { date: dateStr(yesterdayBar.t), high: yesterdayBar.high, low: yesterdayBar.low, close: yesterdayBar.close },
    ranges: { w2: windowHighLow(10), m1: windowHighLow(21), w13: windowHighLow(65), w52: windowHighLow(252) },
  }, 200, cors);
}

// ------------------------------------------------------------- intraday ----
async function intradayStructure(symbol, cors) {
  const upstreamRes = await yahooChart(symbol, "range=1d&interval=5m&includePrePost=true", 30);
  if (!upstreamRes.ok) {
    return jsonResponse({ error: `Yahoo Finance returned ${upstreamRes.status}` }, 502, cors);
  }
  const json = await upstreamRes.json();
  const result = firstResult(json);
  if (!result) {
    return jsonResponse({ error: errDescription(json) || "No data for this symbol" }, 404, cors);
  }
  const timestamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const { high = [], low = [], close = [], volume = [] } = quote;
  const bars = timestamps
    .map((t, i) => ({ t, high: high[i], low: low[i], close: close[i], volume: volume[i] }))
    .filter((b) => typeof b.high === "number" && typeof b.low === "number" && typeof b.close === "number");
  if (bars.length < 5) {
    return jsonResponse({ error: `Only ${bars.length} intraday bar(s) available today, need at least 5` }, 422, cors);
  }

  let cumPV = 0, cumVol = 0;
  bars.forEach((b) => {
    if (typeof b.volume === "number" && b.volume > 0) {
      const typicalPrice = (b.high + b.low + b.close) / 3;
      cumPV += typicalPrice * b.volume;
      cumVol += b.volume;
    }
  });
  const vwap = cumVol > 0 ? cumPV / cumVol : null;

  const SWING_WINDOW = 2;
  const swingHighs = [], swingLows = [];
  for (let i = SWING_WINDOW; i < bars.length - SWING_WINDOW; i++) {
    const slice = bars.slice(i - SWING_WINDOW, i + SWING_WINDOW + 1);
    if (slice.every((b) => bars[i].high >= b.high)) swingHighs.push({ t: bars[i].t, price: bars[i].high });
    if (slice.every((b) => bars[i].low <= b.low)) swingLows.push({ t: bars[i].t, price: bars[i].low });
  }
  const classify = (swings, higherLabel, lowerLabel) => swings
    .map((s, i) => (i === 0 ? null : { t: s.t, price: s.price, kind: s.price > swings[i - 1].price ? higherLabel : lowerLabel }))
    .filter(Boolean);
  const classifiedHighs = classify(swingHighs, "HH", "LH");
  const classifiedLows = classify(swingLows, "HL", "LL");
  const MAX_SWINGS_EACH = 3;

  const highsArr = high.filter((v) => typeof v === "number");
  const lowsArr = low.filter((v) => typeof v === "number");

  return jsonResponse({
    symbol: symbol.toUpperCase(),
    vwap,
    dayHigh: highsArr.length ? Math.max(...highsArr) : null,
    dayLow: lowsArr.length ? Math.min(...lowsArr) : null,
    swingHighs: classifiedHighs.slice(-MAX_SWINGS_EACH).map((s) => ({ price: s.price, kind: s.kind, time: new Date(s.t * 1000).toISOString() })),
    swingLows: classifiedLows.slice(-MAX_SWINGS_EACH).map((s) => ({ price: s.price, kind: s.kind, time: new Date(s.t * 1000).toISOString() })),
  }, 200, cors);
}

// --------------------------------------------------------------- router ----
export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405, cors);
    if (origin && !allowed) return jsonResponse({ error: "Origin not allowed" }, 403, cors);

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return jsonResponse({ ok: true, service: "nabd-yahoo", endpoints: ["/daily-closes?symbol=AAPL", "/intraday-structure?symbol=AAPL"] }, 200, cors);
    }
    if (url.pathname !== "/daily-closes" && url.pathname !== "/intraday-structure") {
      return jsonResponse({ error: "Not found" }, 404, cors);
    }
    const symbol = url.searchParams.get("symbol");
    if (!symbol) return jsonResponse({ error: "symbol is required" }, 400, cors);
    if (!SYMBOL_RE.test(symbol)) return jsonResponse({ error: "invalid symbol" }, 400, cors);

    try {
      return url.pathname === "/daily-closes"
        ? await dailyCloses(symbol, cors)
        : await intradayStructure(symbol, cors);
    } catch (err) {
      return jsonResponse({ error: "Upstream request failed" }, 502, cors);
    }
  },
};
