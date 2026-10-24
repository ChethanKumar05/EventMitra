import path from 'node:path';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import { env } from './config/env';
import apiRouter from './routes';
import { errorHandler, notFound } from './middleware/errorHandler';
import { success } from './utils/response';

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.corsOrigins.includes('*') ? '*' : env.corsOrigins }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => success(res, 'eventmitra server working', { service: 'eventmitra-api' }));
app.get('/api/user/health', (_req, res) => success(res, 'healthy', { service: 'user-service' }));
app.use('/api', apiRouter);
app.use('/admin', express.static(path.resolve(process.cwd(), 'public')));
app.use(notFound);
app.use(errorHandler);
