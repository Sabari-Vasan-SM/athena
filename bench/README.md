# Benchmarks

Measures the built CLI (`dist/cli.js`) on a generated repository.

```bash
npm run bench                         # 20k files, compares with bench/baseline.json
node bench/run.mjs --files 200000     # large repo (generation takes a few minutes)
npm run bench:check                   # exit 1 on a >20% time or memory regression
```

Scenarios: cold `init`, warm `sync --check` (nothing changed), `sync --check` after a one-file change, `status`, `review` of a 500-file diff, and `athena event` cold start (p50 of 10, what every agent hook pays).

Peak memory is each process's max RSS, recorded by `bench/rss.cjs` (preloaded with `--require`). The generated repo lives in the OS temp dir and is reused between runs; results go to `bench/results/<label>.json`. Numbers depend on the machine — compare runs from the same machine only.
