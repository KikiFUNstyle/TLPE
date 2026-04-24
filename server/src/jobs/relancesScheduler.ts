import { runEscaladeImpayes, type RunEscaladeImpayesResult } from '../impayes';
import { runRelancesDeclarations, type RunRelancesResult } from '../relances';

let timer: NodeJS.Timeout | null = null;

export type DailyJobRunResult = {
  relances: {
    ok: boolean;
    result?: RunRelancesResult;
    error?: string;
  };
  impayes: {
    ok: boolean;
    result?: RunEscaladeImpayesResult;
    error?: string;
  };
};

function msUntilNextDailyRun(hour = 5, minute = 0): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function runDailyJobs(deps?: {
  runRelances?: () => RunRelancesResult;
  runImpayes?: () => RunEscaladeImpayesResult;
}): DailyJobRunResult {
  const executeRelances = deps?.runRelances ?? runRelancesDeclarations;
  const executeImpayes = deps?.runImpayes ?? runEscaladeImpayes;

  const relances: DailyJobRunResult['relances'] = { ok: false };
  const impayes: DailyJobRunResult['impayes'] = { ok: false };

  try {
    relances.result = executeRelances();
    relances.ok = true;
  } catch (error) {
    relances.error = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error('[TLPE] Erreur job relances declarations', error);
  }

  try {
    impayes.result = executeImpayes();
    impayes.ok = true;
  } catch (error) {
    impayes.error = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error('[TLPE] Erreur job escalade impayes', error);
  }

  // eslint-disable-next-line no-console
  console.log('[TLPE] Jobs quotidiens executes', { relances, impayes });
  return { relances, impayes };
}

function scheduleNextDailyTick() {
  const delay = msUntilNextDailyRun();
  timer = setTimeout(() => {
    try {
      runDailyJobs();
    } finally {
      scheduleNextDailyTick();
    }
  }, delay);
}

export function startRelancesScheduler() {
  if (timer) return;
  scheduleNextDailyTick();
}

export function stopRelancesScheduler() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}
