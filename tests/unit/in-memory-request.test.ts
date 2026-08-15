import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { describe, expect, it } from 'vitest';

import { createGlobalRateLimit } from '../../src/middleware/rateLimit';
import { requestId } from '../../src/middleware/requestId';
import { request } from '../helpers/inMemoryRequest';

describe('in-memory Express test request', () => {
  it('sends and receives JSON without opening a socket', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo', (req, res) => res.status(201).json(req.body));

    const response = await request(app).post('/echo').send({ ok: true });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });

  it('supports the production middleware stack', async () => {
    const app = express();
    app.set('trust proxy', 0);
    app.use(helmet({ strictTransportSecurity: false }));
    app.use(cors({ origin: true }));
    app.use(compression());
    app.use(express.json());
    app.use(requestId);
    app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
    app.use(createGlobalRateLimit({ RATE_LIMIT_WINDOW_MS: 60_000, RATE_LIMIT_MAX: 100 }));
    app.post('/echo', (req, res) => res.status(201).json(req.body));

    const response = await request(app).post('/echo').send({ ok: true });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ ok: true });
  });
});
