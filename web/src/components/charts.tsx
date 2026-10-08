import { useMemo, useState } from 'react';
import type { GameView } from '../data';
import { clock, pct, pp, tone } from '../format';

/** Horizontal bars around a zero line: you vs peers for each row. */
export function DivergingBars({ rows, max }: { rows: { label: string; you: number; peers: number }[]; max?: number }) {
  const m = max ?? Math.max(...rows.flatMap((r) => [Math.abs(r.you), Math.abs(r.peers)]), 0.01);
  const bar = (v: number, cls: string) => (
    <div className="dv-track">
      <div className={`dv-bar ${cls} ${v < 0 ? 'neg' : 'pos'}`} style={v < 0 ? { right: '50%', width: `${(-v / m) * 50}%` } : { left: '50%', width: `${(v / m) * 50}%` }} />
      <div className="dv-zero" />
    </div>
  );
  return (
    <div className="dv">
      {rows.map((r) => (
        <div className="dv-row" key={r.label}>
          <div className="dv-label">{r.label}</div>
          <div className="dv-bars">
            {bar(r.you, 'you')}
            {bar(r.peers, 'peer')}
          </div>
          <div className={`dv-val ${tone(r.you)}`}>{pp(r.you)}</div>
          <div className="dv-val muted">{pp(r.peers)}</div>
        </div>
      ))}
    </div>
  );
}

/** "You 39% · Peers 44%" as two thin meters. */
export function ShareMeter({ you, peers }: { you: number; peers: number }) {
  return (
    <div className="meter" title={`You do this ${pct(you)} of the time; peers ${pct(peers)}`}>
      <div className="meter-row"><span>You</span><div className="meter-track"><div className="meter-fill you" style={{ width: `${you * 100}%` }} /></div><b>{pct(you)}</b></div>
      <div className="meter-row"><span>Peers</span><div className="meter-track"><div className="meter-fill peer" style={{ width: `${peers * 100}%` }} /></div><b>{pct(peers)}</b></div>
    </div>
  );
}

/** Win-chance change per response, as signed bars with share labels. */
export function ResponseBars({ responses }: { responses: { label: string; n: number; share: number; change: number | null; ci: number | null; peerChange: number | null }[] }) {
  const m = Math.max(...responses.flatMap((r) => [Math.abs(r.change ?? 0) + (r.ci ?? 0), Math.abs(r.peerChange ?? 0)]), 0.01);
  return (
    <div className="dv">
      {responses.map((r) => (
        <div className="dv-row" key={r.label}>
          <div className="dv-label">{r.label}<span className="muted small"> {pct(r.share)}</span></div>
          <div className="dv-bars">
            <div className="dv-track">
              {r.change !== null && <div className={`dv-bar you ${r.change < 0 ? 'neg' : 'pos'}`} style={r.change < 0 ? { right: '50%', width: `${(-r.change / m) * 50}%` } : { left: '50%', width: `${(r.change / m) * 50}%` }} />}
              {r.change !== null && r.ci !== null && <div className="dv-ci" style={{ left: `${50 + ((r.change - r.ci) / m) * 50}%`, width: `${((2 * r.ci) / m) * 50}%` }} />}
              <div className="dv-zero" />
            </div>
            <div className="dv-track">
              {r.peerChange !== null && <div className={`dv-bar peer ${r.peerChange < 0 ? 'neg' : 'pos'}`} style={r.peerChange < 0 ? { right: '50%', width: `${(-r.peerChange / m) * 50}%` } : { left: '50%', width: `${(r.peerChange / m) * 50}%` }} />}
              <div className="dv-zero" />
            </div>
          </div>
          <div className={`dv-val ${tone(r.change)}`} title={r.ci !== null ? `±${(r.ci * 100).toFixed(1)} (95%) · ${r.n} cases` : `${r.n} cases`}>{r.n ? pp(r.change) : '–'}</div>
          <div className="dv-val muted">{pp(r.peerChange)}</div>
        </div>
      ))}
    </div>
  );
}

const COLORS = { kill: 'var(--pos)', death: 'var(--neg)', structure: 'var(--accent)', objective: 'var(--accent)' } as const;

/** Win chance over a game, with his plays as markers and a hover readout. */
export function WpChart({ game }: { game: GameView }) {
  const W = 760, H = 240, L = 36, R = 8, T = 8, B = 22;
  const end = game.curve[game.curve.length - 1]![0];
  const x = (t: number) => L + (t / end) * (W - L - R);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const wpAt = (t: number) => {
    let prev = game.curve[0]!;
    for (const c of game.curve) {
      if (c[0] >= t) return prev[1] + ((t - prev[0]) / (c[0] - prev[0] || 1)) * (c[1] - prev[1]);
      prev = c;
    }
    return prev[1];
  };
  const [hover, setHover] = useState<number | null>(null);
  const path = useMemo(() => game.curve.map((c) => `${x(c[0]).toFixed(1)},${y(c[1]).toFixed(1)}`).join(' '), [game]);
  const area = `${x(0)},${y(0.5)} ${path} ${x(end)},${y(0.5)}`;
  return (
    <svg
      className="wp"
      viewBox={`0 0 ${W} ${H}`}
      onMouseMove={(e) => {
        const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
        const t = (((e.clientX - r.left) / r.width) * W - L) / (W - L - R) * end;
        setHover(t >= 0 && t <= end ? t : null);
      }}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <clipPath id="above"><rect x="0" y="0" width={W} height={y(0.5)} /></clipPath>
        <clipPath id="below"><rect x="0" y={y(0.5)} width={W} height={H} /></clipPath>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((p) => (
        <g key={p}>
          <line x1={L} x2={W - R} y1={y(p)} y2={y(p)} className={p === 0.5 ? 'grid mid' : 'grid'} />
          <text x={L - 6} y={y(p) + 4} className="axis" textAnchor="end">{p * 100}%</text>
        </g>
      ))}
      {Array.from({ length: Math.floor(end / 300) + 1 }, (_, i) => i * 5).map((m) => (
        <text key={m} x={x(m * 60)} y={H - 6} className="axis" textAnchor="middle">{m}</text>
      ))}
      <polygon points={area} className="area pos" clipPath="url(#above)" />
      <polygon points={area} className="area neg" clipPath="url(#below)" />
      <polyline points={path} className="line" />
      {game.events.map((e, i) => (
        <circle key={i} cx={x(e.t)} cy={y(wpAt(e.t))} r={e.kind === 'death' ? 4.5 : 4} fill={e.kind === 'death' ? '#fff' : COLORS[e.kind]} stroke={COLORS[e.kind]} strokeWidth={2}>
          <title>{`${clock(e.t)} ${e.label} (${pp(e.d)})`}</title>
        </circle>
      ))}
      {hover !== null && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="cursor" />
          <text x={Math.min(x(hover) + 6, W - 70)} y={T + 12} className="readout">{`${clock(hover)}  ${Math.round(wpAt(hover) * 100)}%`}</text>
        </g>
      )}
    </svg>
  );
}
