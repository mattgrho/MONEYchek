import express, { type Express } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pinoHttp } from 'pino-http';
import { getEnv } from './config/env';
import { logger } from './lib/logger';
import { requestContext } from './middleware/context';
import { errorHandler } from './middleware/error-handler';
import { AppError } from './lib/errors';
import { healthRouter } from './routes/health';
import { publicRouter } from './routes/public';
import { buildApiRouter } from './routes/index';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function createApp(): Promise<Express> {
  const env = getEnv();
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy:
        env.NODE_ENV === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", 'https://*.clerk.accounts.dev'],
                connectSrc: ["'self'", 'https://*.clerk.accounts.dev'],
                imgSrc: ["'self'", 'data:', 'https://img.clerk.com'],
                styleSrc: ["'self'", "'unsafe-inline'"],
                frameSrc: ["'self'", 'https://*.clerk.accounts.dev'],
                workerSrc: ["'self'", 'blob:'],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
              },
            }
          : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        ignore: (req) => req.url?.startsWith('/health/') === true,
      },
      customProps: (req) => ({ correlationId: (req as express.Request).correlationId }),
      serializers: {
        req(req: { method: string; url: string }) {
          return { method: req.method, url: req.url };
        },
        res(res: { statusCode: number }) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  app.use(healthRouter);
  app.use('/api/public', publicRouter);
  app.use('/api/v1', buildApiRouter());

  // Unknown API path: JSON 404 (never the SPA shell).
  app.use('/api', (_req, _res, next) => next(AppError.notFound('Unknown API endpoint')));

  if (env.NODE_ENV === 'production') {
    const clientDir = path.join(rootDir, 'dist/client');
    const indexHtml = path.join(clientDir, 'index.html');
    app.use(
      express.static(clientDir, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-store, private');
          }
        },
      }),
    );
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-store, private');
      res.sendFile(indexHtml);
    });
  } else if (env.NODE_ENV === 'development') {
    // Vite middleware mode: one public port, no separate dev server.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      configFile: path.join(rootDir, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.get('*', async (req, res, next) => {
      try {
        const template = fs.readFileSync(path.join(rootDir, 'client/index.html'), 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).setHeader('Content-Type', 'text/html').end(html);
      } catch (err) {
        next(err);
      }
    });
  }
  // NODE_ENV=test: API only; supertest drives requests directly.

  app.use(errorHandler);
  return app;
}
