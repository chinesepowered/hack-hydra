# 💥 Blast Radius

### When a package goes bad, know what it touches — in seconds, not days.

**▶️ Live demo: https://blast-radius-4jiw.onrender.com** · 🎬 [3-minute demo script](DEMO.md) · 🏁 **Hack Hydra — Track 02-A, supply chain blast radius**

> ⏳ Free-tier hosting sleeps after ~15 min idle, so a cold first load takes 30–60s to wake and reseed the graph. The boot screen streams the seeding log while it does.

![Blast radius of the chalk/debug attack](docs/blast-chalk-debug.png)

---

## ⚡ In 30 seconds

Pick a real supply-chain attack. A shockwave propagates outward through the **real npm dependency graph**, ring by ring, lighting up every downstream package and every internal service it reaches — while the panels fill in *who got hit, when, and through which dependency chain*.

Every number on that screen is a **live HydraDB traversal**. Nothing is precomputed at build time, and the query console at the bottom of the UI streams the actual Cypher as it executes.

---

## 🔥 The problem

> A package is compromised at 09:00. **Which of your services are exposed by 09:06?**

That is a transitive reverse-dependency closure over a versioned ecosystem graph. It is not a similarity problem, and a vector index cannot answer it at all — "packages semantically near `chalk`" is not the same set as "packages that transitively depend on `chalk`". The second set is the one that gets you breached.

In the TanStack compromise, **84 malicious artifacts across 42 packages shipped in six minutes.** Defenders needed the answer faster than the worm propagated.

---

## 🧠 What HydraDB does here (all of it)

Every question the product answers is a graph query. No caches built offline, no precomputed answer tables.

| ❓ Question | 🔎 How HydraDB answers it |
|---|---|
| **Full blast radius** — every package downstream of the compromise | `CALL algo.SSpaths({sourceNode, relTypes:['DEPENDS_ON'], relDirection:'incoming', maxLen:6, pathCount:4000})` — one call per compromised package, whole paths returned with labels + properties |
| **Which services are exposed, and via what chain** | Same traversal; `Service`-labelled path endpoints, with hop distance from first-visit order |
| **Who installed malicious code while it was live** | `MATCH (s:Service)-[r:RESOLVED]->(v:Version) WHERE v.malicious = true AND v.incident = $inc` — compared against each incident's publish window |
| **Your own lockfile's exposure** | `algo.SSpaths` *outgoing* from each direct dependency, intersected with the incident package set |
| **Shared-maintainer surface** | `MATCH (p {id:$pid})<-[:MAINTAINS]-(m)-[:MAINTAINS]->(q)` — two-hop, the "what else can that account push to" watchlist |
| **Which version introduced it** | `MATCH (p {id:$pid})-[:HAS_VERSION]->(v) ... ORDER BY released_at` — real registry publish times, malicious releases flagged |
| **Typosquat radar** | `MATCH (a:Package)-[r:SIMILAR_NAME]->(b:Package)` — edit-distance edges plus documented real malware |
| **Search** | `WHERE p.name STARTS WITH $q ... ORDER BY downloads DESC` |
| **Seeding** (3,115 nodes / 9,149 edges in ~2.5s) | `UNWIND $rows` batch upserts over Bolt, via the stock `neo4j-driver` |

### 🗺️ Graph schema

```
(:Service)-[:DEPENDS_ON]->(:Package)-[:DEPENDS_ON]->(:Package)
(:Maintainer)-[:MAINTAINS]->(:Package)-[:HAS_VERSION]->(:Version)
(:Service)-[:RESOLVED {resolved_at}]->(:Version {malicious, released_at, incident})
(:Package)-[:SIMILAR_NAME {distance, known_malicious}]->(:Package)
```

The `RESOLVED` edge is what turns "you depend on it" into **"you installed it at 14:03, forty-seven minutes into the attack window."** That distinction is the whole product.

---

## 🧪 Field notes on HydraDB's Cypher subset

Written for the people who built it — everything below was learned by hitting it, and is handled in `server/seed.js` and `server/hydra.js`.

- 🔢 **Node ids are non-negative integers, and JS sends numbers as floats.** Every id goes through `neo4j.int()`, or you get `node id property must be an integer`.
- 🏷️ **`UNWIND` vertex upserts take exactly one `SET` label**, and relationship batches need exactly one label per endpoint — so edge batches are grouped by label pair (`Service→Package`, `Maintainer→Package`, …).
- 🚫 **`MERGE` patterns can't carry extra properties** — the pattern is the identity being matched, so properties go in a following `SET`.
- ↩️ **Variable-length `MATCH` needs a fixed source id and only walks outgoing.** Reverse closures are therefore `algo.SSpaths` with `relDirection: 'incoming'` — which is both faster *and* returns whole paths instead of endpoint projections.
- 🧭 **`algo.SSpaths` enumerates simple paths shortest-first under a global `pathCount` cap**, so hop distance falls out of first-visit order for free. This is the single most useful primitive in the database for this problem.
- 🧵 **`RUST_MIN_STACK=33554432` is mandatory** — without it `graph-node` serves `/readyz` then aborts on the first query. (Documented in your README; worth keeping loud.)
- 🌐 **`graph-node` binds every listener to `0.0.0.0` by default.** On a PaaS this exposes 7687/8443/9090 publicly and makes the platform's port scanner flap its routing. `GRAPH_BOLT_ADDR` / `GRAPH_HTTP_ADDR` / `GRAPH_ADMIN_ADDR` pin them to loopback — see `docker/start.sh`.

---

## 📊 The data is real

| Source | What's real |
|---|---|
| 📦 **registry.npmjs.org** | 1,748 packages, 4,299 dependency edges, 1,091 maintainer accounts, live weekly download counts, real version publish timestamps — crawled by `scripts/build-dataset.mjs` |
| 🚨 **Public advisories** | Package lists, malicious version numbers and timelines for three real attacks, each cited in `data/incidents.json` |
| 🏥 **Demo org overlay** | Meridian Health's nine services and their lockfile resolution times are curated, so each incident has services hit in-window, services only transitively exposed, and services that are clear |

### The three incidents

| Attack | Date | What happened |
|---|---|---|
| 🪱 **Mini Shai-Hulud / TanStack** (CVE-2026-45321) | 2026-05-11 | 84 malicious versions across 42 `@tanstack/*` packages in 6 minutes via a compromised GitHub Actions pipeline — **with valid SLSA provenance**. Persistence in `.claude/` and `.vscode/`, plus a home-directory dead-man switch. |
| 🎣 **chalk / debug takeover** | 2025-09-08 | A phished maintainer account shipped a crypto-clipper in 18 foundational packages — **2.6B combined weekly downloads** — live for ~2 hours. |
| 🐛 **Shai-Hulud worm** | 2025-09-14 | The first self-propagating npm worm: every install stole tokens and republished itself. 500+ packages. |

**Don't take our demo org's word for it — 📤 drop your own `package-lock.json` into the console** and it traverses *your* dependencies against all three incidents.

---

## 🚀 Results

| Metric | Value |
|---|---|
| ⚙️ Graph seeded | **3,115 nodes / 9,149 edges in ~2.5s** (8.9s on a 0.1-CPU free instance) |
| 💣 chalk/debug closure | 18 origin packages → **163 packages, 6 of 9 services**, 4,759 paths, 37 graph calls |
| 📉 Downstream exposure | **5.80B weekly downloads** sit under that one compromise |
| ⚡ Query latency | **0.13s** per incident once warmed at boot (10.2s cold on 0.1 CPU) |
| 📤 Lockfile analysis | 109 packages, 4 graph traversals, **912ms** |
| 🪶 Footprint | **105MB** at boot, 162MB peak — HydraDB *and* the app inside a 512MB free tier |

---

## 🏃 Run it

### 🐳 One container (HydraDB + console)

```bash
docker build -t blast-radius .
docker run --rm -p 3000:3000 blast-radius
# → http://localhost:3000
```

### ☁️ Deploy your own (Render free tier)

`render.yaml` is a ready blueprint — **New → Blueprint**, point at the repo, **Apply**. No env vars, no external database, no persistent disk: the graph reseeds from the committed dataset on every cold start.

### 🔧 Dev mode (separate processes)

```bash
# 1. HydraDB
mkdir -p hydradb-data/store hydradb-data/cache
printf '%s\n' 'local-development-token-32-bytes' > hydradb-data/auth-token
docker run --rm --user "$(id -u):$(id -g)" -p 7687:7687 -p 8443:8443 -p 9090:9090 \
  -v "$PWD/hydradb-data:/data" \
  -e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default -e GRAPH_CELL_ID=cell-0 \
  -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest

# 2. the console
npm install && npm start        # → http://localhost:3000

# optional: re-crawl npm (rewrites data/graph.json)
npm run build-dataset
```

---

## 📸 Screens

| Ecosystem view | TanStack blast radius |
|---|---|
| ![ecosystem](docs/ecosystem-overview.png) | ![tanstack](docs/blast-tanstack.png) |
| **Your lockfile, checked** | **Package forensics** |
| ![lockfile](docs/lockfile-check.png) | ![drawer](docs/package-drawer.png) |

---

## 📁 Repo map

```
server/
  index.js       API — boot/seed orchestration, blast radius, lockfile analysis
  hydra.js       Bolt connection, neo4j.int() discipline, live query log
  seed.js        deterministic ids + UNWIND batch seeding
  lockfile.js    package-lock v1/v2/v3 + package.json parsing
public/          the console UI (vanilla JS, canvas force-graph, no build step)
data/
  incidents.json curated + fully cited incident data
  graph.json     committed crawl of registry.npmjs.org
  org.json       the demo organization
scripts/
  build-dataset.mjs   the npm crawler
docker/start.sh  boots graph-node + console in one container
render.yaml      one-click free-tier deploy
```

---

## 📜 License

MIT. HydraDB itself is AGPL-3.0 and runs **unmodified as a separate process**, spoken to only over its public Bolt and HTTP APIs.
