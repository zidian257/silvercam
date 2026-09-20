import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import StatCards from '../../web/src/lib/components/StatCards.svelte';
import JobsTable from '../../web/src/lib/components/JobsTable.svelte';

// mock /jobs 摘要 JSON：字段随用例覆盖（segments 等服务端可空字段按组件标注的 number 透传）
const job = (over: Record<string, any> = {}): any => ({
  id: 'j1', state: 'rendering', created_at: '2026-09-06T02:00:00Z', video: 'DJI_001.MP4',
  segments: null, skin: 'topline', fit: true, bias_seconds: null,
  progress: { stage: 'render', percent: 42 }, error: null, output: null,
  ...over,
});

describe('StatCards', () => {
  it('渲染数值与标签；warn 标红；link 包装为链接', () => {
    render(StatCards, { props: { cards: [
      { n: 3, k: '待确认素材', link: '/inbox', warn: false },
      { n: 1, k: '失败 1 / 待 FIT 0', link: null, warn: true },
    ] } });
    expect(screen.getByText('3').closest('a')!.getAttribute('href')).toBe('/inbox');
    expect(screen.getByText('1').classList.contains('warn')).toBe(true);
    expect(screen.getByText('失败 1 / 待 FIT 0')).toBeTruthy();
  });
});

describe('JobsTable', () => {
  it('空列表显示提示', () => {
    render(JobsTable, { props: { jobs: [] } });
    expect(screen.getByText('暂无任务')).toBeTruthy();
  });

  it('渲染任务行：视频名/皮肤/状态+进度条；合并段数与 bias 徽标', () => {
    render(JobsTable, { props: { jobs: [job({ segments: 3, bias_seconds: -4.5 })] } });
    expect(screen.getByText('DJI_001.MP4')).toBeTruthy();
    expect(screen.getByText('topline')).toBeTruthy();
    expect(screen.getByText(/rendering 42%/)).toBeTruthy();
    expect(screen.getByText('合并×3')).toBeTruthy();
    expect(screen.getByText('bias -4.5s')).toBeTruthy();
    const bar = document.querySelector<HTMLElement>('.bar > i')!;
    expect(bar.style.width).toBe('42%');
  });

  it('完成/失败状态不显示进度条；错误文案展示', () => {
    render(JobsTable, { props: { jobs: [job({ state: 'failed', progress: null, error: 'ffmpeg 卡死' })] } });
    expect(document.querySelector('.bar')).toBeNull();
    expect(screen.getByText('ffmpeg 卡死')).toBeTruthy();
  });

  it('有 FIT 的任务给出「对齐」链接进 studio', () => {
    const { container } = render(JobsTable, { props: { jobs: [job()] } });
    expect(container.querySelector('a[href="/studio?job=j1"]')).toBeTruthy();
  });

  it('失败任务显示重试并回调；awaiting_fit 显示补 FIT', async () => {
    const onRetry = vi.fn();
    const onFit = vi.fn();
    render(JobsTable, { props: { jobs: [
      job({ id: 'a', state: 'failed', progress: null }),
      job({ id: 'b', state: 'awaiting_fit', progress: null }),
    ], onRetry, onFit } });
    await fireEvent.click(screen.getByText('重试'));
    expect(onRetry).toHaveBeenCalledWith('a');
    await fireEvent.click(screen.getByText('补 FIT'));
    expect(onFit).toHaveBeenCalledWith('b');
  });

  it('日志按钮展开日志行（内容由父级传入）', async () => {
    const onToggleLog = vi.fn();
    const { container } = render(JobsTable, { props: { jobs: [job()], openLogs: { j1: true }, logs: { j1: 'line1\nline2' }, onToggleLog } });
    expect(screen.getByText(/line1/)).toBeTruthy();
    await fireEvent.click(container.querySelector('button[title="日志"]')!);
    expect(onToggleLog).toHaveBeenCalledWith('j1');
  });

  it('快剪标记：有记录显示可点状态 pill；无记录但会自动快剪时显示静态 pill', async () => {
    const onToggleQuickcut = vi.fn();
    render(JobsTable, { props: { jobs: [
      job({ id: 'a', quickcut: true }),                                     // 标记自动快剪、尚无记录
      job({ id: 'b', quickcut: true }),                                     // 已有快剪记录
      job({ id: 'c' }),                                                     // 未标记 → 不出 pill
    ], quickcuts: [
      { id: 'qc1', job_id: 'b', state: 'done', created_at: '2026-09-19T10:00:00Z' },
    ], onToggleQuickcut } });
    const qcPill = screen.getByText('快剪·完成');
    await fireEvent.click(qcPill);
    expect(onToggleQuickcut).toHaveBeenCalledWith('b');
    expect(screen.getByText('快剪', { exact: true }).tagName).toBe('SPAN'); // a 的静态 pill
    expect(screen.queryAllByText(/快剪/).length).toBe(2);
  });
});
