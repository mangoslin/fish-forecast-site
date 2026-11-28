/* 公開網站（GitHub Pages）用：攔截頁面原本對伺服器 /api/... 的呼叫，改讀 data/ 的預先計算結果，
   或在瀏覽器裡計算（問問看、魚價統計）。船班與帳本存在每個人自己的瀏覽器（localStorage）。
   對應的 Python：query.py、trips.py、fish_price.py、direct_price.py；改那邊的規則時這裡要一起改。 */
(() => {
  'use strict';
  const origFetch = window.fetch.bind(window);
  const cache = {};
  const J = p => cache[p] || (cache[p] = origFetch('data/' + p, { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(p + ' ' + r.status);
    return r.json();
  }));
  const CFG = () => J('config.json').then(c => {
    if (!c._sp) {
      c._sp = Object.fromEntries(c.species.map(s => [s.id, s]));
      c._pt = Object.fromEntries(c.ports.map(p => [p.id, p]));
    }
    return c;
  });

  // ---------------------------------------------------------------- 日期（一律用台灣日期的 YYYY-MM-DD 字串）
  const todayTW = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const toUTC = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
  const isoOf = ms => new Date(ms).toISOString().slice(0, 10);
  const addDays = (s, n) => isoOf(toUTC(s) + n * 864e5);
  const diffDays = (a, b) => Math.round((toUTC(a) - toUTC(b)) / 864e5);
  const weekday = s => (new Date(toUTC(s)).getUTCDay() + 6) % 7;   // 週一 = 0（同 Python）
  const labelOf = s => `${+s.slice(5, 7)}/${+s.slice(8, 10)}(${'一二三四五六日'[weekday(s)]})`;
  const ymd = (y, m, d) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? isoOf(t.getTime()) : null;
  };
  const sum = (xs, f = x => x) => xs.reduce((a, x) => a + (f(x) || 0), 0);
  const round1 = x => Math.round(x * 10) / 10;
  const uniq = xs => [...new Set(xs)];

  // ---------------------------------------------------------------- 問問看：句子解析（同 query.py）
  function findSpecies(text, cfg) {
    const out = [];
    for (const s of cfg.species) {
      let t = text;
      for (const b of cfg.longer_names[s.id] || []) t = t.split(b).join('□');
      if (s.aliases.some(a => t.includes(a))) out.push(s.id);
    }
    return out;
  }

  function parseDate(q, today) {
    let m;
    if ((m = q.match(/(20\d\d)[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})/))) return ymd(+m[1], +m[2], +m[3]);
    if ((m = q.match(/(?:^|\D)(\d{1,2})\s*[\/月]\s*(\d{1,2})(?!\d)/))) {
      const y = +today.slice(0, 4), mo = +m[1], da = +m[2];
      const d = ymd(y, mo, da);
      if (!d) return null;
      const next = ymd(y + 1, mo, da);
      if (d < today && next && diffDays(next, today) <= 90) return next;   // 例：12 月問 1/5 → 明年
      if (diffDays(d, today) > 90) return ymd(y - 1, mo, da);             // 很久以後的日期 → 指去年
      return d;
    }
    for (const [w, n] of [['今天', 0], ['明天', 1], ['後天', 2]]) if (q.includes(w)) return addDays(today, n);
    if ((m = q.match(/(下下|下)?(?:週|星期|禮拜)([一二三四五六日天])/))) {
      const target = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }[m[2]];
      let d = addDays(today, ((target - weekday(today)) % 7 + 7) % 7);
      if (m[1]) d = addDays(d, 7 * m[1].length);
      return d;
    }
    return null;
  }

  function parseQuery(q, today, cfg) {
    let port = null, plen = 0;
    for (const p of cfg.ports) {
      const hits = [p.name, ...p.aliases].filter(a => q.includes(a));
      if (hits.length) {
        const L = Math.max(...hits.map(h => h.length));
        if (!port || L > plen) { port = p; plen = L; }
      }
    }
    const species = findSpecies(q, cfg);
    for (const [w, ids] of Object.entries(cfg.categories)) if (q.includes(w)) for (const s of ids) if (!species.includes(s)) species.push(s);
    const methods = Object.entries(cfg.methods).filter(([, m]) => m.aliases.some(a => q.includes(a))).map(([k]) => k);
    return { port, date: parseDate(q, today), species, methods };
  }

  // ---------------------------------------------------------------- 潮汐（預報期內用逐時資料，其餘用調和分析）
  function predictTide(coef, speeds, day, hh) {
    const hrs = (Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), hh) - Date.UTC(2000, 0, 1)) / 3.6e6;
    let v = coef[0];
    speeds.forEach((w, k) => {
      const rad = w * Math.PI / 180 * hrs;
      v += coef[1 + 2 * k] * Math.cos(rad) + coef[2 + 2 * k] * Math.sin(rad);
    });
    return Math.round(v * 100) / 100;
  }

  async function tideDay(port, d) {
    const [hourly, tm] = await Promise.all([J(`hourly/${port.id}.json`).catch(() => null), J('tide.json')]);
    const byTime = {};
    if (hourly) hourly.time.forEach((t, i) => { byTime[t] = [hourly.sea_level[i], hourly.tide_pred[i]]; });
    const coef = tm.models[port.id];
    const series = [];
    for (let i = 0; i < 72; i++) {
      const day = addDays(d, Math.floor(i / 24) - 1), hh = i % 24;
      const hit = byTime[`${day}T${String(hh).padStart(2, '0')}:00`];
      let v = null, pred = true;
      if (hit && hit[0] != null) { v = hit[0]; pred = hit[1]; } else if (coef) v = predictTide(coef, tm.speeds, day, hh);
      series.push({ day, hh, v, pred });
    }
    const hm = mins => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    const extrema = [];
    for (let i = 1; i < series.length - 1; i++) {
      const a = series[i - 1].v, b = series[i].v, c = series[i + 1].v;
      if (a == null || b == null || c == null) continue;
      if ((b > a && b >= c) || (b < a && b <= c)) {
        const denom = a - 2 * b + c, off = denom ? 0.5 * (a - c) / denom : 0;
        const mins = Math.floor((i + off) * 60 + 1e-9);
        if (Math.floor(mins / 1440) !== 1) continue;   // 只留當天
        extrema.push({ time: hm(mins - 1440), type: b > a ? '滿潮' : '乾潮', h: Math.round((b - 0.25 * (a - c) * off) * 100) / 100 });
      }
    }
    const today = series.filter(x => x.day === d);
    return { curve: today.map(x => ({ t: `${String(x.hh).padStart(2, '0')}:00`, h: x.v })), extrema,
             predicted: today.every(x => x.pred) };
  }

  // ---------------------------------------------------------------- 單日預測／回測（同 query.day_report）
  function pastScore(cfg, sid, e) {
    const [score, fish, act, n, nh] = e.s[sid], sp = cfg._sp[sid];
    return { id: sid, name: sp.name, method: sp.method, night: sp.night, score, fish, activity: act, n_reports: n, n_hist: nh,
      reasons: ['回測：用當天實際海況（再分析資料）重算', `魚況潛力 ${fish}`,
        act != null ? `FB 魚情 ${act}%（本港近期 ${n} 篇、去年同期 ${nh} 篇）` : '近期與去年同期皆無 FB 魚情',
        `日間出海指數 ${Math.round((e.c.go || 0) * 100)}%（${e.c.go_label || '–'}）`] };
  }

  async function historyBlock(cfg, port, d, species) {
    const hist = await J('reports_hist.json');
    const lo = addDays(d, -375), hi = addDays(d, -355), by = {};
    for (const [pd, pid, sid, sent, url] of hist) {
      if (pid === (port.report_port || port.id) && pd >= lo && pd <= hi && (!species.length || species.includes(sid))) (by[sid] ||= []).push({ pd, sent, url });
    }
    const last_year = Object.entries(by).filter(([k]) => cfg._sp[k]).map(([k, v]) => ({
      species: cfg._sp[k].name, n: v.length, avg: round1(sum(v, x => x.sent) / v.length) })).sort((a, b) => b.n - a.n);
    const seen = new Set(), posts = [];
    for (const r of Object.values(by).flat().sort((a, b) => b.sent - a.sent)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      posts.push({ date: r.pd, url: r.url, snippet: '（點原文看 FB 貼文）', keywords: [], sentiment: r.sent });
      if (posts.length >= 6) break;
    }
    const trips = loadStore().trips.filter(t => t.port_id === port.id).map(tripMoney)
      .sort((a, b) => b.date.localeCompare(a.date));
    for (const t of trips) t.species_names = (t.species || '').split(',').filter(s => cfg._sp[s]).map(s => cfg._sp[s].name);
    const money = trips.filter(t => t.cost != null && t.revenue != null), n = money.length;
    const avg = f => n ? Math.round(sum(money, f) / n) : null;
    return { last_year, posts, my_trips: trips.slice(0, 8),
      profit: { n, avg_cost: avg(t => t.cost), avg_revenue: avg(t => t.revenue), avg_profit: avg(t => t.revenue - t.cost),
                win_rate: n ? Math.round(100 * money.filter(t => t.revenue > t.cost).length / n) : null } };
  }

  async function dayReport(port, d, speciesIds = [], methodIds = [], query = '') {
    const cfg = await CFG(), today = todayTW(), lead = diffDays(d, today);
    if (lead < -cfg.past_days || lead > 29) return { error: `網站版可查過去 ${cfg.past_days} 天到未來 30 天` };
    const excl = port.exclude_species || [];
    const asked = speciesIds.filter(s => cfg._sp[s]);
    const species = (asked.length ? asked : cfg.species.map(s => s.id)).filter(s => !excl.includes(s));
    let spScores = [], cond;
    if (lead >= 0) {
      const f = await J('forecast.json');
      const day = f.ports.find(p => p.id === port.id)?.days.find(x => x.date === d);
      if (!day) return { error: '這一天的預報還沒產生（網站每天自動更新）' };
      spScores = day.species.filter(s => species.includes(s.id));
      cond = { day: day.day, night: day.night, tier: day.tier, tide_range: day.tide_range, sunrise: day.sunrise, sunset: day.sunset };
    } else {
      const e = (await J(`past/${port.id}.json`).catch(() => ({})))[d];
      if (e) {
        cond = { day: { ...e.c, rain: null, tier: '回測' }, night: null, tier: '回測（實際海況）' };
        spScores = species.filter(s => e.s[s]).map(s => pastScore(cfg, s, e)).sort((a, b) => b.score - a.score);
      } else cond = { tier: '無歷史資料' };
    }
    const moon = (await J('moon.json'))[d];
    return { query, port: port.name, port_id: port.id, date: d, label: labelOf(d), lead,
      species_asked: asked.map(s => cfg._sp[s].name),
      methods: methodIds.filter(m => cfg.methods[m]).map(m => cfg.methods[m].name),
      moon, cond, species: spScores.slice(0, 10), tide: await tideDay(port, d), history: await historyBlock(cfg, port, d, species) };
  }

  async function ask(q) {
    const cfg = await CFG(), p = parseQuery(q, todayTW(), cfg);
    const missing = [['釣場', p.port], ['日期', p.date]].filter(x => !x[1]).map(x => x[0]);
    if (missing.length) return { error: `看不出${missing.join('、')}。例：「南寮漁港 10/24 小搞搞 石斑 嘉鱲」、「北三 下週六 紅甘 弓角」` };
    return dayReport(p.port, p.date, p.species, p.methods, q);
  }

  // ---------------------------------------------------------------- 近期 FB 魚情（只有摘要＋原文連結）
  async function reports(P) {
    const [rows, cfg] = await Promise.all([J('reports.json'), CFG()]);
    const port = P.get('port'), sp = P.get('species'), method = P.get('method');
    const since = addDays(todayTW(), -(+(P.get('days') || 14))), out = [];
    for (const r of rows) {
      if (r.post_date < since) continue;
      const ms = (r.methods || '').split(',').filter(Boolean);
      if (method && !ms.includes(method)) continue;
      const rp = port && (cfg._pt[port]?.report_port || port)
      const hit = r.rows.filter(([pid, sid]) => (!rp || pid === rp) && (!sp || sid === sp));
      if (!hit.length) continue;
      out.push({ ...r, ports: uniq(hit.map(h => h[0])).filter(x => cfg._pt[x]).map(x => cfg._pt[x].name),
        species: cfg.species.filter(s => hit.some(h => h[1] === s.id)).map(s => s.name),
        methods: ms.filter(m => cfg.methods[m]).map(m => cfg.methods[m].name), snippet: '', text: '', photos: [] });
      if (out.length >= 200) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- 批發魚價（同 fish_price.py）
  const KG_TO_JIN = 0.6;
  let PRICE_ROWS = null;
  async function priceData() {
    const P = await J('prices.json');
    PRICE_ROWS ||= P.rows.map(([date, code, market, high, mid, low, volume, avg]) =>
      ({ date, code, market, high, mid, low, volume, avg, name: P.names[code] }));
    return { P, rows: PRICE_ROWS };
  }
  function wavg(rows, key = 'avg') {
    rows = rows.filter(r => r[key]);
    const vol = sum(rows, r => r.volume);
    return vol ? sum(rows, r => r[key] * (r.volume || 0)) / vol : null;
  }
  function tiers(rows) {
    const out = {};
    for (const [k, name] of [['high', 'top'], ['mid', 'mid'], ['low', 'low'], ['avg', 'avg']]) {
      const v = wavg(rows, k);
      out[name] = v ? { kg: Math.round(v), jin: Math.round(v * KG_TO_JIN) } : null;
    }
    return out;
  }
  const inMarket = (P, market) => {
    if (!market) return () => true;
    const ms = P.groups[market] || [market];
    return r => ms.includes(r.market);
  };
  async function priceSummary(days = 7, market) {
    const { P, rows } = await priceData();
    if (market === undefined) market = P.default;
    if (!rows.length) return { last: null, items: [] };
    const last = rows.reduce((a, r) => r.date > a ? r.date : a, '');
    const curFrom = addDays(last, -(days - 1)), prevFrom = addDays(last, -(2 * days - 1)), ok = inMarket(P, market);
    const codeToSpecies = {};
    for (const [sid, cs] of Object.entries(P.species_codes)) for (const c of cs) codeToSpecies[c] = sid;
    const items = {};
    for (const r of rows) {
      if (r.date < prevFrom || !ok(r)) continue;
      const it = items[r.code] ||= { code: r.code, name: r.name, cur: [], prev: [] };
      (r.date >= curFrom ? it.cur : it.prev).push(r);
    }
    const out = [];
    for (const it of Object.values(items)) {
      if (!it.cur.length) continue;
      const avg = wavg(it.cur), mid = wavg(it.cur, 'mid'), prev = wavg(it.prev, 'mid'), markets = {};
      for (const r of it.cur) (markets[r.market] ||= []).push(r);
      out.push({ code: it.code, name: it.name, species_id: codeToSpecies[it.code] || null,
        avg_kg: avg ? Math.round(avg) : null, avg_jin: avg ? Math.round(avg * KG_TO_JIN) : null, tiers: tiers(it.cur),
        volume_kg: Math.round(sum(it.cur, r => r.volume)),
        change: mid && prev ? Math.round(100 * (mid - prev) / prev) : null,
        markets: Object.entries(markets).map(([m, v]) => {
          const a = wavg(v);
          return { market: m, avg_kg: a ? Math.round(a) : null, avg_jin: a ? Math.round(a * KG_TO_JIN) : null, tiers: tiers(v),
                   volume_kg: Math.round(sum(v, x => x.volume)) };
        }).sort((a, b) => b.volume_kg - a.volume_kg) });
    }
    out.sort((a, b) => b.volume_kg - a.volume_kg);
    return { last, days, market, items: out };
  }
  async function priceTrend(code, days = 30, market) {
    const { P, rows } = await priceData();
    if (market === undefined) market = P.default;
    const since = addDays(todayTW(), -days), ok = inMarket(P, market), by = {};
    for (const r of rows) if (r.code === code && r.date >= since && ok(r)) (by[r.date] ||= []).push(r);
    return Object.keys(by).sort().map(d => {
      const v = by[d], a = wavg(v);
      return { date: d, avg_kg: a ? Math.round(a) : null, avg_jin: a ? Math.round(a * KG_TO_JIN) : null, tiers: tiers(v),
               volume_kg: Math.round(sum(v, x => x.volume)) };
    });
  }
  async function speciesPrice(ids, days = 7) {
    const [s, { P }] = await Promise.all([priceSummary(days), priceData()]);
    const byCode = Object.fromEntries(s.items.map(it => [it.code, it])), out = {};
    for (const sid of ids) {
      const hits = (P.species_codes[sid] || []).map(c => byCode[c]).filter(h => h && h.avg_kg);
      if (hits.length) {
        const main = hits.reduce((a, b) => b.volume_kg > a.volume_kg ? b : a);
        out[sid] = { kg: main.avg_kg, jin: main.avg_jin, tiers: main.tiers, name: main.name };
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 釣友直售價（同 direct_price.summary）
  async function directSummary(days = 365) {
    const [{ rows }, cfg] = await Promise.all([J('direct.json'), CFG()]);
    const since = addDays(todayTW(), -days), by = {};
    for (const r of rows) if (r.date >= since) (by[r.species_id] ||= []).push(r);
    const items = Object.entries(by).map(([sid, rs]) => {
      const med = rs.map(r => r.price).sort((a, b) => a - b)[rs.length >> 1];
      const kept = rs.filter(r => r.price <= med * 3);
      rs = kept.length ? kept : rs;
      const ps = rs.map(r => r.price).sort((a, b) => a - b);
      return { species_id: sid, name: cfg._sp[sid]?.name || sid, n: rs.length, few: rs.length < 3,
        median: ps[(ps.length - 1) >> 1], low: ps[0], high: ps[ps.length - 1],
        recent: rs.slice(0, 6).map(r => ({ date: r.date, price: r.price, size: r.size, sold: r.sold, url: r.url })) };
    }).sort((a, b) => b.n - a.n);
    return { days, items };
  }
  async function speciesDirect() {
    return Object.fromEntries((await directSummary()).items.map(it => [it.species_id, { median: it.median, low: it.low, high: it.high, n: it.n }]));
  }

  // ---------------------------------------------------------------- 船班與帳本（存在這個瀏覽器，同 trips.py）
  const KEY = 'fish_trips_v1';
  function loadStore() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && Array.isArray(s.trips)) return s;
    } catch (e) { /* 沒有資料或不允許儲存 */ }
    return { next_id: 1, trips: [] };
  }
  function saveStore(s) {
    try { localStorage.setItem(KEY, JSON.stringify(s)); }
    catch (e) { alert('無法儲存：這個瀏覽器不允許本機儲存（例如無痕模式）'); }
  }
  const num = v => { if (v === null || v === undefined || v === '') return null; const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const findTrip = (s, id) => s.trips.find(t => t.id === id);
  function newTrip(s, fields) {
    const t = { id: s.next_id++, result: null, expenses: [], catch: [], ...fields };
    s.trips.push(t);
    return t;
  }
  function addBooking(d) {
    const s = loadStore();
    newTrip(s, { date: d.date, port_id: d.port_id, species: (d.species || []).join(','), method: d.method || '', note: d.note || '',
                 source: '預定', status: 'planned', boat: d.boat || '', depart_time: d.depart_time || '', fare: num(d.fare) });
    saveStore(s);
  }
  function updateBooking(id, d) {
    const s = loadStore(), t = findTrip(s, id);
    if (!t) return;
    Object.assign(t, { date: d.date, boat: d.boat || '', port_id: d.port_id, species: (d.species || []).join(','), method: d.method || '',
                       depart_time: d.depart_time || '', fare: num(d.fare), note: d.note || '' });
    saveStore(s);
  }
  function applyReport(t, d) {
    Object.assign(t, { status: 'done', result: parseInt(d.result, 10), note: d.note || '', method: d.method || t.method || '' });
    t.expenses = (d.expenses || []).filter(e => num(e.amount)).map(e => ({ item: e.item, amount: num(e.amount) }));
    t.catch = (d.catch || []).filter(c => c.species_id).map(c => ({ species_id: c.species_id, count: num(c.count),
      weight_jin: num(c.weight_jin), place: c.place || '', price_jin: num(c.price_jin), amount: num(c.amount), kept: c.kept ? 1 : 0 }));
  }
  function completeTrip(id, d) {
    const s = loadStore(), t = findTrip(s, id);
    if (t) { applyReport(t, d); saveStore(s); }
  }
  function addTrip(d) {
    const s = loadStore();
    const t = newTrip(s, { date: d.date, port_id: d.port_id, species: (d.species || []).join(','), method: d.method || '',
                           note: d.note || '', source: '手動', status: 'done', boat: d.boat || '', fare: num(d.fare) });
    applyReport(t, d);
    saveStore(s);
  }
  function editDoneTrip(id, d) {
    const s = loadStore(), t = findTrip(s, id);
    if (!t) return;
    Object.assign(t, { date: d.date, boat: d.boat || '', port_id: d.port_id, species: (d.species || []).join(',') });
    applyReport(t, d);
    saveStore(s);
  }
  function deleteTrip(id) {
    const s = loadStore();
    s.trips = s.trips.filter(t => t.id !== id);
    saveStore(s);
  }

  let SPN = {};   // species_id → 名稱（tripMoney 用，listTrips 時填入）
  function tripMoney(t0) {
    const t = { ...t0 }, ex = t.expenses || [];
    const ca = (t.catch || []).map(c => ({ ...c, name: SPN[c.species_id] || c.species_id,
      value: c.amount != null ? c.amount : (c.price_jin ? Math.round((c.weight_jin || 0) * (c.price_jin || 0)) : null) }));
    t.expenses = ex; t.catch = ca;
    if (ex.length) t.cost = sum(ex, e => e.amount);
    if (ca.length) {
      t.revenue = sum(ca, c => c.value);
      t.sold = sum(ca.filter(c => !c.kept), c => c.value);
      t.catch_kg = sum(ca, c => c.weight_jin);
    }
    if (t.cost != null && t.revenue != null) t.profit = t.revenue - t.cost;
    return t;
  }

  async function hindcast(cfg, t) {
    const port = cfg._pt[t.port_id];
    if (!port) return null;
    const e = (await J(`past/${port.id}.json`).catch(() => ({})))[t.date];
    if (!e) return null;
    const sids = (t.species || '').split(',').filter(s => e.s[s]);
    if (!sids.length) return null;
    const best = sids.map(s => pastScore(cfg, s, e)).reduce((a, b) => b.fish > a.fish ? b : a);
    return { score: best.fish, total: best.score, species: best.name, reasons: best.reasons };
  }

  function ledgerStats(done) {
    const money = done.filter(t => t.profit != null);
    const group = key => {
      const g = {};
      for (const t of money) {
        const k = key(t) || '（未填）';
        const x = g[k] ||= { key: k, n: 0, cost: 0, revenue: 0, profit: 0, wins: 0 };
        x.n++; x.cost += t.cost; x.revenue += t.revenue; x.profit += t.profit; x.wins += t.profit > 0 ? 1 : 0;
      }
      for (const x of Object.values(g)) { x.avg_profit = Math.round(x.profit / x.n); x.win_rate = Math.round(100 * x.wins / x.n); }
      return Object.values(g).sort((a, b) => b.profit - a.profit);
    };
    const species = {}, places = {};
    for (const t of done) for (const c of t.catch || []) {
      const s = species[c.name] ||= { name: c.name, count: 0, jin: 0, value: 0, priced_jin: 0 };
      s.count += c.count || 0; s.jin += c.weight_jin || 0;
      if (c.price_jin) { s.value += c.price_jin * (c.weight_jin || 0); s.priced_jin += c.weight_jin || 0; }
      if (c.place && c.price_jin && !c.kept) {
        const k = c.place + '\u0000' + c.name;
        const p = places[k] ||= { place: c.place, species: c.name, n: 0, jin: 0, price_sum: 0 };
        p.n++; p.jin += c.weight_jin || 0; p.price_sum += c.price_jin;
      }
    }
    for (const s of Object.values(species)) { s.avg_price = s.priced_jin ? Math.round(s.value / s.priced_jin) : null; s.jin = round1(s.jin); }
    for (const p of Object.values(places)) { p.avg_price = Math.round(p.price_sum / p.n); p.jin = round1(p.jin); }
    const cost = sum(money, t => t.cost), rev = sum(money, t => t.revenue);
    return { n: money.length, cost, revenue: rev, profit: rev - cost,
      avg_profit: money.length ? Math.round((rev - cost) / money.length) : null,
      win_rate: money.length ? Math.round(100 * money.filter(t => t.profit > 0).length / money.length) : null,
      by_boat: group(t => t.boat), by_port: group(t => t.port),
      by_month: group(t => t.date.slice(0, 7)).sort((a, b) => b.key.localeCompare(a.key)),
      species: Object.values(species).sort((a, b) => b.jin - a.jin),
      places: Object.values(places).sort((a, b) => a.species.localeCompare(b.species) || b.avg_price - a.avg_price) };
  }

  async function listTrips() {
    const cfg = await CFG(), P = await J('prices.json'), today = todayTW();
    SPN = Object.fromEntries(cfg.species.map(s => [s.id, s.name]));
    const trips = loadStore().trips.map(tripMoney).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    for (const t of trips) {
      t.port = cfg._pt[t.port_id]?.name || t.port_id;
      t.species_names = (t.species || '').split(',').filter(s => cfg._sp[s]).map(s => cfg._sp[s].name);
      t.result_label = cfg.results[t.result] || '';
      const port = cfg._pt[t.port_id];
      if (t.status === 'planned' && port) {
        t.forecast = diffDays(t.date, today) >= 0 ? await dayReport(port, t.date, (t.species || '').split(',')) : null;
      } else t.hindcast = await hindcast(cfg, t);
    }
    const done = trips.filter(t => t.status !== 'planned');
    const good = done.filter(t => t.hindcast && (t.result || 0) >= 4).map(t => t.hindcast.score);
    const bad = done.filter(t => t.hindcast && t.result && t.result <= 2).map(t => t.hindcast.score);
    const avg = xs => xs.length ? Math.round(sum(xs) / xs.length) : null;
    const pairs = good.flatMap(g => bad.map(b => [g, b]));
    return { planned: trips.filter(t => t.status === 'planned').sort((a, b) => a.date.localeCompare(b.date)), trips: done,
      summary: { good_avg: avg(good), bad_avg: avg(bad), n_good: good.length, n_bad: bad.length,
                 pair_accuracy: pairs.length ? Math.round(100 * pairs.filter(([g, b]) => g > b).length / pairs.length) : null },
      stats: ledgerStats(done), expense_items: cfg.expense_items,
      places: uniq(trips.flatMap(t => (t.catch || []).map(c => c.place)).filter(Boolean)),
      prices: await speciesPrice(Object.keys(P.species_codes)), direct: await speciesDirect() };
  }

  // 貼上船家公告 → 拆成預定欄位（同 trips.parse_announcement）
  function parseAnnouncement(text, cfg) {
    const TIME = '(\\d{1,2})\\s*[:：]\\s*(\\d{2})';
    const hhmm = m => m ? `${String(+m[1]).padStart(2, '0')}:${m[2]}` : '';
    const find = (...pats) => { for (const p of pats) { const m = text.match(new RegExp(p)); if (m) return m; } return null; };
    const meet = find(TIME + '\\s*集合', '集合[^\\d\\n]{0,4}' + TIME);
    const depart = find(TIME + '\\s*出(?:船|港|發)', '出(?:船|港|發)[^\\d\\n]{0,4}' + TIME);
    const back = find(TIME + '\\s*(?:進港|回港|返港|收竿)', '(?:進港|回港|返港|收竿)[^\\d\\n]{0,4}' + TIME);
    const fare = text.match(/船資[^\d\n]{0,4}([\d,]{3,6})/);
    const depth = text.match(/水深[約大概]*\s*(\d+)\s*[～~\-－至到]\s*(\d+)\s*(?:米|公尺|m)/);
    const known = uniq(loadStore().trips.map(t => t.boat).filter(Boolean)).sort((a, b) => b.length - a.length);
    const bm = text.match(/([一-鿿]{1,6}\d{0,4}號)/);
    const boat = known.find(b => text.includes(b)) || (bm ? bm[1] : '');
    const title = text.split(/\r?\n/).map(l => l.trim()).find(l => l.includes('班') && l.length <= 40) || '';
    const parsed = parseQuery(text, todayTW(), cfg);
    const note = [title, depart ? `出船 ${hhmm(depart)}` : '', back ? `進港 ${hhmm(back)}` : '',
      depth ? `水深 ${depth[1]}-${depth[2]}m` : '', text.includes('身份證') || text.includes('身分證') ? '身份證班' : '',
      text.includes('船員證') ? '船員證' : ''].filter(Boolean).join('　');
    return { date: parsed.date || '', port_id: parsed.port?.id || '', boat, species: findSpecies(text, cfg),
      method: parsed.methods.map(m => cfg.methods[m].name).join('、'), depart_time: hhmm(meet) || hhmm(depart),
      fare: fare ? +fare[1].replace(/,/g, '') : '', note };
  }

  // 備份：匯出／匯入 JSON 檔（換手機、清除瀏覽資料前）
  window.FishTrips = {
    download() {
      const blob = new Blob([JSON.stringify({ app: 'fish-forecast', version: 1, ...loadStore() }, null, 1)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `船班帳本備份_${todayTW()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    async upload(file) {
      if (!file) return;
      let data;
      try { data = JSON.parse(await file.text()); } catch (e) { alert('這不是有效的備份檔'); return; }
      if (!Array.isArray(data.trips)) { alert('備份檔裡沒有船班資料'); return; }
      const s = loadStore();
      const sig = t => [t.date, t.port_id, t.boat || '', t.species || '', t.status].join('|');
      const have = new Set(s.trips.map(sig));
      let n = 0;
      for (const t of data.trips) {
        if (!t.date || !t.port_id || have.has(sig(t))) continue;
        const { id, ...rest } = t;
        newTrip(s, rest);
        have.add(sig(t));
        n++;
      }
      saveStore(s);
      alert(`匯入 ${n} 筆（${data.trips.length - n} 筆已存在，略過）`);
    },
  };

  // ---------------------------------------------------------------- 路由：/api/... → 上面的函式
  const ROUTES = [
    [/^\/api\/forecast$/, () => J('forecast.json')],
    [/^\/api\/hourly\/([\w-]+)$/, m => J(`hourly/${m[1]}.json`)],
    [/^\/api\/history\/([\w-]+)$/, m => J(`history/${m[1]}.json`)],
    [/^\/api\/reports$/, (m, P) => reports(P)],
    [/^\/api\/ask$/, (m, P) => ask(P.get('q') || '')],
    [/^\/api\/jobs$/, () => ({})],
    [/^\/api\/prices$/, (m, P) => priceSummary(+(P.get('days') || 7), P.has('market') ? (P.get('market') || null) : undefined)],
    [/^\/api\/prices\/(\d+)$/, (m, P) => priceTrend(+m[1], +(P.get('days') || 30), P.has('market') ? (P.get('market') || null) : undefined)],
    [/^\/api\/direct_list$/, () => J('direct.json')],
    [/^\/api\/direct_prices$/, (m, P) => directSummary(+(P.get('days') || 365))],
    [/^\/api\/parse_booking$/, async (m, P, b) => parseAnnouncement(b.text || '', await CFG())],
    [/^\/api\/trips$/, (m, P, b, method) => {
      if (method === 'POST') (b.kind === 'booking' ? addBooking : addTrip)(b);
      return listTrips();
    }],
    [/^\/api\/trips\/(\d+)\/complete$/, (m, P, b) => { completeTrip(+m[1], b); return { ok: true }; }],
    [/^\/api\/trips\/(\d+)$/, (m, P, b, method) => {
      if (method === 'PUT') (b.kind === 'done' ? editDoneTrip : updateBooking)(+m[1], b);
      else deleteTrip(+m[1]);
      return { ok: true };
    }],
  ];
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

  window.fetch = async (input, opts = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('/api/')) return origFetch(input, opts);
    const u = new URL(url, location.origin), method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    for (const [re, fn] of ROUTES) {
      const m = u.pathname.match(re);
      if (!m) continue;
      try { return reply(await fn(m, u.searchParams, body, method)); }
      catch (e) { console.error(e); return reply({ error: '資料載入失敗，請重新整理頁面（' + e.message + '）' }, 500); }
    }
    return reply({ error: 'not found' }, 404);
  };
})();
