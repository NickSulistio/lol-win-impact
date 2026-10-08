/**
 * Builds a single shareable HTML "story" for one player from:
 *   --report=reports/<name>.html   (exported app report; its embedded report-data JSON)
 *   --habits=<json>                (scripts/habits.ts --json, all champions)
 *   --habits-champ=<json>          (optional, scripts/habits.ts --champion=X --json)
 *   --wards=<json>                 (scripts/wards.ts --json)
 *   --notes=<json>                 (optional: { summary: string[], takeaways: string[] } written by hand)
 *   --champion=Riven --out=reports/<name>-story.html
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const readJson = (p: string) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined);
const html = readFileSync(arg('report'), 'utf8');
const R = JSON.parse(html.match(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!.replace(/\\u003c/g, '<'));
const H = readJson(arg('habits'));
const HC = readJson(arg('habits-champ'));
const W = readJson(arg('wards'));
const N = readJson(arg('notes')) ?? { summary: [], takeaways: [] };
const CH = arg('champion');

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const pp = (x: number, d = 1) => (Number.isFinite(x) ? `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}` : '–');
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
const cls = (x: number) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const date = (ts: number) => new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' });

const all = R.views[0];
const champView = R.views.find((v: { label: string }) => v.label === CH);
const p = R.player;
const section = (title: string, body: string, note = '') => `<h2>${esc(title)}</h2>${note ? `<p class="note">${note}</p>` : ''}${body}`;
const table = (head: string[], rows: string[][], numericFrom = 1) =>
  `<div class="tw"><table><thead><tr>${head.map((h, i) => `<th${i >= numericFrom ? ' class="n"' : ''}>${h}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i >= numericFrom ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;

// ---- header + headline
const views = R.views.map((v: any) => ({ label: v.label, games: v.games, wins: v.wins, you: v.total.you, peers: v.total.peers, peerLabel: v.peerLabel, peerGames: v.peerGames }));
const headline = `
<div class="cards">
  <div><b class="${cls(all.total.you - all.total.peers)}">${pp(all.total.you)}</b><span>contribution per game<br>peers ${pp(all.total.peers)}</span></div>
  <div><b>${all.deathsPerGame.you.toFixed(1)}</b><span>deaths per game<br>peers ${all.deathsPerGame.peers.toFixed(1)}</span></div>
  ${all.phases.map((ph: any) => `<div><b class="${cls(ph.you - ph.peers)}">${pp(ph.you)}</b><span>${esc(ph.label)}<br>peers ${pp(ph.peers)}</span></div>`).join('')}
</div>
<p class="note">Contribution = how much his plays moved his team's chance of winning, in percentage points per game, net of what his deaths cost. Peers: ${esc(all.peerLabel)}, ${all.peerGames.toLocaleString()} games from ${all.peerPlayers.toLocaleString()} players.</p>
${table(['View', 'Games', 'Win rate', 'Contribution', 'Peers', 'Compared with'], views.map((v: any) => [esc(v.label), String(v.games), pct(v.wins / v.games), `<b class="${cls(v.you - v.peers)}">${pp(v.you)}</b>`, pp(v.peers), esc(v.peerLabel)]))}`;

const cats = table(['Where it comes from', 'Him', 'Peers', 'Gap'], all.categories.map((c: any) => [esc(c.label), pp(c.you), pp(c.peers), `<span class="${cls(c.you - c.peers)}">${pp(c.you - c.peers)}</span>`]));

// ---- rules
const rulesOf = (v: any) =>
  table(
    ['When', 'Do this', 'Instead of', 'Gain', 'He picks it', 'Peers'],
    v.rules.slice(0, 6).map((r: any) => {
      const clear = Math.abs(r.gain) > r.ci;
      return [esc(r.situation), `<b>${esc(r.doThis)}</b>`, esc(r.insteadOf), `<span class="${clear ? 'pos' : 'muted'}">${pp(r.gain)} ±${(r.ci * 100).toFixed(1)}</span>`, pct(r.youShare), pct(r.peerShare)];
    }),
    3,
  );

// ---- why
const why = (v: any, n: number) =>
  v.explanations
    .slice(0, n)
    .map((e: any) => `<div class="why"><b>${esc(e.title)} <span class="${cls(e.gap)}">${pp(e.gap)}</span></b><ul>${e.summary.slice(0, 4).map((s: string) => `<li>${esc(s)}</li>`).join('')}</ul></div>`)
    .join('');

// ---- habits
const OUTCOME_COUPLED = new Set(['noDeathOpensObj', 'noDeath1425', 'deaths25le1']);
const habitsTable = H
  ? (() => {
      const champRate = new Map<string, number>((HC?.habits ?? []).map((h: any) => [h.key, h.peerRate]));
      const hisChampRate = new Map<string, number>((HC?.habits ?? []).map((h: any) => [h.key, h.hisRate]));
      const rows = H.habits
        .filter((h: any) => Number.isFinite(h.peerEff) && Math.abs(h.peerEff) > 1.96 * h.peerSe)
        .slice(0, 14)
        .map((h: any) => [
          `${esc(h.label)}${OUTCOME_COUPLED.has(h.key) ? ' <span class="muted">*</span>' : ''}`,
          `${pp(h.peerEff)} <span class="muted">±${(h.peerSe * 196).toFixed(1)}</span>`,
          pp(h.inPlayer),
          `<b>${pct(h.hisRate)}</b>`,
          pct(h.peerRate),
          ...(HC ? [pct(hisChampRate.get(h.key) ?? NaN), pct(champRate.get(h.key) ?? NaN)] : []),
          `${pct(h.inWins)} / ${pct(h.inLosses)}`,
          `<span class="${cls(h.value)}">${pp(h.value)}</span>`,
        ]);
      return table(
        ['Habit', 'Effect on winning', 'Within player', 'He does it', 'Peers', ...(HC ? [`He does (${esc(CH)})`, `${esc(CH)} players`] : []), 'In his wins / losses', 'Gain if he matched peers'],
        rows,
      );
    })()
  : '';

// ---- vision
const VISION_ROWS: [string, string, 'pg' | 'pct' | 'any'][] = [
  ['Wards placed', 'Wards placed (all)', 'pg'],
  ['  before 14:00', 'Wards placed before 14:00', 'pg'],
  ['Control wards bought', 'Control wards bought', 'pg'],
  ['Games with any control ward', 'Control wards bought', 'any'],
  ['Oracle Lens swap (% of games)', 'Swapped to Oracle Lens (sweeper)', 'pct'],
  ['Farsight swap (% of games)', 'Swapped to Farsight (blue)', 'pct'],
  ['Enemy wards cleared', 'Enemy wards cleared', 'pg'],
  ['Vision score', 'Vision score', 'pg'],
];
const visionTable = W
  ? (() => {
      const cols = Object.keys(W);
      const name = (c: string) => (c === 'him' ? 'Him' : c === 'peer' ? 'Peers' : c.startsWith('him-') ? `Him on ${c.slice(4)}` : `${c.slice(5)} players`);
      return table(
        ['Per game', ...cols.map(name)],
        [
          ['Games', ...cols.map((c) => W[c].games.toLocaleString())],
          ...VISION_ROWS.map(([label, key, kind]) => [
            esc(label),
            ...cols.map((c) => {
              const g = W[c];
              const v = kind === 'any' ? g.anyShare[key] : g.perGame[key];
              const s = kind === 'pg' ? v.toFixed(2) : pct(v);
              return c.startsWith('him') ? `<b>${s}</b>` : s;
            }),
          ]),
        ],
      );
    })()
  : '';
const pinks = H?.pinks
  ? table(
      ['Lane state at 14:00', 'Effect of a control ward 14:00-25:00', 'Within player', 'Peers buy', 'He buys'],
      H.pinks.map((x: any) => [esc(x.state), `${pp(x.eff)} <span class="muted">±${(x.se * 196).toFixed(1)}</span>`, pp(x.inPlayer), pct(x.peerRate), `<b>${pct(x.hisRate)}</b>`]),
    )
  : '';

// ---- vods + deaths
const vods = (H?.vods ?? [])
  .slice(0, 10)
  .map(
    (g: any) => `<div class="vod"><div class="vh"><code>${esc(g.matchId)}</code> ${date(g.endTs)} · ${esc(g.champion)} vs ${esc(g.opponent ?? '?')} · <span class="${g.win ? 'pos' : 'neg'}">${g.win ? 'Win' : 'Loss'}</span> ${Math.round(g.minutes)}m · control wards: ${g.pinks}</div>
<ul>${g.moments.map((m: any) => `<li><span class="t">${mmss(m.t / 1000)}</span> <span class="neg">${pp(m.dWp)}</span> ${esc(m.detail)}</li>`).join('')}</ul></div>`,
  )
  .join('');
const deaths = table(
  ['Death type (per game)', 'Him', 'Peers'],
  all.deathTypes.map((d: any) => [esc(d.label), `<b class="${d.you > d.peers * 1.15 ? 'neg' : ''}">${d.you.toFixed(2)}</b>`, d.peers.toFixed(2)]),
);
const costliest = table(
  ['Match', 'Champion', 'Time', 'Team was at', 'Cost', 'What happened'],
  all.costliestDeaths.slice(0, 8).map((d: any) => [`<code>${esc(d.matchId)}</code>`, esc(d.champion), mmss(d.t), pct(d.wpBefore), `<span class="neg">−${(d.cost * 100).toFixed(1)}</span>`, esc(d.context.join(', '))]),
  2,
);

const ev = R.method.evaluation;
const acc = (m: number) => ev?.accuracy?.find((b: any) => b.minute === m)?.accuracy;
const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.name)}: season story</title>
<style>
:root{--ink:#18181b;--muted:#6b6b73;--line:#e6e6e8;--soft:#f6f6f5;--accent:#2557a7;--pos:#16794a;--neg:#c0362c}
*{box-sizing:border-box}body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1040px;margin:0 auto;padding:28px 20px 64px}h1{font-size:24px;margin:0}.sub{color:var(--muted);margin-top:2px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:36px 0 10px;border-top:1px solid var(--line);padding-top:18px}
p{margin:8px 0}.note{color:var(--muted);font-size:13px}.muted{color:var(--muted)}.pos{color:var(--pos)}.neg{color:var(--neg)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0 6px}.cards div{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.cards b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.cards span{font-size:12px;color:var(--muted)}
.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px;margin:6px 0}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}td:first-child{min-width:230px}td.n,th.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.why{border-left:3px solid var(--accent);padding:2px 0 2px 12px;margin:14px 0}.why ul{margin:4px 0 0;padding-left:18px;font-size:14px}
.vod{border:1px solid var(--line);border-radius:8px;padding:8px 12px;margin:8px 0}.vh{font-size:14px}.vod ul{margin:4px 0 0;padding-left:18px;font-size:14px}.t{font-variant-numeric:tabular-nums;display:inline-block;min-width:42px}
code{font-size:12px;background:var(--soft);padding:1px 4px;border-radius:4px}ul.plain{padding-left:18px}ul.plain li{margin:4px 0}
</style></head><body><main>
<h1>${esc(p.name)}</h1>
<div class="sub">${esc(p.rank)} · ${esc(p.role)} · ${esc(p.season)} · ${all.games} games, ${all.wins}-${all.games - all.wins} (${pct(all.wins / all.games)})</div>
${headline}
${N.summary.length ? section('The short version', N.summary.map((s: string) => `<p>${s}</p>`).join('')) : ''}
${N.takeaways.length ? section('What to work on', `<ol class="plain">${N.takeaways.map((s: string) => `<li>${s}</li>`).join('')}</ol>`) : ''}
${section('Where his win chance comes from', cats)}
${section('His rules', rulesOf(all) + (champView ? `<p class="note">On ${esc(CH)} only, vs ${esc(champView.peerLabel)}:</p>` + rulesOf(champView) : ''), 'Two things he actually does in the same spot, and how much more win chance the better one gave him over a fixed window. Grey = not yet clear (within the margin).')}
${section('Why', why(all, 4))}
${H ? section('Habits that go with winning', habitsTable, `Win-rate difference (percentage points) between games with and without the habit, measured on ${H.peerGames.toLocaleString()} peer games and compared only among games at the same win chance when the habit window starts. "Within player" repeats it inside each peer's own games. These are associations, not proof: in checks on control wards, part of the effect came from longer games giving more chances to buy, and buyers did not die less. * = partly a result of how the game is going.`) : ''}
${W ? section('Vision', visionTable + (pinks ? '<p class="note">Control ward effect by lane state (peers, win chance at 14:00 held fixed):</p>' + pinks : '')) : ''}
${section('Deaths', deaths + '<p class="note">Costliest deaths this season:</p>' + costliest)}
${vods ? section('Recent games to rewatch', vods, 'Newest first; the 3 deaths that cost his team the most win chance in each game. The number after NA1_ is the game ID in the client match history; replays are only available for the current patch.') : ''}
${section('Method', `<ul class="plain"><li>Riot match-v5 data (match + timeline) for his ${esc(p.season)} games and ${all.peerGames.toLocaleString()} peer games (${esc(all.peerLabel)}).</li><li>Win chance comes from a model trained on ${R.method.trainedMatches?.toLocaleString?.() ?? R.method.trainedMatches} high-elo matches${acc(10) ? `; on games it never saw it picks the winner ${pct(acc(10))} of the time at 10 min and ${pct(acc(20))} at 20 min` : ''}.</li><li>Peers are ranked by their current ladder spot. Nothing here estimates hidden MMR.</li><li>Generated ${esc(p.generated)}.</li></ul>`)}
</main></body></html>`;
writeFileSync(arg('out'), page);
console.log(`Wrote ${arg('out')} (${Math.round(page.length / 1024)} KB)`);
