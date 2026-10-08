import { parseArgs } from 'node:util';
import { analyze } from './commands/analyze';
import { crawl, findMains, seedRanks } from './commands/crawl';
import { deep } from './commands/deep';
import { explain } from './commands/explain';
import { htmlReport } from './commands/htmlReport';
import { serve } from './server';
import { situations } from './commands/situations';
import { wpa, wpTrain } from './commands/wp';
import { loadConfig } from './config';
import { parseSince } from './season';
import { RiotApiError } from './riot/client';

const USAGE = `Usage:
  npm run analyze -- "Name#TAG" [--platform na1] [--count 20] [--since 2026] [--queue 420] [--role TOP]
                    [--min-lp 600] [--champions Riven,Camille]
  npm run crawl   -- [--players 10] [--count 10] [--min-lp 600] [--prefer Riven,Camille]
  npm run cli -- find-mains --min-lp 600 --prefer Riven,Camille [--players 5000]
  npm run cli -- seed-ranks [--platform na1]
  npm run cli -- wp-train
  npm run cli -- wpa "Name#TAG" --role TOP [--since 2026] [--queue 420] [--min-lp 600] [--champions Riven,Camille]
  npm run cli -- explain "Name#TAG" --role TOP [--since 2026] [--queue 420] [--min-lp 600] [--champions Riven,Camille] [--count 15] [--all]
  npm run cli -- situations "Name#TAG" --role TOP [--since 2026] [--queue 420] [--min-lp 600] [--champion Riven]
  npm run cli -- report "Name#TAG" --role TOP [--since 2026] [--queue 420] [--min-lp 600] [--champions Riven,Camille] [--out file.html] [--rebuild]
  npm run cli -- serve ["Name#TAG"] [--port 8787] [same options as report, used as defaults]
  npm run cli -- deep "Name#TAG" --role TOP [--since 2026] [--queue 420] [--min-lp 600] [--champions Riven,Camille]

  analyze     Fetch a player's recent games, compute metrics, compare with peers in the same role.
              --since: a season (2026) or date (2026-05-01); fetches every game since then
                       (--count becomes the cap, default 1000).
              --min-lp: only compare against players currently Master N+ LP (solo queue).
              --champions: add per-champion comparisons.
  crawl       Grow the benchmark dataset. --min-lp crawls apex-ladder players (run seed-ranks first);
              --prefer crawls players already seen on those champions first.
  deep        Phase analysis (laning, teamfights, objectives, macro, win drivers) from stored games.
  wp-train    Train the win-probability model on stored matches (reports held-out accuracy).
  wpa         Win Probability Added per game: what each player's actions were worth.
  report      Export the web app as one shareable HTML file with the player's data baked in.
  serve       Local API (+ built app) for the web UI; the Riot ID etc. become defaults for /api/report.
  explain     Find the gaps between him and peers (and between his choices) and explain why each exists.
  situations  Decision points: what he did in each situation and what it did to win probability.
  find-mains  Store top-3 mastery champions of ladder players so crawl --prefer targets real mains.
  seed-ranks  Store the current Master/GM/Challenger solo-queue ladder (3 requests).`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      platform: { type: 'string' },
      count: { type: 'string' },
      queue: { type: 'string' },
      role: { type: 'string' },
      players: { type: 'string' },
      'min-lp': { type: 'string' },
      champions: { type: 'string' },
      champion: { type: 'string' },
      out: { type: 'string' },
      port: { type: 'string' },
      rebuild: { type: 'boolean' },
      all: { type: 'boolean' },
      prefer: { type: 'string' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return;
  }

  const int = (v: string | undefined, fallback: number, max: number, min = 1) => {
    const n = v === undefined ? fallback : Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Expected a number ${min}-${max}, got "${v}"`);
    return n;
  };
  const list = (v: string | undefined) =>
    v
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const minLp = values['min-lp'] === undefined ? undefined : int(values['min-lp'], 0, 10_000, 0);

  const config = loadConfig({ platform: values.platform });
  switch (command) {
    case 'analyze': {
      const riotId = positionals.join(' ');
      if (!riotId) throw new Error('analyze needs a Riot ID, e.g. "Faker#KR1"');
      await analyze(config, {
        riotId,
        count: values.since ? int(values.count, 1000, 5000) : int(values.count, 20, 100),
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        role: values.role,
        minLp,
        champions: list(values.champions),
      });
      break;
    }
    case 'crawl':
      await crawl(config, {
        players: int(values.players, 10, 1000),
        count: int(values.count, 10, 100),
        minLp,
        preferChampions: list(values.prefer),
        preferRole: values.role,
      });
      break;
    case 'explain': {
      const riotId = positionals.join(' ');
      if (!riotId || !values.role) throw new Error('explain needs a Riot ID and --role');
      await explain(config, {
        riotId,
        role: values.role,
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        minLp,
        champions: list(values.champions) ?? [],
        significantOnly: !values.all,
        top: int(values.count, 15, 200),
      });
      break;
    }
    case 'find-mains':
      await findMains(config, { minLp: minLp ?? 600, players: int(values.players, 5000, 20_000), champions: list(values.prefer) ?? [] });
      break;
    case 'deep': {
      const riotId = positionals.join(' ');
      if (!riotId || !values.role) throw new Error('deep needs a Riot ID and --role, e.g. deep "Name#TAG" --role TOP');
      await deep(config, {
        riotId,
        role: values.role,
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        minLp,
        champions: list(values.champions),
      });
      break;
    }
    case 'wp-train':
      await wpTrain(config);
      break;
    case 'wpa': {
      const riotId = positionals.join(' ');
      if (!riotId || !values.role) throw new Error('wpa needs a Riot ID and --role');
      await wpa(config, {
        riotId,
        role: values.role,
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        minLp,
        champions: list(values.champions),
      });
      break;
    }
    case 'report':
    case 'serve': {
      const riotId = positionals.join(' ');
      const q = {
        riotId,
        role: values.role ?? 'TOP',
        since: values.since,
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        minLp,
        champions: values.champions ? values.champions.split(',').map((c) => c.trim()) : [],
      };
      if (command === 'serve') {
        serve(config, values.port ? int(values.port, 1, 65_535) : 8787, q);
        return;
      }
      if (!riotId) throw new Error('report needs a Riot ID');
      await htmlReport(config, { ...q, out: values.out, rebuild: values.rebuild });
      break;
    }
    case 'situations': {
      const riotId = positionals.join(' ');
      if (!riotId || !values.role) throw new Error('situations needs a Riot ID and --role');
      await situations(config, {
        riotId,
        role: values.role,
        sinceMs: values.since ? parseSince(values.since) : undefined,
        queue: values.queue ? int(values.queue, 0, 10_000) : undefined,
        minLp,
        champion: values.champion,
      });
      break;
    }
    case 'seed-ranks':
      await seedRanks(config);
      break;
    default:
      throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof RiotApiError && (err.status === 401 || err.status === 403)) {
    console.error('Riot API rejected the key (401/403). Dev keys expire every 24h; regenerate it.');
  } else if (err instanceof RiotApiError && err.status === 404) {
    console.error(`Not found: ${err.path}. Check the Riot ID and --platform.`);
  } else {
    console.error((err as Error).message);
  }
  process.exitCode = 1;
});
