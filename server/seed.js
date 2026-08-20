// Seeds HydraDB with the real npm ecosystem slice + incidents + demo org.
// HydraDB batch-write rules (see cypher-compat.md in the hydradb repo):
//   - vertex upsert: UNWIND $rows MERGE (n {id: row.id}) SET n:Label, n.prop = row.prop
//     (exactly one SET label; MERGE pattern carries only the id)
//   - edges: UNWIND $rows MATCH (s:Src {id: row.src}), (d:Dst {id: row.dst})
//     MERGE (s)-[r:TYPE {id: row.eid}]->(d) SET ...
//     (endpoints need exactly one label each, so batches are grouped by label pair)
//   - every id is a non-negative integer
const fs = require('fs');
const path = require('path');
const { run, I } = require('./hydra');

const DATA = path.join(__dirname, '..', 'data');
const graph = JSON.parse(fs.readFileSync(path.join(DATA, 'graph.json'), 'utf8'));
const incidentsFile = JSON.parse(fs.readFileSync(path.join(DATA, 'incidents.json'), 'utf8'));
const org = JSON.parse(fs.readFileSync(path.join(DATA, 'org.json'), 'utf8'));

const BATCH = 400;

// ---- deterministic id assignment (same every boot, derived from data files) ----
function buildIdMaps() {
  const pkgId = new Map();
  let next = 1000;
  const crawled = graph.packages.map((p) => p.name).sort();
  for (const name of crawled) pkgId.set(name, next++);
  // Known-malicious historical typosquats were removed from npm, so the crawl
  // cannot see them; they still get nodes (flagged) so the radar can show them.
  for (const t of [...graph.typosquats].sort((a, b) => a.squat.localeCompare(b.squat))) {
    if (t.known_malicious && !pkgId.has(t.squat)) pkgId.set(t.squat, next++);
  }
  const maintainerId = new Map();
  const maintainers = [...new Set(graph.packages.flatMap((p) => p.maintainers))].sort();
  next = 200000;
  for (const m of maintainers) maintainerId.set(m, next++);
  const serviceId = new Map();
  next = 300000;
  for (const s of org.services) serviceId.set(s.name, next++);
  const versionId = new Map(); // "pkg@semver" -> id
  next = 400000;
  for (const [pkg, versions] of Object.entries(graph.timelines).sort()) {
    for (const v of versions) versionId.set(`${pkg}@${v.version}`, next++);
  }
  return { pkgId, maintainerId, serviceId, versionId };
}

function incidentByPackage() {
  const map = new Map(); // pkg name -> {incidentId, versions:Set}
  for (const inc of incidentsFile.incidents) {
    for (const p of inc.packages) {
      map.set(p.name, { incidentId: inc.id, versions: new Set(p.malicious_versions) });
    }
  }
  return map;
}

async function batched(query, rows, paramName = 'rows') {
  for (let i = 0; i < rows.length; i += BATCH) {
    await run(query, { [paramName]: rows.slice(i, i + BATCH) });
  }
}

async function alreadySeeded() {
  try {
    const res = await run('MATCH (m:Meta {id: 0}) RETURN m.seeded AS s');
    return res.records.length > 0 && res.records[0].get('s') === true;
  } catch {
    return false;
  }
}

async function seed(onProgress = () => {}) {
  const ids = buildIdMaps();
  const incPkg = incidentByPackage();
  const stats = { nodes: 0, edges: 0, skipped: false };

  if (await alreadySeeded()) {
    stats.skipped = true;
    return { ids, stats };
  }

  const t0 = Date.now();

  // -- Package nodes
  const squatNotes = new Map(graph.typosquats.filter((t) => t.known_malicious).map((t) => [t.squat, t]));
  const pkgRows = graph.packages.map((p) => {
    const inc = incPkg.get(p.name);
    return {
      id: I(ids.pkgId.get(p.name)),
      name: p.name,
      version: p.version,
      description: p.description || '',
      downloads: I(p.downloads || 0),
      compromised: Boolean(inc),
      incident: inc ? inc.incidentId : '',
      removed: false,
    };
  });
  for (const [squat, t] of squatNotes) {
    if (!graph.packages.some((p) => p.name === squat)) {
      pkgRows.push({
        id: I(ids.pkgId.get(squat)), name: squat, version: '',
        description: t.note || 'Known malicious typosquat, removed from npm',
        downloads: I(0), compromised: false, incident: '', removed: true,
      });
    }
  }
  await batched(
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Package, n.name = row.name, n.version = row.version, n.description = row.description, n.downloads = row.downloads, n.compromised = row.compromised, n.incident = row.incident, n.removed = row.removed',
    pkgRows,
  );
  stats.nodes += pkgRows.length;
  onProgress(`packages: ${pkgRows.length}`);

  // -- Maintainer nodes
  const maintRows = [...ids.maintainerId.entries()].map(([name, id]) => ({ id: I(id), name }));
  await batched('UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Maintainer, n.name = row.name', maintRows);
  stats.nodes += maintRows.length;
  onProgress(`maintainers: ${maintRows.length}`);

  // -- Service nodes
  const svcRows = org.services.map((s) => ({
    id: I(ids.serviceId.get(s.name)), name: s.name, kind: s.kind,
    description: s.description, org: org.org,
  }));
  await batched(
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Service, n.name = row.name, n.kind = row.kind, n.description = row.description, n.org = row.org',
    svcRows,
  );
  stats.nodes += svcRows.length;

  // -- Version nodes (incident package timelines; malicious flag + incident id)
  const verRows = [];
  for (const [pkg, versions] of Object.entries(graph.timelines)) {
    const inc = incPkg.get(pkg);
    for (const v of versions) {
      verRows.push({
        id: I(ids.versionId.get(`${pkg}@${v.version}`)),
        pkg, semver: v.version,
        released_at: I(Math.floor(new Date(v.time).getTime() / 1000)),
        malicious: Boolean(v.malicious),
        unpublished: Boolean(v.unpublished),
        incident: v.malicious && inc ? inc.incidentId : '',
      });
    }
  }
  await batched(
    'UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Version, n.pkg = row.pkg, n.semver = row.semver, n.released_at = row.released_at, n.malicious = row.malicious, n.unpublished = row.unpublished, n.incident = row.incident',
    verRows,
  );
  stats.nodes += verRows.length;
  onProgress(`versions: ${verRows.length}`);

  // -- Edges. Unique integer ids per edge, grouped by endpoint label pair.
  let eid = 10000000;

  const depRows = [];
  for (const p of graph.packages) {
    for (const d of p.deps) {
      if (ids.pkgId.has(d)) {
        depRows.push({ src: I(ids.pkgId.get(p.name)), dst: I(ids.pkgId.get(d)), eid: I(eid++) });
      }
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Package {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[r:DEPENDS_ON {id: row.eid}]->(d)',
    depRows,
  );
  stats.edges += depRows.length;
  onProgress(`dependency edges: ${depRows.length}`);

  const svcDepRows = [];
  for (const s of org.services) {
    for (const d of s.deps) {
      if (ids.pkgId.has(d)) {
        svcDepRows.push({ src: I(ids.serviceId.get(s.name)), dst: I(ids.pkgId.get(d)), eid: I(eid++) });
      }
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Service {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[r:DEPENDS_ON {id: row.eid}]->(d)',
    svcDepRows,
  );
  stats.edges += svcDepRows.length;

  const maintainsRows = [];
  for (const p of graph.packages) {
    for (const m of p.maintainers) {
      maintainsRows.push({ src: I(ids.maintainerId.get(m)), dst: I(ids.pkgId.get(p.name)), eid: I(eid++) });
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Maintainer {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[r:MAINTAINS {id: row.eid}]->(d)',
    maintainsRows,
  );
  stats.edges += maintainsRows.length;
  onProgress(`maintainer edges: ${maintainsRows.length}`);

  const hasVerRows = [];
  for (const [pkg, versions] of Object.entries(graph.timelines)) {
    if (!ids.pkgId.has(pkg)) continue;
    for (const v of versions) {
      hasVerRows.push({ src: I(ids.pkgId.get(pkg)), dst: I(ids.versionId.get(`${pkg}@${v.version}`)), eid: I(eid++) });
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Package {id: row.src}), (d:Version {id: row.dst}) MERGE (s)-[r:HAS_VERSION {id: row.eid}]->(d)',
    hasVerRows,
  );
  stats.edges += hasVerRows.length;

  const resolvedRows = [];
  for (const s of org.services) {
    for (const r of s.resolutions || []) {
      const vid = ids.versionId.get(`${r.name}@${r.version}`);
      if (vid !== undefined) {
        resolvedRows.push({
          src: I(ids.serviceId.get(s.name)), dst: I(vid), eid: I(eid++),
          resolved_at: I(Math.floor(new Date(r.resolved_at).getTime() / 1000)),
        });
      }
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Service {id: row.src}), (d:Version {id: row.dst}) MERGE (s)-[r:RESOLVED {id: row.eid}]->(d) SET r.resolved_at = row.resolved_at',
    resolvedRows,
  );
  stats.edges += resolvedRows.length;
  onProgress(`lockfile resolutions: ${resolvedRows.length}`);

  const squatRows = [];
  for (const t of graph.typosquats) {
    if (ids.pkgId.has(t.squat) && ids.pkgId.has(t.target)) {
      squatRows.push({
        src: I(ids.pkgId.get(t.squat)), dst: I(ids.pkgId.get(t.target)), eid: I(eid++),
        distance: I(t.distance), known_malicious: Boolean(t.known_malicious), note: t.note || '',
      });
    }
  }
  await batched(
    'UNWIND $rows AS row MATCH (s:Package {id: row.src}), (d:Package {id: row.dst}) MERGE (s)-[r:SIMILAR_NAME {id: row.eid}]->(d) SET r.distance = row.distance, r.known_malicious = row.known_malicious, r.note = row.note',
    squatRows,
  );
  stats.edges += squatRows.length;

  await run('UNWIND $rows AS row MERGE (n {id: row.id}) SET n:Meta, n.seeded = row.seeded, n.nodes = row.nodes, n.edges = row.edges',
    { rows: [{ id: I(0), seeded: true, nodes: I(stats.nodes), edges: I(stats.edges) }] });

  stats.ms = Date.now() - t0;
  return { ids, stats };
}

module.exports = { seed, buildIdMaps, incidentByPackage, graph, incidentsFile, org };
