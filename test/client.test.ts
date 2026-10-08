import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RiotApiError, RiotClient } from '../src/riot/client';
import { parseLimits, RateLimiter } from '../src/riot/rateLimiter';
import { accountRegionFor, regionFor } from '../src/riot/routing';

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

test('rate limiter waits once a window is full', async () => {
  const clock = fakeClock();
  const limiter = new RateLimiter(parseLimits('2:1,3:10'), clock.now, clock.sleep);
  await limiter.acquire();
  await limiter.acquire();
  assert.equal(clock.sleeps.length, 0);
  await limiter.acquire(); // 1s window full
  assert.ok(clock.now() >= 1000 && clock.now() < 1100);
  await limiter.acquire(); // 10s window full
  assert.ok(clock.now() >= 10_000);
});

test('client retries 429 using Retry-After and sends the key header', async () => {
  const clock = fakeClock();
  const calls: { url: string; key: string | null }[] = [];
  const responses = [
    new Response('', { status: 429, headers: { 'Retry-After': '3' } }),
    new Response(JSON.stringify(['NA1_1', 'NA1_2']), { status: 200 }),
  ];
  const client = new RiotClient({
    apiKey: 'RGAPI-test',
    limits: parseLimits('100:1'),
    now: clock.now,
    sleep: clock.sleep,
    fetchImpl: (async (url: URL, init?: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get('X-Riot-Token') });
      return responses.shift()!;
    }) as typeof fetch,
  });

  const ids = await client.getMatchIds('americas', 'abc', { count: 2, type: 'ranked' });
  assert.deepEqual(ids, ['NA1_1', 'NA1_2']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.key, 'RGAPI-test');
  assert.equal(
    calls[0]!.url,
    'https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/abc/ids?count=2&type=ranked',
  );
  assert.deepEqual(clock.sleeps, [3000]);
});

test('client surfaces non-retryable errors', async () => {
  const client = new RiotClient({
    apiKey: 'k',
    limits: parseLimits('100:1'),
    fetchImpl: (async () => new Response('{"status":{"message":"Forbidden"}}', { status: 403 })) as typeof fetch,
  });
  await assert.rejects(client.getMatch('europe', 'EUW1_1'), (err: unknown) => {
    assert.ok(err instanceof RiotApiError);
    assert.equal(err.status, 403);
    return true;
  });
});

test('routing maps platforms to regional clusters', () => {
  assert.equal(regionFor('NA1'), 'americas');
  assert.equal(regionFor('euw1'), 'europe');
  assert.equal(regionFor('oc1'), 'sea');
  assert.equal(accountRegionFor('oc1'), 'asia');
  assert.throws(() => regionFor('xx1'));
});

test('getAllMatchIds pages 100 at a time until a short page', async () => {
  const starts: string[] = [];
  const client = new RiotClient({
    apiKey: 'k',
    limits: parseLimits('100:1'),
    fetchImpl: (async (url: URL) => {
      const u = new URL(String(url));
      starts.push(`${u.searchParams.get('start')}:${u.searchParams.get('count')}:${u.searchParams.get('startTime')}`);
      const start = Number(u.searchParams.get('start'));
      const n = Math.max(0, Math.min(Number(u.searchParams.get('count')), 230 - start));
      return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => `NA1_${start + i}`)));
    }) as typeof fetch,
  });
  const ids = await client.getAllMatchIds('americas', 'p', { queue: 420, startTime: 1767902400 }, 1000);
  assert.equal(ids.length, 230);
  assert.deepEqual(starts, ['0:100:1767902400', '100:100:1767902400', '200:100:1767902400']);
  assert.equal((await client.getAllMatchIds('americas', 'p', {}, 150)).length, 150);
});
