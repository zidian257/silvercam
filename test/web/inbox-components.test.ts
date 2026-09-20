import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import PendingGroup from '../../web/src/lib/components/PendingGroup.svelte';
import ResolvedItem from '../../web/src/lib/components/ResolvedItem.svelte';
import MergeConfirm from '../../web/src/lib/components/MergeConfirm.svelte';

const SKINS = ['topline', 'trace'];
const LUT_OPTS = [
  { value: '', label: '自动（按 D-Log 策略）' },
  { value: 'none', label: '不套 LUT' },
  { value: 'dlogm_rec709', label: '官方 Rec.709（默认）' },
];
const FIT_OPTS = [
  { value: 'none', label: '无 FIT（仅拷贝）' },
  { value: '__load', label: '载入 .fit 文件…' },
  { value: '/fits/a.fit', label: 'a.fit（8月30日 08:50 起 · 10\'00"）' },
];

// mock /api/inbox 清单项 JSON：字段随用例覆盖
const member = (id: string, over: Record<string, any> = {}) => ({
  id,
  src: `/Volumes/CAM/DCIM/DJI_20260830085039_000${id}_D.MP4`,
  recorded_at: '2026-08-30 08:50:39',
  seq: Number(id), size: 2 * 1073741824,
  probe: { duration: 100, width: 3840, height: 2160, fps: 30 },
  status: 'pending', ingest: { state: 'on_card', percent: 0 }, src_exists: true,
  ...over,
});

const selOf = (members: { id: string }[], over: Record<string, any> = {}) => ({
  checked: true, skin: 'topline', lut: '', fit: '/fits/a.fit', volume: '', quickcut: true,
  memberIds: members.map((m) => m.id), ...over,
});

describe('PendingGroup', () => {
  it('单段组：日期标题、时长/大小/分辨率、默认选中值', () => {
    const members = [member('2')];
    const { container } = render(PendingGroup, { props: { members, sel: selOf(members), skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS } });
    expect(container.querySelector('.name')!.textContent).toContain('8月30日');
    expect(container.querySelector('.name')!.textContent).toContain('上午8:50');
    expect(screen.getByText(/总时长 1'40"/)).toBeTruthy();
    expect(screen.getByText(/3840×2160 30fps/)).toBeTruthy();
    expect(screen.getByText(/2.00 GB/)).toBeTruthy();
  });

  it('多段组：同次录制徽标 + 全在卡上徽标；studio 链接带首段 id 与皮肤/LUT', () => {
    const members = [member('2'), member('3'), member('4')];
    const { container } = render(PendingGroup, { props: { members, sel: selOf(members, { lut: 'none' }), skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS } });
    expect(screen.getByText('同次录制 3 段')).toBeTruthy();
    expect(screen.getAllByText('在卡上').length).toBeGreaterThan(0);
    const a = container.querySelector('a[href^="/studio?inbox="]')!;
    expect(a.getAttribute('href')).toBe('/studio?inbox=2&skin=topline&lut=none');
  });

  it('有段已拔出徽标；组不可操作时 checkbox 禁用', () => {
    const members = [member('2'), member('3', { src_exists: false })];
    render(PendingGroup, { props: { members, sel: selOf(members), skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS } });
    expect(screen.getAllByText(/已拔出/).length).toBeGreaterThan(0);
    const members2 = [member('9', { ingest: { state: 'copying', percent: 40 } })];
    const { container } = render(PendingGroup, { props: { members: members2, sel: selOf(members2), skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS } });
    expect(container.querySelector<HTMLInputElement>('input[type=checkbox]')!.disabled).toBe(true);
    expect(screen.getByText(/拷贝中 40%/)).toBeTruthy();
  });

  it('改皮肤/LUT/FIT 下拉会写回 sel 并回调 onSelChange', async () => {
    const members = [member('2')];
    const sel = selOf(members);
    const onSelChange = vi.fn();
    const { container } = render(PendingGroup, { props: { members, sel, skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS, onSelChange } });
    const [skinSel, lutSel, fitSel] = container.querySelectorAll('select');
    await fireEvent.change(skinSel, { target: { value: 'trace' } });
    expect(sel.skin).toBe('trace');
    await fireEvent.change(lutSel, { target: { value: 'none' } });
    expect(sel.lut).toBe('none');
    await fireEvent.change(fitSel, { target: { value: 'none' } });
    expect(sel.fit).toBe('none');
    expect(onSelChange).toHaveBeenCalledTimes(3);
  });

  it('FIT 下拉选「载入 .fit 文件…」触发 onLoadFit 且不改变当前值', async () => {
    const members = [member('2')];
    const sel = selOf(members);
    const onLoadFit = vi.fn();
    const { container } = render(PendingGroup, { props: { members, sel, skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS, onLoadFit } });
    const fitSel = container.querySelectorAll('select')[2];
    await fireEvent.change(fitSel, { target: { value: '__load' } });
    expect(onLoadFit).toHaveBeenCalledOnce();
    expect(sel.fit).toBe('/fits/a.fit'); // 保持原值
  });

  it('全组已按当前 FIT 校准时显示「已对齐 bias」徽标', () => {
    const members = [member('2', { pre_align: { fit: '/fits/a.fit', bias_seconds: -3.5 } })];
    render(PendingGroup, { props: { members, sel: selOf(members), skins: SKINS, lutOptions: LUT_OPTS, fitOptions: FIT_OPTS } });
    expect(screen.getByText(/已对齐 bias -3.5s/)).toBeTruthy();
  });
});

describe('ResolvedItem', () => {
  const decided = member('2', {
    status: 'approved',
    decision: { skin: 'topline', lut: 'dlogm_rec709', fit: '/fits/a.fit', bias_seconds: 2 },
    job_id: 'j1',
  });

  it('展示决策摘要（皮肤/LUT 中文名/FIT 文件名/bias）与任务状态', () => {
    render(ResolvedItem, { props: { item: decided, job: { id: 'j1', state: 'done' }, lutLabels: { dlogm_rec709: '官方 Rec.709' } } });
    expect(screen.getByText(/皮肤 topline/)).toBeTruthy();
    expect(screen.getByText(/LUT 官方 Rec\.709/)).toBeTruthy();
    expect(screen.getByText(/FIT a\.fit/)).toBeTruthy();
    expect(screen.getByText(/bias \+2s/)).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
  });

  it('已跳过条目没有重新编辑；approved 有重新编辑', () => {
    const skipped = member('3', { status: 'skipped' });
    render(ResolvedItem, { props: { item: skipped, job: null, lutLabels: {} } });
    expect(screen.getByText('已跳过')).toBeTruthy();
    expect(screen.queryByText('重新编辑')).toBeNull();
  });

  it('按钮回调：重新编辑 / 移除（Alt=连 staging 一起删）', async () => {
    const onReopen = vi.fn();
    const onDismiss = vi.fn();
    render(ResolvedItem, { props: { item: decided, job: null, lutLabels: {}, onReopen, onDismiss } });
    await fireEvent.click(screen.getByText('重新编辑'));
    expect(onReopen).toHaveBeenCalledWith(decided);
    await fireEvent.click(screen.getByText('移除'));
    expect(onDismiss).toHaveBeenCalledWith(decided, false);
  });
});

describe('MergeConfirm', () => {
  it('展示切段统计；三个选择各自回调；点背板取消', async () => {
    const onChoice = vi.fn();
    const { container } = render(MergeConfirm, { props: { groups: [{ fit: '/fits/a.fit', n: 3 }], onChoice } });
    expect(screen.getByText(/检测到同一次录制的 3 个切段/)).toBeTruthy();
    expect(screen.getByText(/a\.fit × 3 段/)).toBeTruthy();
    await fireEvent.click(screen.getByText('合并输出'));
    expect(onChoice).toHaveBeenCalledWith('merge');
    await fireEvent.click(screen.getByText('分段输出'));
    expect(onChoice).toHaveBeenCalledWith('split');
    await fireEvent.click(container.querySelector('.cfmodal')!);
    expect(onChoice).toHaveBeenCalledWith('cancel');
  });
});
