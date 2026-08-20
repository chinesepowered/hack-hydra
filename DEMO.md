# 3-minute demo script

Target: one continuous screen recording of the deployed Render URL (or `docker run -p 3000:3000 blast-radius` locally). Times are cumulative.

**0:00 — the hook (boot screen or ecosystem view).**
> "On May 11th at 19:20 UTC, an attacker turned TanStack's own release pipeline against it: 84 malicious packages in six minutes, with valid provenance. The defender's problem is speed — when the compromise lands at 9:00, which of *your* services are exposed by 9:06? That's not a search problem. It's a graph problem. This is Blast Radius, built on HydraDB."

**0:25 — ecosystem view.**
Pan/zoom the graph briefly.
> "This is a real slice of npm — 1,700 packages, their dependency edges, their maintainer accounts, real weekly download counts — loaded into HydraDB, with the nine services of a hospital platform wired into it. On the right: three real incidents."

**0:45 — detonate chalk/debug.**
Click the **chalk/debug 2025-09-08** tab. Let the shockwave run.
> "September 2025: a phished maintainer account ships a crypto-clipper in 18 packages that sit under everything. Watch the blast wave — each ring is one dependency hop, computed live by HydraDB's native path procedure. 163 packages… and six of our nine services, 5.8 billion weekly downloads downstream."

Point at the alarm banner.
> "And it gets worse: HydraDB's lockfile-resolution edges show three services didn't just *depend* on it — they actually installed the malicious versions during the two-hour live window. The EHR API pulled debug 4.4.2 forty-seven minutes after it was published."

**1:30 — evidence, not vibes.**
Click a DIRECT HIT service card, then click `debug` in a chain; scroll its drawer.
> "Every claim is a path you can walk: here's debug's real version timeline from the registry, with 4.4.2 flagged, its maintainers, and everyone downstream of it."

Point at the live query console at the bottom.
> "Nothing is precomputed — this is the Cypher hitting HydraDB right now: algo.SSpaths, reverse direction, whole paths back in milliseconds."

**2:00 — maintainer overlap + typosquats (right panel / ecosystem view).**
> "Same graph answers the follow-ups: which other packages do the compromised maintainers control — that's your watchlist — and which names sit one keystroke from a package with a hundred million downloads. The red ones are documented malware."

**2:20 — make it personal.**
Click **Check your lockfile**, then **Use a sample lockfile** (or drop your own `package-lock.json`).
> "And it's not just our demo org. Drop in your own lockfile: four graph traversals later — this project resolved the malicious debug, and here's every path from its direct dependencies into the incident sets. This runs on Render's free tier: one container, HydraDB plus the console, no external services."

**2:50 — close.**
> "Extraction is cheap now. Knowing your blast radius before the attacker does — that's a graph traversal. Blast Radius, on HydraDB."
