import { describe, expect, it } from 'vitest';
import translations from '../../src/i18n/zh-Hant.generated.json';
import simplifiedOnly from '../../src/i18n/simplified-only.generated.json';
import { copy } from '../../src/i18n/copy';

const table: Record<string, string> = translations;
describe('generated Taiwan artifacts', () => {
  it('contains no simplified-only characters and preserves every placeholder', () => {
    const characters = new Set(simplifiedOnly);
    for (const [source, translated] of Object.entries(table)) {
      expect(
        Array.from(translated).filter((character) => characters.has(character)),
        source,
      ).toEqual([]);
      const placeholders = /%@|%lld|\{\{[^{}]+\}\}|\{[^{}]+\}/g;
      expect(translated.match(placeholders), source).toEqual(source.match(placeholders));
    }
  });
  it.each([
    ['力量举', '健力'],
    ['硬拉', '硬舉'],
    ['相扑硬拉', '相撲硬舉'],
    ['训练计划', '課表'],
    ['退让组', '回退組'],
    ['减载', '減量'],
    ['视频反馈', '影片反饋'],
    ['登录', '登入'],
    ['退出登录', '登出'],
    ['账号', '帳號'],
    ['设置', '設定'],
    ['消息', '訊息'],
    ['默认', '預設'],
    ['发布', '發布'],
    ['获取', '取得'],
    ['次数', '下數'],
    ['N 次', 'N 下'],
    ['21 次法弯举', '21 下法彎舉'],
    ['EZ杆二头弯举', 'EZ槓二頭彎舉'],
    ['六角杆硬拉', '六角槓硬舉'],
    ['低杆位早安式', '低槓位早安式'],
    ['圆石过杆', '圓石過槓'],
    ['杠杆式单腿水平腿屈伸', '槓桿式單腿水平腿屈伸'],
    ['悍马多连杆卧推', '悍馬多連桿臥推'],
  ])('applies approved terminology %s', (source, translated) => {
    expect(copy('zh-Hant', source)).toBe(translated);
  });
  it('keeps input aliases and context annotations out of display overrides', () => {
    expect(table).not.toHaveProperty('滑轮下拉');
    expect(table).not.toHaveProperty('别名（规范化后简体）');
    expect(table).not.toHaveProperty('次数（reps 义）');
    expect(copy('zh-Hant', '第2次')).toBe('第2次');
    expect(copy('zh-Hant', '次日')).toBe('次日');
  });
  it('does not reinterpret placeholders or simplified words inside user content', () => {
    expect(copy('zh-Hant', '{0} 申请绑定', ['张学员{1}'])).toBe('张学员{1} 申請繫結');
  });
});
