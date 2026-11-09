import { describe, expect, it } from 'vitest';
import { moderateCoachReview } from '../src/services/coach-reviews/moderation';

describe('coach review automatic moderation (B6)', () => {
  it.each([
    ['联系我 13812345678', 'phone'],
    ['欢迎加 wx: abc123', 'wechat'],
    ['欢迎加 QQ 12345678', 'qq'],
    ['训练反馈及时，微信号：abc123', 'wechat'],
    ['训练反馈及时，QQ号：12345678', 'qq'],
    ['详情 https://example.com', 'link'],
    ['这是测试辱骂词', 'blocked_word'],
    ['计划安排合理，反馈及时认真。', null],
  ])('returns the reason for %s', (body, reason) => {
    expect(moderateCoachReview(body, ['测试辱骂词'])).toEqual(reason);
  });
});
