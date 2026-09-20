import { describe, it, expect } from 'vitest';
import {
  fmtSize, fmtDur, fmtRec, groupItems, gkey, sigOf,
  mergeGroupsNow, buildDecisions, commitSummary, lutLabel,
} from '../../web/src/lib/inbox.ts';

describe('fmtSize / fmtDur', () => {
  it('fmtSize: GB/MB 分档，空值 ?', () => {
    expect(fmtSize(null)).toBe('?');
    expect(fmtSize(1.5 * 1073741824)).toBe('1.50 GB');
    expect(fmtSize(300 * 1048576)).toBe('0.29 GB'); // ≥0.1GB 即走 GB 档
    expect(fmtSize(50 * 1048576)).toBe('50.0 MB');
  });
  it('fmtDur: 分′秒″', () => {
    expect(fmtDur(null)).toBe('?');
    expect(fmtDur(65)).toBe(`1'05"`);
    expect(fmtDur(9.6)).toBe(`0'10"`);
  });
});

describe('fmtRec: 拍摄时间人类化（上午/下午/晚上 + 星期）', () => {
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const wd = (y: number, m: number, d: number) => WEEK[new Date(y, m - 1, d).getDay()];
  it('常规：月日 周几 时段+12 小时制', () => {
    expect(fmtRec('2026-08-09 16:53:24')).toBe(`8月9日 周${wd(2026, 8, 9)} 下午4:53`);
    expect(fmtRec('2026-08-09 08:05:00')).toBe(`8月9日 周${wd(2026, 8, 9)} 上午8:05`);
    expect(fmtRec('2026-08-09 20:30:00')).toBe(`8月9日 周${wd(2026, 8, 9)} 晚上8:30`);
    expect(fmtRec('2026-08-09 12:00:00')).toContain('下午12:00'); // 中午算下午
  });
  it('跨年补年份前缀；解析不出返回 null', () => {
    const otherYear = new Date().getFullYear() === 2025 ? '2026' : '2025';
    expect(fmtRec(`${otherYear}-01-05 08:05:00`)).toContain(`${otherYear}年1月5日`);
    expect(fmtRec('garbage')).toBeNull();
    expect(fmtRec(null)).toBeNull();
  });
});

// mock /api/inbox 清单项 JSON：字段随用例覆盖
const item = (id: string, over: Record<string, any> = {}) => ({
  id,
  src: `/Volumes/CAM/DCIM/DJI_20260830085039_000${id}_D.MP4`,
  recorded_at: '2026-08-30 08:50:39',
  seq: Number(id),
  probe: { duration: 100 },
  size: 1000,
  status: 'pending',
  ingest: { state: 'on_card', percent: 0 },
  src_exists: true,
  ...over,
});

describe('groupItems: 同次录制切段分组（seq 相邻 + 间隙 <30s），最新录制在前', () => {
  const rec = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  it('相邻 seq 小间隙同组；组内按时间升序', () => {
    const t0 = Date.parse('2026-08-30T00:50:39Z');
    const a = item('2', { recorded_at: rec(t0) });
    const b = item('3', { recorded_at: rec(t0 + 102_000) });
    const c = item('4', { recorded_at: rec(t0 + 205_000) });
    const groups = groupItems([c, b, a]);
    expect(groups.length).toBe(1);
    expect(groups[0].map((i) => i.id)).toEqual(['2', '3', '4']);
  });
  it('seq 跳号或间隙过大 → 拆组；不同录制新的在前', () => {
    const t0 = Date.parse('2026-08-30T00:50:39Z');
    const a = item('2', { recorded_at: rec(t0) });
    const b = item('4', { recorded_at: rec(t0 + 102_000) }); // 跳号
    const c = item('7', { recorded_at: rec(t0 + 86_400_000) }); // 第二天
    const groups = groupItems([a, b, c]);
    expect(groups.length).toBe(3);
    expect(groups[0][0].id).toBe('7'); // 最新在前
  });
  it('无 seq/无时间信息的各自成组不报错', () => {
    const x = item('9', { seq: null, recorded_at: null, probe: null });
    expect(groupItems([x]).length).toBe(1);
  });
});

it('gkey: 成员 id 排序拼接，与顺序无关', () => {
  expect(gkey([{ id: 'b' }, { id: 'a' }])).toBe('a+b');
});

describe('sigOf: 轮询变更指纹', () => {
  it('状态/进度档位变化会改指纹；无变化保持稳定', () => {
    const items = [item('2')];
    const jobs = [{ id: 'j1', state: 'rendering', progress: { percent: 41 } }];
    const s1 = sigOf(items, jobs);
    expect(sigOf(items, jobs)).toBe(s1);
    expect(sigOf(items, [{ id: 'j1', state: 'rendering', progress: { percent: 46 } }])).not.toBe(s1);
    expect(sigOf([item('2', { ingest: { state: 'copying', percent: 10 } })], jobs)).not.toBe(s1);
  });
});

describe('mergeGroupsNow / buildDecisions / commitSummary', () => {
  const selVal = (over = {}) => ({ checked: true, skin: 'topline', lut: '', fit: '/fits/a.fit', memberIds: ['1', '2'], ...over });
  it('mergeGroupsNow: 勾选且同 FIT（≥2 段）计入；未勾选/无 FIT 不计', () => {
    const groups = mergeGroupsNow([
      selVal(),                                                  // a.fit × 2 段
      selVal({ memberIds: ['3', '4', '5'] }),                    // a.fit 再 × 3 段 → 同 key 累加
      selVal({ checked: false }),                                // 未勾选
      selVal({ fit: 'none' }),                                   // 无 FIT
      selVal({ fit: '/fits/b.fit', memberIds: ['9'] }),          // 单段组不参与合并提示
    ]);
    expect(groups.get('/fits/a.fit|topline|')).toBe(5);
    expect(groups.has('/fits/b.fit|topline|')).toBe(false);
  });
  it('buildDecisions: process 展开成员；skip 只有 id+action；lut 空串归 null', () => {
    const d = buildDecisions([selVal(), selVal({ checked: false })], 'process');
    expect(d.length).toBe(2);
    expect(d[0]).toEqual({ id: '1', action: 'process', skin: 'topline', lut: null, fit: '/fits/a.fit' });
    const sk = buildDecisions([selVal()], 'skip');
    expect(sk).toEqual([{ id: '1', action: 'skip' }, { id: '2', action: 'skip' }]);
  });
  it('buildDecisions: 音量/快剪覆盖随决策带出；音量默认档（空串）省略该键', () => {
    const d = buildDecisions([selVal({ volume: '0.5', quickcut: true, memberIds: ['7'] })], 'process');
    expect(d[0]).toEqual({ id: '7', action: 'process', skin: 'topline', lut: null, fit: '/fits/a.fit', audio_volume: 0.5, quickcut: true });
    const def = buildDecisions([selVal({ volume: '', quickcut: false, memberIds: ['8'] })], 'process');
    expect(def[0]).toEqual({ id: '8', action: 'process', skin: 'topline', lut: null, fit: '/fits/a.fit', quickcut: false });
    expect('audio_volume' in def[0]).toBe(false);
    const mute = buildDecisions([selVal({ volume: '0', memberIds: ['9'] })], 'process');
    expect(mute[0].audio_volume).toBe(0); // 静音是显式选择，不能被 '' 判空吞掉
  });
  it('commitSummary: 入队/跳过/失败计数合成文案', () => {
    const s = commitSummary({ results: [
      { id: '1', job_id: 'j1' }, { id: '2', job_id: 'j1', merged: 2 }, { id: '3', skipped: true }, { id: '4', error: 'boom' },
    ] });
    expect(s.text).toContain('已入队 2 段');
    expect(s.text).toContain('已跳过 1 段');
    expect(s.text).toContain('失败 1：boom');
    expect(s.isErr).toBe(true);
    expect(commitSummary({ results: [{ id: '1', job_id: 'j' }] }).isErr).toBe(false);
  });
});

it('lutLabel: null→自动，none→不套，有中文名用中文名', () => {
  const labels = { dlogm_rec709: '官方 Rec.709' };
  expect(lutLabel(null, labels)).toBe('自动');
  expect(lutLabel('', labels)).toBe('自动');
  expect(lutLabel('none', labels)).toBe('不套');
  expect(lutLabel('dlogm_rec709', labels)).toBe('官方 Rec.709');
  expect(lutLabel('other', labels)).toBe('other');
});
