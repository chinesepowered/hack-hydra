// Parses npm lockfiles / package.json into {name -> Set(versions)} plus the
// list of direct dependencies, for the "check your own lockfile" flow.

function parseLockfile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON — upload a package-lock.json or package.json');
  }
  const found = new Map(); // name -> Set of versions ('' when unknown)
  const add = (name, version) => {
    if (!name) return;
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(version || '');
  };
  let direct = [];
  let kind = 'unknown';

  if (doc.lockfileVersion >= 2 && doc.packages) {
    kind = `package-lock v${doc.lockfileVersion}`;
    for (const [key, meta] of Object.entries(doc.packages)) {
      if (key === '') {
        direct = Object.keys({ ...(meta.dependencies || {}), ...(meta.devDependencies || {}) });
        continue;
      }
      const idx = key.lastIndexOf('node_modules/');
      if (idx === -1) continue;
      add(key.slice(idx + 'node_modules/'.length), meta.version);
    }
  } else if (doc.lockfileVersion === 1 && doc.dependencies) {
    kind = 'package-lock v1';
    direct = Object.keys(doc.dependencies);
    const walk = (deps) => {
      for (const [name, meta] of Object.entries(deps || {})) {
        add(name, meta.version);
        if (meta.dependencies) walk(meta.dependencies);
      }
    };
    walk(doc.dependencies);
  } else if (doc.dependencies || doc.devDependencies) {
    kind = 'package.json';
    direct = Object.keys({ ...(doc.dependencies || {}), ...(doc.devDependencies || {}) });
    for (const name of direct) add(name, '');
  } else {
    throw new Error('Unrecognized file — expected package-lock.json or package.json');
  }
  return { found, direct, kind };
}

module.exports = { parseLockfile };
