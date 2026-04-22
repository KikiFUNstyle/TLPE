import { activateBaremesForYear } from '../baremes';

const TARGET_YEAR = Number(process.env.TLPE_BAREME_YEAR || new Date().getUTCFullYear());

const activated = activateBaremesForYear(TARGET_YEAR);

if (activated) {
  // eslint-disable-next-line no-console
  console.log(`[TLPE] Baremes ${TARGET_YEAR} actives`);
} else {
  // eslint-disable-next-line no-console
  console.log(`[TLPE] Aucune activation necessaire pour ${TARGET_YEAR}`);
}
