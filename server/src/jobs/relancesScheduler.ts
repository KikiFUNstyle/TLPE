import { runEscaladeImpayes } from '../impayes';
import { runRelancesDeclarations } from '../relances';

let timer: NodeJS.Timeout | null = null;

function msUntilNextDailyRun(hour = 5, minute = 0): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleNextDailyTick() {
  const delay = msUntilNextDailyRun();
  timer = setTimeout(() => {
    let relancesResult: ReturnType<typeof runRelancesDeclarations> | null = null;
    let impayesResult: ReturnType<typeof runEscaladeImpayes> | null = null;

    try {
      relancesResult = runRelancesDeclarations();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[TLPE] Erreur job quotidien relances declarations', error);
    }

    try {
      impayesResult = runEscaladeImpayes();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[TLPE] Erreur job quotidien escalade impayes', error);
    }

    // eslint-disable-next-line no-console
    console.log('[TLPE] Jobs quotidiens executes', {
      relances: relancesResult,
      impayes: impayesResult,
    });

    scheduleNextDailyTick();
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
