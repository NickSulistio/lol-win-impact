# League replay analyser

Leetify-style performance analytics for League of Legends, built on Riot's match-v5 API.
It pulls a player's recent ranked games (match detail + timeline), computes per-game
metrics for all 10 participants, and ranks the player against others in the same role.

## Setup

Requires Node 22.13+ (uses built-in `fetch` and `node:sqlite`; no native deps).

```sh
npm install
cp .env.example .env   # add RIOT_API_KEY from https://developer.riotgames.com
```

## Usage

```sh
npm run analyze -- "Name#TAG" --platform euw1 --count 20
npm run crawl -- --players 20 --count 10   # grow the benchmark pool
npm test
npm run typecheck
```

`analyze` options: `--count` (1-100), `--queue 420` (solo) / `440` (flex) instead of all ranked,
`--role JUNGLE` to override the auto-detected main role.

### Rank- and champion-matched comparisons

```sh
npm run cli -- seed-ranks --platform na1          # store the Master/GM/Challenger ladder (3 requests)
npm run crawl -- --min-lp 600 --players 40 --prefer Riven,Camille
npm run analyze -- "oRegret#NA69" --queue 420 --count 50 --role TOP --min-lp 600 --champions Riven,Camille
```

`--min-lp N` keeps only peers currently at Master N LP or higher (Master, GM, and Challenger share one
LP ladder, so GM starts around 1000 LP on NA). Ranks are today's ladder, not the rank at the time of
each game. Rank-filtered runs use solo queue only. `--prefer` crawls ladder players already seen on
those champions first.

## How it works

```
Riot ID ──account-v1──▶ PUUID ──match-v5 ids──▶ match + timeline ──▶ SQLite
                                                         │
                                       computeMatchMetrics (10 rows/match)
                                                         │
                                  player averages vs role peers ──▶ report
```

| File | Role |
| --- | --- |
| `src/riot/client.ts` | HTTP client: per-region rate limiting, 429 `Retry-After` and 5xx backoff |
| `src/riot/rateLimiter.ts` | Sliding-window limiter enforcing several limits at once |
| `src/metrics/compute.ts` | Metric definitions and computation from match + timeline |
| `src/db.ts` | SQLite store: raw JSON payloads plus derived metrics |
| `src/report.ts` | Aggregation, percentile benchmarking, table rendering |
| `src/commands/` | `analyze` and `crawl` |

Raw match and timeline JSON is kept, so new metrics can be backfilled without refetching.

## Metrics

| Metric | Source | Notes |
| --- | --- | --- |
| CS @10, CS/gold/XP diff @10, gold diff @15 | Timeline frames | Diff is vs the enemy with the same `teamPosition` |
| CS/min, KDA, kill participation, damage share, vision/min | Match detail | |
| Deaths with no enemy assist | `CHAMPION_KILL` events | Excludes tower/minion executes |
| Deaths <60s before enemy objective | Kill + `ELITE_MONSTER_KILL` events | Dragon, Baron, Herald, Voidgrubs, Atakhan |
| Deaths deep in enemy half | Kill event position | Map diagonal ±1500 units from river |
| First back | First `ITEM_PURCHASED` after 1:30 | Approximate; Riot has no recall event |

Games under 5 minutes (remakes) are skipped.

## Benchmarks

Every fetched match contributes all 10 participants to the peer pool. A player's averages
are compared with other players' averages (those with 3+ games in the role) once at least
20 such players exist; before that it falls back to per-game values, which overstates
spread. Run `crawl` to grow the pool.

Without `--min-lp`, the pool is not split by rank, so players are compared with whoever happens
to be in their match history.

## Limits

- Dev keys expire every 24h and allow about 20 req/s and 100 req/2min. Each new match costs
  2 requests, so `analyze --count 20` takes about 25 seconds cold. Set `RIOT_RATE_LIMITS`
  when you have a production key.
- Timeline frames are 60s apart, so no movement, ability timing or teamfight positioning.
- Riot policy forbids estimating hidden MMR; keep scores framed as performance.

## Next steps

1. Ranks below Master: look up `league-v4` `entries/by-puuid` for crawled players.
2. Larger champion-specific benchmarks once the pool is large enough.
3. Patch filter (`game_version`) so benchmarks track the current meta.
4. Web UI / API over the same store; move to Postgres when concurrent writes matter.

## Web app

React + Vite frontend in `web/`, reading report JSON from a local API.

```sh
npm run cli -- wp-train                    # (re)train the win chance model on stored matches
npm run web:build                          # build web/dist (app) and web/dist-single (export template)
npm run serve -- "oRegret#NA69" --platform na1 --role TOP --since 2026 --queue 420 --min-lp 600 --champions Riven,Camille
# -> http://localhost:8787  (GET /api/report?riotId=Name%23TAG&role=TOP&since=2026&queue=420&minLp=600&champions=A,B)
npm run web:dev                            # hot-reload UI on :5173, proxies /api to :8787
```

Tabs: Overview (contribution vs peers, by source and phase), Rules (situation -> best choice, how often you make it),
Games (win chance chart per game with your plays), Deaths (types vs peers, costliest deaths), Profile (phase averages).
The champion switch re-scopes every tab. Tabs are linkable via `#rules`, `#games`, etc.

Shareable file: `npm run cli -- report "Name#TAG" ...` (same options) exports the app as one self-contained HTML file
with the data baked in (`reports/<name>-<tag>.html`). Add `--rebuild` after changing the UI.
