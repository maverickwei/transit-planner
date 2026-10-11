// 捷運＋公車轉乘規劃（RAPTOR 演算法，時間單位：分鐘，相對出發時刻），全部在瀏覽器執行。
// 資料：臺北市公車開放資料（站序、班距、即時到站）＋ mrt-data.js（捷運站序、座標）
// 行車時間為以距離估算的近似值，不是時刻表。
const Planner = (() => {
  const BLOB = 'https://tcgbusfs.blob.core.windows.net/blobbus/';
  const STATIC_TTL = 6 * 3600e3, ETA_TTL = 20e3;
  const WALK_M_PER_MIN = 75, WALK_DETOUR = 1.3;   // 步行 4.5 km/h；直線換實際距離
  const BUS_M_PER_MIN = 280, BUS_DETOUR = 1.25;   // 公車含停靠約 17 km/h
  const MRT_M_PER_MIN = 650, MRT_DWELL = 0.4;     // 捷運約 39 km/h（站間直線距離）
  const MRT_GATE = 2.0;                            // 進出捷運站（走到月台）
  const ACCESS_M = 1000, TRANSFER_M = 400, MAX_RIDES = 4;

  const cache = {};

  // ------------------------------------------------------------ 資料
  async function fetchBlob(name, ttl) {
    const hit = cache[name];
    if (hit && Date.now() - hit.t < ttl) return hit.data;
    if (!('DecompressionStream' in window)) throw new Error('瀏覽器版本太舊，請更新 iOS / Safari');
    const res = await fetch(BLOB + name + '.gz', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`公車資料讀取失敗（${res.status}）`);
    const text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const data = JSON.parse(text.replace(/^﻿/, '')).BusInfo;
    cache[name] = { t: Date.now(), data };
    return data;
  }

  async function etaMap() {
    try {
      const m = new Map();
      for (const e of await fetchBlob('GetEstimateTime', ETA_TTL)) m.set(e.StopID + '_' + e.RouteID, +e.EstimateTime);
      return m;
    } catch (e) { return new Map(); }
  }

  function distM(lat1, lon1, lat2, lon2) {
    const p = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * p / 2) ** 2
      + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(a));
  }
  const walkMin = d => d * WALK_DETOUR / WALK_M_PER_MIN;

  function headwayWait(r) {
    // 依班距估平均候車時間（班距一半）。尖峰平日 7-9、17-19 點。
    const now = new Date(), wd = (now.getDay() + 6) % 7, h = now.getHours();
    const peak = wd < 5 && ((h >= 7 && h < 9) || (h >= 17 && h < 19));
    let hw = (peak ? r.peakHeadway : r.offPeakHeadway) || '';
    if (wd >= 5) hw = r.holidayOffPeakHeadway || hw;
    if (/^\d{4}$/.test(hw) && hw !== '0000') {
      const lo = +hw.slice(0, 2), hi = +hw.slice(2);
      return Math.min(15, Math.max(2, (lo + hi) / 4));
    }
    return 8;
  }

  // ------------------------------------------------------------ 路網
  // 節點 = 公車站位(stopLocationId) 或 捷運站；pattern = 一條路線的一個方向
  class Graph {
    async build() {
      this.nodes = []; this.patterns = []; this.keymap = new Map();
      for (const [code, name, color, seq] of MRT_LINES) {
        const ids = seq.split(' ').map(s => this.node('M' + s, s, ...MRT_STATIONS[s], true, ''));
        for (const order of [ids, [...ids].reverse()]) {
          const cum = [0], km = [0];
          for (let i = 1; i < order.length; i++) {
            const a = this.nodes[order[i - 1]], b = this.nodes[order[i]];
            const d = distM(a.lat, a.lon, b.lat, b.lon);
            cum.push(cum[i - 1] + d / MRT_M_PER_MIN + MRT_DWELL);
            km.push(km[i - 1] + d / 1000);
          }
          this.patterns.push({ mode: 'mrt', name, color, code, toward: this.nodes[order[order.length - 1]].name,
            nodes: order, cum, km, wait: 3, routeId: null, stopIds: null });
        }
      }
      const [routeList, stopList] = await Promise.all([fetchBlob('GetRoute', STATIC_TTL), fetchBlob('GetStop', STATIC_TTL)]);
      const routes = new Map(routeList.map(r => [r.Id, r]));
      const groups = new Map();
      this.locs = new Map();  // 最近公車站用：站位 → 經過的路線
      for (const s of stopList) {
        const r = routes.get(s.routeId);
        if (!r) continue;
        const k = s.routeId + '_' + s.goBack;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s);
        if (!this.locs.has(s.stopLocationId)) this.locs.set(s.stopLocationId, {
          name: s.nameZh, address: s.address, lat: +s.latitude, lon: +s.longitude, stops: [] });
        this.locs.get(s.stopLocationId).stops.push({ stopId: s.Id, routeId: r.Id, route: r.nameZh,
          toward: s.goBack === '0' ? r.destinationZh : r.departureZh });
      }
      for (const [k, stops] of groups) {
        const [rid, gb] = k.split('_'), r = routes.get(+rid);
        stops.sort((a, b) => +a.seqNo - +b.seqNo);
        const order = [], sids = [];
        for (const s of stops) {
          const n = this.node('B' + s.stopLocationId, s.nameZh, +s.latitude, +s.longitude, false, s.address || '');
          if (order.length && order[order.length - 1] === n) continue;
          order.push(n); sids.push(s.Id);
        }
        if (order.length < 2) continue;
        const cum = [0];
        for (let i = 1; i < order.length; i++) {
          const a = this.nodes[order[i - 1]], b = this.nodes[order[i]];
          cum.push(cum[i - 1] + Math.max(0.7, distM(a.lat, a.lon, b.lat, b.lon) * BUS_DETOUR / BUS_M_PER_MIN));
        }
        this.patterns.push({ mode: 'bus', name: r.nameZh, color: '#16a34a', code: 'bus',
          toward: gb === '0' ? r.destinationZh : r.departureZh, nodes: order, cum, km: null,
          wait: headwayWait(r), routeId: r.Id, stopIds: sids });
      }
      this.serving = this.nodes.map(() => []);
      this.patterns.forEach((p, pi) => p.nodes.forEach((n, i) => this.serving[n].push([pi, i])));
      // 步行轉乘（網格加速）
      this.grid = new Map();
      this.nodes.forEach((n, i) => {
        const c = this.cell(n.lat, n.lon);
        if (!this.grid.has(c)) this.grid.set(c, []);
        this.grid.get(c).push(i);
      });
      this.foot = this.nodes.map((n, i) => this.near(n.lat, n.lon, TRANSFER_M)
        .filter(([j]) => j !== i)
        .map(([j, d]) => [j, walkMin(d) + ((n.mrt || this.nodes[j].mrt) ? MRT_GATE : 0)]));
      this.built = Date.now();
      return this;
    }
    node(key, name, lat, lon, mrt, addr) {
      if (!this.keymap.has(key)) {
        this.keymap.set(key, this.nodes.length);
        this.nodes.push({ name, lat, lon, mrt, addr });
      }
      return this.keymap.get(key);
    }
    cell(lat, lon) { return Math.floor(lat / 0.005) + ',' + Math.floor(lon / 0.005); }
    near(lat, lon, radius) {
      const cy = Math.floor(lat / 0.005), cx = Math.floor(lon / 0.005), r = Math.floor(radius / 500) + 1, out = [];
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        for (const j of this.grid.get((cy + dy) + ',' + (cx + dx)) || []) {
          const n = this.nodes[j], d = distM(lat, lon, n.lat, n.lon);
          if (d <= radius) out.push([j, d]);
        }
      }
      return out;
    }
  }

  let graphPromise = null;
  function graph() {
    if (!graphPromise || (cache.graphBuilt && Date.now() - cache.graphBuilt > STATIC_TTL)) {
      graphPromise = new Graph().build().then(g => { cache.graphBuilt = Date.now(); return g; })
        .catch(e => { graphPromise = null; throw e; });
    }
    return graphPromise;
  }

  // ------------------------------------------------------------ 最近公車站
  const ETA_TEXT = { '-1': '未發車', '-2': '交管不停', '-3': '末班已過', '-4': '今日停駛' };
  const etaText = s => s >= 0 ? (s < 60 ? '進站中' : Math.floor(s / 60) + ' 分') : (ETA_TEXT[s] || '—');

  async function nearby(lat, lon, n = 6) {
    const g = await graph(), eta = await etaMap();
    return [...g.locs.values()]
      .map(l => ({ l, d: distM(lat, lon, l.lat, l.lon) }))
      .sort((a, b) => a.d - b.d).slice(0, n)
      .map(({ l, d }) => ({
        name: l.name, address: l.address, lat: l.lat, lon: l.lon,
        dist: Math.round(d), walkMin: Math.max(1, Math.round(d / 75)),
        routes: l.stops.map(s => {
          const sec = eta.get(s.stopId + '_' + s.routeId);
          return { route: s.route, toward: s.toward, eta: sec === undefined ? '—' : etaText(sec),
            sec: sec !== undefined && sec >= 0 ? sec : 1e6 };
        }).sort((a, b) => a.sec - b.sec || a.route.localeCompare(b.route)),
      }));
  }

  // ------------------------------------------------------------ 地點解析
  function mrtLookup(text) {
    const t = text.replace(/臺/g, '台').replace(/捷運/g, '').trim().replace(/(捷運站|站)$/, '');
    return MRT_STATIONS[t] ? [t, MRT_STATIONS[t]] : null;
  }

  async function geocode(text) {
    text = (text || '').trim();
    const m = text.match(/^@?\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)$/);
    if (m) return { name: '目前位置', lat: +m[1], lon: +m[2] };
    const hit = mrtLookup(text);
    if (hit) return { name: `捷運${hit[0]}站`, lat: hit[1][0], lon: hit[1][1], mrt: hit[0] };
    const bus = text.replace(/（公車站）$/, '');
    const g = await graph();
    const n = g.nodes.find(n => !n.mrt && n.name === bus);
    if (n) return { name: n.name + '（公車站）', lat: n.lat, lon: n.lon };
    return (await arcgis(text)) || (await nominatim(text));
  }

  async function arcgis(text) {
    // ArcGIS World Geocoder（免金鑰、不儲存結果的查詢）；台灣門牌精準度比 OSM 好
    const key = 'arcgis:' + text;
    if (cache[key]) return cache[key];
    const q = new URLSearchParams({ SingleLine: text, f: 'json', maxLocations: 1, countryCode: 'TWN',
      location: '121.55,25.05', outFields: 'Addr_type' });
    try {
      const c = (await (await fetch('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' + q)).json()).candidates || [];
      if (c.length && c[0].score >= 80) {
        return cache[key] = { name: text, lat: c[0].location.y, lon: c[0].location.x, matched: c[0].address,
          approx: !['PointAddress', 'StreetAddress', 'StreetAddressExt', 'POI'].includes(c[0].attributes.Addr_type) };
      }
    } catch (e) { /* 改用 Nominatim */ }
    return null;
  }

  async function nominatim(text) {
    let t = text.replace(/台/g, '臺');
    const tries = [t];
    for (const pat of [/\d+樓.*$/, /之\d+.*$/, /\d+號.*$/, /\d+弄.*$/, /\d+巷.*$/]) {
      const t2 = t.replace(pat, '').trim();
      if (t2 && t2 !== t) { tries.push(t2); t = t2; }
    }
    for (const q of tries) {
      try {
        const data = await (await fetch('https://nominatim.openstreetmap.org/search?' + new URLSearchParams(
          { q, format: 'json', countrycodes: 'tw', limit: 1, 'accept-language': 'zh-TW' }))).json();
        if (data.length) return { name: text, lat: +data[0].lat, lon: +data[0].lon, approx: q !== text, matched: data[0].display_name };
      } catch (e) { /* 試下一個 */ }
      await new Promise(r => setTimeout(r, 1000));  // Nominatim 使用規範：每秒最多 1 次
    }
    return null;
  }

  // ------------------------------------------------------------ RAPTOR
  function mrtFare(km) {
    for (const [lim, f] of [[5, 20], [8, 25], [11, 30], [14, 35], [17, 40], [20, 45], [23, 50], [27, 55], [31, 60]]) {
      if (km <= lim) return f;
    }
    return 65;
  }

  function raptor(g, orig, dest, modeSeq, eta, dead) {
    const N = g.nodes.length, best = new Float64Array(N).fill(Infinity);
    const labs = [], pars = [];
    const lab0 = new Float64Array(N).fill(Infinity), par0 = new Array(N).fill(null);
    for (const [j, d] of g.near(orig.lat, orig.lon, ACCESS_M)) {
      const n = g.nodes[j];
      const t = n.mrt && orig.mrt === n.name ? 0.5 : walkMin(d) + (n.mrt ? MRT_GATE : 0);
      if (t < lab0[j]) { lab0[j] = t; par0[j] = ['access', d]; best[j] = Math.min(best[j], t); }
    }
    labs.push(lab0); pars.push(par0);
    const egress = new Map();
    for (const [j, d] of g.near(dest.lat, dest.lon, ACCESS_M)) {
      const n = g.nodes[j];
      egress.set(j, [n.mrt && dest.mrt === n.name ? 0.5 : walkMin(d) + (n.mrt ? MRT_GATE : 0), d]);
    }
    let marked = new Set();
    for (let j = 0; j < N; j++) if (lab0[j] < Infinity) marked.add(j);
    const results = [];
    let bestTotal = Infinity;
    for (let k = 1; k <= MAX_RIDES; k++) {
      const prev = labs[labs.length - 1];
      const lab = new Float64Array(N).fill(Infinity), par = new Array(N).fill(null);
      const modes = modeSeq[Math.min(k, modeSeq.length) - 1];
      const queue = new Map();
      for (const n of marked) for (const [pi, i] of g.serving[n]) {
        if (modes.includes(g.patterns[pi].mode) && !dead.has(pi) && i < (queue.get(pi) ?? Infinity)) queue.set(pi, i);
      }
      const updated = new Set();
      for (const [pi, i0] of queue) {
        const p = g.patterns[pi], nodes = p.nodes, cum = p.cum;
        let boardT = Infinity, boardI = -1, boardInfo = null;
        for (let j = i0; j < nodes.length; j++) {
          const n = nodes[j];
          if (boardI >= 0) {
            const arr = boardT + cum[j] - cum[boardI];
            if (arr < best[n] && arr < bestTotal) {
              lab[n] = best[n] = arr;
              par[n] = ['ride', pi, boardI, j, boardInfo];
              updated.add(n);
            }
          }
          if (prev[n] < Infinity) {
            let wait = p.wait, info = null;
            if (k === 1 && p.stopIds) {
              const sec = eta.get(p.stopIds[j] + '_' + p.routeId);
              // 走得到站牌時這班還沒過才用即時到站；趕不上就用班距估
              if (sec !== undefined && sec >= 0 && sec / 60 >= prev[n]) {
                wait = Math.max(sec / 60 - prev[n], 0.5); info = Math.round(sec / 60);
              }
            }
            const t = prev[n] + wait;
            if (boardI < 0 || t < boardT + cum[j] - cum[boardI]) { boardT = t; boardI = j; boardInfo = info; }
          }
        }
      }
      // 步行轉乘
      for (const n of [...updated]) for (const [m, w] of g.foot[n]) {
        const t = lab[n] + w;
        if (t < best[m] && t < bestTotal) { lab[m] = best[m] = t; par[m] = ['walk', n]; updated.add(m); }
      }
      labs.push(lab); pars.push(par);
      marked = updated;
      // 抵達目的地
      let total = Infinity, tj = -1;
      for (const [j, e] of egress) if (lab[j] < Infinity && lab[j] + e[0] < total) { total = lab[j] + e[0]; tj = j; }
      if (tj >= 0 && total < bestTotal - 0.5) {
        bestTotal = total;
        results.push(trace(g, labs, pars, k, tj, egress.get(tj), total));
      }
      if (!marked.size) break;
    }
    return results;
  }

  const r6 = x => Math.round(x * 1e6) / 1e6;
  function place(g, n) {
    const node = g.nodes[n];
    return { to: node.name + (node.mrt ? '站' : ''), toKind: node.mrt ? 'mrt' : 'bus', toAddr: node.addr,
      toPos: [r6(node.lat), r6(node.lon)] };
  }

  function trace(g, labs, pars, k, j, egress, total) {
    const legs = [], [egMin, egD] = egress;
    if (egD > 30) legs.push({ mode: 'walk', to: '目的地', min: Math.round(egMin), dist: Math.round(egD) });
    let n = j;
    while (k >= 0) {
      const p = pars[k][n];
      if (p[0] === 'access') {
        if (p[1] > 30) legs.push({ mode: 'walk', ...place(g, n), min: Math.round(labs[0][n]), dist: Math.round(p[1]) });
        break;
      }
      if (p[0] === 'walk') {
        const m = p[1], a = g.nodes[m], b = g.nodes[n];
        legs.push({ mode: 'walk', ...place(g, n), min: Math.round(labs[k][n] - labs[k][m]),
          dist: Math.round(distM(a.lat, a.lon, b.lat, b.lon)) });
        n = m;
        continue;
      }
      const [, pi, bi, ji, info] = p, pat = g.patterns[pi], b = pat.nodes[bi];
      const seg = pat.nodes.slice(bi, ji + 1), ride = pat.cum[ji] - pat.cum[bi];
      legs.push({ mode: pat.mode, line: pat.name, color: pat.color, code: pat.code,
        from: g.nodes[b].name, to: g.nodes[pat.nodes[ji]].name,
        fromAddr: g.nodes[b].addr, toAddr: g.nodes[pat.nodes[ji]].addr,
        toward: pat.toward, stops: ji - bi,
        via: seg.map(x => g.nodes[x].name), viaPos: seg.map(x => [r6(g.nodes[x].lat), r6(g.nodes[x].lon)]),
        min: Math.round(ride), wait: Math.round(labs[k][n] - ride - labs[k - 1][b]),
        eta: info, km: pat.km ? pat.km[ji] - pat.km[bi] : 0 });
      n = b;
      k--;
    }
    legs.reverse();
    return { min: Math.round(total), legs };
  }

  function summarize(r) {
    const rides = r.legs.filter(l => l.mode !== 'walk'), kinds = new Set(rides.map(l => l.mode));
    let fare = 0, mrtKm = 0;
    for (const l of r.legs) {
      if (l.mode === 'mrt') { mrtKm += l.km; continue; }
      if (mrtKm) { fare += mrtFare(mrtKm); mrtKm = 0; }
      if (l.mode === 'bus') fare += 15;
    }
    if (mrtKm) fare += mrtFare(mrtKm);
    // 捷運／公車互轉（悠遊卡一小時內）每次折 8 元
    let switches = 0;
    for (let i = 1; i < rides.length; i++) if (rides[i].mode !== rides[i - 1].mode) switches++;
    r.fare = Math.max(0, fare - 8 * switches);
    r.type = !kinds.size ? 'walk' : kinds.size === 2 ? 'mix' : kinds.has('mrt') ? 'mrt' : 'bus';
    r.xfer = Math.max(0, rides.length - 1);
    r.legs.forEach(l => delete l.km);
    return r;
  }

  function recommend(routes) {
    // 最佳建議：不只看最快，也把轉乘次數、估計（非即時）候車的不確定性、長距離步行算進去
    for (const r of routes) {
      const rides = r.legs.filter(l => l.mode !== 'walk');
      const walk = r.legs.filter(l => l.mode === 'walk').reduce((s, l) => s + l.min, 0);
      const guess = rides.filter(l => l.mode === 'bus' && l.eta == null).length;
      r.score = r.min + 5 * r.xfer + 3 * guess + 0.3 * Math.max(0, walk - 8);
    }
    const best = routes.reduce((a, b) => (b.score < a.score || (b.score === a.score && b.min < a.min)) ? b : a);
    best.recommend = true;
    const minX = Math.min(...routes.map(r => r.xfer)), minFare = Math.min(...routes.map(r => r.fare));
    const rides = best.legs.filter(l => l.mode !== 'walk'), why = [];
    why.push(best.best ? '最快抵達' : `只比最快的多 ${best.min - routes[0].min} 分`);
    if (best.xfer === 0 && rides.length) why.push('不用轉乘');
    else if (best.xfer === minX) why.push('轉乘次數最少');
    if (rides.length && rides[0].mode === 'bus' && rides[0].eta != null) {
      const e = rides[0].eta;
      why.push(e <= 5 ? `${rides[0].line} ${e <= 1 ? '即將進站' : e + ' 分後就到'}` : `${rides[0].line} 要等 ${e} 分`);
    } else if (rides.length && rides[0].mode === 'mrt') why.push('先搭捷運，班次密、時間準');
    if (rides.some(l => l.mode === 'bus') && !rides.some(l => l.mode === 'bus' && l.eta == null)) why.push('沒有要碰運氣等的公車');
    if (best.fare === minFare) why.push('最省錢');
    best.reason = why.join('・');
  }

  async function plan(fromText, toText) {
    const [orig, dest] = await Promise.all([geocode(fromText), geocode(toText)]);
    if (!orig) return { error: `找不到起點：${fromText}` };
    if (!dest) return { error: `找不到目的地：${toText}` };
    const g = await graph(), eta = await etaMap();
    // 今天不營運／末班已過的公車路線（該路線所有站都 ≤ -2）
    const seenR = new Set(), alive = new Set();
    for (const [k, sec] of eta) {
      const rid = +k.split('_')[1];
      seenR.add(rid);
      if (sec >= -1) alive.add(rid);  // 有預估時間或「尚未發車」都算有營運
    }
    const dead = new Set();
    g.patterns.forEach((p, pi) => { if (p.routeId && seenR.has(p.routeId) && !alive.has(p.routeId)) dead.add(pi); });

    const ANY = ['mrt', 'bus'], M = ['mrt'], B = ['bus'];
    const variants = [
      [ANY],        // 最快（不限）
      [M],          // 純捷運
      [B],          // 純公車
      [B, ANY],     // 先公車再轉
      [M, B],       // 捷運轉公車（可再轉公車）
      [M, B, M],    // 捷運→公車→捷運
      [B, M, B],    // 公車→捷運→公車
    ];
    const seen = new Set();
    let routes = [];
    for (const seq of variants) {
      for (const r of raptor(g, orig, dest, seq, eta, dead)) {
        const sig = r.legs.filter(l => l.mode !== 'walk').map(l => [l.mode, l.line, l.from, l.to].join('|')).join('>');
        if (sig && !seen.has(sig)) { seen.add(sig); routes.push(summarize(r)); }
      }
    }
    const d = distM(orig.lat, orig.lon, dest.lat, dest.lon);
    if (d < 1500) routes.push({ min: Math.round(walkMin(d)), type: 'walk', xfer: 0, fare: 0,
      legs: [{ mode: 'walk', to: '目的地', min: Math.round(walkMin(d)), dist: Math.round(d * WALK_DETOUR) }] });
    routes.sort((a, b) => a.min - b.min || a.xfer - b.xfer);
    if (routes.length) {
      routes = routes.filter(r => r.min <= routes[0].min * 1.6 + 10).slice(0, 8);
      routes[0].best = true;
      recommend(routes);
    }
    return { from: orig, to: dest, routes };
  }

  return { plan, nearby, preload: graph };
})();
