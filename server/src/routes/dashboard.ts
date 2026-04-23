import { Router } from 'express';
import { authMiddleware } from '../auth';
import { getDashboardMetrics } from '../dashboardMetrics';

export const dashboardRouter = Router();

dashboardRouter.use(authMiddleware);

// Tableau de bord executif (section 10.1 + US3.7)
dashboardRouter.get('/', (_req, res) => {
  res.json(getDashboardMetrics());
});
