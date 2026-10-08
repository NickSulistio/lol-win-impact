import type { Store } from '../db';
import { computeGameFeatures, type GameFeatures } from '../insights/features';
import { FIGHTS, LANING, MACRO, OBJECTIVES, rowValue, verdict, type Row } from '../insights/report';
import { explainAll, type Explanation } from '../insights/explain';
import { findSituations, SITUATIONS, type Situation, type SituationKind } from '../insights/situations';
import { formatRank } from '../rank';
import { features, predict, type WinModel } from '../wp/model';
import { sigmoid } from '../wp/logit';
import type { GameState } from '../wp/state';
import { GameTimeline } from '../wp/state';
import { computeWpa, type Category, type Phase, type PlayerWpa } from '../wp/wpa';

/** Everything the report UI needs, computed from stored games only. */
export interface ReportData {
  player: { name: string; rank: string | null; role: string; season: string; peerLabel: string; peerGames: number; peerPlayers: number; modelMatches: number; generated: string };
  views: View[]; // "All" first, then one per champion
  games: GameView[];
  method: MethodData;
}

/** Numbers for the Method tab, taken from the trained model and the player's own games. */
export interface MethodData {
  evaluation: import('../wp/model').ModelEvaluation | null;
  trainedMatches: number;
  trainedSnapshots: number;
  /** Win-chance change from an even (50%) game, per input. */
  worth: { label: string; at10: number; at20: number; at30: number }[];
  /** A real solo kill from his games, to show how credit is assigned. */
  example: { matchId: string; champion: string; victim: string; t: number; before: number; after: number } | null;
  goldPerMinuteExample: { at10: number; at25: number }; // +100 gold vs lane opponent in one minute
}

export interface View {
  label: string;
  /** Who this view is compared against, e.g. "Master 600+ LP Riven players". */
  peerLabel: string;
  peerGames: number;
  peerPlayers: number;
  games: number;
  wins: number;
  total: { you: number; peers: number; wins: number; losses: number };
  deathsPerGame: { you: number; peers: number };
  categories: { label: string; you: number; peers: number }[];
  phases: { label: string; you: number; peers: number }[];
  rules: Rule[];
  situations: SituationBlock[];
  /** Gaps between him and peers (or between his choices), each with reasons. */
  explanations: Pick<Explanation, 'kind' | 'type' | 'title' | 'gap' | 'ci' | 'significant' | 'perGame' | 'n' | 'summary'>[];
  deathTypes: { label: string; you: number; peers: number; cost: number }[];
  costliestDeaths: { matchId: string; champion: string; t: number; wpBefore: number; cost: number; context: string[] }[];
  profile: { section: string; rows: { label: string; you: string; peers: string; verdict: string }[] }[];
}

export interface Rule {
  kind: SituationKind;
  situation: string;
  detail: string;
  doThis: string;
  doChange: number;
  insteadOf: string;
  insteadChange: number;
  gain: number;
  ci: number;
  n: number;
  youShare: number;
  peerShare: number;
}

export interface SituationBlock {
  kind: SituationKind;
  situation: string;
  detail: string;
  count: number;
  perGame: number;
  responses: { label: string; n: number; share: number; change: number | null; ci: number | null; wr: number | null; peerShare: number; peerChange: number | null }[];
}

export interface GameView {
  matchId: string;
  date: string;
  champion: string;
  opponent: string;
  win: boolean;
  kda: string;
  minutes: number;
  wpa: number;
  curve: [number, number][]; // [seconds, his team's win probability]
  events: { t: number; kind: 'kill' | 'death' | 'structure' | 'objective'; label: string; d: number }[];
}

/** Short UI labels, in the same order as SITUATIONS[kind].responses. */
const SHORT: Record<SituationKind, { situation: string; detail: string; responses: string[] }> = {
  'solo-kill-in-lane': { situation: 'After a solo kill', detail: 'You solo kill your lane opponent before 14:00. Measured over the next 3 min.', responses: ['Push / take plates', 'Recall', 'Stay or roam', 'Die before recalling'] },
  'enemy-epic-monster': { situation: 'Enemy takes an objective', detail: 'Enemy takes dragon, Baron, herald or grubs after 14:00 while you are alive. 1 min before to 2 min after.', responses: ['Take a tower', 'Team trades, not you', 'Contest it', 'Nothing'] },
  'team-won-fight': { situation: 'After winning a fight', detail: 'Your team wins a teamfight after 14:00 and you survive. Next 3 min.', responses: ['You convert', 'Team converts', 'No conversion'] },
  'ahead-in-lane-at-10': { situation: 'Ahead at 10 min', detail: '500+ gold up on your lane opponent at 10:00. 10:00 to 16:00.', responses: ['Tower before 14:00', 'No tower'] },
  'fed-mid-game': { situation: 'When fed', detail: '1500+ gold up on your lane opponent between 14 and 25 min. Next 5 min.', responses: ['Stay alive', 'Die near team', 'Die alone'] },
  'objective-20m-plus': { situation: 'Late objectives', detail: 'Dragon, Baron or Atakhan taken after 20:00 by either team. 90s before to 90s after.', responses: ['Grouped', 'Split + tower', 'Split, no tower', 'Dead'] },
  'joined-teamfight': { situation: 'In teamfights', detail: 'Teamfights (3+ deaths) after 14:00 that you are part of. Start to end of fight.', responses: ['Survive', 'Die (not first)', 'Die first'] },
};

/** "He solo kills his lane opponent" -> "You solo kill your lane opponent". */
const youText = (s: string) =>
  s
    .replace(/\bHe is\b/g, 'You are').replace(/\bhe is\b/g, 'you are')
    .replace(/\bHe solo kills\b/g, 'You solo kill').replace(/\bhe takes\b/g, 'you take').replace(/\bHe\b/g, 'You').replace(/\bhe\b/g, 'you')
    .replace(/\bHis\b/g, 'Your').replace(/\bhis\b/g, 'your').replace(/\bhim\b/g, 'you')
    .replace(/then (takes|recalls|survives|dies|does|converts)/, (_, v: string) => `then ${({ takes: 'take', recalls: 'recall', survives: 'survive', dies: 'die', does: 'do', converts: 'convert' } as Record<string, string>)[v]}`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
function stat(rows: Situation[]) {
  const n = rows.length;
  const m = mean(rows.map((r) => r.dWp));
  const sd = n > 1 ? Math.sqrt(rows.reduce((s, r) => s + (r.dWp - m) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: n ? m : null, ci: n > 1 ? (1.96 * sd) / Math.sqrt(n) : null, wr: n ? rows.filter((r) => r.win).length / n : null };
}

export interface BuildOptions {
  puuid: string;
  name: string;
  role: string;
  season: string;
  sinceMs?: number;
  queue?: number;
  peerRefs: { matchId: string; puuid: string }[];
  peerLabel: string;
  champions: string[];
}

type Analyzed = { wpa: PlayerWpa; sit: Situation[]; feat: GameFeatures | null; view?: GameView };

export function buildReport(store: Store, model: WinModel, o: BuildOptions): ReportData {
  const analyze = (matchId: string, puuid: string, withView: boolean): Analyzed | null => {
    const g = store.loadGame(matchId);
    if (!g || g.match.info.gameDuration < 15 * 60) return null;
    const wpa = computeWpa(g.match, g.timeline, model).find((p) => p.puuid === puuid);
    if (!wpa) return null;
    const res: Analyzed = { wpa, sit: findSituations(g.match, g.timeline, puuid, model), feat: computeGameFeatures(g.match, g.timeline, puuid) };
    if (withView) res.view = gameView(g.match, g.timeline, puuid, wpa, model, matchId);
    return res;
  };

  const myGames = store.playerGames(o.puuid, 5000, { queueId: o.queue, sinceMs: o.sinceMs }).filter((g) => g.teamPosition === o.role);
  const mine = myGames.map((g) => analyze(g.matchId, o.puuid, true)).filter((x): x is Analyzed => !!x);
  const peers = o.peerRefs.map((r) => analyze(r.matchId, r.puuid, false)).filter((x): x is Analyzed => !!x);

  // Champion views compare against high-elo players on the same champion when there is enough data.
  const MIN_CHAMP_PEER_GAMES = 60;
  const views = [
    makeView('All', mine, peers, `${o.peerLabel} ${o.role.toLowerCase()} laners`),
    ...o.champions.map((c) => {
      const same = peers.filter((a) => a.wpa.champion === c);
      return same.length >= MIN_CHAMP_PEER_GAMES
        ? makeView(c, mine.filter((a) => a.wpa.champion === c), same, `${o.peerLabel} ${c} players`)
        : makeView(c, mine.filter((a) => a.wpa.champion === c), peers, `${o.peerLabel} ${o.role.toLowerCase()} laners (only ${same.length} ${c} games so far)`);
    }),
  ].filter((v) => v.games > 0);
  const rankRow = store.db.prepare('SELECT tier, division, lp FROM player_ranks WHERE puuid = ?').get(o.puuid) as { tier: string; division: string; lp: number } | undefined;
  return {
    player: {
      name: o.name,
      rank: rankRow ? formatRank(rankRow) : null,
      role: o.role,
      season: o.season,
      peerLabel: o.peerLabel,
      peerGames: peers.length,
      peerPlayers: new Set(o.peerRefs.map((r) => r.puuid)).size,
      modelMatches: model.trainedOn.matches,
      generated: new Date().toISOString().slice(0, 10),
    },
    views,
    games: mine.map((a) => a.view!).sort((a, b) => b.date.localeCompare(a.date)),
    method: methodData(store, model, o.puuid, mine),
  };
}

function methodData(store: Store, model: WinModel, puuid: string, mine: Analyzed[]): MethodData {
  const even = (minute: number): GameState => ({ minute, goldDiff: 0, xpDiff: 0, towerDiff: 0, inhibDiff: 0, dragonDiff: 0, soul: 0, baron: 0, elder: 0, deadDiff: 0 });
  const delta = (minute: number, change: Partial<GameState>) => sigmoid(features({ ...even(minute), ...change }).reduce((s, x, i) => s + x * model.weights[i]!, 0)) - predict(model, even(minute));
  const row = (label: string, change: Partial<GameState>) => ({ label, at10: delta(10, change), at20: delta(20, change), at30: delta(30, change) });
  const worth = [
    row('+1,000 team gold', { goldDiff: 1000 }),
    row('+1,000 team XP', { xpDiff: 1000 }),
    row('One more tower', { towerDiff: 1 }),
    row('One enemy inhibitor down', { inhibDiff: 1 }),
    row('One more dragon', { dragonDiff: 1 }),
    row('Baron buff', { baron: 1 }),
    row('One more enemy dead', { deadDiff: 1 }),
  ];
  // Marginal value of 100 gold in an even game (what economy credit uses).
  const goldPerMinuteExample = { at10: delta(10, { goldDiff: 100 }), at25: delta(25, { goldDiff: 100 }) };

  let example: MethodData['example'] = null;
  for (const a of mine.slice(0, 60)) {
    const g = store.loadGame(a.wpa.deaths[0]?.matchId ?? a.view?.matchId ?? '');
    if (!g) continue;
    const me = g.match.info.participants.find((p) => p.puuid === puuid)!;
    const gt = new GameTimeline(g.match, g.timeline);
    const k = gt.kills.find((k) => k.killerId === me.participantId && !(k.assistingParticipantIds ?? []).length && k.timestamp > 4 * 60_000 && k.timestamp < 14 * 60_000);
    if (!k) continue;
    const wp = (inclusive: boolean) => {
      const p = predict(model, gt.stateAt(k.timestamp, inclusive));
      return me.teamId === 100 ? p : 1 - p;
    };
    const victim = g.match.info.participants.find((p) => p.participantId === k.victimId);
    example = { matchId: a.view!.matchId, champion: me.championName, victim: victim?.championName ?? '?', t: Math.round(k.timestamp / 1000), before: r3(wp(false)), after: r3(wp(true)) };
    break;
  }
  return { evaluation: model.evaluation ?? null, trainedMatches: model.trainedOn.matches, trainedSnapshots: model.trainedOn.rows, worth, example, goldPerMinuteExample };
}

function makeView(label: string, mine: Analyzed[], peers: Analyzed[], peerLabel: string): View {
  const mySit = mine.flatMap((a) => a.sit);
  const peerSit = peers.flatMap((a) => a.sit);
  const situations: SituationBlock[] = [];
  const rules: Rule[] = [];
  for (const [kind, def] of Object.entries(SITUATIONS) as [SituationKind, (typeof SITUATIONS)[SituationKind]][]) {
    const m = mySit.filter((s) => s.kind === kind);
    const p = peerSit.filter((s) => s.kind === kind);
    if (!m.length) continue;
    const short = SHORT[kind];
    const responses = def.responses.map((r, i) => {
      const a = stat(m.filter((s) => s.response === r));
      const b = stat(p.filter((s) => s.response === r));
      return { label: short.responses[i]!, n: a.n, share: a.n / m.length, change: a.mean, ci: a.ci, wr: a.wr, peerShare: p.length ? b.n / p.length : 0, peerChange: b.mean };
    });
    situations.push({ kind, situation: short.situation, detail: short.detail, count: m.length, perGame: m.length / mine.length, responses });
    if (kind === 'joined-teamfight') continue; // "don't die" is not a decision
    const usable = responses.filter((r) => r.n >= 10 && r.change !== null).sort((a, b) => b.change! - a.change!);
    if (usable.length < 2) continue;
    const best = usable[0]!;
    const usual = usable.slice(1).sort((a, b) => b.n - a.n)[0]!;
    rules.push({
      kind,
      situation: short.situation,
      detail: short.detail,
      doThis: best.label,
      doChange: best.change!,
      insteadOf: usual.label,
      insteadChange: usual.change!,
      gain: best.change! - usual.change!,
      ci: Math.hypot(best.ci ?? 0, usual.ci ?? 0),
      n: best.n + usual.n,
      youShare: best.share,
      peerShare: best.peerShare,
    });
  }
  rules.sort((a, b) => b.gain - a.gain);

  const avg = (rows: Analyzed[], f: (a: Analyzed) => number) => (rows.length ? mean(rows.map(f)) : 0);
  const cats: [Category, string][] = [['kills', 'Kills'], ['deaths', 'Deaths'], ['structures', 'Towers'], ['economy', 'Farm vs lane'], ['objectives', 'Objectives']];
  const phases: [Phase, string][] = [['laning', '0-14 min'], ['mid', '14-25 min'], ['late', '25+ min']];

  const ctx = (rows: Analyzed[]) => {
    const m = new Map<string, { n: number; cost: number }>();
    for (const a of rows) for (const d of a.wpa.deaths) for (const c of d.context) {
      const e = m.get(c) ?? { n: 0, cost: 0 };
      e.n++;
      e.cost += d.cost;
      m.set(c, e);
    }
    return m;
  };
  const myCtx = ctx(mine);
  const peerCtx = ctx(peers);
  const deathTypes = [...myCtx]
    .filter(([c]) => !/^caught by [145]$/.test(c) && !/took (horde|riftherald|atakhan)/.test(c))
    .map(([c, v]) => ({ label: cap(c.replace(/_/g, ' ').replace(/ after$/, '').replace('baron nashor', 'Baron')), you: v.n / mine.length, peers: (peerCtx.get(c)?.n ?? 0) / peers.length, cost: v.cost / v.n }))
    .sort((a, b) => b.you - a.you)
    .slice(0, 9);

  const myF = mine.map((a) => a.feat).filter((f): f is GameFeatures => !!f);
  const peerF = peers.map((a) => a.feat).filter((f): f is GameFeatures => !!f);
  const section = (name: string, rows: Row[]) => ({
    section: name,
    rows: rows
      .filter((r) => r.better !== undefined)
      .map((r) => {
        const y = rowValue(r, myF);
        const p = rowValue(r, peerF);
        const label = r.label.startsWith('  ') && name === 'Objectives' ? `Enemy objective: you were ${r.label.trim()}` : r.label.trim();
        return { label: cap(label.replace(/\bhe joins\b/g, 'you join').replace(/\bhe is\b/g, 'you are').replace(/\bhe\b/g, 'you').replace(/\bhis\b/g, 'your')), you: y === null ? '-' : r.fmt(y), peers: p === null ? '-' : r.fmt(p), verdict: verdict(r, y, p, peerF).toLowerCase() };
      }),
  });

  const explanations = explainAll(mySit, peerSit, mine.length, [...new Set(mine.map((a) => a.wpa.champion))].filter((c) => label === 'All' && mine.filter((a) => a.wpa.champion === c).length >= 30))
    .filter((e) => e.significant)
    .slice(0, 12)
    .map(({ kind, type, title, gap, ci, significant, perGame, n, summary }) => ({ kind, type, title: youText(title), gap, ci, significant, perGame, n, summary: summary.map(youText) }));
  return {
    label,
    peerLabel,
    explanations,
    peerGames: peers.length,
    peerPlayers: new Set(peers.map((a) => a.wpa.puuid)).size,
    games: mine.length,
    wins: mine.filter((a) => a.wpa.win).length,
    total: {
      you: avg(mine, (a) => a.wpa.total),
      peers: avg(peers, (a) => a.wpa.total),
      wins: avg(mine.filter((a) => a.wpa.win), (a) => a.wpa.total),
      losses: avg(mine.filter((a) => !a.wpa.win), (a) => a.wpa.total),
    },
    deathsPerGame: { you: avg(mine, (a) => a.wpa.deaths.length), peers: avg(peers, (a) => a.wpa.deaths.length) },
    categories: cats.map(([k, l]) => ({ label: l, you: avg(mine, (a) => a.wpa.byCategory[k]), peers: avg(peers, (a) => a.wpa.byCategory[k]) })),
    phases: phases.map(([k, l]) => ({ label: l, you: avg(mine, (a) => a.wpa.byPhase[k]), peers: avg(peers, (a) => a.wpa.byPhase[k]) })),
    rules,
    situations,
    deathTypes,
    costliestDeaths: mine
      .flatMap((a) => a.wpa.deaths.map((d) => ({ matchId: d.matchId, champion: a.wpa.champion, t: Math.round(d.t / 1000), wpBefore: r3(d.wpBefore), cost: r3(d.cost), context: d.context.map((c) => c.replace(/_/g, ' ')) })))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, 12),
    profile: [section('Laning', LANING), section('Teamfights', FIGHTS), section('Objectives', OBJECTIVES), section('Mid / late', MACRO)],
  };
}

function gameView(match: Parameters<typeof computeWpa>[0], timeline: Parameters<typeof computeWpa>[1], puuid: string, wpa: PlayerWpa, model: WinModel, matchId: string): GameView {
  const gt = new GameTimeline(match, timeline);
  const me = match.info.participants.find((p) => p.puuid === puuid)!;
  const opp = match.info.participants.find((p) => p.teamId !== me.teamId && p.teamPosition === me.teamPosition);
  const curve: [number, number][] = [];
  for (let t = 0; t < gt.endMs; t += 30_000) {
    const p = predict(model, gt.stateAt(t));
    curve.push([t / 1000, r3(me.teamId === 100 ? p : 1 - p)]);
  }
  curve.push([Math.round(gt.endMs / 1000), me.win ? 1 : 0]);
  const events: GameView['events'] = [
    ...wpa.plays.map((p) => ({
      t: Math.round(p.t / 1000),
      kind: (p.what.startsWith('kill') ? 'kill' : /tower|inhibitor/.test(p.what) ? 'structure' : 'objective') as GameView['events'][number]['kind'],
      label: p.what.replace(/_/g, ' '),
      d: r3(p.gain),
    })),
    ...wpa.deaths.map((d) => ({ t: Math.round(d.t / 1000), kind: 'death' as const, label: d.context.length ? `died: ${d.context.join(', ')}` : 'died', d: r3(-d.cost) })),
  ].sort((a, b) => a.t - b.t);
  return {
    matchId,
    date: new Date(match.info.gameEndTimestamp ?? match.info.gameCreation).toISOString().slice(0, 10),
    champion: me.championName,
    opponent: opp?.championName ?? '?',
    win: me.win,
    kda: `${me.kills}/${me.deaths}/${me.assists}`,
    minutes: Math.round(match.info.gameDuration / 60),
    wpa: r3(wpa.total),
    curve,
    events,
  };
}
