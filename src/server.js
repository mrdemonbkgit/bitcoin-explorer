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
import { metricsEnabled, metricsHandler } from './infra/metrics.js';
import { startWebsocketGateway } from './infra/websocketGateway.js';
import {
  primeAddressIndexer,
  getAddressDetails,
  getXpubDetails
} from './services/addressExplorerService.js';
import { stopAddressIndexer } from './infra/addressIndexer.js';

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

  app.use((req, res, next) => {
    res.locals.websocket = config.websocket;
    next();
  });

  app.get(config.metrics.path, (req, res, next) => metricsHandler(req, res, next));

  nunjucks.configure(viewsPath, {
    autoescape: true,
    express: app,
    watch: false,
    noCache: true
  });

  app.set('view engine', 'njk');
  app.locals.features = config.features;
  app.locals.websocket = config.websocket;
  app.locals.address = config.address;

  if (config.address.enabled) {
    primeAddressIndexer().catch((error) => {
      const logger = getLogger();
      logger.error({ context: { event: 'addressIndexer.startup.error' }, err: error }, 'Failed to start address indexer');
    });
  }

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
    if (result.type === 'address') {
      return res.redirect(302, `/address/${result.id}`);
    }
    if (result.type === 'xpub') {
      return res.redirect(302, `/xpub/${result.id}`);
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

  if (config.features.addressExplorer) {
    app.get('/address/:address', asyncHandler(async (req, res) => {
      const page = Number(req.query.page) || 1;
      const pageSize = Number(req.query.pageSize) || 25;
      const data = await getAddressDetails(req.params.address, { page, pageSize });
      res.render('address.njk', {
        addressSummary: data.summary,
        utxos: data.utxos,
        transactions: data.transactions,
        pagination: data.pagination
      });
    }));

    app.get('/xpub/:xpub', asyncHandler(async (req, res) => {
      const details = await getXpubDetails(req.params.xpub);
      res.render('xpub.njk', { xpub: details });
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
  let stopWebsocketGateway = async () => {};

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
    if (metricsEnabled) {
      logger.info({
        context: {
          event: 'metrics.enabled',
          path: config.metrics.path
        }
      }, `Metrics endpoint available at ${config.metrics.path}`);
    }
  });

  if (config.websocket.enabled) {
    startWebsocketGateway({ httpServer: server })
      .then((stopper) => {
        stopWebsocketGateway = stopper ?? stopWebsocketGateway;
        const message = config.websocket.port
          ? `WebSocket gateway active on port ${config.websocket.port}${config.websocket.path}`
          : `WebSocket gateway active at ${config.websocket.path}`;
        logger.info({ context: { event: 'websocket.enabled', path: config.websocket.path, port: config.websocket.port ?? config.app.port } }, message);
      })
      .catch((error) => {
        logger.error({ context: { event: 'websocket.startup.error' }, err: error }, 'Failed to start WebSocket gateway');
      });
  }

  let shuttingDown = false;

  const closeHttpServer = () => new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      logger.info({ context: { event: 'server.shutdown', signal } }, 'server.shutdown');
      await closeHttpServer();
      await stopWebsocketGateway();
      if (stopZmqListener) {
        await stopZmqListener();
      } else if (zmqStartPromise) {
        const resolved = await zmqStartPromise;
        if (typeof resolved === 'function') {
          await resolved();
        }
      }
      if (config.address.enabled) {
        await stopAddressIndexer();
      }
      logger.info({ context: { event: 'server.shutdown.complete', signal } }, 'server.shutdown.complete');
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
