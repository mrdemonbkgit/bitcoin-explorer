import express from 'express';
import nunjucks from 'nunjucks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { AppError, NotFoundError } from './errors.js';
import { requestLogger } from './middleware/requestLogger.js';
import { getLogger } from './infra/logger.js';
import { startZmqListener } from './infra/zmqListener.js';
import {
  getTipData,
  getBlockData,
  getTransactionData,
  resolveSearchQuery
} from './services/bitcoinService.js';
import apiRouter from './routes/api/index.js';
import { asyncHandler } from './utils/asyncHandler.js';
import { getMempoolViewModel } from './services/mempoolService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewsPath = path.join(__dirname, '..', 'views');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false }));
  app.use(requestLogger());
  app.use((req, _res, next) => {
    req.isApiRequest = () => (req.path?.startsWith('/api/') || req.headers.accept?.includes('application/json'));
    next();
  });

  nunjucks.configure(viewsPath, {
    autoescape: true,
    express: app,
    watch: false,
    noCache: true
  });

  app.set('view engine', 'njk');
  app.locals.features = config.features;

  app.get('/', asyncHandler(async (req, res) => {
    const summary = await getTipData();
    res.render('home.njk', { summary });
  }));

  app.get('/block/:id', asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const blockData = await getBlockData(req.params.id, page);
    const block = {
      hash: blockData.hash,
      height: blockData.height,
      time: blockData.timestamp,
      timestamp: blockData.timestamp ? new Date(blockData.timestamp * 1000).toISOString() : null,
      size: blockData.size,
      weight: blockData.weight,
      version: blockData.version,
      bits: blockData.bits,
      difficulty: blockData.difficulty,
      previousblockhash: blockData.previousBlockHash,
      nextblockhash: blockData.nextBlockHash,
      txCount: blockData.txCount,
      txids: blockData.txids,
      page: blockData.pagination.page,
      totalPages: blockData.pagination.totalPages,
      pageSize: blockData.pagination.pageSize
    };

    res.render('block.njk', { block });
  }));

  app.get('/tx/:txid', asyncHandler(async (req, res) => {
    const tx = await getTransactionData(req.params.txid);
    res.render('tx.njk', { tx });
  }));

  app.get('/search', asyncHandler(async (req, res) => {
    const result = await resolveSearchQuery(req.query.q ?? '');
    if (result.type === 'block') {
      return res.redirect(302, `/block/${result.id}`);
    }
    if (result.type === 'tx') {
      return res.redirect(302, `/tx/${result.id}`);
    }
    throw new NotFoundError('No matching resource');
  }));

  if (config.features.mempoolDashboard) {
    app.get('/mempool', asyncHandler(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const mempool = await getMempoolViewModel(page);
      res.render('mempool.njk', { mempool });
    }));
  }

  app.use('/api/v1', apiRouter);

  app.use((req, res, next) => {
    next(new NotFoundError('Page not found'));
  });

  app.use((error, req, res, _next) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const logger = req?.log ?? getLogger();

    const logContext = {
      status,
      requestId: res.locals?.requestId,
      route: req.originalUrl || req.url,
      method: req.method
    };

    if (status >= 500) {
      logger.error({
        context: {
          ...logContext,
          event: 'request.exception'
        },
        err: error
      }, 'request.exception');
    } else {
      logger.warn({
        context: {
          ...logContext,
          event: 'request.error'
        },
        err: error
      }, 'request.error');
    }

    res.status(status);

    if (typeof req.isApiRequest === 'function' && req.isApiRequest()) {
      res.json({
        error: {
          code: status,
          type: error.name || 'Error',
          message: error.message || 'Unexpected error'
        },
        meta: {}
      });
      return;
    }

    res.render('error.njk', {
      status,
      message: error.message || 'Unexpected error'
    });
  });

  return app;
}

function startServer() {
  const app = createApp();
  const logger = getLogger();
  let stopZmqListener = async () => {};
  let zmqStartPromise = null;

  if (config.zmq.blockEndpoint || config.zmq.txEndpoint) {
    zmqStartPromise = startZmqListener({
      blockEndpoint: config.zmq.blockEndpoint,
      txEndpoint: config.zmq.txEndpoint
    })
      .then((stop) => {
        stopZmqListener = stop ?? stopZmqListener;
        return stop;
      })
      .catch((error) => {
        logger.error({
          context: {
            zmq: {
              event: 'startup.error',
              blockEndpoint: config.zmq.blockEndpoint,
              txEndpoint: config.zmq.txEndpoint
            }
          },
          err: error
        }, 'zmq.startup.error');
        return null;
      });
  }

  const server = app.listen(config.app.port, config.app.bind, () => {
    logger.info({
      context: {
        event: 'server.start',
        bind: config.app.bind,
        port: config.app.port
      }
    }, `Explorer listening on ${config.app.bind}:${config.app.port}`);
  });

  const shutdown = async (signal) => {
    try {
      logger.info({ context: { event: 'server.shutdown', signal } }, 'server.shutdown');
      server.close();
      if (!stopZmqListener && zmqStartPromise) {
        const resolved = await zmqStartPromise;
        if (typeof resolved === 'function') {
          await resolved();
        }
      } else if (stopZmqListener) {
        await stopZmqListener();
      }
    } catch (error) {
      logger.error({ context: { event: 'server.shutdown.error' }, err: error }, 'server.shutdown.error');
    } finally {
      process.exitCode = 0;
    }
  };

  ['SIGINT', 'SIGTERM'].forEach((signal) => {
    process.once(signal, () => {
      shutdown(signal);
    });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer();
}
