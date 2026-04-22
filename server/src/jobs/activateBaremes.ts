import { activateBaremesForYear } from '../baremes';

const rawYear = process.env.TLPE_BAREME_YEAR;
const fallbackYear = new Date().getUTCFullYear();
const targetYear = rawYear ? Number(rawYear) : fallbackYear;

if (!Number.isInteger(targetYear) || targetYear < 2008 || targetYear > 2100) {
  // eslint-disable-next-line no-console
  console.error(`[TLPE] TLPE_BAREME_YEAR invalide: ${rawYear}`);
  process.exit(1);
}

const activated = activateBaremesForYear(targetYear);

if (activated) {
  // eslint-disable-next-line no-console
  console.log(`[TLPE] Baremes ${targetYear} actives`);
} else {
  // eslint-disable-next-line no-console
  console.log(`[TLPE] Aucune activation necessaire pour ${targetYear}`);
}
