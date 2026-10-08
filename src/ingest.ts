import type { Store } from './db';
import { computeMatchMetrics } from './metrics/compute';
import { RiotApiError, type RiotClient } from './riot/client';
import type { Region } from './riot/routing';

export interface IngestResult {
  fetched: number;
  cached: number;
  failed: number;
}

/** Fetches match + timeline for ids not already stored, computes metrics, and saves both. */
export async function ingestMatches(
  client: RiotClient,
  store: Store,
  region: Region,
  matchIds: string[],
  log: (msg: string) => void = () => undefined,
): Promise<IngestResult> {
  const result: IngestResult = { fetched: 0, cached: 0, failed: 0 };
  const todo = matchIds.filter((id) => {
    const cached = store.hasMatch(id);
    if (cached) result.cached++;
    return !cached;
  });

  for (const [i, id] of todo.entries()) {
    try {
      const [match, timeline] = await Promise.all([
        client.getMatch(region, id),
        client.getTimeline(region, id),
      ]);
      store.saveMatch(match, timeline, computeMatchMetrics(match, timeline));
      result.fetched++;
      log(`  [${i + 1}/${todo.length}] ${id}`);
    } catch (err) {
      // A single missing/broken match should not abort a long crawl; auth errors should.
      if (err instanceof RiotApiError && (err.status === 401 || err.status === 403)) throw err;
      result.failed++;
      log(`  [${i + 1}/${todo.length}] ${id} failed: ${(err as Error).message}`);
    }
  }
  return result;
}
