// Preloaded into benchmarked CLI runs (`node --require bench/rss.cjs dist/cli.js …`).
// On exit it records the process's peak resident memory so bench/run.mjs can report it
// the same way on every OS (no /usr/bin/time flags to juggle).
'use strict';
const fs = require('node:fs');

const out = process.env.BENCH_RSS_OUT;
if (out) {
  process.on('exit', () => {
    try {
      // resourceUsage().maxRSS is in kilobytes on every platform Node supports.
      fs.writeFileSync(out, JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS, heapUsed: process.memoryUsage().heapUsed }));
    } catch {
      // Measurement must never change the CLI's behaviour.
    }
  });
}
