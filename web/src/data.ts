import type { ReportData } from '../../src/web/build';

export type { GameView, ReportData, Rule, SituationBlock, View } from '../../src/web/build';

/** Exported single-file reports embed their data; otherwise ask the local API (same query string). */
export async function loadReport(): Promise<ReportData> {
  const embedded = document.getElementById('report-data');
  if (embedded?.textContent) return JSON.parse(embedded.textContent) as ReportData;
  const res = await fetch(`/api/report${window.location.search}`);
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return (await res.json()) as ReportData;
}
