import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getTransactionData } from '../../services/bitcoinService.js';

const router = Router();

router.get('/:txid', asyncHandler(async (req, res) => {
  const { txid } = req.params;
  const data = await getTransactionData(txid);
  res.json({ data, meta: {} });
}));

export default router;
