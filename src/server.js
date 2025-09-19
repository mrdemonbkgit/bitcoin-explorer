import express from 'express';
import nunjucks from 'nunjucks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { AppError, NotFoundError } from './errors.js';
import {
  getTipSummary,
  getBlockViewModel,
  getTransactionViewModel,
  resolveSearchQuery
} from './services/bitcoinService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const viewsPath = path.join(__dirname, '..', 'views');

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false }));

  nunjucks.configure(viewsPath, {
    autoescape: true,
    express: app,
    watch: false,
    noCache: true
  });

  app.set('view engine', 'njk');

  app.get('/', asyncHandler(async (req, res) => {
    const summary = await getTipSummary();
    res.render('home.njk', { summary });
  }));

  app.get('/block/:id', asyncHandler(async (req, res) => {
    const page = Number(req.query.page) || 1;
    const block = await getBlockViewModel(req.params.id, page);
    res.render('block.njk', { block });
  }));

  app.get('/tx/:txid', asyncHandler(async (req, res) => {
    const tx = await getTransactionViewModel(req.params.txid);
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

  app.use((req, res, next) => {
    next(new NotFoundError('Page not found'));
  });

  app.use((error, req, res, _next) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    if (status === 500) {
      console.error(error);
    }

    res.status(status);
    res.render('error.njk', {
      status,
      message: error.message || 'Unexpected error'
    });
  });

  return app;
}

function startServer() {
  const app = createApp();
  app.listen(config.app.port, config.app.bind, () => {
    console.log(`Explorer listening on ${config.app.bind}:${config.app.port}`);
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startServer();
}
