# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/safianzien/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/safianzien/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar, radar-2: the best token launch radar for make.fun's token-radar-01 bounty. It ranks
226 pre-token protocols by an implied value calibrated from the snapshot's own live tokens, and
shows a reader how to farm each one.

## How it works

`main.ts` (Node 22, standard library only) reads the sealed DefiLlama snapshot at
`/input/snapshot.json`, scores every pre-token protocol with the radar-2 model in `lib/model.ts`,
and writes the ranked board to `/output/board.json`, the dashboard data to `/output/data.js`, and
`/output/dossier.json` with the vendored make.fun library.

The model, in one line: implied value = TVL x the category multiple x a log-damped growth
multiplier x a concave maturity multiplier x a log chain multiplier. The category multiple is
calibrated from the snapshot itself: the median market-cap / TVL of live tokens in the same
category, shrunk toward the global median, with categories that have fewer than three live
protocols taking the global median. Growth is log-damped, so one extreme week cannot swamp the
board. Maturity is concave in the time a protocol has run with no token. No protocol name is
ever special-cased.

The board covers all 40 watchlist protocols and every rankable pre-token protocol below the
$50M floor: 226 rows, exhaustive under the rankable rule. The dashboard is a static page with
no network: a sortable, filterable board, a detail view for each protocol with its model
breakdown and farm plan, a live-token view set aside with market caps, and the category
calibration table.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>

---
