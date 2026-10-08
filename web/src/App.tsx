import { useEffect, useMemo, useState } from 'react';
import { DivergingBars, ResponseBars, ShareMeter, WpChart } from './components/charts';
import { loadReport, type GameView, type ReportData, type Rule, type View } from './data';
import { clock, pct, pp, tone } from './format';
import { Method } from './Method';

type Tab = 'overview' | 'rules' | 'why' | 'games' | 'deaths' | 'profile' | 'method';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['rules', 'Rules'], ['why', 'Why'], ['games', 'Games'], ['deaths', 'Deaths'], ['profile', 'Profile'], ['method', 'Method']];

export function App() {
  const [data, setData] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewIdx, setViewIdx] = useState(0);
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.slice(1);
    return (TABS.some(([k]) => k === h) ? h : 'overview') as Tab;
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(null, '', `#${t}`);
  };
  const [gameId, setGameId] = useState<string | null>(null);

  useEffect(() => {
    loadReport().then(setData, (e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="state">Could not load report: {error}</div>;
  if (!data) return <div className="state">Loading…</div>;
  const view = data.views[viewIdx]!;
  const openGame = (id: string) => {
    setGameId(id);
    setTab('games');
  };

  return (
    <div className="app">
      <header className="top">
        <div className="who">
          <div className="name">{data.player.name}</div>
          <div className="sub">{[data.player.rank, data.player.role.toLowerCase(), data.player.season].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="seg" role="tablist" aria-label="Champion">
          {data.views.map((v, i) => (
            <button key={v.label} className={i === viewIdx ? 'on' : ''} onClick={() => setViewIdx(i)}>
              {v.label} <span className="muted">{v.games}</span>
            </button>
          ))}
        </div>
      </header>
      <nav className="tabs">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span className="peers" title={`Win chance model trained on ${data.player.modelMatches.toLocaleString()} matches. Generated ${data.player.generated}.`}>
          vs {view.peerGames.toLocaleString()} games from {view.peerPlayers} {view.peerLabel}
        </span>
      </nav>
      <main>
        {tab === 'overview' && <Overview view={view} onRule={() => setTab('rules')} />}
        {tab === 'rules' && <Rules view={view} />}
        {tab === 'why' && <Why view={view} />}
        {tab === 'games' && <Games games={data.games} champion={view.label === 'All' ? null : view.label} selected={gameId} onSelect={setGameId} />}
        {tab === 'deaths' && <Deaths view={view} onGame={openGame} />}
        {tab === 'profile' && <Profile view={view} />}
        {tab === 'method' && <Method data={data} />}
      </main>
      <footer>
        <button className="link" onClick={() => setTab('method')}>What "contribution" means and how the model works →</button>
      </footer>
    </div>
  );
}

function Kpi({ label, value, cls, sub, hint }: { label: string; value: string; cls?: string; sub?: string; hint?: string }) {
  return (
    <div className="kpi" title={hint}>
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${cls ?? ''}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function Overview({ view, onRule }: { view: View; onRule: () => void }) {
  const top = view.rules.filter((r) => r.gain - r.ci > 0).slice(0, 3);
  return (
    <>
      <section className="kpis">
        <Kpi label="Contribution / game" value={pp(view.total.you)} cls={tone(view.total.you)} sub={`peers ${pp(view.total.peers)}`} hint="Win chance (percentage points) your plays added per game, net of what your deaths cost. See the Method tab." />
        <Kpi label="Win rate" value={pct(view.wins / view.games)} sub={`${view.wins}-${view.games - view.wins}`} />
        <Kpi label="Deaths / game" value={view.deathsPerGame.you.toFixed(1)} cls={view.deathsPerGame.you > view.deathsPerGame.peers * 1.15 ? 'neg' : ''} sub={`peers ${view.deathsPerGame.peers.toFixed(1)}`} />
        <Kpi label="In wins / losses" value={`${pp(view.total.wins)} / ${pp(view.total.losses)}`} hint="Your contribution per game in games you won and lost." />
      </section>
      <div className="grid2">
        <section className="card">
          <h3>Where your win chance comes from <Legend /></h3>
          <DivergingBars rows={view.categories} />
        </section>
        <section className="card">
          <h3>By phase <Legend /></h3>
          <DivergingBars rows={view.phases} />
        </section>
      </div>
      <section className="card">
        <h3>Biggest wins available</h3>
        <div className="toprules">
          {top.map((r) => (
            <button key={r.kind} className="toprule" onClick={onRule}>
              <span className="tr-sit">{r.situation}</span>
              <span className="tr-do">{r.doThis}</span>
              <span className="tr-gain pos">{pp(r.gain)}</span>
            </button>
          ))}
          {!top.length && <span className="muted">No clear rules yet for this sample.</span>}
        </div>
      </section>
    </>
  );
}

const Legend = () => (
  <span className="legend"><i className="sw you" />you <i className="sw peer" />peers</span>
);

function Rules({ view }: { view: View }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="rules">
      {view.rules.map((r) => (
        <RuleCard key={r.kind} rule={r} open={open === r.kind} onToggle={() => setOpen(open === r.kind ? null : r.kind)} view={view} />
      ))}
      <h3 className="section-h">Teamfights</h3>
      {view.situations.filter((s) => s.kind === 'joined-teamfight').map((s) => (
        <div className="card" key={s.kind}>
          <div className="muted small">{s.detail} {s.perGame.toFixed(1)} per game.</div>
          <ResponseBars responses={s.responses} />
        </div>
      ))}
    </section>
  );
}

function RuleCard({ rule: r, open, onToggle, view }: { rule: Rule; open: boolean; onToggle: () => void; view: View }) {
  const clear = r.gain - r.ci > 0;
  const sit = view.situations.find((s) => s.kind === r.kind)!;
  return (
    <div className={`card rule ${clear ? '' : 'unclear'}`}>
      <button className="rule-head" onClick={onToggle} aria-expanded={open}>
        <div className="rule-sit" title={r.detail}>{r.situation}</div>
        <div className="rule-choice">
          <span className="do">{r.doThis}</span>
          <span className="vs">over</span>
          <span className="instead">{r.insteadOf}</span>
        </div>
        <div className="rule-gain" title={`±${(r.ci * 100).toFixed(1)} (95%) · ${r.n} cases`}>
          <b className={clear ? 'pos' : ''}>{pp(r.gain)}</b>
          <span>{clear ? 'win %' : 'unclear'}</span>
        </div>
        <ShareMeter you={r.youShare} peers={r.peerShare} />
        <span className="chev">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="rule-body">
          <div className="muted small">{r.detail} {sit.count} times ({sit.perGame.toFixed(2)} per game).</div>
          <div className="rb-head"><span /> <Legend /></div>
          <ResponseBars responses={sit.responses} />
        </div>
      )}
    </div>
  );
}

function Games({ games, champion, selected, onSelect }: { games: GameView[]; champion: string | null; selected: string | null; onSelect: (id: string) => void }) {
  const [result, setResult] = useState<'all' | 'win' | 'loss'>('all');
  const [sort, setSort] = useState<'new' | 'best' | 'worst'>('new');
  const list = useMemo(() => {
    let l = games.filter((g) => (!champion || g.champion === champion) && (result === 'all' || g.win === (result === 'win')));
    if (sort === 'best') l = [...l].sort((a, b) => b.wpa - a.wpa);
    if (sort === 'worst') l = [...l].sort((a, b) => a.wpa - b.wpa);
    return l;
  }, [games, champion, result, sort]);
  const game = games.find((g) => g.matchId === selected) ?? list[0];
  const maxAbs = Math.max(...list.map((g) => Math.abs(g.wpa)), 0.01);
  return (
    <div className="games">
      <aside className="glist card">
        <div className="gfilters">
          <div className="seg small">
            {(['all', 'win', 'loss'] as const).map((k) => <button key={k} className={result === k ? 'on' : ''} onClick={() => setResult(k)}>{k === 'all' ? 'All' : k === 'win' ? 'Wins' : 'Losses'}</button>)}
          </div>
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="new">Newest</option>
            <option value="best">Best</option>
            <option value="worst">Worst</option>
          </select>
        </div>
        <div className="gscroll">
          {list.map((g) => (
            <button key={g.matchId} className={`grow ${g.matchId === game?.matchId ? 'on' : ''}`} onClick={() => onSelect(g.matchId)}>
              <span className={`wl ${g.win ? 'w' : 'l'}`}>{g.win ? 'W' : 'L'}</span>
              <span className="g-main"><b>{g.champion}</b> <span className="muted">vs {g.opponent}</span><br /><span className="muted small">{g.date} · {g.kda} · {g.minutes}m</span></span>
              <span className="g-bar"><span className={g.wpa < 0 ? 'neg' : 'pos'} style={{ width: `${(Math.abs(g.wpa) / maxAbs) * 100}%` }} /></span>
              <span className={`g-val ${tone(g.wpa)}`}>{pp(g.wpa)}</span>
            </button>
          ))}
        </div>
      </aside>
      {game && (
        <section className="gdetail card">
          <div className="gd-head">
            <div>
              <div className="gd-title"><span className={`wl ${game.win ? 'w' : 'l'}`}>{game.win ? 'W' : 'L'}</span> {game.champion} <span className="muted">vs {game.opponent}</span></div>
              <div className="muted small">{game.date} · {game.kda} · {game.minutes} min · {game.matchId}</div>
            </div>
            <div className="gd-wpa"><span className="muted small">your contribution</span><b className={tone(game.wpa)}>{pp(game.wpa)}</b></div>
          </div>
          <WpChart game={game} />
          <div className="legend chart-legend"><i className="dot k-kill" />kill <i className="dot k-death" />death <i className="dot k-structure" />tower / objective</div>
          <div className="events">
            {game.events.filter((e) => Math.abs(e.d) >= 0.005).map((e, i) => (
              <div key={i} className="ev">
                <span className="ev-t">{clock(e.t)}</span>
                <i className={`dot k-${e.kind}`} />
                <span className="ev-l">{e.label}</span>
                <span className={`ev-d ${tone(e.d)}`}>{pp(e.d)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Deaths({ view, onGame }: { view: View; onGame: (id: string) => void }) {
  const max = Math.max(...view.deathTypes.flatMap((d) => [d.you, d.peers]), 0.01);
  return (
    <div className="grid2 deaths">
      <section className="card">
        <h3>Death types per game <Legend /></h3>
        <div className="hbars">
          {view.deathTypes.map((d) => (
            <div className="hb-row" key={d.label} title={`Average cost ${pp(-d.cost)} win %`}>
              <div className="hb-label">{d.label}</div>
              <div className="hb-bars">
                <div className="hb-track"><div className={`hb-fill you ${d.you > d.peers * 1.15 ? 'hot' : ''}`} style={{ width: `${(d.you / max) * 100}%` }} /></div>
                <div className="hb-track"><div className="hb-fill peer" style={{ width: `${(d.peers / max) * 100}%` }} /></div>
              </div>
              <div className="hb-val">{d.you.toFixed(2)}<span className="muted"> / {d.peers.toFixed(2)}</span></div>
            </div>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Costliest deaths <span className="muted small">click to open the game</span></h3>
        <div className="costly">
          {view.costliestDeaths.map((d, i) => (
            <button key={i} className="cd" onClick={() => onGame(d.matchId)}>
              <span className="cd-cost neg">{pp(-d.cost)}</span>
              <span className="cd-main"><b>{d.champion}</b> <span className="muted">{clock(d.t)} · was {pct(d.wpBefore)}</span><br /><span className="small muted">{d.context.join(' · ')}</span></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Profile({ view }: { view: View }) {
  return (
    <div className="grid2">
      {view.profile.map((s) => (
        <section className="card" key={s.section}>
          <h3>{s.section}</h3>
          <table className="ptable">
            <thead><tr><th /><th>You</th><th>Peers</th></tr></thead>
            <tbody>
              {s.rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className={r.verdict === 'better' ? 'pos strong' : r.verdict === 'worse' ? 'neg strong' : ''}>{r.you}</td>
                  <td className="muted">{r.peers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function Why({ view }: { view: View }) {
  if (!view.explanations.length) return <div className="card muted">No gaps clear of noise yet for this sample.</div>;
  return (
    <section className="why">
      {view.explanations.map((e, i) => (
        <div className="card why-card" key={i}>
          <div className="why-head">
            <span className={`why-type ${e.type}`}>{e.type === 'response-contrast' ? 'Your choices' : 'You vs peers'}</span>
            <div className="why-title">{e.title.replace(/: you vs peers$/, '').replace(/ for you$/, '')}</div>
            <div className="why-gap" title={`±${(e.ci * 100).toFixed(1)} per case (95%) · ${e.n.a} vs ${e.n.b} cases`}>
              <b className={tone(e.gap)}>{pp(e.gap)}</b>
              <span>per case · {pp(e.perGame)}/game</span>
            </div>
          </div>
          <ul className="why-list">
            {e.summary.map((line, j) => <li key={j}>{line}</li>)}
          </ul>
        </div>
      ))}
    </section>
  );
}
