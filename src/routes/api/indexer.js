import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getIndexerStatus } from '../../services/addressExplorerService.js';

const router = Router();

router.get('/status', asyncHandler(async (_req, res) => {
  const data = await getIndexerStatus({ refreshTip: true });
  res.json({
    data,
    meta: {
      generatedAt: new Date().toISOString()
    }
  });
}));

export default router;
