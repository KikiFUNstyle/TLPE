import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { initSchema } from './db';
import { authRouter } from './routes/auth';
import { assujettisRouter } from './routes/assujettis';
import { dispositifsRouter } from './routes/dispositifs';
import { referentielsRouter } from './routes/referentiels';
import { declarationsRouter } from './routes/declarations';
import { titresRouter } from './routes/titres';
import { dashboardRouter } from './routes/dashboard';
import { simulateurRouter } from './routes/simulateur';
import { contentieuxRouter } from './routes/contentieux';
import { geocodingRouter } from './routes/geocoding';
import { piecesJointesRouter } from './routes/piecesJointes';
import { campagnesRouter } from './routes/campagnes';
import { paiementsRouter } from './routes/paiements';
import { sepaRouter } from './routes/sepa';
import { startRelancesScheduler } from './jobs/relancesScheduler';
import { rapprochementRouter } from './routes/rapprochement';
import { controlesRouter } from './routes/controles';
import { rapportsRouter } from './routes/rapports';
import { exportsPersonnalisesRouter } from './routes/exportsPersonnalises';

const PORT = Number(process.env.PORT || 4000);

initSchema();

// Seed auto si base vide (pour simplifier le demarrage en dev)
import { db } from './db';
const userCount = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
if (userCount === 0) {
  // eslint-disable-next-line no-console
  console.log('[TLPE] Base vide, seed en cours...');
  require('./seed');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'TLPE Manager', version: '1.0.0' });
});

app.use('/api/auth', authRouter);
app.use('/api/assujettis', assujettisRouter);
app.use('/api/dispositifs', dispositifsRouter);
app.use('/api/referentiels', referentielsRouter);
app.use('/api/declarations', declarationsRouter);
app.use('/api/titres', titresRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/simulateur', simulateurRouter);
app.use('/api/contentieux', contentieuxRouter);
app.use('/api/geocoding', geocodingRouter);
app.use('/api/pieces-jointes', piecesJointesRouter);
app.use('/api/campagnes', campagnesRouter);
app.use('/api/paiements', paiementsRouter);
app.use('/api/sepa', sepaRouter);
app.use('/api/rapprochement', rapprochementRouter);
app.use('/api/controles', controlesRouter);
app.use('/api/rapports', rapportsRouter);
app.use('/api/exports-personnalises', exportsPersonnalisesRouter);

// Fichiers statiques du front en prod
const clientDist = path.resolve(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error('[TLPE] Erreur non geree', err);
  res.status(500).json({ error: 'Erreur interne' });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[TLPE] API en ecoute sur http://localhost:${PORT}`);
  startRelancesScheduler();
});
