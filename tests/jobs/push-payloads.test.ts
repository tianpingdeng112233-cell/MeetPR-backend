import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildPushPayload, REGISTERED_PUSH_EVENT_TYPES } from '../../src/jobs/push-payloads';

describe('push payload builders', () => {
  it('builds the coach plan_shifted contract in Chinese and English', () => {
    const studentId = randomUUID();
    const planId = randomUUID();
    const payload = {
      coach_name: 'Coach A',
      student_id: studentId,
      plan_id: planId,
      anchor_date: '2026-09-02',
      offset_days: 3,
    };

    expect(buildPushPayload('plan_shifted', payload)).toEqual({
      alert: {
        title: '教练调整了你的计划日期',
        body: 'Coach A 把 9月2日 起的训练后移了 3 天',
      },
      collapseId: planId,
      threadId: 'plan_updated',
      custom: { kind: 'plan_shifted', student_id: studentId, plan_id: planId },
    });
    expect(buildPushPayload('plan_shifted', payload, 'en')).toEqual({
      alert: {
        title: 'Your plan dates changed',
        body: 'Coach A moved your training from Sep 2 onward by 3 days',
      },
      collapseId: planId,
      threadId: 'plan_updated',
      custom: { kind: 'plan_shifted', student_id: studentId, plan_id: planId },
    });
    expect(REGISTERED_PUSH_EVENT_TYPES).toContain('plan_shifted');
  });

  it('builds the coach plan_shift_undone contract in Chinese and English', () => {
    const studentId = randomUUID();
    const planId = randomUUID();
    const payload = { coach_name: 'Coach A', student_id: studentId, plan_id: planId };

    expect(buildPushPayload('plan_shift_undone', payload)).toEqual({
      alert: {
        title: '教练撤销了上次的日期调整',
        body: 'Coach A 恢复了原来的推荐日期',
      },
      collapseId: planId,
      threadId: 'plan_updated',
      custom: { kind: 'plan_shift_undone', student_id: studentId, plan_id: planId },
    });
    expect(buildPushPayload('plan_shift_undone', payload, 'en')).toEqual({
      alert: {
        title: 'Plan date change undone',
        body: 'Coach A restored the previous dates',
      },
      collapseId: planId,
      threadId: 'plan_updated',
      custom: { kind: 'plan_shift_undone', student_id: studentId, plan_id: planId },
    });
    expect(REGISTERED_PUSH_EVENT_TYPES).toContain('plan_shift_undone');
  });

  it('builds the plan_updated contract in Chinese and English', () => {
    const studentId = randomUUID();
    const planId = randomUUID();
    const payload = { coach_name: 'Coach A', student_id: studentId, plan_id: planId };

    expect(buildPushPayload('plan_updated', payload)).toEqual({
      alert: {
        title: '教练更新了你的计划',
        body: 'Coach A 调整了你正在练的计划，打开看看',
      },
      collapseId: `plan-updated-${planId}`,
      threadId: 'plan_updated',
      custom: { kind: 'plan_updated', student_id: studentId, plan_id: planId },
    });
    expect(buildPushPayload('plan_updated', payload, 'en')).toEqual({
      alert: {
        title: 'Your plan was updated',
        body: 'Coach A adjusted your current plan',
      },
      collapseId: `plan-updated-${planId}`,
      threadId: 'plan_updated',
      custom: { kind: 'plan_updated', student_id: studentId, plan_id: planId },
    });
    expect(REGISTERED_PUSH_EVENT_TYPES).toContain('plan_updated');
  });

  it('builds the plan_published contract from the existing outbox payload', () => {
    const traineeId = randomUUID();
    const planId = randomUUID();
    const payload = { plan_id: planId, trainee_id: traineeId };

    expect(buildPushPayload('plan_published', payload)).toEqual({
      alert: {
        title: '教练发布了新计划',
        body: '新的训练周期已经准备好，打开看看',
      },
      collapseId: `plan-published-${planId}`,
      threadId: 'plan_published',
      custom: { kind: 'plan_published', student_id: traineeId, plan_id: planId },
    });
    expect(buildPushPayload('plan_published', payload, 'en')).toEqual({
      alert: {
        title: 'New plan published',
        body: 'Your next training cycle is ready',
      },
      collapseId: `plan-published-${planId}`,
      threadId: 'plan_published',
      custom: { kind: 'plan_published', student_id: traineeId, plan_id: planId },
    });
    expect(REGISTERED_PUSH_EVENT_TYPES).toContain('plan_published');
  });

  it('builds the locked six-event APNs contracts', () => {
    const studentId = randomUUID();
    const conversationId = randomUUID();
    const videoId = randomUUID();
    const requestId = randomUUID();
    const planId = randomUUID();

    expect(
      buildPushPayload('chat_message', {
        sender_name: '王晨曦',
        preview: '今天练吗？',
        conversation_id: conversationId,
        seq: 7,
      }),
    ).toEqual({
      alert: { title: '王晨曦', body: '今天练吗？' },
      collapseId: `conv-${conversationId}`,
      threadId: 'chat_message',
      custom: { kind: 'chat_message', conversation_id: conversationId, seq: 7 },
    });
    expect(
      buildPushPayload('missed_training', {
        student_name: '钱骁',
        consecutive_days: 3,
        student_id: studentId,
      }),
    ).toMatchObject({
      alert: { title: '学员缺练提醒', body: '钱骁已 3 天未训练' },
      custom: { kind: 'missed_training', student_id: studentId },
    });
    expect(
      buildPushPayload('pr_congrats', {
        student_name: '小李',
        lift_name: '深蹲',
        increase_kg: 2.5,
        student_id: studentId,
      }),
    ).toMatchObject({
      alert: { title: '破 PR 🎉', body: '小李 深蹲 实测重量新高 ↑2.5kg' },
      custom: { kind: 'pr_congrats', student_id: studentId },
    });
    expect(
      buildPushPayload('video_pending', {
        student_name: '王晨曦',
        exercise_name: '比赛式深蹲',
        student_id: studentId,
        video_id: videoId,
      }),
    ).toMatchObject({
      alert: { title: '新视频待反馈', body: '王晨曦上传了 比赛式深蹲 视频' },
      collapseId: `vid-${studentId}`,
      custom: { kind: 'video_pending', student_id: studentId, video_id: videoId },
    });
    expect(
      buildPushPayload('bind_request', { student_name: '陈某', request_id: requestId }),
    ).toMatchObject({
      alert: { title: '新学员申请', body: '陈某 申请绑定' },
      custom: { kind: 'bind_request', request_id: requestId },
    });
    expect(
      buildPushPayload('plan_shift', {
        student_name: '小张',
        shift_days: 2,
        student_id: studentId,
        plan_id: planId,
      }),
    ).toMatchObject({
      alert: { title: '学员顺延了计划', body: '小张 将本周期顺延 2 天' },
      collapseId: `shift-${planId}`,
      custom: { kind: 'plan_shift', student_id: studentId, plan_id: planId },
    });
  });

  it('renders English copy for global recipients', () => {
    const studentId = randomUUID();
    const videoId = randomUUID();
    const requestId = randomUUID();
    const planId = randomUUID();

    expect(
      buildPushPayload(
        'missed_training',
        { student_name: 'Alex', consecutive_days: 1, student_id: studentId },
        'en',
      ).alert,
    ).toEqual({ title: 'Missed training', body: "Alex hasn't trained for 1 day" });

    // Chinese lift/exercise names from the CN catalog never leak into English
    // bodies — the copy degrades to neutral wording instead.
    expect(
      buildPushPayload(
        'pr_congrats',
        { student_name: 'Alex', lift_name: '深蹲', increase_kg: 2.5, student_id: studentId },
        'en',
      ).alert.body,
    ).toBe('Alex hit a new weight PR ↑2.5kg');
    expect(
      buildPushPayload(
        'pr_congrats',
        { student_name: 'Alex', lift_name: 'Squat', increase_kg: 2.5, student_id: studentId },
        'en',
      ).alert.body,
    ).toBe('Alex hit a new Squat weight PR ↑2.5kg');

    expect(
      buildPushPayload(
        'video_pending',
        {
          student_name: 'Alex',
          exercise_name: '比赛式深蹲',
          student_id: studentId,
          video_id: videoId,
        },
        'en',
      ).alert,
    ).toEqual({ title: 'New video to review', body: 'Alex uploaded a training video' });

    expect(
      buildPushPayload('bind_request', { student_name: 'Alex', request_id: requestId }, 'en').alert,
    ).toEqual({ title: 'New student request', body: 'Alex requested to link' });

    expect(
      buildPushPayload(
        'plan_shift',
        { student_name: 'Alex', shift_days: 2, student_id: studentId, plan_id: planId },
        'en',
      ).alert,
    ).toEqual({ title: 'Plan shifted', body: 'Alex shifted this cycle by 2 days' });
  });
});
