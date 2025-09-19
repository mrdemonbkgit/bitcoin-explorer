import { Router } from 'express';
import tipRouter from './tip.js';
import blockRouter from './block.js';
import txRouter from './tx.js';
import mempoolRouter from './mempool.js';
import addressRouter from './address.js';
import xpubRouter from './xpub.js';

const apiRouter = Router();

apiRouter.use('/tip', tipRouter);
apiRouter.use('/block', blockRouter);
apiRouter.use('/tx', txRouter);
apiRouter.use('/mempool', mempoolRouter);
apiRouter.use('/address', addressRouter);
apiRouter.use('/xpub', xpubRouter);

export default apiRouter;
