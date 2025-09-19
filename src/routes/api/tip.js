import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getTipData } from '../../services/bitcoinService.js';

const router = Router();

router.get('/', asyncHandler(async (_req, res) => {
  const data = await getTipData();
  res.json({ data, meta: { generatedAt: new Date().toISOString() } });
}));

export default router;
