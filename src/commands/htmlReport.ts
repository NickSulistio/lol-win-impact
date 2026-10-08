import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config';
import { loadReportData, type ReportQuery } from '../web/load';

const TEMPLATE = 'web/dist-single/index.html';

/** Export the web app as one self-contained HTML file with the player's data baked in. */
export async function htmlReport(config: Config, q: ReportQuery & { out?: string; rebuild?: boolean }): Promise<void> {
  if (q.rebuild || !existsSync(TEMPLATE)) {
    console.log('Building the single-file app template...');
    execSync('npx vite build --config web/vite.config.ts --mode single --logLevel warn', { stdio: 'inherit' });
  }
  const data = await loadReportData(config, q);
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const html = readFileSync(TEMPLATE, 'utf8').replace('</head>', `<script id="report-data" type="application/json">${json}</script></head>`).replace('<title>Replay Analyser</title>', `<title>${data.player.name.replace(/[<&]/g, '')}: what wins your games</title>`);
  const out = q.out ?? `reports/${data.player.name.replace('#', '-').replace(/\s+/g, '_')}.html`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB): ${data.views[0]?.games ?? 0} games, ${data.player.peerGames} peer games.`);
}
