import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Config } from './config';
import { parseSince } from './season';
import { loadReportData, type ReportQuery } from './web/load';

const STATIC = 'web/dist';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/**
 * Local API for the web app. GET /api/report?riotId=Name%23TAG&role=TOP&since=2026&queue=420&minLp=600&champions=A,B
 * Missing parameters fall back to the defaults the server was started with. Also serves the built app from web/dist.
 */
export function serve(config: Config, port: number, defaults: Partial<ReportQuery>): void {
  const cache = new Map<string, Promise<unknown>>();
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/api/report') {
        const p = url.searchParams;
        const since = p.get('since') ?? defaults.since;
        const q: ReportQuery = {
          riotId: p.get('riotId') ?? defaults.riotId ?? '',
          role: p.get('role') ?? defaults.role ?? 'TOP',
          since,
          sinceMs: since ? parseSince(since) : undefined,
          queue: p.has('queue') ? Number(p.get('queue')) : defaults.queue,
          minLp: p.has('minLp') ? Number(p.get('minLp')) : defaults.minLp,
          champions: p.has('champions') ? p.get('champions')!.split(',').filter(Boolean) : (defaults.champions ?? []),
        };
        if (!q.riotId) throw Object.assign(new Error('riotId is required, e.g. ?riotId=oRegret%23NA69'), { status: 400 });
        const key = JSON.stringify(q);
        if (p.has('refresh')) cache.delete(key);
        if (!cache.has(key)) cache.set(key, loadReportData(config, q).catch((e) => { cache.delete(key); throw e; }));
        const body = JSON.stringify(await cache.get(key));
        res.writeHead(200, { 'content-type': 'application/json' }).end(body);
        return;
      }
      const file = normalize(join(STATIC, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!file.startsWith(normalize(STATIC)) || !existsSync(file)) {
        res.writeHead(existsSync(join(STATIC, 'index.html')) ? 404 : 503, { 'content-type': 'text/plain' }).end(existsSync(join(STATIC, 'index.html')) ? 'Not found' : 'App not built: run "npm run web:build" (or use "npm run web:dev" for development).');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    } catch (e) {
      const err = e as Error & { status?: number };
      res.writeHead(err.status ?? 500, { 'content-type': 'text/plain' }).end(err.message);
    }
  }).listen(port, () => console.log(`API and app on http://localhost:${port}  (dev UI: npm run web:dev -> http://localhost:5173)`));
}
