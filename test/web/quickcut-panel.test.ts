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

  it('快剪 30s 一键提交：默认 AI 优选开，提交带上 jobId 与 useLlm', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(QuickcutPanel, { props: { jobId: 'j1', records: [], onSubmit } });
    const ai = document.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(ai.checked).toBe(true);
    await fireEvent.click(ai); // 关掉 AI 优选
    await fireEvent.click(screen.getByText('快剪 30s'));
    expect(onSubmit).toHaveBeenCalledWith('j1', false);
  });

  it('AI 优选旁的小字随 llmStatus：configured 显示将用模型，否则提示仅按数据优选', async () => {
    const { unmount } = render(QuickcutPanel, { props: { jobId: 'j1', records: [], llmStatus: { configured: true, describe: 'lmstudio/qwen' } } });
    expect(screen.getByText('将使用 lmstudio/qwen')).toBeTruthy();
    unmount();

    render(QuickcutPanel, { props: { jobId: 'j1', records: [] } }); // 未传 llmStatus → 按未配置
    expect(screen.getByText('未配置 LLM，仅按数据优选')).toBeTruthy();
  });
});
