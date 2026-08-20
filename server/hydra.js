// HydraDB connection + query helpers.
// HydraDB speaks Bolt 5.x, so the standard neo4j driver connects directly.
// Two things matter when talking to it from JS:
//   1. Node ids are non-negative integers — plain JS numbers are sent as
//      floats, so every id must be wrapped with neo4j.int().
//   2. One statement per request, and UNWIND batch writes go through the
//      Bolt client transport (a list-of-maps parameter is a transport type).
const neo4j = require('neo4j-driver');

const BOLT_URL = process.env.HYDRA_BOLT_URL || 'neo4j://127.0.0.1:7687';
const TOKEN = process.env.HYDRA_TOKEN || 'local-development-token-32-bytes';
const ADMIN_URL = process.env.HYDRA_ADMIN_URL || 'http://127.0.0.1:9090';

const driver = neo4j.driver(BOLT_URL, neo4j.auth.bearer(TOKEN), {
  disableLosslessIntegers: true,
  maxConnectionPoolSize: 8,
});

const I = (n) => neo4j.int(n);

// Ring buffer of recent queries, surfaced in the UI's live query console.
const queryLog = [];
function logQuery(entry) {
  queryLog.push(entry);
  if (queryLog.length > 60) queryLog.shift();
}

async function run(query, params = {}) {
  const session = driver.session();
  const t0 = Date.now();
  try {
    const res = await session.run(query, params);
    logQuery({ query, ms: Date.now() - t0, rows: res.records.length, at: Date.now(), ok: true });
    return res;
  } catch (e) {
    logQuery({ query, ms: Date.now() - t0, rows: 0, at: Date.now(), ok: false, error: e.message });
    throw e;
  } finally {
    await session.close();
  }
}

async function waitForReady(timeoutMs = 120000) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`${ADMIN_URL}/readyz`);
      if (res.ok) {
        // readyz up; verify Bolt answers a real query too
        await run('MATCH (n:Meta {id: 0}) RETURN n.seeded AS s');
        return true;
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`HydraDB not ready after ${timeoutMs}ms: ${lastErr && lastErr.message}`);
}

module.exports = { driver, run, I, waitForReady, neo4j, queryLog };
