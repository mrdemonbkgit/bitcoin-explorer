import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getXpubDetails } from '../../services/addressExplorerService.js';

const router = Router();

router.get('/:xpub', asyncHandler(async (req, res) => {
  const data = await getXpubDetails(req.params.xpub);
  res.json({ data, meta: {} });
}));

export default router;
