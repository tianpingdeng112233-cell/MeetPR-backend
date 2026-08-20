import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildPushPayload } from '../../src/jobs/push-payloads';

describe('push payload builders', () => {
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
