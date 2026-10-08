import { readFileSync, writeFileSync } from 'node:fs';
import type { GameState } from './state';
import { dot, fitLogit, sigmoid } from './logit';

/**
 * Win probability for blue given a game state. Logistic regression with time
 * interactions: a gold lead or dead players matter more as the game goes on.
 */
export const FEATURE_NAMES = [
  'intercept',
  'gold/1k',
  'gold/1k x time',
  'xp/1k',
  'towers',
  'inhibs down',
  'baron buff',
  'elder buff',
  'soul',
  'dragons',
  'dead players x time',
] as const;

export function features(s: GameState): number[] {
  const tm = s.minute / 30;
  return [
    1,
    s.goldDiff / 1000,
    (s.goldDiff / 1000) * tm,
    s.xpDiff / 1000,
    s.towerDiff,
    s.inhibDiff,
    s.baron,
    s.elder,
    s.soul,
    s.dragonDiff,
    s.deadDiff * tm,
  ];
}

export interface WinModel {
  weights: number[];
  trainedOn: { matches: number; rows: number; at: string };
  /** Held-out evaluation from `wp-train` (model fitted without these matches). */
  evaluation?: ModelEvaluation;
}

export interface ModelEvaluation {
  heldOutMatches: number;
  accuracy: { minute: number; accuracy: number; n: number }[];
  overallAccuracy: number;
  logLoss: number;
  /** Baseline log loss of always predicting 50%. */
  baselineLogLoss: number;
  calibration: { predicted: number; actual: number; n: number }[];
}

export function predict(model: WinModel, s: GameState): number {
  return sigmoid(dot(features(s), model.weights));
}

export function train(rows: { state: GameState; blueWin: boolean }[], matches: number): WinModel {
  const { w } = fitLogit(
    rows.map((r) => features(r.state)),
    rows.map((r) => +r.blueWin),
    1,
  );
  return { weights: w, trainedOn: { matches, rows: rows.length, at: new Date().toISOString() } };
}

export const saveModel = (path: string, m: WinModel) => writeFileSync(path, JSON.stringify(m, null, 2));
export const loadModel = (path: string): WinModel => JSON.parse(readFileSync(path, 'utf8')) as WinModel;
