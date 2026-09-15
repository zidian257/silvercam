import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import SeekBar from '../../web/src/lib/components/SeekBar.svelte';

// jsdom 的 getBoundingClientRect 全是 0，mock 成 100px 宽（只补 SeekBar 用到的字段）
function mockRect(el: HTMLElement, width = 100) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: 18, width, height: 18 }) as DOMRect;
}

describe('SeekBar', () => {
  it('播放头与数据蓝带按 frac 定位', () => {
    const { container } = render(SeekBar, { props: { frac: 0.25, dataWin: [0.1, 0.6], label: '0:30 / 2:00' } });
    expect(container.querySelector<HTMLElement>('.seekHead')!.style.left).toBe('25%');
    const band = container.querySelector<HTMLElement>('.seekData')!;
    expect(band.style.left).toBe('10%');
    expect(band.style.width).toBe('50%');
    expect(screen.getByText('0:30 / 2:00')).toBeTruthy();
  });

  it('无数据窗口时不渲染蓝带', () => {
    const { container } = render(SeekBar, { props: { frac: 0, dataWin: null } });
    expect(container.querySelector('.seekData')).toBeNull();
  });

  it('点击/拖动回调 frac 并钳制到 0..1', async () => {
    const onSeek = vi.fn();
    const { container } = render(SeekBar, { props: { frac: 0, dataWin: null, onSeek } });
    const bar = container.querySelector<HTMLElement>('.seekBar')!;
    mockRect(bar);
    await fireEvent.pointerDown(bar, { clientX: 40 });
    expect(onSeek).toHaveBeenLastCalledWith(0.4);
    await fireEvent.pointerMove(bar, { clientX: 80, buttons: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(0.8);
    await fireEvent.pointerMove(bar, { clientX: 250, buttons: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(1); // 越界钳制
    await fireEvent.pointerMove(bar, { clientX: 10, buttons: 0 });
    expect(onSeek).toHaveBeenCalledTimes(3); // 未按键的 hover 不触发
  });
});
