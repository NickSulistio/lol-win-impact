import { FACTS, SITUATIONS, WP_PARTS, type FactKey, type Situation, type SituationKind, type WpPart } from './situations';

/**
 * Turns "his number differs" into "here is why". Two kinds of comparison:
 *  - Him vs peers in the same situation (and the same response).
 *  - One response vs another for him (why is A better than B?).
 * Each gap is explained by (1) choice mix vs execution, (2) which win-probability parts
 * moved (these add up to the gap exactly), (3) what happened differently in the window,
 * and (4) where in the game the gap concentrates.
 */

export interface Explanation {
  kind: SituationKind;
  type: 'vs-peers' | 'vs-peers-response' | 'response-contrast';
  title: string;
  /** Gap in win-probability change per case (him minus peers, or A minus B). */
  gap: number;
  ci: number;
  significant: boolean;
  /** Win probability per game this gap is worth for him (frequency x gap). */
  perGame: number;
  n: { a: number; b: number };
  mix?: { choice: number; execution: number; shares: { response: string; him: number; peers: number; himChange: number | null; peerChange: number | null }[] };
  parts: { part: WpPart; a: number; b: number; diff: number }[];
  facts: { key: FactKey; label: string; a: number; b: number; diff: number; z: number; rate: boolean; worse: boolean }[];
  where: { label: string; n: number; gap: number }[];
  summary: string[];
}

const mean = (xs: number[]) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
};
const variance = (xs: number[]) => {
  const v = xs.filter(Number.isFinite);
  const m = mean(v);
  return v.length > 1 ? v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1) : NaN;
};
const se = (xs: number[]) => Math.sqrt(variance(xs) / xs.filter(Number.isFinite).length);
const seDiff = (a: number[], b: number[]) => Math.hypot(se(a), se(b) || 0);
const pp = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}`;

function fmtFact(key: FactKey, v: number): string {
  if (FACTS[key].rate) return `${Math.round(v * 100)}%`;
  if (key === 'shutdownGiven' || key === 'goldSwing' || key === 'xpSwing') return `${v >= 0 && key !== 'shutdownGiven' ? '+' : ''}${Math.round(v)}`;
  if (key === 'csSwing') return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
  return v.toFixed(2);
}

const SPLITS: { label: string; f: (s: Situation) => boolean }[] = [
  { label: 'before 10:00', f: (s) => s.ctx.minute < 10 },
  { label: '10:00-20:00', f: (s) => s.ctx.minute >= 10 && s.ctx.minute < 20 },
  { label: '20:00+', f: (s) => s.ctx.minute >= 20 },
  { label: 'your team behind (<40%)', f: (s) => s.ctx.wpStart < 0.4 },
  { label: 'even game (40-60%)', f: (s) => s.ctx.wpStart >= 0.4 && s.ctx.wpStart <= 0.6 },
  { label: 'your team ahead (>60%)', f: (s) => s.ctx.wpStart > 0.6 },
];

/** Compare two groups of cases (a = him or response A, b = peers or response B). */
function compare(a: Situation[], b: Situation[], champions: string[]) {
  const gap = mean(a.map((s) => s.dWp)) - mean(b.map((s) => s.dWp));
  const ci = 1.96 * seDiff(a.map((s) => s.dWp), b.map((s) => s.dWp));
  const parts = WP_PARTS.map((part) => {
    const ma = mean(a.map((s) => s.parts[part]));
    const mb = mean(b.map((s) => s.parts[part]));
    return { part, a: ma, b: mb, diff: ma - mb };
  }).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const facts = (Object.keys(FACTS) as FactKey[])
    .map((key) => {
      const va = a.map((s) => s.facts[key]);
      const vb = b.map((s) => s.facts[key]);
      const ma = mean(va);
      const mb = mean(vb);
      const s = seDiff(va, vb);
      const diff = ma - mb;
      const worse = FACTS[key].better === 'lower' ? diff > 0 : diff < 0;
      return { key, label: FACTS[key].label, a: ma, b: mb, diff, z: s > 0 ? diff / s : 0, rate: FACTS[key].rate, worse };
    })
    .filter((f) => Number.isFinite(f.a) && Number.isFinite(f.b))
    // When one side always/never died, death facts restate the definition of the groups.
    .filter((f) => !(['died', 'diedAlone'].includes(f.key) && [f.a, f.b].some((v) => v === 0 || v === 1)))
    .sort((x, y) => Math.abs(y.z) - Math.abs(x.z));
  const splits = [...SPLITS, ...champions.map((c) => ({ label: `on ${c}`, f: (s: Situation) => s.ctx.champion === c }))];
  const where = splits
    .map(({ label, f }) => {
      const sa = a.filter(f);
      const sb = b.filter(f);
      return { label, n: sa.length, gap: sa.length >= 15 && sb.length >= 15 ? mean(sa.map((s) => s.dWp)) - mean(sb.map((s) => s.dWp)) : NaN };
    })
    .filter((w) => Number.isFinite(w.gap));
  return { gap, ci, significant: Math.abs(gap) > ci, parts, facts, where };
}

function narrate(e: Omit<Explanation, 'summary'>, aName: string, bName: string): string[] {
  const out: string[] = [];
  if (e.mix) {
    const { choice, execution } = e.mix;
    const total = choice + execution;
    if (Math.abs(total) > 0.002) {
      const bigger = Math.abs(choice) > Math.abs(execution) ? 'choice' : 'execution';
      out.push(
        bigger === 'choice'
          ? `Mostly a choice gap: you pick different options than peers (${pp(choice)}); the same options work about as well (${pp(execution)}).`
          : `Mostly an execution gap: the same options go ${execution < 0 ? 'worse' : 'better'} for you (${pp(execution)}); your choices account for ${pp(choice)}.`,
      );
      const shifts = e.mix.shares.filter((s) => Math.abs(s.him - s.peers) >= 0.05).sort((x, y) => Math.abs(y.him - y.peers) - Math.abs(x.him - x.peers));
      for (const s of shifts.slice(0, 2)) out.push(`You "${s.response}" ${Math.round(s.him * 100)}% of the time; peers ${Math.round(s.peers * 100)}%.`);
    }
  }
  const drivers = e.parts.filter((p) => Math.abs(p.diff) >= 0.003 && Math.sign(p.diff) === Math.sign(e.gap)).slice(0, 3);
  if (drivers.length) out.push(`Where the ${pp(e.gap)} comes from: ${drivers.map((p) => `${p.part} ${pp(p.diff)}`).join(', ')}.`);
  const offset = e.parts.find((p) => Math.abs(p.diff) >= 0.005 && Math.sign(p.diff) !== Math.sign(e.gap));
  if (offset) out.push(`Partly offset by ${offset.part} (${pp(offset.diff)}).`);
  const facts = e.facts.filter((f) => Math.abs(f.z) >= 2).slice(0, 4);
  for (const f of facts) out.push(`${cap(f.label)}: ${fmtFact(f.key, f.a)} (${aName}) vs ${fmtFact(f.key, f.b)} (${bName}).`);
  const where = [...e.where].sort((x, y) => (e.gap < 0 ? x.gap - y.gap : y.gap - x.gap));
  const worst = where[0];
  const least = where[where.length - 1];
  if (worst && least && where.length >= 3 && Math.abs(worst.gap - least.gap) > 0.01)
    out.push(`Biggest when ${worst.label} (${pp(worst.gap)}, ${worst.n} cases); smallest when ${least.label} (${pp(least.gap)}).`);
  return out;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function explainAll(mine: Situation[], peers: Situation[], games: number, champions: string[]): Explanation[] {
  const out: Explanation[] = [];
  for (const kind of Object.keys(SITUATIONS) as SituationKind[]) {
    const def = SITUATIONS[kind];
    const m = mine.filter((s) => s.kind === kind);
    const p = peers.filter((s) => s.kind === kind);
    if (m.length < 20 || p.length < 50) continue;
    const perGameCases = m.length / games;

    // 1. The situation as a whole: him vs peers, split into choice and execution.
    const shares = def.responses.map((r) => {
      const mr = m.filter((s) => s.response === r);
      const pr = p.filter((s) => s.response === r);
      return { response: r, him: mr.length / m.length, peers: pr.length / p.length, himChange: mr.length ? mean(mr.map((s) => s.dWp)) : null, peerChange: pr.length ? mean(pr.map((s) => s.dWp)) : null };
    });
    // Choice: his mix at peers' outcomes; execution: his outcomes vs peers' at his mix.
    const choice = shares.reduce((s, x) => s + (x.him - x.peers) * (x.peerChange ?? 0), 0);
    const execution = shares.reduce((s, x) => s + x.him * ((x.himChange ?? 0) - (x.peerChange ?? 0)), 0);
    const whole = compare(m, p, champions);
    const e1 = { kind, type: 'vs-peers' as const, title: `${def.title}: you vs peers`, ...whole, perGame: whole.gap * perGameCases, n: { a: m.length, b: p.length }, mix: { choice, execution, shares } };
    out.push({ ...e1, summary: narrate(e1, 'you', 'peers') });

    // 2. Each response: him vs peers doing the same thing.
    for (const r of def.responses) {
      const mr = m.filter((s) => s.response === r);
      const pr = p.filter((s) => s.response === r);
      if (mr.length < 20 || pr.length < 30) continue;
      const c = compare(mr, pr, champions);
      const e2 = { kind, type: 'vs-peers-response' as const, title: `${def.title}, then ${r}: you vs peers`, ...c, perGame: c.gap * (mr.length / games), n: { a: mr.length, b: pr.length } };
      out.push({ ...e2, summary: narrate(e2, 'you', 'peers') });
    }

    // 3. Best response vs his most common other one: why is it better for him?
    const ranked = def.responses
      .map((r) => ({ r, cases: m.filter((s) => s.response === r) }))
      .filter((x) => x.cases.length >= 20)
      .sort((x, y) => mean(y.cases.map((s) => s.dWp)) - mean(x.cases.map((s) => s.dWp)));
    if (ranked.length >= 2) {
      const best = ranked[0]!;
      const other = ranked.slice(1).sort((x, y) => y.cases.length - x.cases.length)[0]!;
      const c = compare(best.cases, other.cases, champions);
      const e3 = { kind, type: 'response-contrast' as const, title: `${def.title}: why "${best.r}" beats "${other.r}" for you`, ...c, perGame: c.gap * (other.cases.length / games), n: { a: best.cases.length, b: other.cases.length } };
      out.push({ ...e3, summary: narrate(e3, best.r, other.r) });
    }
  }
  return out.sort((a, b) => Math.abs(b.perGame) - Math.abs(a.perGame));
}
