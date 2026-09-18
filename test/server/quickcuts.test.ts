import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ActpipeConfig, Job } from '../../src/types.ts';

// quickcuts.json 落在 paths.home：临时 ACTPIPE_HOME 隔离真实数据（必须在 import 前设置）
process.env.ACTPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-quickcuts-'));
const { QuickcutService } = await import('../../src/server/quickcuts.ts');
const { paths } = await import('../../src/lib/paths.ts');
const { readJson, writeJsonAtomic } = await import('../../src/lib/util.ts');
import type { QuickcutRenderFn } from '../../src/server/quickcuts.ts';

const VIDEO = path.resolve('fixtures/out/movies/2026-09-06/DJI_20260906100100_virb_like_dash.mp4');
const VIDEO_2 = path.resolve('fixtures/out/movies/2026-09-06/DJI_20260906100100_virb_like_dash_2.mp4');
if (!fs.existsSync(VIDEO) || !fs.existsSync(VIDEO_2)) throw new Error('fixture 成片缺失');

// 真实骑行的归一化样本（tS 流逝秒）：真实 grid 壳里样本带绝对 ISO 时间戳，这里按 t0 还原
const FIXTURE = JSON.parse(fs.readFileSync(path.resolve('fixtures/quickcut-samples.json'), 'utf8'));
const T0_MS = Date.parse('2026-01-01T00:00:00.000Z');
const mkGrid = () => ({
  version: 1,
  t0: new Date(T0_MS).toISOString(),
  t0_ms: T0_MS,
  interval_ms: 1000,
  count: FIXTURE.samples.length,
  fields: ['speed', 'altitude', 'heart_rate', 'power', 'grade'],
  samples: FIXTURE.samples.map(({ tS, ...rest }: any) => ({ ...rest, t: new Date(T0_MS + tS * 1000).toISOString() })),
});

// 造 fake job 目录（合并任务布局：seg0/samples.json + seg0/session.json；offset 0 = 视频与 FIT 同步开始）
const mkJobDir = (id: string, { video = VIDEO, state = 'done', duration = 2244, withSamples = true }: { video?: string; state?: string; duration?: number; withSamples?: boolean } = {}) => {
  const dir = path.join(paths.jobs, id);
  fs.mkdirSync(path.join(dir, 'seg0'), { recursive: true });
  const job = {
    id,
    dir,
    created_at: new Date().toISOString(),
    state,
    error: null,
    params: {},
    steps: {},
    artifacts: {
      output: video,
      segments: [{ probe: { duration }, session: { offset_seconds: 0 } }],
    },
    progress: null,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job, null, 2));
  if (withSamples) fs.writeFileSync(path.join(dir, 'seg0', 'samples.json'), JSON.stringify(mkGrid()));
  fs.writeFileSync(path.join(dir, 'seg0', 'session.json'), JSON.stringify({ offset_seconds: 0 }));
  return job;
};

// stub render（不真编码）
const mkService = (jobs: Map<string, any>, { renderOuts = null as string[] | null } = {}) =>
  new QuickcutService({
    queue: { get: (id: string) => (jobs.get(id) ?? null) as Job | null },
    configRef: { current: {} as ActpipeConfig },
    log: () => {},
    render: (async ({ out, onProgress }: any) => {
      renderOuts?.push(out);
      onProgress(50);
      onProgress(100);
      return { out, durationS: 12 };
    }) as QuickcutRenderFn,
  });

const waitState = async (svc: any, id: string, want: string, timeoutMs = 10000) => {
  const t0 = Date.now();
  for (;;) {
    const it = await svc.get(id);
    if (it.state === want) return it;
    if (it.state === 'failed' && want !== 'failed') throw new Error(`任务失败: ${it.error}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${want} 超时（当前 ${it.state}）`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ---------- 主流程：create → 串行消化 → done ----------

test('create → done：L0 兜底四幕成片（offset 0 无车内段，departure/finish 丢弃）', async () => {
  const job = mkJobDir('job-happy');
  const svc = mkService(new Map([[job.id, job]]));
  const rec = await svc.create({ job_id: job.id });
  assert.equal(rec.state, 'queued'); // create 返回入队快照，异步消化
  assert.equal(rec.percent, 0);
  assert.equal(rec.plan, null);

  const done = await waitState(svc, rec.id, 'done');
  assert.equal(done.percent, 100);
  assert.equal(done.error, null);

  // 兜底槽位：offset 0 无片头/片尾 → departure/finish 丢弃，命中其余四幕
  assert.ok(done.plan);
  assert.deepEqual(done.plan.acts.map((a: any) => a.key), ['rollout', 'effort', 'high', 'speed']);
  const droppedKeys = done.plan.dropped.map((d: any) => d.key);
  assert.ok(droppedKeys.includes('departure'), `dropped=${droppedKeys}`);
  assert.ok(droppedKeys.includes('finish'), `dropped=${droppedKeys}`);

  // 输出路径：与成片同目录、去 _dash 后缀
  assert.equal(done.out, path.join(path.dirname(VIDEO), 'DJI_20260906100100_virb_like_kuaijian.mp4'));

  // quickcuts.json 落盘
  const onDisk = readJson(path.join(paths.home, 'quickcuts.json'), []) as any[];
  const saved = onDisk.find((r) => r.id === rec.id);
  assert.ok(saved, 'quickcuts.json 未持久化该记录');
  assert.equal(saved.state, 'done');
  assert.equal(saved.plan.acts.length, 4);
});

test('create 带 cuts：外部剪辑点原样采纳，不跑兜底组装', async () => {
  const job = mkJobDir('job-cuts');
  const svc = mkService(new Map([[job.id, job]]));
  const cuts = [
    { start: 3, end: 7, label: '开车门' },
    { start: 1416.2, end: 1423.2, label: '爬坡' },
  ];
  const rec = await svc.create({ job_id: job.id, cuts });
  const done = await waitState(svc, rec.id, 'done');
  assert.deepEqual(done.plan.acts.map((a: any) => [a.start, a.end, a.label]), [
    [3, 7, '开车门'],
    [1416.2, 1423.2, '爬坡'],
  ]);
  assert.equal(done.plan.dropped.length, 0);
  assert.equal(done.plan.totalS, 11);
});

test('串行通道：两个任务按入队顺序逐个消化', async () => {
  const a = mkJobDir('job-fifo-a', { video: VIDEO });
  const b = mkJobDir('job-fifo-b', { video: VIDEO_2 });
  const renderOuts: string[] = [];
  const svc = mkService(new Map([[a.id, a], [b.id, b]]), { renderOuts });
  const ra = await svc.create({ job_id: a.id });
  const rb = await svc.create({ job_id: b.id });
  const [da, db] = await Promise.all([waitState(svc, ra.id, 'done'), waitState(svc, rb.id, 'done')]);
  assert.equal(da.state, 'done');
  assert.equal(db.state, 'done');
  // render 调用顺序 = 入队顺序（串行，不并发）
  assert.ok(da.out);
  assert.ok(db.out);
  assert.deepEqual(renderOuts, [da.out, db.out]);
});

// ---------- create 校验（400 风格） ----------

test('create 校验：job 不存在 / 未 done / cuts 非法 → 400', async () => {
  const done = mkJobDir('job-val-done');
  const queued = mkJobDir('job-val-queued', { state: 'queued' });
  const svc = mkService(new Map([[done.id, done], [queued.id, queued]]));
  await assert.rejects(() => svc.create({}), (e: any) => e.code === 400 && /job_id/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: 'ghost' }), (e: any) => e.code === 400 && /job not found/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: queued.id }), (e: any) => e.code === 400 && /done/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: done.id, cuts: [] }), (e: any) => e.code === 400 && /cuts/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: done.id, cuts: [{ start: 9, end: 3 }] }), (e: any) => e.code === 400 && /start/.test(e.message));
});

test('create 校验：成片缺失 / 无 FIT 样本 → 400', async () => {
  const noOut = mkJobDir('job-val-noout');
  noOut.artifacts.output = '/nope/none.mp4';
  const noSamples = mkJobDir('job-val-nosamples', { withSamples: false });
  const svc = mkService(new Map([[noOut.id, noOut], [noSamples.id, noSamples]]));
  await assert.rejects(() => svc.create({ job_id: noOut.id }), (e: any) => e.code === 400 && /成片/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: noSamples.id }), (e: any) => e.code === 400 && /FIT 样本/.test(e.message));
});

// ---------- analyze：只分析不渲染 ----------

test('analyze：返回事件菜单 + 兜底计划 + 视频信息，不产生快剪记录', async () => {
  const job = mkJobDir('job-analyze');
  const svc = mkService(new Map([[job.id, job]]));
  const before = (await svc.find()).length;
  const r = await svc.analyze({ job_id: job.id });
  assert.equal(r.job_id, job.id);
  assert.equal(r.video, VIDEO);
  assert.equal(r.videoDurationS, 15); // ffprobe 读的是 fixture 真实时长（≠ job 假壳里的段时长）
  assert.deepEqual(r.segments, [{ videoStartS: 0, durationS: 2244, offsetSeconds: 0 }]);
  // 事件菜单：功率/心率/海拔/极速事件都该在（段坐标 2244s 下可映射，是否超出 15s 真实时长由调用方判断）
  const types = r.events.map((e: any) => e.type);
  for (const t of ['first_move', 'power_peak', 'hr_peak', 'alt_high', 'speed_peak']) {
    assert.ok(types.includes(t), `缺事件 ${t}（实有 ${types}）`);
  }
  assert.ok(r.events.every((e: any) => e.videoS == null || e.videoS >= 0));
  // 兜底计划：六个槽位非选即弃，且丢弃必须给原因
  assert.equal(r.plan.acts.length + r.plan.dropped.length, 6);
  assert.ok(r.plan.dropped.every((d: any) => d.reason));
  // 只读：不落记录
  assert.equal((await svc.find()).length, before);
});

test('analyze 校验：job 不存在 / 未 done → 400', async () => {
  const queued = mkJobDir('job-analyze-queued', { state: 'queued' });
  const svc = mkService(new Map([[queued.id, queued]]));
  await assert.rejects(() => svc.analyze({}), (e: any) => e.code === 400 && /job_id/.test(e.message));
  await assert.rejects(() => svc.analyze({ job_id: 'ghost' }), (e: any) => e.code === 400 && /job not found/.test(e.message));
  await assert.rejects(() => svc.analyze({ job_id: queued.id }), (e: any) => e.code === 400 && /done/.test(e.message));
});

// ---------- get / find ----------

test('get/find：单查、列表新→旧、不存在 404', async () => {
  const job = mkJobDir('job-list');
  const svc = mkService(new Map([[job.id, job]]));
  const rec = await svc.create({ job_id: job.id });
  await waitState(svc, rec.id, 'done');

  const got = await svc.get(rec.id);
  assert.equal(got.id, rec.id);
  await assert.rejects(() => svc.get('ghost'), (e: any) => e.code === 404);

  const all = await svc.find();
  assert.ok(all.some((r: any) => r.id === rec.id));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].created_at >= all[i].created_at, 'find 应按 created_at 降序');
});

// ---------- 进程重启：中间态任务标记 failed ----------

test('进程重启：加载时中间态任务标记 failed（进程重启中断）', async () => {
  const file = path.join(paths.home, 'quickcuts.json');
  const items = readJson(file, []) as any[];
  const zombie = (id: string, state: string) => ({
    id, job_id: 'job-happy', cuts: null,
    state, percent: 55, plan: null, out: null, error: null, created_at: '2026-01-01T00:00:00.000Z',
  });
  items.push(zombie('zombie-queued', 'queued'), zombie('zombie-rendering', 'rendering'), zombie('zombie-done', 'done'));
  writeJsonAtomic(file, items);

  // 重新构造服务 = 模拟进程重启
  const svc = new QuickcutService({
    queue: { get: () => null },
    configRef: { current: {} as ActpipeConfig },
    log: () => {},
  });
  for (const id of ['zombie-queued', 'zombie-rendering']) {
    const it = await svc.get(id);
    assert.equal(it.state, 'failed');
    assert.ok(it.error);
    assert.match(it.error, /进程重启中断/);
  }
  assert.equal((await svc.get('zombie-done')).state, 'done'); // 已完成的不动
});
