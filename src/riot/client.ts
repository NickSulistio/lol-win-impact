import { RateLimiter, type Limit } from './rateLimiter';
import type { AccountRegion, Region } from './routing';
import type { AccountDto, LeagueEntryDto, LeagueListDto, MatchDto, TimelineDto, ChampionMasteryDto } from './types';

export type ApexTier = 'challenger' | 'grandmaster' | 'master';

export class RiotApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    body: string,
  ) {
    super(`Riot API ${status} for ${path}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.name = 'RiotApiError';
  }
}

export interface RiotClientOptions {
  apiKey: string;
  limits: Limit[];
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface MatchIdQuery {
  start?: number;
  count?: number; // max 100
  queue?: number; // 420 = ranked solo, 440 = ranked flex
  type?: 'ranked' | 'normal' | 'tourney' | 'tutorial';
  startTime?: number; // epoch seconds
  endTime?: number;
}

export class RiotClient {
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: RiotClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = opts.maxRetries ?? 5;
  }

  getAccountByRiotId(region: AccountRegion, gameName: string, tagLine: string): Promise<AccountDto> {
    return this.get(
      region,
      `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    );
  }

  getMatchIds(region: Region, puuid: string, query: MatchIdQuery = {}): Promise<string[]> {
    return this.get(region, `/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids`, query);
  }

  /** Pages through match IDs (100 per request, newest first) until `max` or the end of history. */
  async getAllMatchIds(region: Region, puuid: string, query: Omit<MatchIdQuery, 'start' | 'count'>, max: number): Promise<string[]> {
    const ids: string[] = [];
    while (ids.length < max) {
      const count = Math.min(100, max - ids.length);
      const page = await this.getMatchIds(region, puuid, { ...query, start: ids.length, count });
      ids.push(...page);
      if (page.length < count) break;
    }
    return ids;
  }

  /** League endpoints use the platform host (na1, euw1, ...), not the regional one. */
  getLeagueEntries(platform: string, puuid: string): Promise<LeagueEntryDto[]> {
    return this.get(platform, `/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`);
  }

  /** A player's highest-mastery champions (platform host, e.g. na1). */
  getTopMasteries(platform: string, puuid: string, count = 3): Promise<ChampionMasteryDto[]> {
    return this.get(platform, `/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=${count}`);
  }

  getApexLeague(platform: string, tier: ApexTier, queue = 'RANKED_SOLO_5x5'): Promise<LeagueListDto> {
    return this.get(platform, `/lol/league/v4/${tier}leagues/by-queue/${queue}`);
  }

  getMatch(region: Region, matchId: string): Promise<MatchDto> {
    return this.get(region, `/lol/match/v5/matches/${encodeURIComponent(matchId)}`);
  }

  getTimeline(region: Region, matchId: string): Promise<TimelineDto> {
    return this.get(region, `/lol/match/v5/matches/${encodeURIComponent(matchId)}/timeline`);
  }

  /** Riot rate limits apply per routing value, so each host gets its own limiter. */
  private limiterFor(host: string): RateLimiter {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new RateLimiter(this.opts.limits, this.opts.now, this.sleep);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  async get<T>(host: string, path: string, query: object = {}): Promise<T> {
    const url = new URL(path, `https://${host}.api.riotgames.com`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt++) {
      await this.limiterFor(host).acquire();
      const res = await this.fetchImpl(url, { headers: { 'X-Riot-Token': this.opts.apiKey } });
      if (res.ok) return (await res.json()) as T;

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const delayMs =
          res.status === 429 && retryAfterSec > 0 ? retryAfterSec * 1000 : 1000 * 2 ** attempt;
        await this.sleep(delayMs);
        continue;
      }
      throw new RiotApiError(res.status, url.pathname, await res.text().catch(() => ''));
    }
  }
}
