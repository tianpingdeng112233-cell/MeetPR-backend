import { Router, type Router as ExpressRouter } from 'express';
import type { Insertable, Kysely } from 'kysely';

import type { Config } from '../../config';
import type { Database, EventsTable } from '../../db/types';
import { insertEvents, insertFeedback } from '../../handlers/events-insert';
import type { Logger } from '../../logger';
import { createEventsRateLimit } from '../../middleware/rateLimit';
import { route, validationEnvelope } from '../http';
import { EventsBatchSchema, EventSchema, FeedbackSchema } from './schemas';

interface EventsRouterDeps {
  db: Kysely<Database>;
  logger: Logger;
  config: Config;
}

const MAX_BATCH = 50;

/** Strip client-supplied user_id/role BEFORE validation (SPEC §3.4 strip→strict→
 * server-set): we ignore the client value, we do not 4xx it. */
function stripIdentity(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const { user_id: _userId, role: _role, ...rest } = raw as Record<string, unknown>;
  return rest;
}

function nameOf(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return (raw as { name?: unknown }).name;
}

export function eventsRouter(deps: EventsRouterDeps): ExpressRouter {
  const router = Router();
  // SPEC §3.7: /events and /events/feedback each mount their OWN limiter instance
  // (separate per-anon_id buckets), so an ingest burst can't exhaust the feedback
  // budget or vice versa. Both are fail-open, so neither ever 429s a user.
  const ingestLimiter = createEventsRateLimit(deps.config);
  const feedbackLimiter = createEventsRateLimit(deps.config);

  // Remote kill-switch + sample rate. optional-auth read; iOS reads once at
  // app_open. enabled=false stops the client from sending, no app update needed.
  // Synchronous (no DB) — a plain handler, not the async route() wrapper.
  router.get('/config', (_req, res) => {
    res.status(200).json({
      enabled: deps.config.ANALYTICS_ENABLED,
      sample_rate: deps.config.ANALYTICS_SAMPLE_RATE,
    });
  });

  router.post(
    '/',
    ingestLimiter,
    route(async (req, res) => {
      const envelope = EventsBatchSchema.safeParse(req.body);
      if (!envelope.success) {
        res.status(400).json(validationEnvelope(envelope.error));
        return;
      }
      const { anon_id, app_version, build, platform, events } = envelope.data;

      if (events.length === 0) {
        res.status(400).json({ error: 'EVENTS_EMPTY_BATCH' });
        return;
      }
      if (events.length > MAX_BATCH) {
        res.status(400).json({ error: 'EVENTS_BATCH_TOO_LARGE' });
        return;
      }

      // Server identity — never trusted from the body. Logged-in → derive from
      // the JWT; anon (pre-login funnel) → NULL, not rejected.
      const userId = req.user?.id ?? null;
      const role = req.user?.role ?? null;

      const rows: Insertable<EventsTable>[] = [];
      for (let i = 0; i < events.length; i++) {
        const raw = events[i];
        const parsed = EventSchema.safeParse(stripIdentity(raw));
        if (!parsed.success) {
          // partial-accept: skip the bad event, never poison the batch (SPEC §3.5).
          deps.logger.warn(
            { event_index: i, name: nameOf(raw), issues: parsed.error.issues },
            'events_ingest_skip',
          );
          continue;
        }
        const e = parsed.data;
        rows.push({
          event_id: e.event_id,
          anon_id,
          user_id: userId,
          role,
          session_id: e.session_id,
          seq: e.seq,
          name: e.name,
          props: JSON.stringify(e.props),
          schema_version: e.schema_version,
          app_version: app_version ?? null,
          build: build ?? null,
          platform,
          ts_client: new Date(e.ts_client),
        });
      }

      const accepted = rows.length;
      if (accepted > 0) {
        // await-insert-then-respond: a DB failure throws → 5xx, client retries.
        await insertEvents(deps.db, rows);
      }
      // The one heartbeat for a fail-silent client + a silent pipeline break.
      deps.logger.info(
        {
          received: events.length,
          accepted,
          skipped: events.length - accepted,
          has_user: userId !== null,
        },
        'events_ingest',
      );
      res.status(204).end();
    }),
  );

  router.post(
    '/feedback',
    feedbackLimiter,
    route(async (req, res) => {
      const parsed = FeedbackSchema.safeParse(stripIdentity(req.body));
      if (!parsed.success) {
        res.status(400).json(validationEnvelope(parsed.error));
        return;
      }
      const f = parsed.data;
      const userId = req.user?.id ?? null;

      await insertFeedback(deps.db, {
        event_id: f.event_id,
        anon_id: f.anon_id,
        user_id: userId,
        session_id: f.session_id,
        flow: f.flow,
        from_screen: f.from_screen,
        trigger: f.trigger,
        text: f.text,
        app_version: f.app_version ?? null,
        build: f.build ?? null,
        ts_client: new Date(f.ts_client),
      });
      res.status(204).end();
    }),
  );

  return router;
}
