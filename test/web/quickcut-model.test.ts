import { describe, it, expect } from 'vitest';
import {
  fmtSec,
  fmtRange,
  stateText,
  stateShort,
  statePill,
  scenarioLabel,
  isActiveState,
  hasActive,
  recordsForJob,
  latestForJob,
  fileName,
  quickcutVideoUrl,
} from '../../web/src/lib/quickcut.ts';
import type { QuickcutRecord } from '../../web/src/lib/quickcut.ts';

const rec = (over: Partial<QuickcutRecord> = {}): QuickcutRecord => ({
  id: 'q1',
  job_id: 'j1',
  scenario: 'ride_4plus2',
  state: 'analyzing',
  percent: null,
  plan: null,
  out: null,
  error: null,
  llm_used: true,
  created_at: '2026-09-15T02:00:00Z',
  ...over,
});

describe('fmtSec / fmtRange', () => {
  it('整数秒不带小数，小数组保留一位', () => {
    expect(fmtSec(12)).toBe('12s');
    expect(fmtSec(12.5)).toBe('12.5s');
    expect(fmtSec(12.34)).toBe('12.3s');
    expect(fmtSec(0)).toBe('0s');
  });

  it('非法输入归一为 0s；四舍五入到整数时去掉小数', () => {
    expect(fmtSec(-3)).toBe('0s');
    expect(fmtSec(NaN)).toBe('0s');
    expect(fmtSec(12.96)).toBe('13s');
  });

  it('fmtRange 拼区间', () => {
    expect(fmtRange(12, 35.5)).toBe('12s–35.5s');
  });
});

describe('stateText / stateShort / statePill', () => {
  it('进行态文案：排队/分析情节/AI 优选镜头', () => {
    expect(stateText(rec({ state: 'queued' }))).toBe('排队中…');
    expect(stateText(rec({ state: 'analyzing' }))).toBe('分析情节…');
    expect(stateText(rec({ state: 'refining' }))).toBe('AI 优选镜头…');
  });

  it('渲染中带取整百分比；percent 缺失时省略数字', () => {
    expect(stateText(rec({ state: 'rendering', percent: 33.6 }))).toBe('渲染中 34%');
    expect(stateText(rec({ state: 'rendering', percent: null }))).toBe('渲染中…');
  });

  it('终态文案；未知 state 原样透出', () => {
    expect(stateText(rec({ state: 'done' }))).toBe('已完成');
    expect(stateText(rec({ state: 'failed' }))).toBe('失败');
    expect(stateText(rec({ state: 'mystery' }))).toBe('mystery');
  });

  it('历史短标签与药丸配色', () => {
    expect(stateShort('done')).toBe('完成');
    expect(stateShort('failed')).toBe('失败');
    expect(stateShort('analyzing')).toBe('进行中');
    expect(statePill('done')).toBe('ok');
    expect(statePill('failed')).toBe('danger');
    expect(statePill('queued')).toBe('mute');
    expect(statePill('rendering')).toBe('info');
  });
});

describe('isActiveState / hasActive', () => {
  it('done/failed 为终态，其余都要轮询', () => {
    expect(isActiveState('done')).toBe(false);
    expect(isActiveState('failed')).toBe(false);
    for (const s of ['queued', 'analyzing', 'refining', 'rendering']) expect(isActiveState(s)).toBe(true);
  });

  it('hasActive：任一非终态即真', () => {
    expect(hasActive([rec({ state: 'done' }), rec({ id: 'q2', state: 'failed' })])).toBe(false);
    expect(hasActive([rec({ state: 'done' }), rec({ id: 'q2', state: 'queued' })])).toBe(true);
    expect(hasActive([])).toBe(false);
  });
});

describe('recordsForJob / latestForJob（历史归并）', () => {
  it('按 job_id 过滤并按 created_at 新→旧排序（输入乱序也稳定）', () => {
    const records = [
      rec({ id: 'old', job_id: 'j1', created_at: '2026-09-14T01:00:00Z' }),
      rec({ id: 'other', job_id: 'j2', created_at: '2026-09-15T03:00:00Z' }),
      rec({ id: 'new', job_id: 'j1', created_at: '2026-09-15T02:00:00Z' }),
    ];
    expect(recordsForJob(records, 'j1').map((r) => r.id)).toEqual(['new', 'old']);
    expect(latestForJob(records, 'j1')?.id).toBe('new');
  });

  it('created_at 缺失的记录排最后；无记录返回 null', () => {
    const records = [
      rec({ id: 'nodate', created_at: undefined }),
      rec({ id: 'dated', created_at: '2026-09-15T02:00:00Z' }),
    ];
    expect(recordsForJob(records, 'j1').map((r) => r.id)).toEqual(['dated', 'nodate']);
    expect(latestForJob([], 'j1')).toBeNull();
    expect(latestForJob(records, 'nope')).toBeNull();
  });
});

describe('scenarioLabel / fileName / quickcutVideoUrl', () => {
  it('场景名映射；未知场景原样透出', () => {
    expect(scenarioLabel('ride_4plus2')).toBe('4+2 爬山');
    expect(scenarioLabel('ride_future')).toBe('ride_future');
    expect(scenarioLabel(undefined)).toBe('未知场景');
  });

  it('取路径末段作文件名', () => {
    expect(fileName('/data/out/DJI_001_kuaijian.mp4')).toBe('DJI_001_kuaijian.mp4');
  });

  it('成片播放走对齐页视频流路由（file: token 编码）', () => {
    expect(quickcutVideoUrl('/data/out/a b.mp4')).toBe(
      `/api/align/video?src=${encodeURIComponent('file:/data/out/a b.mp4')}`,
    );
  });
});
