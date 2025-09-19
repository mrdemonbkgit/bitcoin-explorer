import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getAddressDetails } from '../../services/addressExplorerService.js';

const router = Router();

router.get('/:address', asyncHandler(async (req, res) => {
  const page = Number(req.query.page) || 1;
  const pageSize = Number(req.query.pageSize) || 25;
  const data = await getAddressDetails(req.params.address, { page, pageSize });
  res.json({
    data,
    meta: {
      pagination: data.pagination
    }
  });
}));

export default router;
