import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActpipeConfig } from '../../src/types.ts';
import type { InboxItem } from '../../src/server/inbox.ts';

// Inbox 读写 paths.home/inbox.json：用临时 ACTPIPE_HOME 隔离真实数据（必须在 import 前设置）
process.env.ACTPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-inbox-'));
const { Inbox } = await import('../../src/server/inbox.ts');
const { InboxService } = await import('../../src/server/services/inbox.ts');

const REAL_VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4');
const REAL_FIT = path.resolve('fixtures/out/activity.fit');
const T0 = Date.parse('2026-08-30T00:50:39.000Z');

const mkItem = (id: string, name: string, { start = null, duration = 100, status = 'pending' }: { start?: number | null; duration?: number | null; status?: string } = {}) => ({
  id,
  src: `/Volumes/CAM/DCIM/100MEDIA/${name}`,
  size: 1000,
  mtime_ms: null,
  volume: {},
  found_at: '2026-09-06T02:00:00.000Z',
  staged: null,
  ingest: { state: 'on_card', percent: 0 },
  probe: duration != null ? { duration, ...(start != null ? { creation_time_utc_ms: start } : {}) } : null,
  status,
  decision: null,
  job_id: null,
});

const mkInbox = (items: InboxItem[] = []) => {
  const inbox = new Inbox({ configRef: { current: {} as ActpipeConfig }, log: () => {} });
  inbox.items = items;
  return inbox;
};

// ---- 同一次录制的切段分组：seq 相邻且首尾间隙 <30s 视为同组 ----

test('recordingGroup: seq 相邻 + 小间隙 → 全组，按拍摄时间升序', () => {
  const a = mkItem('a', 'DJI_20260830085039_0002_D.MP4', { start: T0 });
  const b = mkItem('b', 'DJI_20260830085039_0003_D.MP4', { start: T0 + 102_000 }); // 间隙 2s
  const c = mkItem('c', 'DJI_20260830085039_0004_D.MP4', { start: T0 + 205_000 });
  const inbox = mkInbox([c, a, b]); // 乱序放入也应正确
  assert.deepEqual(inbox.recordingGroup('b').map((i: InboxItem) => i.id), ['a', 'b', 'c']);
});

test('recordingGroup: seq 跳号 → 断链', () => {
  const a = mkItem('a', 'DJI_20260830085039_0002_D.MP4', { start: T0 });
  const b = mkItem('b', 'DJI_20260830085039_0004_D.MP4', { start: T0 + 102_000 }); // seq 2→4 跳号
  const inbox = mkInbox([a, b]);
  assert.deepEqual(inbox.recordingGroup('a').map((i: InboxItem) => i.id), ['a']);
  assert.deepEqual(inbox.recordingGroup('b').map((i: InboxItem) => i.id), ['b']);
});

test('recordingGroup: seq 相邻但间隙 >30s → 断链（中间隔了别的录制）', () => {
  const a = mkItem('a', 'DJI_20260830085039_0002_D.MP4', { start: T0 });
  const b = mkItem('b', 'DJI_20260830085039_0003_D.MP4', { start: T0 + 500_000 }); // 间隙 400s
  const inbox = mkInbox([a, b]);
  assert.deepEqual(inbox.recordingGroup('a').map((i: InboxItem) => i.id), ['a']);
});

test('recordingGroup: 首尾轻微重叠（>-60s）仍链接（相机时间戳回拨）', () => {
  const a = mkItem('a', 'DJI_20260830085039_0002_D.MP4', { start: T0 });
  const b = mkItem('b', 'DJI_20260830085039_0003_D.MP4', { start: T0 + 90_000 }); // 重叠 10s
  const inbox = mkInbox([a, b]);
  assert.deepEqual(inbox.recordingGroup('a').map((i: InboxItem) => i.id), ['a', 'b']);
});

test('recordingGroup: 无文件名时间戳/无 probe → 只有自己', () => {
  const a = mkItem('a', 'random_clip.mov', { start: null, duration: null });
  const inbox = mkInbox([a]);
  assert.deepEqual(inbox.recordingGroup('a').map((i: InboxItem) => i.id), ['a']);
  assert.deepEqual(mkInbox([]).recordingGroup('ghost'), []);
});

// ---- list() 展示层 ----

test('list: 最新拍摄排最顶；无拍摄时间的排最后；附带 src_exists/seq/fit_suggestion', () => {
  const old = mkItem('old', 'DJI_20260801080000_0001_D.MP4', {});
  const newer = mkItem('new', 'DJI_20260830085039_0002_D.MP4', {});
  const unknown = mkItem('unk', 'random.mov', { duration: 10 });
  const inbox = mkInbox([old, unknown, newer]);
  const list = inbox.list();
  assert.deepEqual(list.map((i: InboxItem) => i.id), ['new', 'old', 'unk']);
  assert.equal(list[0].seq, 2);
  assert.equal(list[0].recorded_src, 'filename');
  assert.equal(list[0].src_exists, false); // 假路径
  assert.equal(list[0].fit_suggestion, null); // fit_library_dir 未配置
});

// ---- 状态机：approve / skip / reopen / dismiss / setAlign ----

test('approve: 待确认→已确认并记录决策；重复确认报错', () => {
  const item = mkItem('x', 'DJI_20260906100100.MP4', {});
  item.src = REAL_VIDEO; // approve 要求文件真实存在
  const inbox = mkInbox([item]);
  const done = inbox.approve('x', { skin: 'topline', lut: 'none', fit: null });
  assert.equal(done.status, 'approved');
  assert.deepEqual(done.decision, { skin: 'topline', lut: 'none', fit: null, bias_seconds: null, audio_volume: null, quickcut: null });
  assert.throws(() => inbox.approve('x'), /approved/);
});

test('approve: 源文件不存在时报错', () => {
  const inbox = mkInbox([mkItem('x', 'DJI_20260906100100.MP4', {})]); // 假 /Volumes 路径
  assert.throws(() => inbox.approve('x'), /卡已拔出/);
});

test('skip → dismiss；待确认条目不能直接 dismiss', () => {
  const inbox = mkInbox([mkItem('x', 'DJI_20260830085039_0002_D.MP4', {})]);
  assert.throws(() => inbox.dismiss('x'), /待确认素材/);
  inbox.skip('x');
  assert.equal(inbox.get('x')!.status, 'skipped');
  inbox.dismiss('x');
  assert.equal(inbox.get('x'), null);
});

test('reopen: 已处理条目拉回待处理；源不可用时报错', () => {
  const item = mkItem('x', 'DJI_20260906100100.MP4', {});
  item.src = REAL_VIDEO;
  const inbox = mkInbox([item]);
  inbox.approve('x', {});
  const back = inbox.reopen('x');
  assert.equal(back.status, 'pending');
  assert.equal(back.ingest!.state, 'on_card'); // 卡上原件还在
  assert.throws(() => inbox.reopen('x'), /本就在待处理/);

  const ghost = mkInbox([mkItem('g', 'DJI_20260906100100.MP4', {})]);
  ghost.skip('g');
  assert.throws(() => ghost.reopen('g'), /源文件不可用/);
});

test('setAlign: 预校准写入 pre_align；非待处理状态拒绝', () => {
  const item = mkItem('x', 'DJI_20260906100100.MP4', {});
  item.src = REAL_VIDEO;
  const inbox = mkInbox([item]);
  inbox.setAlign('x', { fit: '/tmp/a.fit', bias_seconds: -3.5 });
  assert.deepEqual(inbox.get('x')!.pre_align, { fit: '/tmp/a.fit', bias_seconds: -3.5 });
  inbox.approve('x', {});
  assert.throws(() => inbox.setAlign('x', { fit: '/tmp/a.fit', bias_seconds: 0 }), /不能对齐/);
});

test('setAlign: merge 语义——只写给出的键（studio 分通道回写：fit/bias 与 skin/lut 不互相覆盖）', () => {
  const item = mkItem('x', 'DJI_20260906100100.MP4', {});
  item.src = REAL_VIDEO;
  const inbox = mkInbox([item]);
  inbox.setAlign('x', { fit: '/tmp/a.fit', bias_seconds: -3.5 });
  inbox.setAlign('x', { skin: 'topline', lut: 'dlogm_rec709' });
  assert.deepEqual(inbox.get('x')!.pre_align, { fit: '/tmp/a.fit', bias_seconds: -3.5, skin: 'topline', lut: 'dlogm_rec709' });
  inbox.setAlign('x', { skin: 'dashline' }); // 单键更新，其余保留
  assert.deepEqual(inbox.get('x')!.pre_align, { fit: '/tmp/a.fit', bias_seconds: -3.5, skin: 'dashline', lut: 'dlogm_rec709' });
  inbox.setAlign('x', { lut: null }); // 显式 null 也写入（回「自动」）
  assert.equal(inbox.get('x')!.pre_align!.lut, null);
});

test('构造：崩溃恢复——copying 状态标记 failed，staging 丢失标记 failed', () => {
  const dir = process.env.ACTPIPE_HOME!;
  fs.writeFileSync(
    path.join(dir, 'inbox.json'),
    JSON.stringify([
      { ...mkItem('c', 'DJI_20260830085039_0002_D.MP4', {}), ingest: { state: 'copying', percent: 40 } },
      { ...mkItem('d', 'DJI_20260830085039_0003_D.MP4', {}), staged: '/nonexistent/staged.mp4', ingest: { state: 'ready', percent: 100 } },
    ])
  );
  const inbox = new Inbox({ configRef: { current: {} as ActpipeConfig }, log: () => {} });
  assert.equal(inbox.get('c')!.ingest!.state, 'failed');
  assert.match(inbox.get('c')!.ingest!.error!, /重启/);
  assert.equal(inbox.get('d')!.ingest!.state, 'failed');
  assert.match(inbox.get('d')!.ingest!.error!, /丢失/);
});

// ---- commit：每条覆盖（audio_volume / quickcut）随决策落进 job params 与 decision ----

const mkCommitCtx = (items: InboxItem[]) => {
  const inbox = mkInbox(items);
  const added: any[] = [];
  const stubQueue = {
    add: (p: any) => { added.push(p); return { id: `job-${added.length}` }; },
    get: () => null,
  };
  const svc = new InboxService({ queue: stubQueue as any, configRef: { current: {} as ActpipeConfig }, inbox });
  return { inbox, added, svc };
};

test('commit 单段：audio_volume/quickcut 透传 job params 并落 decision；缺省不带这两个键', async () => {
  const a = { ...mkItem('a', 'DJI_20260906100100.MP4', {}), src: REAL_VIDEO };
  const b = { ...mkItem('b', 'DJI_20260906100100.MP4', {}), src: REAL_VIDEO };
  const { inbox, added, svc } = mkCommitCtx([a, b] as InboxItem[]);
  const r = await svc.commit({
    decisions: [
      { id: 'a', action: 'process', fit: 'none', audio_volume: 0.5, quickcut: true },
      { id: 'b', action: 'process', fit: 'none' },
    ],
  });
  assert.equal(r.results.length, 2);
  assert.equal(added.length, 2);
  assert.equal(added[0].audio_volume, 0.5);
  assert.equal(added[0].quickcut, true);
  assert.ok(!('audio_volume' in added[1]) && !('quickcut' in added[1])); // 缺省 = 跟随全局，不落 params
  assert.equal(inbox.get('a')!.decision!.audio_volume, 0.5);
  assert.equal(inbox.get('a')!.decision!.quickcut, true);
});

test('commit 单段：audio_volume 非法 → 该条报错不入队', async () => {
  const a = { ...mkItem('a', 'DJI_20260906100100.MP4', {}), src: REAL_VIDEO };
  const { added, svc } = mkCommitCtx([a] as InboxItem[]);
  const r = await svc.commit({ decisions: [{ id: 'a', action: 'process', fit: 'none', audio_volume: -1 }] });
  assert.match(String(r.results[0].error), /audio_volume/);
  assert.equal(added.length, 0);
});

test('commit 合并：同 FIT 多段成一个 job，音量/快剪覆盖取首段（拍摄时间序）决策', async () => {
  // 合并分支要求每段文件真实存在：复制 fixture 出两段（文件名时间戳定序）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-commit-'));
  const v2 = path.join(dir, 'DJI_20260906101200.MP4');
  fs.copyFileSync(REAL_VIDEO, v2);
  const a = { ...mkItem('a', 'DJI_20260906100100.MP4', {}), src: REAL_VIDEO };
  const b = { ...mkItem('b', 'DJI_20260906101200.MP4', {}), src: v2 };
  const { added, svc } = mkCommitCtx([a, b] as InboxItem[]);
  const r = await svc.commit({
    decisions: [
      { id: 'a', action: 'process', fit: REAL_FIT, quickcut: true, audio_volume: 0.75 },
      { id: 'b', action: 'process', fit: REAL_FIT, quickcut: false },
    ],
  });
  assert.equal(added.length, 1); // 合并为一个任务
  assert.equal(added[0].segments.length, 2);
  assert.equal(added[0].quickcut, true);       // d0 = 拍摄时间最早段
  assert.equal(added[0].audio_volume, 0.75);
  assert.ok(r.results.every((x: any) => x.merged === 2));
});
