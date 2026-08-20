// Blast Radius — supply-chain incident console on HydraDB.
// Every graph question in the API is answered by HydraDB: reverse-dependency
// closures via the native algo.SSpaths path procedure, exposure chains via
// algo.SPpaths, maintainer overlap and lockfile-window checks via Cypher.
const express = require('express');
const path = require('path');
const { run, I, waitForReady, queryLog } = require('./hydra');
const { seed, buildIdMaps, incidentByPackage, graph, incidentsFile, org } = require('./seed');
const { parseLockfile } = require('./lockfile');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

const state = {
  status: 'starting', // starting -> waiting-db -> seeding -> ready | error
  progress: [],
  error: null,
  seedStats: null,
};
let ids = null;          // {pkgId, maintainerId, serviceId, versionId}
let idToNode = null;     // numeric id -> {name, type}
let overviewCache = null;
const blastCache = new Map();

function note(msg) {
  state.progress.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  console.log(`[boot] ${msg}`);
}

function buildIdIndex() {
  idToNode = new Map();
  for (const [name, id] of ids.pkgId) idToNode.set(id, { name, type: 'package' });
  for (const [name, id] of ids.maintainerId) idToNode.set(id, { name, type: 'maintainer' });
  for (const [name, id] of ids.serviceId) idToNode.set(id, { name, type: 'service' });
  for (const [key, id] of ids.versionId) idToNode.set(id, { name: key, type: 'version' });
}

// ---------------------------------------------------------------- boot
async function boot() {
  try {
    state.status = 'waiting-db';
    note('waiting for HydraDB (bolt 7687 / admin 9090)...');
    await waitForReady(180000).catch(async (e) => {
      // Meta node may not exist yet on a fresh store — readyz is enough then.
      if (!/not ready/.test(e.message)) return;
      throw e;
    });
    note('HydraDB is up');

    state.status = 'seeding';
    note('seeding graph (real npm ecosystem slice + incidents + org)...');
    const result = await seed((m) => note(`  ${m}`));
    ids = result.ids;
    state.seedStats = result.stats;
    buildIdIndex();
    note(result.stats.skipped
      ? 'store already seeded — skipped'
      : `seeded ${result.stats.nodes} nodes, ${result.stats.edges} edges in ${result.stats.ms}ms`);

    note('building ecosystem overview from HydraDB...');
    overviewCache = await buildOverview();
    note(`overview ready: ${overviewCache.nodes.length} nodes, ${overviewCache.links.length} links`);
    state.status = 'ready';
    note('console ready');
  } catch (e) {
    state.status = 'error';
    state.error = e.message;
    console.error('[boot] FAILED:', e);
  }
}

async function buildOverview() {
  const pkgRes = await run(
    'MATCH (p:Package) RETURN p.id AS id, p.name AS name, p.downloads AS downloads, p.compromised AS compromised, p.incident AS incident, p.removed AS removed LIMIT 10000');
  const depRes = await run(
    'MATCH (a:Package)-[e:DEPENDS_ON]->(b:Package) RETURN a.id AS s, b.id AS t LIMIT 30000');
  const svcRes = await run(
    'MATCH (s:Service) RETURN s.id AS id, s.name AS name, s.kind AS kind, s.description AS description LIMIT 100');
  const svcDepRes = await run(
    'MATCH (s:Service)-[e:DEPENDS_ON]->(b:Package) RETURN s.id AS sid, b.id AS t LIMIT 1000');
  const squatRes = await run(
    'MATCH (a:Package)-[r:SIMILAR_NAME]->(b:Package) RETURN a.id AS s, b.id AS t, r.known_malicious AS known LIMIT 1000');

  const nodes = pkgRes.records.map((r) => ({
    id: r.get('id'), name: r.get('name'), type: 'package',
    downloads: r.get('downloads'), compromised: r.get('compromised'),
    incident: r.get('incident') || null, removed: r.get('removed'),
  }));
  for (const r of svcRes.records) {
    nodes.push({ id: r.get('id'), name: r.get('name'), type: 'service', kind: r.get('kind'), description: r.get('description') });
  }
  const links = depRes.records.map((r) => ({ source: r.get('s'), target: r.get('t'), rel: 'DEPENDS_ON' }));
  for (const r of svcDepRes.records) links.push({ source: r.get('sid'), target: r.get('t'), rel: 'DEPENDS_ON' });
  for (const r of squatRes.records) links.push({ source: r.get('s'), target: r.get('t'), rel: 'SIMILAR_NAME', known: r.get('known') });
  return { nodes, links };
}

// ------------------------------------------------------- blast radius
async function blastRadius(incident) {
  const t0 = Date.now();
  let dbCalls = 0;
  let pathsSeen = 0;
  const nodes = new Map(); // id -> {id,name,type,hop,...}
  const links = new Map(); // "s->t" -> {source,target,hop}
  const serviceChains = new Map(); // serviceId -> chain of names (service..origin)

  const originIds = [];
  for (const p of incident.packages) {
    const pid = ids.pkgId.get(p.name);
    if (pid === undefined) continue;
    originIds.push(pid);
    nodes.set(pid, { id: pid, name: p.name, type: 'origin', hop: 0,
      malicious_versions: p.malicious_versions });
  }

  for (const pid of originIds) {
    const res = await run(
      "CALL algo.SSpaths({sourceNode: $src, relTypes: ['DEPENDS_ON'], relDirection: 'incoming', maxLen: 6, pathCount: 4000}) YIELD path RETURN path",
      { src: I(pid) });
    dbCalls++;
    for (const rec of res.records) {
      const p = rec.get('path');
      pathsSeen++;
      let prevId = pid;
      p.segments.forEach((seg, k) => {
        const n = seg.end;
        const nid = Number(n.identity);
        const hop = k + 1;
        if (!nodes.has(nid)) {
          const props = n.properties || {};
          nodes.set(nid, {
            id: nid,
            name: props.name,
            type: n.labels.includes('Service') ? 'service' : 'package',
            kind: props.kind,
            downloads: props.downloads || 0,
            compromised: Boolean(props.compromised),
            hop,
          });
          if (n.labels.includes('Service') && !serviceChains.has(nid)) {
            const chain = [pid, ...p.segments.slice(0, k + 1).map((s2) => Number(s2.end.identity))];
            serviceChains.set(nid, chain.reverse()); // service ... origin
          }
        } else {
          const existing = nodes.get(nid);
          if (hop < existing.hop) existing.hop = hop;
        }
        const key = `${nid}->${prevId}`; // true edge direction: dependent -> dependency
        if (!links.has(key)) links.set(key, { source: nid, target: prevId, hop });
        prevId = nid;
      });
    }
  }

  // Which services resolved a malicious version, and was it inside the live window?
  const resolvedRes = await run(
    'MATCH (s:Service)-[r:RESOLVED]->(v:Version) WHERE v.malicious = true AND v.incident = $inc RETURN s.name AS service, v.pkg AS pkg, v.semver AS semver, r.resolved_at AS at',
    { inc: incident.id });
  dbCalls++;
  const windowStart = Math.floor(new Date(incident.published_at).getTime() / 1000);
  const windowEnd = Math.floor(new Date(incident.window_end).getTime() / 1000);
  const resolvedMalicious = resolvedRes.records.map((r) => ({
    service: r.get('service'), pkg: r.get('pkg'), semver: r.get('semver'),
    resolved_at: new Date(r.get('at') * 1000).toISOString(),
    in_window: r.get('at') >= windowStart && r.get('at') <= windowEnd,
  }));

  // Maintainer overlap: who controls the compromised packages, what else do they control?
  const maintainers = new Map();
  for (const p of incident.packages) {
    const pid = ids.pkgId.get(p.name);
    if (pid === undefined) continue;
    const res = await run(
      'MATCH (p {id: $pid})<-[:MAINTAINS]-(m)-[:MAINTAINS]->(q) RETURN m.name AS maintainer, q.name AS pkg, q.compromised AS compromised, q.downloads AS downloads',
      { pid: I(pid) });
    dbCalls++;
    for (const rec of res.records) {
      const m = rec.get('maintainer');
      if (!maintainers.has(m)) maintainers.set(m, new Map());
      maintainers.get(m).set(rec.get('pkg'), {
        name: rec.get('pkg'), compromised: rec.get('compromised'), downloads: rec.get('downloads'),
      });
    }
  }
  const maintainerOverlap = [...maintainers.entries()].map(([m, pkgs]) => ({
    maintainer: m,
    packages: [...pkgs.values()].sort((a, b) => b.downloads - a.downloads),
  })).sort((a, b) => b.packages.length - a.packages.length);

  const exposedServices = [...nodes.values()].filter((n) => n.type === 'service').map((n) => ({
    id: n.id, name: n.name, kind: n.kind, hop: n.hop,
    chain: (serviceChains.get(n.id) || []).map((x) => idToNode.get(x)?.name || String(x)),
  })).sort((a, b) => a.hop - b.hop);
  const exposedNames = new Set(exposedServices.map((s) => s.name));
  const resolvedNames = new Set(resolvedMalicious.map((r) => r.service));
  const safeServices = org.services.map((s) => s.name)
    .filter((n) => !exposedNames.has(n) && !resolvedNames.has(n));

  const affected = [...nodes.values()].filter((n) => n.type === 'package').length;
  return {
    incident,
    nodes: [...nodes.values()],
    links: [...links.values()],
    services: { exposed: exposedServices, resolvedMalicious, safe: safeServices },
    maintainerOverlap,
    stats: {
      originPackages: originIds.length,
      packagesAffected: affected,
      servicesExposed: exposedServices.length,
      paths: pathsSeen,
      dbCalls,
      ms: Date.now() - t0,
    },
  };
}

// ------------------------------------------------------------- routes
const ready = (res) => {
  if (state.status !== 'ready') {
    res.status(503).json({ error: 'not ready', status: state.status });
    return false;
  }
  return true;
};

app.get('/api/state', (req, res) => {
  res.json({
    status: state.status,
    progress: state.progress.slice(-14),
    error: state.error,
    seedStats: state.seedStats,
    org: { name: org.org, tagline: org.tagline, services: org.services.map((s) => ({ name: s.name, kind: s.kind, description: s.description })) },
    incidents: incidentsFile.incidents.map((i) => ({
      id: i.id, name: i.name, short: i.short, date: i.date, attacker: i.attacker,
      cve: i.cve, advisory: i.advisory, published_at: i.published_at,
      detected_at: i.detected_at, window_end: i.window_end,
      story: i.story, payload: i.payload, window_note: i.window_note,
      sources: i.sources, packages: i.packages, packages_note: i.packages_note,
    })),
    dataset: {
      generated_at: graph.generated_at, source: graph.source,
      packages: graph.packages.length,
      edges: graph.packages.reduce((a, p) => a + p.deps.length, 0),
      maintainers: new Set(graph.packages.flatMap((p) => p.maintainers)).size,
    },
  });
});

app.get('/api/overview', (req, res) => {
  if (!ready(res)) return;
  res.json(overviewCache);
});

app.get('/api/blast/:incidentId', async (req, res) => {
  if (!ready(res)) return;
  try {
    const incident = incidentsFile.incidents.find((i) => i.id === req.params.incidentId);
    if (!incident) return res.status(404).json({ error: 'unknown incident' });
    if (!blastCache.has(incident.id)) blastCache.set(incident.id, await blastRadius(incident));
    res.json(blastCache.get(incident.id));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/package/:name(*)', async (req, res) => {
  if (!ready(res)) return;
  try {
    const name = req.params.name;
    const pid = ids.pkgId.get(name);
    if (pid === undefined) return res.status(404).json({ error: 'package not in graph' });
    const info = await run('MATCH (p:Package {id: $pid}) RETURN p.name AS name, p.version AS version, p.description AS description, p.downloads AS downloads, p.compromised AS compromised, p.incident AS incident, p.removed AS removed', { pid: I(pid) });
    const maint = await run('MATCH (p {id: $pid})<-[:MAINTAINS]-(m) RETURN m.name AS name', { pid: I(pid) });
    const deps = await run('MATCH (p {id: $pid})-[:DEPENDS_ON]->(d) RETURN d.id AS id, d.name AS name ORDER BY name', { pid: I(pid) });
    const dependents = await run('MATCH (p {id: $pid})<-[:DEPENDS_ON]-(d) RETURN d.id AS id, d.name AS name ORDER BY name LIMIT 100', { pid: I(pid) });
    const timeline = await run('MATCH (p {id: $pid})-[:HAS_VERSION]->(v) RETURN v.semver AS semver, v.released_at AS released_at, v.malicious AS malicious, v.unpublished AS unpublished ORDER BY released_at', { pid: I(pid) });
    if (info.records.length === 0) return res.status(404).json({ error: 'not found' });
    const rec = info.records[0];
    res.json({
      name: rec.get('name'), version: rec.get('version'), description: rec.get('description'),
      downloads: rec.get('downloads'), compromised: rec.get('compromised'),
      incident: rec.get('incident') || null, removed: rec.get('removed'),
      maintainers: maint.records.map((r) => r.get('name')),
      dependencies: deps.records.map((r) => ({ id: r.get('id'), name: r.get('name') })),
      dependents: dependents.records.map((r) => ({
        id: r.get('id'), name: r.get('name'),
        type: idToNode.get(r.get('id'))?.type || 'package',
      })),
      timeline: timeline.records.map((r) => ({
        semver: r.get('semver'),
        released_at: new Date(r.get('released_at') * 1000).toISOString(),
        malicious: r.get('malicious'), unpublished: r.get('unpublished'),
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  if (!ready(res)) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const r = await run(
      'MATCH (p:Package) WHERE p.name STARTS WITH $q RETURN p.id AS id, p.name AS name, p.downloads AS downloads, p.compromised AS compromised ORDER BY downloads DESC LIMIT 12',
      { q });
    res.json({ results: r.records.map((x) => ({ id: x.get('id'), name: x.get('name'), downloads: x.get('downloads'), compromised: x.get('compromised') })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/typosquats', async (req, res) => {
  if (!ready(res)) return;
  try {
    const r = await run(
      'MATCH (a:Package)-[r:SIMILAR_NAME]->(b:Package) RETURN a.name AS squat, a.removed AS removed, a.description AS description, b.name AS target, b.downloads AS target_downloads, r.distance AS distance, r.known_malicious AS known, r.note AS note LIMIT 500');
    res.json({
      pairs: r.records.map((x) => ({
        squat: x.get('squat'), removed: x.get('removed'), description: x.get('description'),
        target: x.get('target'), target_downloads: x.get('target_downloads'),
        distance: x.get('distance'), known_malicious: x.get('known'), note: x.get('note'),
      })).sort((a, b) => (b.known_malicious - a.known_malicious) || (b.target_downloads - a.target_downloads)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/check-lockfile', async (req, res) => {
  if (!ready(res)) return;
  const t0 = Date.now();
  let dbCalls = 0;
  try {
    const { found, direct, kind } = parseLockfile(String(req.body.content || ''));
    const incPkg = incidentByPackage();

    const resolvedMalicious = [];
    const compromisedPresent = [];
    for (const [name, versions] of found) {
      const inc = incPkg.get(name);
      if (!inc) continue;
      const incident = incidentsFile.incidents.find((i) => i.id === inc.incidentId);
      const bad = [...versions].filter((v) => inc.versions.has(v));
      if (bad.length > 0) {
        resolvedMalicious.push({ name, versions: bad, incident: incident.short, incidentId: incident.id });
      } else {
        compromisedPresent.push({
          name, versions: [...versions].filter(Boolean),
          malicious_versions: [...inc.versions], incident: incident.short, incidentId: incident.id,
        });
      }
    }

    // Transitive exposure: walk each direct dep's dependency cone in HydraDB
    // and intersect it with the incident packages.
    const directInGraph = direct.filter((d) => ids.pkgId.has(d)).slice(0, 80);
    const incidentIdsByPkgId = new Map();
    for (const [name, inc] of incPkg) {
      const pid = ids.pkgId.get(name);
      if (pid !== undefined) incidentIdsByPkgId.set(pid, { name, incidentId: inc.incidentId });
    }
    const transitive = [];
    const seenPairs = new Set();
    for (const dep of directInGraph) {
      const res2 = await run(
        "CALL algo.SSpaths({sourceNode: $src, relTypes: ['DEPENDS_ON'], relDirection: 'outgoing', maxLen: 6, pathCount: 2000}) YIELD path RETURN path",
        { src: I(ids.pkgId.get(dep)) });
      dbCalls++;
      for (const rec of res2.records) {
        const p = rec.get('path');
        const endId = Number(p.end.identity);
        const hit = incidentIdsByPkgId.get(endId);
        if (hit) {
          const key = `${dep}->${hit.name}`;
          if (!seenPairs.has(key)) {
            seenPairs.add(key);
            const incident = incidentsFile.incidents.find((i) => i.id === hit.incidentId);
            transitive.push({
              from: dep, to: hit.name, incident: incident.short, incidentId: incident.id,
              chain: [p.start.properties.name, ...p.segments.map((s) => s.end.properties.name)],
              inLockfile: found.has(hit.name),
            });
          }
        }
      }
    }

    res.json({
      kind,
      stats: {
        totalPackages: found.size, directDeps: direct.length,
        directInGraph: directInGraph.length, dbCalls, ms: Date.now() - t0,
      },
      resolvedMalicious, compromisedPresent,
      transitive: transitive.sort((a, b) => a.chain.length - b.chain.length).slice(0, 60),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/query-log', (req, res) => {
  res.json({ queries: queryLog.slice(-30).reverse() });
});

app.get('/healthz', (req, res) => res.json({ status: state.status }));

app.listen(PORT, () => {
  console.log(`Blast Radius console listening on :${PORT}`);
  boot();
});
