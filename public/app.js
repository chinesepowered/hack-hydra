/* Blast Radius — frontend.
   One force-graph instance, two modes:
   - overview: the crawled npm ecosystem slice + org services
   - blast: the reverse-dependency closure of one incident, laid out on
     concentric hop-distance rings, lit by an expanding shockwave. */
/* global ForceGraph */
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => {
    n = Number(n) || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
    return String(n);
  };
  const fmtDelta = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  };
  const fmtDate = (iso) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const C = {
    critical: '#d03b3b', criticalBright: '#ff5d5d', warning: '#fab219',
    good: '#0ca30c', goodBright: '#35c435', service: '#3987e5',
    neutral: '#35405a', neutralInk: '#5c6a84', ink: '#e8edf6',
  };

  const S = {
    state: null, overview: null, typosquats: null,
    mode: 'overview', incidentId: null, blast: null,
    graph: null, wave: null, litAt: new Map(),
    hopGap: 78, maxHop: 0, drawerOpen: false,
  };

  // ============================================================ boot
  const bootLog = $('bootLog');
  const seenLines = new Set();
  async function pollBoot() {
    try {
      const r = await fetch('/api/state');
      const d = await r.json();
      S.state = d;
      for (const line of d.progress || []) {
        if (!seenLines.has(line)) {
          seenLines.add(line);
          const div = document.createElement('div');
          div.textContent = '▸ ' + line;
          bootLog.appendChild(div);
        }
      }
      if (d.status === 'ready') {
        const ok = document.createElement('div');
        ok.className = 'ok';
        ok.textContent = '▸ all systems go — entering console';
        bootLog.appendChild(ok);
        setTimeout(init, 500);
        return;
      }
      if (d.status === 'error') {
        bootLog.appendChild(el('div', 'q-err', 'boot failed: ' + esc(d.error)));
      }
    } catch { /* server still starting */ }
    setTimeout(pollBoot, 900);
  }
  pollBoot();

  // ============================================================ init
  async function init() {
    const [ov, ts] = await Promise.all([
      fetch('/api/overview').then((r) => r.json()),
      fetch('/api/typosquats').then((r) => r.json()),
    ]);
    S.overview = ov;
    S.typosquats = ts.pairs || [];
    $('boot').classList.add('hidden');
    $('app').classList.remove('hidden');
    buildTabs();
    buildGraph();
    setOverviewMode();
    startQueryConsole();
    wireChrome();
  }

  function buildTabs() {
    const tabs = $('tabs');
    tabs.innerHTML = '';
    const eco = el('button', 'tab active', 'ECOSYSTEM');
    eco.id = 'tab-overview';
    eco.onclick = () => setOverviewMode();
    tabs.appendChild(eco);
    for (const inc of S.state.incidents) {
      const t = el('button', 'tab incident',
        `<span class="tab-mark">⚠</span>${esc(inc.short)}<span class="tab-date">${esc(inc.date)}</span>`);
      t.id = 'tab-' + inc.id;
      t.onclick = () => detonate(inc.id);
      tabs.appendChild(t);
    }
  }
  function markTab(id) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    const t = $(id);
    if (t) t.classList.add('active');
  }

  // ============================================================ graph
  function hashAngle(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) / 4294967295) * Math.PI * 2;
  }

  function nodeR(n) {
    if (n.type === 'service') return 6.5;
    return 2 + Math.max(0, Math.log10((n.downloads || 0) + 1) - 2.5) * 1.05;
  }

  function buildGraph() {
    const graphEl = $('graph');
    S.graph = ForceGraph()(graphEl)
      .width(graphEl.clientWidth || window.innerWidth - 610)
      .height(graphEl.clientHeight || window.innerHeight - 240)
      .backgroundColor('#0b0e14')
      .nodeId('id')
      .nodeVal((n) => nodeR(n))
      .nodeLabel((n) => {
        if (n.type === 'service') return `<b>${esc(n.name)}</b> · internal service (${esc(n.kind || '')})`;
        const dl = n.downloads ? ` · ${fmt(n.downloads)} dl/wk` : '';
        const hop = n.hop !== undefined && S.mode === 'blast' ? ` · hop ${n.hop}` : '';
        const bad = n.type === 'origin' ? ' · ⚠ COMPROMISED' : (n.compromised ? ' · ⚠ compromised' : '');
        return `<b>${esc(n.name)}</b>${dl}${hop}${bad}`;
      })
      .nodeCanvasObject(paintNode)
      .nodePointerAreaPaint((n, color, ctx) => {
        const r = Math.max(5, nodeR(n) + 2);
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      })
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkDirectionalParticles((l) => (S.mode === 'blast' && l.blast ? 1 : 0))
      .linkDirectionalParticleSpeed(0.006)
      .linkDirectionalParticleWidth(2.2)
      .linkDirectionalParticleColor(() => 'rgba(255,93,93,0.9)')
      .onNodeClick((n) => {
        if (n.type === 'service') return;
        openPackageDrawer(n.name);
      })
      .onRenderFramePre(drawRings)
      .cooldownTicks(180)
      .d3VelocityDecay(0.32);
    new ResizeObserver(() => {
      S.graph.width(graphEl.clientWidth).height(graphEl.clientHeight);
    }).observe(graphEl);
  }

  function litFraction(n, now) {
    // 0 = dark, 1 = fully lit by the wave
    if (S.mode !== 'blast') return 1;
    if (!S.wave) return 1;
    const hop = n.hop === undefined ? S.maxHop + 1 : n.hop;
    const waveHop = (now - S.wave.t0) / S.wave.hopMs;
    if (n.safe) return 1; // safe services always visible in good color
    if (waveHop >= hop) {
      if (!S.litAt.has(n.id)) S.litAt.set(n.id, now);
      return 1;
    }
    return 0;
  }

  function paintNode(n, ctx, scale) {
    const now = performance.now();
    const lit = litFraction(n, now);
    const r0 = nodeR(n);
    let r = r0;
    const litT = S.litAt.get(n.id);
    if (litT !== undefined && S.mode === 'blast') {
      r = r0 * (1 + 1.1 * Math.exp(-(now - litT) / 320));
    }

    let fill = C.neutral, ring = null, dashed = false, alpha = 1;
    if (S.mode === 'overview') {
      if (n.type === 'service') { fill = C.service; }
      else if (n.compromised) { fill = '#5a1f1f'; ring = C.criticalBright; }
      else if (n.removed) { fill = 'rgba(0,0,0,0)'; ring = C.neutralInk; dashed = true; }
    } else {
      if (!lit) { fill = '#1a2130'; alpha = 0.5; }
      else if (n.type === 'origin') { fill = C.critical; ring = C.criticalBright; }
      else if (n.type === 'service' && n.safe) { fill = '#123a12'; ring = C.goodBright; }
      else if (n.type === 'service') { fill = C.critical; ring = C.criticalBright; }
      else { fill = '#7a5a10'; ring = C.warning; }
    }

    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    if (n.type === 'service') {
      const s = r * 1.7;
      ctx.fillRect(n.x - s / 2, n.y - s / 2, s, s);
      if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = 1.6 / Math.sqrt(scale); ctx.strokeRect(n.x - s / 2, n.y - s / 2, s, s); }
    } else {
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      if (ring) {
        ctx.strokeStyle = ring;
        ctx.lineWidth = (n.type === 'origin' ? 2.2 : 1.4) / Math.sqrt(scale);
        if (dashed) ctx.setLineDash([2, 2]);
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 1.2, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // origin glow
    if (S.mode === 'blast' && n.type === 'origin' && lit) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 300);
      ctx.globalAlpha = 0.18 + 0.12 * pulse;
      ctx.beginPath(); ctx.arc(n.x, n.y, r + 6 + 2 * pulse, 0, Math.PI * 2);
      ctx.fillStyle = C.criticalBright; ctx.fill();
      ctx.globalAlpha = alpha;
    }
    // labels
    const showLabel =
      (n.type === 'service') ||
      (S.mode === 'blast' && n.type === 'origin' && (n.big || scale > 0.7)) ||
      (scale > 1.6 && r0 > 2.4) || (scale > 3.2);
    if (showLabel && lit) {
      const fs = Math.max(10 / scale, 2.2);
      ctx.font = `500 ${fs}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = n.type === 'service' ? '#bcd6f7' : (n.type === 'origin' ? '#ffb3b3' : '#8b98b0');
      ctx.fillText(n.name, n.x, n.y + r + fs + 1);
    }
    ctx.globalAlpha = 1;
  }

  function linkColor(l) {
    if (S.mode === 'overview') {
      if (l.rel === 'SIMILAR_NAME') return 'rgba(250,178,25,0.35)';
      return 'rgba(122,138,166,0.10)';
    }
    const now = performance.now();
    const sHop = l.source.hop, tHop = l.target.hop;
    const far = Math.max(sHop === undefined ? 99 : sHop, tHop === undefined ? 99 : tHop);
    const waveHop = S.wave ? (now - S.wave.t0) / S.wave.hopMs : 99;
    if (waveHop >= far) return 'rgba(255,116,93,0.34)';
    return 'rgba(122,138,166,0.07)';
  }
  function linkWidth(l) {
    if (S.mode === 'overview') return l.rel === 'SIMILAR_NAME' ? 1.2 : 0.4;
    return l.blast ? 0.9 : 0.4;
  }

  function drawRings(ctx) {
    if (S.mode !== 'blast' || !S.wave) return;
    const now = performance.now();
    const waveHop = (now - S.wave.t0) / S.wave.hopMs;
    // static hop rings
    ctx.save();
    for (let h = 1; h <= S.maxHop; h++) {
      ctx.beginPath();
      ctx.arc(0, 0, ringR(h), 0, Math.PI * 2);
      ctx.strokeStyle = waveHop >= h ? 'rgba(208,59,59,0.16)' : 'rgba(122,138,166,0.07)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    // expanding shockwave front
    if (waveHop >= 0 && waveHop <= S.maxHop + 0.6) {
      const r = ringR(Math.max(0.01, waveHop));
      const grd = ctx.createRadialGradient(0, 0, Math.max(0, r - 14), 0, 0, r + 6);
      grd.addColorStop(0, 'rgba(255,93,93,0)');
      grd.addColorStop(0.8, 'rgba(255,93,93,0.13)');
      grd.addColorStop(1, 'rgba(255,93,93,0)');
      ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,93,93,0.55)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
  }
  const ringR = (h) => (h <= 0 ? 0 : 46 + h * S.hopGap);
  let originRing = 0; // spread multiple origins on a small inner ring

  function radialByHop() {
    let nodes = [];
    const force = (alpha) => {
      for (const n of nodes) {
        const hop = n.safe ? S.maxHop + 1.6 : (n.hop === undefined ? S.maxHop + 1 : n.hop);
        const target = hop === 0 ? originRing : ringR(hop);
        const dx = n.x || 1e-4, dy = n.y || 1e-4;
        const r = Math.sqrt(dx * dx + dy * dy) || 1e-4;
        const k = ((target - r) / r) * alpha * 0.12;
        n.vx += dx * k; n.vy += dy * k;
      }
    };
    force.initialize = (ns) => { nodes = ns; };
    return force;
  }

  // ============================================================ modes
  function setOverviewMode() {
    S.mode = 'overview';
    S.incidentId = null;
    S.blast = null;
    S.wave = null;
    S.litAt.clear();
    markTab('tab-overview');
    $('alarm').classList.add('hidden');
    $('waveCaption').classList.add('hidden');
    $('stageHint').textContent = 'the npm ecosystem slice · scroll to zoom · click a package · pick an incident above to detonate';

    // filter: services + compromised + removed squats + top-by-downloads
    const nodes = S.overview.nodes;
    const keep = new Set();
    const sorted = [...nodes].filter((n) => n.type === 'package').sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
    for (const n of sorted.slice(0, 560)) keep.add(n.id);
    for (const n of nodes) if (n.type === 'service' || n.compromised || n.removed) keep.add(n.id);
    for (const l of S.overview.links) if (l.rel === 'SIMILAR_NAME') { keep.add(l.source); keep.add(l.target); }

    const shownNodes = nodes.filter((n) => keep.has(n.id)).map((n) => ({ ...n }));
    const shownLinks = S.overview.links
      .filter((l) => keep.has(l.source) && keep.has(l.target))
      .map((l) => ({ ...l }));

    S.graph.d3Force('radial', null);
    S.graph.graphData({ nodes: shownNodes, links: shownLinks });
    S.graph.d3Force('charge').strength(-42);
    setTimeout(() => S.graph.zoomToFit(700, 40), 900);

    renderLegendOverview();
    renderLeftOverview();
    renderRightOverview();
  }

  async function detonate(incidentId) {
    markTab('tab-' + incidentId);
    S.incidentId = incidentId;
    $('stageHint').textContent = 'running reverse-dependency closure in HydraDB (algo.SSpaths, incoming)…';
    const blast = await fetch('/api/blast/' + incidentId).then((r) => r.json());
    S.blast = blast;
    S.mode = 'blast';
    S.litAt.clear();

    S.maxHop = Math.max(1, ...blast.nodes.map((n) => n.hop || 0));
    S.hopGap = Math.max(60, Math.min(95, 520 / S.maxHop));

    // graph data: blast nodes + safe services (context), links reversed so
    // particles/arrows flow outward from the origin — the infection direction.
    const present = new Set(blast.nodes.map((n) => n.id));
    originRing = blast.stats.originPackages > 1 ? Math.min(34, 7 + blast.stats.originPackages * 1.6) : 0;
    const nodes = blast.nodes.map((n) => {
      const a = hashAngle(n.name || String(n.id));
      const r = n.hop === 0 ? originRing : ringR(n.hop === undefined ? S.maxHop + 1 : n.hop);
      return { ...n, big: (n.downloads || 0) > 5e7, x: Math.cos(a) * r, y: Math.sin(a) * r };
    });
    for (const svcName of blast.services.safe) {
      const ov = S.overview.nodes.find((n) => n.type === 'service' && n.name === svcName);
      if (ov && !present.has(ov.id)) {
        const a = hashAngle(svcName);
        const r = ringR(S.maxHop + 1.6);
        nodes.push({ ...ov, safe: true, x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
    }
    const links = blast.links.map((l) => ({ source: l.target, target: l.source, blast: true, hop: l.hop }));

    S.graph.graphData({ nodes, links });
    S.graph.d3Force('radial', radialByHop());
    S.graph.d3Force('charge').strength(-26);
    S.graph.d3ReheatSimulation();
    setTimeout(() => S.graph.zoomToFit(800, 46), 350);
    setTimeout(() => { if (S.mode === 'blast' && S.blast === blast) S.graph.zoomToFit(900, 42); },
      800 + (S.maxHop + 1) * 850 + 900);

    // shockwave
    S.wave = { t0: performance.now() + 800, hopMs: 850 };
    const inc = blast.incident;
    $('stageHint').textContent = `${inc.short}: ${blast.stats.originPackages} compromised packages · ${blast.stats.dbCalls} HydraDB calls · ${blast.stats.paths} paths · ${blast.stats.ms}ms`;
    runWaveCaption(blast);

    renderLegendBlast();
    renderLeftIncident(blast);
    renderRightIncident(blast);
  }

  function runWaveCaption(blast) {
    const cap = $('waveCaption');
    cap.classList.remove('hidden');
    const iv = setInterval(() => {
      if (S.mode !== 'blast' || S.blast !== blast) { clearInterval(iv); cap.classList.add('hidden'); return; }
      const waveHop = (performance.now() - S.wave.t0) / S.wave.hopMs;
      if (waveHop < 0) { cap.textContent = '⚠ malicious versions are live on npm'; return; }
      if (waveHop > S.maxHop + 0.5) {
        clearInterval(iv);
        const svc = blast.stats.servicesExposed;
        cap.textContent = `blast radius mapped — ${blast.stats.packagesAffected} packages, ${svc} internal service${svc === 1 ? '' : 's'} exposed`;
        showAlarm(blast);
        setTimeout(() => cap.classList.add('hidden'), 5200);
        return;
      }
      const h = Math.floor(waveHop);
      const pkgs = blast.nodes.filter((n) => n.type === 'package' && n.hop <= waveHop).length;
      const svcs = blast.nodes.filter((n) => n.type === 'service' && n.hop !== undefined && n.hop <= waveHop).length;
      cap.textContent = `propagating · hop ${h} — ${pkgs} packages downstream${svcs ? ` · ${svcs} SERVICE${svcs === 1 ? '' : 'S'} HIT` : ''}`;
      updateLiveTiles(blast, waveHop);
    }, 120);
  }

  function showAlarm(blast) {
    const hits = blast.services.resolvedMalicious.filter((r) => r.in_window);
    if (hits.length === 0) { $('alarm').classList.add('hidden'); return; }
    const pub = new Date(blast.incident.published_at).getTime();
    const parts = hits.map((h) =>
      `<b>${esc(h.service)}</b> installed ${esc(h.pkg)}@${esc(h.semver)} <b>T+${fmtDelta(new Date(h.resolved_at) - pub)}</b>`);
    $('alarm').innerHTML = `🔴 ${hits.length} service${hits.length === 1 ? '' : 's'} resolved malicious code during the live window — ${parts.join(' · ')}`;
    $('alarm').classList.remove('hidden');
  }

  // ============================================================ legend
  function renderLegendOverview() {
    $('legend').innerHTML = [
      row('circle', C.neutral, 'npm package (size = weekly downloads)'),
      row('ring', '', 'compromised in a loaded incident'),
      row('square', C.service, 'internal service (Meridian Health)'),
      row('dashed', '', 'malicious typosquat, removed from npm'),
      `<div class="legend-row"><span class="legend-swatch" style="background:linear-gradient(90deg,transparent,${C.warning})"></span><span>name-similarity edge (typosquat radar)</span></div>`,
    ].join('');
    function row(shape, color, label) {
      return `<div class="legend-row"><span class="legend-swatch ${shape}" style="background:${color}"></span><span>${label}</span></div>`;
    }
  }
  function renderLegendBlast() {
    $('legend').innerHTML = [
      ['circle', C.critical, '⚠ compromised origin package'],
      ['circle', '#7a5a10', 'downstream dependent (in blast radius)'],
      ['square', C.critical, 'internal service — EXPOSED'],
      ['square', '#123a12', 'internal service — clear'],
    ].map(([shape, color, label]) =>
      `<div class="legend-row"><span class="legend-swatch ${shape}" style="background:${color};border:1.5px solid ${shape === 'square' && color === '#123a12' ? C.goodBright : (color === C.critical ? C.criticalBright : C.warning)}"></span><span>${label}</span></div>`).join('') +
      `<div class="legend-row"><span class="legend-swatch circle" style="background:transparent;border:1.5px solid rgba(208,59,59,0.5)"></span><span>rings = dependency hops from origin</span></div>`;
  }

  // ============================================================ panels
  function renderLeftOverview() {
    const d = S.state;
    $('leftPanel').innerHTML = `
      <div class="p-section">
        <div class="p-kicker">Graph under watch</div>
        <div class="p-title">The npm ecosystem, as a graph</div>
        <div class="p-sub">${fmt(d.dataset.packages)} packages · ${fmt(d.dataset.edges)} dependency edges · ${fmt(d.dataset.maintainers)} maintainers</div>
      </div>
      <div class="p-section p-body">
        A real slice of <b>registry.npmjs.org</b>, crawled ${esc((d.dataset.generated_at || '').slice(0, 10))} and loaded into
        <b>HydraDB</b> as packages, versions, maintainers and services connected by
        <span class="mono">DEPENDS_ON</span>, <span class="mono">MAINTAINS</span>, <span class="mono">HAS_VERSION</span>,
        <span class="mono">RESOLVED</span> and <span class="mono">SIMILAR_NAME</span> edges.
      </div>
      <div class="p-section">
        <div class="p-kicker">Protected org (demo)</div>
        <div class="p-title" style="font-size:15px">${esc(d.org.name)}</div>
        <div class="p-body" style="margin-top:2px">${esc(d.org.tagline)}</div>
        <div style="height:8px"></div>
        ${d.org.services.map((s) => `
          <div class="svc"><div class="svc-head">
            <span style="color:${C.service}">■</span>
            <span class="svc-name">${esc(s.name)}</span>
            <span class="dim" style="margin-left:auto;font-size:11px">${esc(s.kind)}</span>
          </div></div>`).join('')}
      </div>
      <div class="p-section p-body">
        <div class="p-kicker">Why a graph database</div>
        “Which of our services are exposed?” is a <b>transitive reverse-dependency closure</b> —
        a pure graph traversal. Here it runs as HydraDB's native
        <span class="mono">algo.SSpaths</span> procedure, not as similarity search.
      </div>`;
  }

  function renderRightOverview() {
    const cards = S.state.incidents.map((inc) => `
      <div class="svc hit" style="cursor:pointer" data-inc="${esc(inc.id)}">
        <div class="svc-head">
          <span style="color:${C.criticalBright}">⚠</span>
          <span class="svc-name">${esc(inc.name)}</span>
        </div>
        <div class="svc-chain">${esc(inc.date)} · ${esc(inc.attacker)}</div>
        <div class="p-body" style="margin-top:6px;font-size:12px">${esc(inc.story)}</div>
        <div class="svc-detail" style="color:var(--ink-3)">▸ click to map the blast radius</div>
      </div>`).join('');

    const known = S.typosquats.filter((t) => t.known_malicious);
    const cand = S.typosquats.filter((t) => !t.known_malicious);
    $('rightPanel').innerHTML = `
      <div class="p-section">
        <div class="p-kicker">Threat feed — real incidents</div>
        ${cards}
      </div>
      <div class="p-section">
        <div class="p-kicker">Typosquat radar (SIMILAR_NAME edges)</div>
        ${known.map((t) => squatRow(t)).join('')}
        ${cand.length ? `<div class="p-kicker" style="margin-top:10px">candidates for review</div>` : ''}
        ${cand.slice(0, 6).map((t) => squatRow(t)).join('')}
      </div>`;
    document.querySelectorAll('[data-inc]').forEach((c) => {
      c.onclick = () => detonate(c.dataset.inc);
    });
  }
  function squatRow(t) {
    return `<div class="squat">
      <span class="squat-name ${t.known_malicious ? '' : 'candidate'}">${esc(t.squat)}</span>
      <span class="dim">→</span>
      <span class="squat-target">${esc(t.target)} (${fmt(t.target_downloads)}/wk)</span>
      <span class="squat-tag ${t.known_malicious ? '' : 'candidate'}">${t.known_malicious ? 'KNOWN MALWARE' : 'Δ' + t.distance}</span>
      ${t.note ? `<span class="squat-note">${esc(t.note)}</span>` : ''}
    </div>`;
  }

  function renderLeftIncident(blast) {
    const inc = blast.incident;
    const pub = new Date(inc.published_at);
    const det = new Date(inc.detected_at);
    const end = new Date(inc.window_end);
    $('leftPanel').innerHTML = `
      <div class="p-section">
        <div class="p-kicker">Incident brief</div>
        <div class="p-title">${esc(inc.name)}</div>
        <div class="p-sub">${esc(inc.attacker)}</div>
      </div>
      <div class="p-section"><div class="story">${esc(inc.story)}</div></div>
      <div class="p-section">
        <dl class="meta-grid">
          <dt>date</dt><dd>${esc(inc.date)}</dd>
          ${inc.cve ? `<dt>cve</dt><dd>${esc(inc.cve)}</dd>` : ''}
          ${inc.advisory ? `<dt>advisory</dt><dd>${esc(inc.advisory)}</dd>` : ''}
          <dt>vector</dt><dd>${esc(inc.id === 'chalk-debug-2025' ? 'phished npm maintainer account' : inc.id === 'tanstack-2026' ? 'GitHub Actions release pipeline' : 'self-propagating worm (stolen npm tokens)')}</dd>
        </dl>
      </div>
      <div class="p-section">
        <div class="p-kicker">Timeline</div>
        <div class="timeline">
          <div class="tl-item crit">
            <div class="tl-dot"></div>
            <div class="tl-when">${fmtDate(inc.published_at)}</div>
            <div class="tl-what">malicious versions published <span class="tl-delta">T+0</span></div>
          </div>
          <div class="tl-item warn">
            <div class="tl-dot"></div>
            <div class="tl-when">${fmtDate(inc.detected_at)}</div>
            <div class="tl-what">first public detection <span class="tl-delta">T+${fmtDelta(det - pub)}</span></div>
          </div>
          <div class="tl-item ok">
            <div class="tl-dot"></div>
            <div class="tl-when">${fmtDate(inc.window_end)}</div>
            <div class="tl-what">malicious versions pulled <span class="tl-delta">T+${fmtDelta(end - pub)}</span></div>
          </div>
        </div>
        <div class="p-body" style="margin-top:8px;font-size:11.5px">${esc(inc.window_note)}</div>
      </div>
      <div class="p-section">
        <div class="p-kicker">Payload</div>
        <div class="p-body">${esc(inc.payload)}</div>
      </div>
      <div class="p-section">
        <div class="p-kicker">Compromised packages (${inc.packages.length}${inc.packages_note ? ' loaded' : ''})</div>
        <div class="chips">
          ${inc.packages.map((p) => `<span class="chip bad" data-pkg="${esc(p.name)}" title="malicious: ${esc(p.malicious_versions.join(', '))}">${esc(p.name)}</span>`).join('')}
        </div>
        ${inc.packages_note ? `<div class="p-body" style="margin-top:6px;font-size:11px">${esc(inc.packages_note)}</div>` : ''}
      </div>
      <div class="p-section">
        <div class="p-kicker">Sources</div>
        <div class="p-body" style="font-size:11.5px">${inc.sources.map((s) => `<div><a href="${esc(s)}" target="_blank" rel="noopener">${esc(s.replace(/^https?:\/\//, '').slice(0, 42))}…</a></div>`).join('')}</div>
      </div>`;
    document.querySelectorAll('#leftPanel [data-pkg]').forEach((c) => {
      c.onclick = () => openPackageDrawer(c.dataset.pkg);
    });
  }

  function dlAtRisk(blast) {
    return blast.nodes.filter((n) => n.type === 'package').reduce((a, n) => a + (n.downloads || 0), 0);
  }

  function updateLiveTiles(blast, waveHop) {
    const pkgs = blast.nodes.filter((n) => n.type === 'package' && n.hop <= waveHop);
    const svcs = blast.nodes.filter((n) => n.type === 'service' && n.hop !== undefined && n.hop <= waveHop).length;
    const dl = pkgs.reduce((a, n) => a + (n.downloads || 0), 0);
    const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    set('tilePkgs', pkgs.length);
    set('tileSvcs', svcs);
    set('tileDl', fmt(dl));
  }

  function renderRightIncident(blast) {
    const inc = blast.incident;
    const pub = new Date(inc.published_at).getTime();
    const hitNames = new Set(blast.services.resolvedMalicious.map((r) => r.service));
    const rowsByService = new Map();
    for (const r of blast.services.resolvedMalicious) {
      if (!rowsByService.has(r.service)) rowsByService.set(r.service, []);
      rowsByService.get(r.service).push(r);
    }

    const svcRow = (s) => {
      const hits = rowsByService.get(s.name) || [];
      const isHit = hits.some((h) => h.in_window);
      const badge = isHit
        ? '<span class="svc-badge crit">DIRECT HIT</span>'
        : '<span class="svc-badge warn">EXPOSED</span>';
      const chain = s.chain && s.chain.length
        ? `<div class="svc-chain">${s.chain.map((c, i) =>
            `<span class="${i === s.chain.length - 1 ? 'origin' : ''}" ${i === s.chain.length - 1 ? '' : ''}>${esc(c)}</span>`)
            .join('<span class="arr"> → </span>')}</div>`
        : '';
      const details = hits.map((h) =>
        `<div class="svc-detail">▸ lockfile resolved ${esc(h.pkg)}@${esc(h.semver)} at T+${fmtDelta(new Date(h.resolved_at) - pub)}${h.in_window ? ' — inside the live window' : ''}</div>`).join('');
      return `<div class="svc ${isHit ? 'hit' : 'exposed'}">
        <div class="svc-head"><span style="color:${C.criticalBright}">■</span><span class="svc-name">${esc(s.name)}</span>${badge}</div>
        ${chain}${details}</div>`;
    };

    const safeRow = (name) => `
      <div class="svc safe"><div class="svc-head">
        <span style="color:${C.goodBright}">■</span><span class="svc-name">${esc(name)}</span>
        <span class="svc-badge ok">CLEAR</span>
      </div></div>`;

    const maint = blast.maintainerOverlap.slice(0, 6).map((m) => `
      <div class="mrow">
        <div class="mrow-head"><span class="mrow-name">${esc(m.maintainer)}</span>
        <span class="mrow-count">${m.packages.length} pkgs in graph ▾</span></div>
        <div class="mrow-pkgs">
          ${m.packages.slice(0, 24).map((p) => `<span class="chip ${p.compromised ? 'bad' : ''}" data-pkg="${esc(p.name)}">${esc(p.name)}</span>`).join('')}
          ${m.packages.length > 24 ? `<span class="dim" style="font-size:11px">+${m.packages.length - 24} more</span>` : ''}
        </div>
      </div>`).join('');

    $('rightPanel').innerHTML = `
      <div class="p-section">
        <div class="p-kicker">Impact — computed live in HydraDB</div>
        <div class="tiles">
          <div class="tile"><div class="tile-num warn" id="tilePkgs">0</div><div class="tile-label">packages in blast radius</div></div>
          <div class="tile"><div class="tile-num crit" id="tileSvcs">0</div><div class="tile-label">internal services exposed</div></div>
          <div class="tile"><div class="tile-num warn" id="tileDl">0</div><div class="tile-label">weekly downloads downstream</div></div>
          <div class="tile"><div class="tile-num" style="color:var(--service)">${blast.stats.dbCalls}</div><div class="tile-label">graph queries</div>
            <div class="tile-sub">${blast.stats.paths} paths · ${blast.stats.ms}ms</div></div>
        </div>
      </div>
      <div class="p-section">
        <div class="p-kicker">Meridian Health — service exposure</div>
        ${blast.services.exposed.map(svcRow).join('')}
        ${blast.services.safe.map(safeRow).join('')}
      </div>
      <div class="p-section">
        <div class="p-kicker">Shared maintainer surface</div>
        <div class="p-body" style="font-size:11.5px;margin-bottom:6px">Accounts that publish the compromised packages — and everything else those accounts can push to.</div>
        ${maint || '<div class="dim">none in graph</div>'}
      </div>`;
    document.querySelectorAll('#rightPanel .mrow-head').forEach((h) => {
      h.onclick = () => h.parentElement.classList.toggle('open');
    });
    document.querySelectorAll('#rightPanel [data-pkg]').forEach((c) => {
      c.onclick = () => openPackageDrawer(c.dataset.pkg);
    });
    // final numbers (wave will animate up to these)
    setTimeout(() => updateLiveTiles(blast, 99), (S.maxHop + 2) * (S.wave ? S.wave.hopMs : 800));
  }

  // ============================================================ drawer
  async function openPackageDrawer(name) {
    const d = await fetch('/api/package/' + encodeURIComponent(name)).then((r) => r.json());
    if (d.error) return;
    const card = $('drawerCard');
    const incMeta = d.incident ? S.state.incidents.find((i) => i.id === d.incident) : null;
    card.innerHTML = `
      <button class="d-close" id="dClose">✕</button>
      <div class="d-name">${esc(d.name)}</div>
      <div class="d-badges">
        ${d.compromised ? `<span class="d-badge crit">⚠ compromised — ${esc(incMeta ? incMeta.short : d.incident)}</span>` : ''}
        ${d.removed ? '<span class="d-badge crit">removed from npm</span>' : ''}
        <span class="d-badge">v${esc(d.version || '?')}</span>
        ${d.maintainers.map((m) => `<span class="d-badge">@${esc(m)}</span>`).join('')}
      </div>
      <div class="d-desc">${esc(d.description || '')}</div>
      <div class="d-stats">
        <div><div class="d-stat-num">${fmt(d.downloads)}</div><div class="d-stat-label">downloads / week</div></div>
        <div><div class="d-stat-num">${d.dependents.length}${d.dependents.length === 100 ? '+' : ''}</div><div class="d-stat-label">dependents in graph</div></div>
        <div><div class="d-stat-num">${d.dependencies.length}</div><div class="d-stat-label">dependencies</div></div>
      </div>
      ${d.timeline.length ? `
        <div class="p-kicker">version timeline (registry publish times)</div>
        <div class="vtl">
          ${d.timeline.map((t) => `
            <div class="vtl-row ${t.malicious ? 'bad' : ''}">
              <span class="vtl-dot"></span>
              <span class="vtl-ver">${esc(t.semver)}</span>
              <span class="vtl-date">${esc(t.released_at.slice(0, 16).replace('T', ' '))}</span>
              ${t.malicious ? `<span class="vtl-tag">MALICIOUS${t.unpublished ? ' · UNPUBLISHED' : ''}</span>` : ''}
            </div>`).join('')}
        </div>` : ''}
      ${d.dependents.length ? `
        <div class="p-kicker" style="margin-top:12px">dependents (who pulls this in)</div>
        <div class="chips">${d.dependents.slice(0, 40).map((x) =>
          `<span class="chip" data-pkg="${esc(x.name)}" style="${x.type === 'service' ? 'border-color:rgba(57,135,229,0.6)' : ''}">${x.type === 'service' ? '■ ' : ''}${esc(x.name)}</span>`).join('')}</div>` : ''}
      ${d.dependencies.length ? `
        <div class="p-kicker" style="margin-top:12px">dependencies</div>
        <div class="chips">${d.dependencies.map((x) => `<span class="chip" data-pkg="${esc(x.name)}">${esc(x.name)}</span>`).join('')}</div>` : ''}
    `;
    $('drawer').classList.remove('hidden');
    $('dClose').onclick = closeDrawer;
    card.querySelectorAll('[data-pkg]').forEach((c) => {
      c.onclick = () => openPackageDrawer(c.dataset.pkg);
    });
  }
  function closeDrawer() { $('drawer').classList.add('hidden'); }

  // ============================================================ chrome
  function wireChrome() {
    $('brandHome').onclick = () => setOverviewMode();
    $('drawer').onclick = (e) => { if (e.target === $('drawer')) closeDrawer(); };
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDrawer(); $('lockModal').classList.add('hidden'); }
    });

    // search
    const input = $('search');
    const results = $('searchResults');
    let deb = null;
    input.oninput = () => {
      clearTimeout(deb);
      deb = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) { results.classList.add('hidden'); return; }
        const d = await fetch('/api/search?q=' + encodeURIComponent(q)).then((r) => r.json());
        results.innerHTML = (d.results || []).map((r) => `
          <div class="search-row ${r.compromised ? 'compromised' : ''}" data-pkg="${esc(r.name)}">
            <span class="sr-name">${esc(r.name)}</span><span class="sr-dl">${fmt(r.downloads)}/wk</span>
          </div>`).join('') || '<div class="search-row dim">no matches in graph</div>';
        results.classList.remove('hidden');
        results.querySelectorAll('[data-pkg]').forEach((row) => {
          row.onclick = () => { results.classList.add('hidden'); input.value = ''; openPackageDrawer(row.dataset.pkg); };
        });
      }, 220);
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-wrap')) results.classList.add('hidden');
    });

    // console collapse
    $('consoleHead').onclick = () => {
      $('console').classList.toggle('collapsed');
      $('consoleToggle').textContent = $('console').classList.contains('collapsed') ? '▸' : '▾';
    };

    // lockfile modal
    $('lockfileBtn').onclick = () => { $('lockModal').classList.remove('hidden'); $('lockResults').classList.add('hidden'); $('lockInput').classList.remove('hidden'); };
    $('lockClose').onclick = () => $('lockModal').classList.add('hidden');
    $('lockModal').onclick = (e) => { if (e.target === $('lockModal')) $('lockModal').classList.add('hidden'); };
    const dt = $('droptarget');
    dt.onclick = () => $('fileInput').click();
    dt.ondragover = (e) => { e.preventDefault(); dt.classList.add('over'); };
    dt.ondragleave = () => dt.classList.remove('over');
    dt.ondrop = (e) => {
      e.preventDefault(); dt.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) f.text().then((t) => { $('lockText').value = t; runLockCheck(); });
    };
    $('fileInput').onchange = (e) => {
      const f = e.target.files[0];
      if (f) f.text().then((t) => { $('lockText').value = t; runLockCheck(); });
    };
    $('lockRun').onclick = runLockCheck;
    $('lockSample').onclick = async () => {
      const t = await fetch('/sample-package-lock.json').then((r) => r.text());
      $('lockText').value = t;
      runLockCheck();
    };
  }

  async function runLockCheck() {
    const content = $('lockText').value.trim();
    if (!content) return;
    const box = $('lockResults');
    box.classList.remove('hidden');
    $('lockInput').classList.add('hidden');
    box.innerHTML = '<div class="dim" style="font-family:var(--mono);font-size:12px">running graph traversals in HydraDB…</div>';
    const d = await fetch('/api/check-lockfile', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).then((r) => r.json());
    if (d.error) {
      box.innerHTML = `<div class="verdict crit"><div class="verdict-head">Could not read that file</div><div class="verdict-sub">${esc(d.error)}</div></div>
        <button class="btn" onclick="document.getElementById('lockInput').classList.remove('hidden');document.getElementById('lockResults').classList.add('hidden')">try again</button>`;
      return;
    }
    let verdict;
    if (d.resolvedMalicious.length) {
      verdict = `<div class="verdict crit"><div class="verdict-head">🔴 You resolved malicious code</div>
        <div class="verdict-sub">${d.resolvedMalicious.length} package version${d.resolvedMalicious.length === 1 ? ' is' : 's are'} a known-malicious release. Rotate credentials and rebuild from a clean lockfile.</div></div>`;
    } else if (d.transitive.length) {
      verdict = `<div class="verdict warn"><div class="verdict-head">🟡 You are in the blast radius</div>
        <div class="verdict-sub">No malicious versions pinned — but ${d.transitive.length} dependency path${d.transitive.length === 1 ? '' : 's'} reach compromised packages. One <span style="font-family:var(--mono)">npm update</span> at the wrong hour is all it takes.</div></div>`;
    } else {
      verdict = `<div class="verdict ok"><div class="verdict-head">🟢 Clear against the loaded incidents</div>
        <div class="verdict-sub">No malicious versions and no dependency paths into the three incident package sets.</div></div>`;
    }
    box.innerHTML = `
      ${verdict}
      ${d.resolvedMalicious.length ? `
        <div class="lock-section-title">malicious versions in your lockfile</div>
        ${d.resolvedMalicious.map((r) => `<div class="lock-hit"><b>${esc(r.name)}@${esc(r.versions.join(', '))}</b> — ${esc(r.incident)} incident</div>`).join('')}` : ''}
      ${d.transitive.length ? `
        <div class="lock-section-title">exposure paths (your direct deps → compromised package)</div>
        ${d.transitive.slice(0, 14).map((t) => `
          <div class="lock-row"><div class="lock-chain">
            ${t.chain.map((c, i) => `<span class="${i === t.chain.length - 1 ? 'origin' : ''}">${esc(c)}</span>`).join('<span class="arr"> → </span>')}
            <span class="dim">· ${esc(t.incident)}</span>
          </div></div>`).join('')}
        ${d.transitive.length > 14 ? `<div class="dim" style="font-family:var(--mono);font-size:11px;margin-top:4px">+${d.transitive.length - 14} more paths</div>` : ''}` : ''}
      ${d.compromisedPresent.length ? `
        <div class="lock-section-title">compromised packages in your tree — at safe versions</div>
        ${d.compromisedPresent.slice(0, 12).map((c) => `
          <div class="lock-row">${esc(c.name)}@${esc(c.versions.join(', ') || '?')}
            <span class="dim">· malicious: ${esc(c.malicious_versions.join(', '))} (${esc(c.incident)})</span></div>`).join('')}` : ''}
      <div class="lock-note">${esc(d.kind)} · ${d.stats.totalPackages} packages scanned · ${d.stats.directInGraph} direct deps traversed in HydraDB · ${d.stats.dbCalls} graph calls · ${d.stats.ms}ms.
      Path analysis uses the current registry snapshot (${fmt(S.state.dataset.packages)} packages) — packages outside it won't show chains.</div>
      <div class="modal-actions"><button class="btn" id="lockAgain">check another file</button></div>`;
    $('lockAgain').onclick = () => {
      $('lockInput').classList.remove('hidden');
      box.classList.add('hidden');
      $('lockText').value = '';
    };
  }

  // ============================================================ query console
  function startQueryConsole() {
    const body = $('consoleBody');
    const render = (queries) => {
      body.innerHTML = queries.map((q) => {
        const cy = esc(q.query)
          .replace(/\b(MATCH|MERGE|UNWIND|RETURN|WHERE|SET|CALL|YIELD|ORDER BY|LIMIT|AS|DELETE|DETACH)\b/g, '<span class="q-kw">$1</span>')
          .replace(/(algo\.\w+)/g, '<span class="q-proc">$1</span>');
        return `<div class="q-row"><span class="q-ms ${q.ms > 100 ? 'slow' : ''}">${q.ms}ms</span><span class="q-rows">${q.rows} rows</span> ${q.ok ? '' : '<span class="q-err">ERR</span> '}${cy}</div>`;
      }).join('');
    };
    const tick = async () => {
      if (!$('console').classList.contains('collapsed')) {
        try {
          const d = await fetch('/api/query-log').then((r) => r.json());
          render(d.queries || []);
        } catch { /* ignore */ }
      }
      setTimeout(tick, 2500);
    };
    tick();
  }
})();
