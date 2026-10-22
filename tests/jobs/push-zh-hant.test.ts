import { describe, expect, it } from 'vitest';
import { buildPushPayload, type RegisteredPushEventType } from '../../src/jobs/push-payloads';

const id = '10000000-0000-4000-8000-000000000001';
const cases: [RegisteredPushEventType, object, string, string][] = [
  [
    'chat_message',
    { sender_name: '张教练', preview: '视频看过了', conversation_id: id, seq: 1 },
    '张教练',
    '视频看过了',
  ],
  [
    'missed_training',
    { student_name: '张同学', consecutive_days: 2, student_id: id },
    '學員缺練提醒',
    '张同学已 2 天未訓練',
  ],
  [
    'pr_congrats',
    { student_name: '张同学', lift_name: '硬拉', increase_kg: 2.5, student_id: id },
    '破 PR 🎉',
    '张同学 硬舉 實測重量新高 ↑2.5kg',
  ],
  [
    'video_pending',
    {
      student_name: '张同学',
      exercise_name: '杠铃卧推',
      exercise_is_custom: false,
      student_id: id,
      video_id: id,
    },
    '新影片待反饋',
    '张同学上傳了 槓鈴臥推 影片',
  ],
  ['bind_request', { student_name: '张同学', request_id: id }, '新學員申請', '张同学 申請繫結'],
  [
    'plan_shift',
    { student_name: '张同学', shift_days: 2, student_id: id, plan_id: id },
    '學員順延了課表',
    '张同学 將本週期順延 2 天',
  ],
  [
    'plan_updated',
    { coach_name: '张教练', student_id: id, plan_id: id },
    '教練更新了你的課表',
    '张教练 調整了你正在練的課表，開啟看看',
  ],
  [
    'plan_shifted',
    {
      coach_name: '张教练',
      student_id: id,
      plan_id: id,
      anchor_date: '2026-10-22',
      offset_days: 2,
    },
    '教練調整了你的課表日期',
    '张教练 把 10月22日 起的訓練後移了 2 天',
  ],
  [
    'plan_shift_undone',
    { coach_name: '张教练', student_id: id, plan_id: id },
    '教練復原了上次的日期調整',
    '张教练 恢復了原來的推薦日期',
  ],
  [
    'plan_published',
    { trainee_id: id, plan_id: id },
    '教練發布了新課表',
    '新的訓練週期已經準備好，開啟看看',
  ],
  [
    'coach_daily_digest',
    {
      aps: { alert: { title: '昨日训练摘要', body: '昨天：1 练完 · 2 缺练' } },
      counts: { session_completed: 1, missed_training: 2 },
      gym_day: '2026-10-22',
    },
    '昨日訓練摘要',
    '昨天：1 練完 · 2 缺練',
  ],
];

describe('all push locales', () => {
  it.each([
    ['[图片]', '[圖片]'],
    ['[训练组]', '[訓練組]'],
  ])('localizes only the system chat preview %s', (preview, expected) => {
    const payload = { sender_name: 'Alex', preview, conversation_id: id, seq: 1 };
    expect(buildPushPayload('chat_message', payload, 'zh-Hant').alert.body).toBe(preview);
    expect(
      buildPushPayload('chat_message', { ...payload, preview_is_system: true }, 'zh-Hant').alert
        .body,
    ).toBe(expected);
  });
  it('translates a system fallback sender without changing an identical real nickname', () => {
    const payload = { sender_name: '教练', preview: '视频看过了', conversation_id: id, seq: 1 };
    expect(buildPushPayload('chat_message', payload, 'zh-Hant').alert.title).toBe('教练');
    expect(
      buildPushPayload('chat_message', { ...payload, display_name_is_fallback: true }, 'zh-Hant')
        .alert,
    ).toEqual({ title: '教練', body: '视频看过了' });
    expect(
      buildPushPayload('chat_message', { ...payload, display_name_is_fallback: true }, 'zh').alert
        .title,
    ).toBe('教练');
    expect(
      buildPushPayload('chat_message', { ...payload, display_name_is_fallback: true }, 'en').alert
        .title,
    ).toBe('教练');
  });
  it('keeps a coach-created name even when it equals a catalog name', () => {
    const result = buildPushPayload(
      'video_pending',
      {
        student_name: '张同学',
        exercise_name: '杠铃卧推',
        exercise_is_custom: true,
        student_id: id,
        video_id: id,
      },
      'zh-Hant',
    );
    expect(result.alert.body).toBe('张同学上傳了 杠铃卧推 影片');
  });
  it.each(cases)('%s preserves existing Chinese and English payloads', (event, payload) => {
    expect([
      buildPushPayload(event, payload, 'zh'),
      buildPushPayload(event, payload, 'en'),
    ]).toMatchSnapshot();
  });
  it.each(cases)(
    '%s translates product copy while preserving user input',
    (event, payload, title, body) => {
      expect(buildPushPayload(event, payload, 'zh-Hant').alert).toEqual({ title, body });
    },
  );
});
