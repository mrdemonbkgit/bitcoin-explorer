import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getBlockData } from '../../services/bitcoinService.js';

const router = Router();

router.get('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const page = Number(req.query.page) || 1;
  const data = await getBlockData(id, page);
  res.json({ data, meta: {} });
}));

export default router;
