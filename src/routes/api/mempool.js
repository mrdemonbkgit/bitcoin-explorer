import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getMempoolViewModel } from '../../services/mempoolService.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const view = await getMempoolViewModel(page);
  const data = {
    updatedAt: view.snapshot.updatedAt,
    txCount: view.snapshot.txCount,
    virtualSize: view.snapshot.virtualSize,
    medianFee: view.snapshot.medianFee,
    histogram: view.snapshot.histogram,
    recent: view.snapshot.recent
  };
  res.json({ data, meta: { pagination: view.pagination } });
}));

export default router;
