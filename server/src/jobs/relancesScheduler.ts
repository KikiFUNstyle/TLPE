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
    try {
      const result = runRelancesDeclarations();
      // eslint-disable-next-line no-console
      console.log('[TLPE] Relances quotidiennes executees', result);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[TLPE] Erreur job relances quotidiennes', error);
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
