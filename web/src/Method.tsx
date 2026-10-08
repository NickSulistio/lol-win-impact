import type { ReportData } from './data';
import { clock, pct, pp } from './format';

type M = ReportData['method'];

export function Method({ data }: { data: ReportData }) {
  const m = data.method;
  const ev = m.evaluation;
  return (
    <div className="method">
      <section className="card define">
        <div className="define-term">Contribution</div>
        <div className="define-text">
          How much you moved your team's <b>chance of winning</b>, added up over a game. It is measured in percentage points of win chance.{' '}
          <span className="muted">+2.0 per game means your plays added 2 points of win chance per game more than they cost.</span>
        </div>
      </section>

      <div className="steps">
        <Step n={1} title="Estimate win chance at every moment" text="A model reads the game state and outputs each team's chance to win." />
        <Step n={2} title="Measure every event" text="Each kill, death, tower and objective changes the win chance. That change is the event's value." />
        <Step n={3} title="Credit the players involved" text="Your contribution is the sum of the value of everything you did." />
      </div>

      <div className="grid2">
        <section className="card">
          <h3>Example: one of your kills</h3>
          {m.example ? <KillExample ex={m.example} /> : <span className="muted">No example available.</span>}
        </section>
        <section className="card">
          <h3>Who gets credit</h3>
          <table className="ptable credit">
            <tbody>
              <tr><td>Kill</td><td>Killer 50%, assists share 50% (solo kill: killer 100%)</td></tr>
              <tr><td>Death</td><td>Victim takes the full loss</td></tr>
              <tr><td>Tower, inhibitor</td><td>Split between the players who took it</td></tr>
              <tr><td>Dragon, Baron, herald, grubs</td><td>Split between the players who took it</td></tr>
              <tr><td>Farm</td><td>Gold earned beyond your lane opponent each minute: +100g is worth {pp(m.goldPerMinuteExample.at10, 2)} at 10 min and {pp(m.goldPerMinuteExample.at25, 2)} at 25 min</td></tr>
              <tr><td>Minions, wards</td><td>Not credited directly (only through gold)</td></tr>
            </tbody>
          </table>
          <p className="muted small">Credit is zero-sum: what one team gains the other loses, so the average player is near 0. A winning team's five players add up to about +50 between them.</p>
        </section>
      </div>

      <section className="card">
        <h3>What the model sees, and what each input is worth <span className="legend"><i className="sw t10" />10 min <i className="sw t20" />20 min <i className="sw t30" />30 min</span></h3>
        <p className="muted small">Change in win chance from an even (50%) game when one team gains this, at three points in the game.</p>
        <WorthBars rows={m.worth} />
      </section>

      {ev && (
        <div className="grid2">
          <section className="card">
            <h3>How often it picks the winner</h3>
            <AccuracyChart ev={ev} />
            <p className="muted small">Tested on {ev.heldOutMatches.toLocaleString()} matches the model never trained on. Overall {pct(ev.overallAccuracy)}. Early on it is close to a coin flip, because little has happened yet.</p>
          </section>
          <section className="card">
            <h3>Do its percentages hold up?</h3>
            <CalibrationChart ev={ev} />
            <p className="muted small">Each dot groups moments by predicted win chance and shows how often that team actually won. Dots on the diagonal mean "70%" really is 70%.</p>
          </section>
        </div>
      )}

      <section className="card">
        <h3>How rules are tested</h3>
        <div className="steps inner">
          <Step n={1} title="Find the situation" text="For example, every solo kill you got before 14:00, found in the match timeline." />
          <Step n={2} title="Group by what you did" text="Pushed for plates, recalled, or neither, within 90 seconds." />
          <Step n={3} title="Compare win chance afterwards" text="Average change over a fixed window (here 3 minutes) for each choice. The rule is the best choice compared with your most common other one." />
        </div>
        <ul className="facts">
          <li><b>Game state is accounted for.</b> Each case is measured from where the win chance already was, so being ahead does not inflate a choice.</li>
          <li><b>± is a 95% range.</b> If the range includes zero, the rule is marked <i>unclear</i>: it could be noise.</li>
          <li><b>Not proof of cause.</b> Choices are not random. You may recall because you are low on health. Treat rules as strong hints for replay review.</li>
        </ul>
      </section>

      <section className="card">
        <h3>Data</h3>
        <table className="ptable credit">
          <tbody>
            <tr><td>Your games</td><td>{data.views[0]?.games} {data.player.role.toLowerCase()} games, {data.player.season}, 15+ min</td></tr>
            <tr><td>Peers</td><td>{data.player.peerGames.toLocaleString()} {data.player.role.toLowerCase()} games from {data.player.peerPlayers} players, {data.player.peerLabel} on the current ladder</td></tr>
            <tr><td>Model</td><td>Logistic regression, {m.trainedMatches.toLocaleString()} high-elo matches, {m.trainedSnapshots.toLocaleString()} one-minute snapshots</td></tr>
            <tr><td>Source</td><td>Riot match and timeline data. Positions are recorded once a minute, so "alone" and "near the objective" are estimates.</td></tr>
            <tr><td>Not included</td><td>Hidden MMR (not estimated, per Riot policy), vision, items, and anything not in the timeline</td></tr>
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Step({ n, title, text }: { n: number; title: string; text: string }) {
  return (
    <div className="step">
      <div className="step-n">{n}</div>
      <div><div className="step-t">{title}</div><div className="step-x">{text}</div></div>
    </div>
  );
}

function KillExample({ ex }: { ex: NonNullable<M['example']> }) {
  const d = ex.after - ex.before;
  return (
    <div className="kex">
      <div className="muted small">{ex.champion} solo kills {ex.victim} at {clock(ex.t)} · {ex.matchId}</div>
      <div className="kex-bars">
        <div className="kex-col"><div className="kex-track"><div className="kex-fill" style={{ height: `${ex.before * 100}%` }} /></div><b>{pct(ex.before)}</b><span>before</span></div>
        <div className="kex-arrow">→</div>
        <div className="kex-col"><div className="kex-track"><div className="kex-fill after" style={{ height: `${ex.after * 100}%` }} /></div><b>{pct(ex.after)}</b><span>after</span></div>
        <div className="kex-split">
          <div><span className="chip pos">{pp(d)}</span> to you (killer, no assists)</div>
          <div><span className="chip neg">{pp(-d)}</span> to {ex.victim}</div>
          <div className="muted small">With assists, you would get {pp(d / 2)} and the assisters would share {pp(d / 2)}.</div>
        </div>
      </div>
      <p className="muted small">The jump comes from the kill gold and the enemy being dead for a while.</p>
    </div>
  );
}

function WorthBars({ rows }: { rows: M['worth'] }) {
  const max = Math.max(...rows.flatMap((r) => [r.at10, r.at20, r.at30].map(Math.abs)), 0.01);
  return (
    <div className="worth">
      {rows.map((r) => (
        <div className="worth-row" key={r.label}>
          <div className="worth-label">{r.label}</div>
          <div className="worth-bars">
            {([['t10', r.at10], ['t20', r.at20], ['t30', r.at30]] as const).map(([k, v]) => (
              <div className="worth-line" key={k}>
                <div className={`worth-fill ${k}`} style={{ width: `${(Math.max(0, v) / max) * 100}%` }} />
                <span>{pp(v)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function AccuracyChart({ ev }: { ev: NonNullable<M['evaluation']> }) {
  const W = 480, H = 200, L = 34, R = 8, T = 8, B = 22;
  const maxMin = Math.max(...ev.accuracy.map((a) => a.minute));
  const x = (m: number) => L + ((m - 1) / (maxMin - 1)) * (W - L - R);
  const y = (a: number) => T + (1 - (a - 0.5) / 0.5) * (H - T - B);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mchart">
      {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map((a) => (
        <g key={a}><line x1={L} x2={W - R} y1={y(a)} y2={y(a)} className={a === 0.5 ? 'grid mid' : 'grid'} /><text x={L - 6} y={y(a) + 4} className="axis" textAnchor="end">{Math.round(a * 100)}%</text></g>
      ))}
      {[5, 10, 15, 20, 25, 30, 35].filter((m) => m <= maxMin).map((m) => <text key={m} x={x(m)} y={H - 6} className="axis" textAnchor="middle">{m} min</text>)}
      <polyline className="line" points={ev.accuracy.map((a) => `${x(a.minute)},${y(a.accuracy)}`).join(' ')} />
      {ev.accuracy.filter((a) => a.minute % 5 === 0).map((a) => (
        <g key={a.minute}><circle cx={x(a.minute)} cy={y(a.accuracy)} r={3.5} className="pt" /><text x={x(a.minute)} y={y(a.accuracy) - 8} className="lbl" textAnchor="middle">{pct(a.accuracy)}</text></g>
      ))}
      <text x={W - R} y={y(0.5) - 5} className="axis" textAnchor="end">coin flip</text>
    </svg>
  );
}

function CalibrationChart({ ev }: { ev: NonNullable<M['evaluation']> }) {
  const S = 220, P = 30;
  const c = (v: number) => P + v * (S - P - 8);
  const yv = (v: number) => S - P - v * (S - P - 8) + 8;
  const maxN = Math.max(...ev.calibration.map((b) => b.n));
  return (
    <svg viewBox={`0 0 ${S + 10} ${S + 4}`} className="mchart cal">
      {[0, 0.25, 0.5, 0.75, 1].map((v) => (
        <g key={v}>
          <line x1={c(0)} x2={c(1)} y1={yv(v)} y2={yv(v)} className="grid" />
          <text x={c(0) - 5} y={yv(v) + 4} className="axis" textAnchor="end">{v * 100}</text>
          <text x={c(v)} y={S - 6} className="axis" textAnchor="middle">{v * 100}</text>
        </g>
      ))}
      <line x1={c(0)} y1={yv(0)} x2={c(1)} y2={yv(1)} className="diag" />
      {ev.calibration.map((b, i) => (
        <circle key={i} cx={c(b.predicted)} cy={yv(b.actual)} r={3 + 5 * Math.sqrt(b.n / maxN)} className="pt">
          <title>{`predicted ${pct(b.predicted)}, actually won ${pct(b.actual)} (${b.n.toLocaleString()} moments)`}</title>
        </circle>
      ))}
      <text x={c(0.5)} y={S + 4} className="axis" textAnchor="middle">predicted %</text>
      <text x={8} y={yv(0.5)} className="axis" textAnchor="middle" transform={`rotate(-90 8 ${yv(0.5)})`}>actual %</text>
    </svg>
  );
}
