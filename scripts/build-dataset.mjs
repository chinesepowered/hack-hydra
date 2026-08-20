#!/usr/bin/env node
// Builds data/graph.json: a real slice of the npm ecosystem crawled from
// registry.npmjs.org, centered on three real supply-chain incidents plus the
// packages the demo org depends on. Run once; the output is committed so the
// deployed app never needs to crawl.
//
// Usage: node scripts/build-dataset.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const incidents = JSON.parse(readFileSync(join(ROOT, 'data', 'incidents.json'), 'utf8'));
const org = JSON.parse(readFileSync(join(ROOT, 'data', 'org.json'), 'utf8'));

const POPULAR_SEEDS = [
  'react', 'react-dom', 'next', 'vue', 'express', 'fastify', 'koa',
  'axios', 'node-fetch', 'lodash', 'moment', 'dayjs', 'date-fns',
  'commander', 'yargs', 'inquirer', 'ora', 'boxen', 'log-symbols',
  'eslint', 'prettier', 'typescript', 'jest', 'mocha', 'vitest', 'vite',
  'webpack', 'rollup', 'esbuild', '@babel/core', '@babel/code-frame',
  'postcss', 'tailwindcss', 'styled-components', 'zod', 'jsonwebtoken',
  'passport', 'bcrypt', 'cors', 'body-parser', 'morgan', 'dotenv',
  'nodemon', 'rimraf', 'glob', 'fs-extra', 'uuid', 'nanoid',
  'pg', 'mysql2', 'mongoose', 'ioredis', 'bullmq', 'nodemailer',
  'socket.io', 'ws', 'sharp', 'multer', 'stripe', 'openai',
  '@tanstack/react-query', 'react-router-dom', 'zustand', 'rxjs',
  'cross-env', 'electron', 'babel-cli', 'send', 'serve-static',
  'http-errors', 'compression', 'cookie-parser', 'helmet', 'express-session',
  'browserslist', 'autoprefixer', 'sass', 'ts-node', 'concurrently',
  'lint-staged', 'pino', 'winston', 'got', 'superagent', 'form-data',
  'archiver', 'chokidar', 'execa', 'listr2', 'gulp', 'pm2', 'serve',
  'http-server', 'semantic-release', 'lerna', 'turbo', 'npm-run-all',
  'react-scripts', 'jscodeshift', 'jsdom', 'puppeteer', 'cheerio',
  'meow', 'update-notifier', 'configstore', 'conf', 'ky', 'undici',
];

const MAX_DEPTH = 3;          // seeds are depth 0; follow runtime deps three levels
const MAX_PACKAGES = 2600;    // hard cap
const CONCURRENCY = 24;

const incidentPkgs = incidents.incidents.flatMap((i) => i.packages.map((p) => p.name));
const orgDeps = org.services.flatMap((s) => s.deps);
const typosquatTargets = incidents.known_typosquats.map((t) => t.target);
const seeds = [...new Set([...incidentPkgs, ...orgDeps, ...typosquatTargets, ...POPULAR_SEEDS])];

const packages = new Map(); // name -> {name, version, description, deps, maintainers, depth}
const queue = seeds.map((name) => ({ name, depth: 0 }));
const queued = new Set(seeds);
let fetched = 0;

async function fetchJson(url, tries = 3) {
  for (let a = 1; a <= tries; a++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (a === tries) { console.error(`  FAIL ${url}: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 500 * a));
    }
  }
}

async function crawlOne({ name, depth }) {
  const enc = name.replace('/', '%2F');
  const doc = await fetchJson(`https://registry.npmjs.org/${enc}/latest`);
  fetched++;
  if (fetched % 100 === 0) console.log(`  ${fetched} fetched, ${queue.length} queued, ${packages.size} kept`);
  if (!doc || !doc.name) return;
  const deps = Object.keys(doc.dependencies || {});
  packages.set(name, {
    name,
    version: doc.version || '',
    description: (doc.description || '').slice(0, 140),
    deps,
    maintainers: (doc.maintainers || []).map((m) => m.name).filter(Boolean),
    depth,
  });
  if (depth < MAX_DEPTH) {
    for (const d of deps) {
      if (!queued.has(d) && queued.size < MAX_PACKAGES) {
        queued.add(d);
        queue.push({ name: d, depth: depth + 1 });
      }
    }
  }
}

async function crawl() {
  console.log(`Crawling from ${seeds.length} seeds (max depth ${MAX_DEPTH}, cap ${MAX_PACKAGES})...`);
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) await crawlOne(item);
    }
  });
  await Promise.all(workers);
  console.log(`Crawl done: ${packages.size} packages`);
}

async function fetchDownloads() {
  console.log('Fetching weekly downloads...');
  const names = [...packages.keys()];
  const unscoped = names.filter((n) => !n.startsWith('@'));
  const scoped = names.filter((n) => n.startsWith('@'));
  const downloads = new Map();
  for (let i = 0; i < unscoped.length; i += 100) {
    const batch = unscoped.slice(i, i + 100);
    const doc = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${batch.join(',')}`);
    if (doc) {
      if (batch.length === 1 && doc.downloads !== undefined) downloads.set(batch[0], doc.downloads);
      else for (const [k, v] of Object.entries(doc)) if (v && v.downloads !== undefined) downloads.set(k, v.downloads);
    }
  }
  let done = 0;
  const scopedQueue = [...scoped];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (scopedQueue.length > 0) {
      const n = scopedQueue.shift();
      if (!n) break;
      const doc = await fetchJson(`https://api.npmjs.org/downloads/point/last-week/${n.replace('/', '%2F')}`);
      if (doc && doc.downloads !== undefined) downloads.set(n, doc.downloads);
      if (++done % 100 === 0) console.log(`  scoped downloads: ${done}/${scoped.length}`);
    }
  }));
  console.log(`Downloads for ${downloads.size} packages`);
  return downloads;
}

// Version timelines for incident packages: real publish timestamps from the
// registry, plus the malicious versions from the advisories (npm unpublished
// them, so the registry no longer lists them).
async function fetchTimelines() {
  console.log('Fetching version timelines for incident packages...');
  const timelines = {};
  for (const inc of incidents.incidents) {
    for (const p of inc.packages) {
      const doc = await fetchJson(`https://registry.npmjs.org/${p.name.replace('/', '%2F')}`);
      const time = (doc && doc.time) || {};
      const entries = Object.entries(time)
        .filter(([v]) => v !== 'created' && v !== 'modified')
        .map(([version, t]) => ({ version, time: t, malicious: false }))
        .sort((a, b) => new Date(a.time) - new Date(b.time));
      const publishedAt = inc.published_at;
      const before = entries.filter((e) => new Date(e.time) <= new Date(publishedAt)).slice(-6);
      const after = entries.filter((e) => new Date(e.time) > new Date(publishedAt)).slice(0, 4);
      const kept = [...before, ...after];
      for (const mv of p.malicious_versions) {
        const existing = kept.find((e) => e.version === mv);
        if (existing) existing.malicious = true;
        else kept.push({ version: mv, time: publishedAt, malicious: true, unpublished: true });
      }
      kept.sort((a, b) => new Date(a.time) - new Date(b.time));
      timelines[p.name] = kept;
    }
  }
  return timelines;
}

function levenshtein(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function findTyposquats(downloads) {
  console.log('Computing typosquat candidates...');
  const pairs = [];
  // Known historical typosquats from the curated list (real malware, removed
  // from npm — they will not appear in the crawl, so add them as flagged nodes).
  for (const t of incidents.known_typosquats) {
    if (packages.has(t.target)) {
      pairs.push({ squat: t.squat, target: t.target,
        distance: levenshtein(t.squat, t.target), known_malicious: true, note: t.note, year: t.year });
    }
  }
  // Name-distance scan across the crawled set against high-download targets.
  // These are candidates for review, not verdicts — but obvious non-squats are
  // filtered: the legacy `scope-name` aliases of `@scope/name` packages, and
  // pairs that share a maintainer (same author, not an impersonator).
  const names = [...packages.keys()];
  const targets = names.filter((n) => (downloads.get(n) || 0) > 1_000_000 && n.length >= 4);
  const shareMaintainer = (a, b) => {
    const ma = packages.get(a)?.maintainers || [], mb = new Set(packages.get(b)?.maintainers || []);
    return ma.some((m) => mb.has(m));
  };
  for (const target of targets) {
    for (const other of names) {
      if (other === target || other.length < 4) continue;
      if ((downloads.get(other) || 0) > (downloads.get(target) || 0) / 10) continue; // squats are far less popular
      if (target.startsWith('@') && target.replace('@', '').replace('/', '-') === other) continue;
      if (other.startsWith('@') && other.replace('@', '').replace('/', '-') === target) continue;
      if (shareMaintainer(other, target)) continue;
      const d = levenshtein(other, target);
      const maxD = target.length >= 10 ? 2 : 1;
      if (d > 0 && d <= maxD) {
        pairs.push({ squat: other, target, distance: d, known_malicious: false,
          note: 'Name within edit distance ' + d + ' of a package with ' +
            ((downloads.get(target) || 0) / 1e6).toFixed(1) + 'M weekly downloads', year: null });
      }
    }
  }
  console.log(`${pairs.length} typosquat pairs`);
  return pairs;
}

const t0 = Date.now();
await crawl();
const downloads = await fetchDownloads();
const timelines = await fetchTimelines();
const typosquats = findTyposquats(downloads);

const out = {
  generated_at: new Date().toISOString(),
  source: 'registry.npmjs.org + api.npmjs.org (real data)',
  packages: [...packages.values()].map((p) => ({
    ...p,
    downloads: downloads.get(p.name) || 0,
  })),
  timelines,
  typosquats,
};
writeFileSync(join(ROOT, 'data', 'graph.json'), JSON.stringify(out));
const edgeCount = out.packages.reduce((a, p) => a + p.deps.length, 0);
console.log(`\nWrote data/graph.json: ${out.packages.length} packages, ${edgeCount} dep edges, ` +
  `${new Set(out.packages.flatMap((p) => p.maintainers)).size} maintainers, ` +
  `${typosquats.length} typosquat pairs, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
