import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { request } from './helpers/inMemoryRequest';
import { makeContext } from './helpers/studentActions';

const planId = '90000000-0000-4000-8000-000000000001';

async function submit(name: string, props: Record<string, unknown>) {
  const ctx = await makeContext();
  const response = await request(ctx.app)
    .post('/events')
    .send({
      anon_id: randomUUID(),
      platform: 'ios',
      events: [
        {
          event_id: randomUUID(),
          session_id: randomUUID(),
          seq: 0,
          ts_client: '2026-10-26T00:00:00.000Z',
          name,
          props,
        },
      ],
    });
  expect(response.status).toBe(204);
  return ctx.db.selectFrom('events').select(['name', 'props']).execute();
}

describe('POST /events first-run contract', () => {
  it.each([
    { source: 'welcome', stage: 'clicked' },
    { source: 'pending_bind', stage: 'resolved', result: 'allowed' },
    { source: 'pending_bind', stage: 'resolved', result: 'denied' },
    { source: 'welcome', stage: 'resolved', result: 'allowed' },
    { source: 'welcome', stage: 'resolved', result: 'denied' },
  ])('accepts permission action %j', async (props) => {
    expect(await submit('notification_permission_action', props)).toEqual([
      { name: 'notification_permission_action', props },
    ]);
  });

  it.each([
    ['bind_welcome_viewed', { plan_id: planId }],
    ['bind_welcome_continue', { note: 'free text' }],
    ...['first_plan_viewed', 'first_plan_start', 'first_plan_dismiss'].flatMap((name) => [
      [name, {}],
      [name, { plan_id: 'invalid' }],
      [name, { plan_id: planId, note: 'free text' }],
    ]),
    ['notification_permission_action', { source: 'other', stage: 'clicked' }],
    ['notification_permission_action', { source: 'welcome', stage: 'other' }],
    ['notification_permission_action', { source: 'welcome', stage: 'resolved', result: 'other' }],
    ['notification_permission_action', { source: 'welcome', stage: 'clicked', note: 'free text' }],
  ] as [string, Record<string, unknown>][])(
    'drops invalid props for %s: %j',
    async (name, props) => {
      expect(await submit(name, props)).toEqual([]);
    },
  );

  it.each([
    { source: 'welcome', stage: 'clicked', result: 'allowed' },
    { source: 'pending_bind', stage: 'resolved' },
  ])('drops inconsistent permission stage/result: %j', async (props) => {
    expect(await submit('notification_permission_action', props)).toEqual([]);
  });

  it.each([
    ['bind_welcome_viewed', {}],
    ['bind_welcome_continue', {}],
    ['first_plan_viewed', { plan_id: planId }],
    ['first_plan_start', { plan_id: planId }],
    ['first_plan_dismiss', { plan_id: planId }],
    ['notification_permission_action', { source: 'pending_bind', stage: 'clicked' }],
  ] as const)('accepts %s', async (name, props) => {
    expect(await submit(name, props)).toEqual([{ name, props }]);
  });
});
