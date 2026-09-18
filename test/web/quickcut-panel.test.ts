import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import QuickcutPanel from '../../web/src/lib/components/QuickcutPanel.svelte';
import type { QuickcutRecord } from '../../web/src/lib/quickcut.ts';

const rec = (over: Partial<QuickcutRecord> = {}): QuickcutRecord => ({
  id: 'q1',
  job_id: 'j1',
  state: 'analyzing',
  percent: null,
  plan: null,
  out: null,
  error: null,
  created_at: '2026-09-15T02:00:00Z',
  ...over,
});

const plan = {
  acts: [
    { key: 'departure', label: '出发', start: 0, end: 4, reason: '片头（数据出现前 134s）' },
    { key: 'effort', label: '发力', start: 612.5, end: 619.5, reason: '功率峰 20s 均 250W' },
  ],
  dropped: [{ key: 'high', label: '制高点', reason: '数据中无此类事件' }],
  totalS: 11,
};

describe('QuickcutPanel', () => {
  it('进行态：状态文案 + rendering 进度条', () => {
    render(QuickcutPanel, { props: { jobId: 'j1', records: [rec({ state: 'analyzing' })] } });
    expect(screen.getByText('分析情节…')).toBeTruthy();
  });

  it('rendering 显示百分比与进度条', () => {
    render(QuickcutPanel, { props: { jobId: 'j1', records: [rec({ state: 'rendering', percent: 42 })] } });
    expect(screen.getByText('渲染中 42%')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('.bar > i')!.style.width).toBe('42%');
  });

  it('完成态：文件名/完整路径/打开链接 + 每幕清单与舍弃幕', () => {
    render(QuickcutPanel, { props: { jobId: 'j1', records: [
      rec({ state: 'done', out: '/data/out/DJI_001_kuaijian.mp4', plan }),
    ] } });
    expect(screen.getByText('DJI_001_kuaijian.mp4')).toBeTruthy();
    expect(screen.getByText('/data/out/DJI_001_kuaijian.mp4')).toBeTruthy();
    const open = screen.getByText('打开') as HTMLAnchorElement;
    expect(open.href).toContain(encodeURIComponent('file:/data/out/DJI_001_kuaijian.mp4'));
    expect(screen.getByText('发力')).toBeTruthy();
    expect(screen.getByText('612.5s–619.5s')).toBeTruthy();
    expect(screen.getByText('功率峰 20s 均 250W')).toBeTruthy();
    // 舍弃幕灰色列出
    const dropped = screen.getByText('制高点').closest('tr')!;
    expect(dropped.classList.contains('dropped')).toBe(true);
    expect(screen.getByText('数据中无此类事件')).toBeTruthy();
  });

  it('失败态展示 error', () => {
    render(QuickcutPanel, { props: { jobId: 'j1', records: [rec({ state: 'failed', error: 'ffmpeg 退出码 1' })] } });
    expect(screen.getByText('ffmpeg 退出码 1')).toBeTruthy();
  });

  it('只归并本 job 的记录：最新一条优先展示，其余进历史', () => {
    render(QuickcutPanel, { props: { jobId: 'j1', records: [
      rec({ id: 'old', state: 'done', created_at: '2026-09-14T01:00:00Z' }),
      rec({ id: 'other', job_id: 'j2', state: 'failed', created_at: '2026-09-15T03:00:00Z' }),
      rec({ id: 'new', state: 'failed', error: '最近一次失败', created_at: '2026-09-15T02:00:00Z' }),
    ] } });
    expect(screen.getByText('最近一次失败')).toBeTruthy(); // 最新一条的状态优先
    const hist = document.querySelector('.hist')!;
    expect(hist.textContent).toContain('完成'); // 旧记录进历史
    expect(hist.textContent).not.toContain('失败'); // j2 与最新一条都不在历史里
  });

  it('快剪 30s 一键提交（兜底粗剪无选项），带上 jobId', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(QuickcutPanel, { props: { jobId: 'j1', records: [], onSubmit } });
    await fireEvent.click(screen.getByText('快剪 30s'));
    expect(onSubmit).toHaveBeenCalledWith('j1');
  });

  it('提交失败展示服务端错误文案', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('任务 j1 缺少 FIT 样本'));
    render(QuickcutPanel, { props: { jobId: 'j1', records: [], onSubmit } });
    await fireEvent.click(screen.getByText('快剪 30s'));
    expect(await screen.findByText('任务 j1 缺少 FIT 样本')).toBeTruthy();
  });
});
