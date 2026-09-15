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
import type { QuickcutRenderFn, QuickcutDeps } from '../../src/server/quickcuts.ts';

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

// 造 fake job 目录（合并任务布局：seg0/samples.json + seg0/session.json；offset 0 = 无车内段）
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

// stub render（不真编码）+ stub resolveLlm（返回 null = LLM 不可达，禁止触碰真实端点）
const mkService = (jobs: Map<string, any>, { renderOuts = null as string[] | null } = {}) =>
  new QuickcutService({
    queue: { get: (id: string) => (jobs.get(id) ?? null) as Job | null },
    configRef: { current: {} as ActpipeConfig },
    log: () => {},
    resolveLlmFn: async () => null,
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

test('create → done：L0 四幕成片（offset 0 无车内段，departure/return 丢弃），llm_used=false', async () => {
  const job = mkJobDir('job-happy');
  const svc = mkService(new Map([[job.id, job]]));
  const rec = await svc.create({ job_id: job.id });
  assert.equal(rec.state, 'queued'); // create 返回入队快照，异步消化
  assert.equal(rec.percent, 0);
  assert.equal(rec.plan, null);

  const done = await waitState(svc, rec.id, 'done');
  assert.equal(done.percent, 100);
  assert.equal(done.error, null);
  assert.equal(done.llm_used, false); // LLM 不可达 → 回退 L0

  // 六幕模板：offset 0 无车内段 → departure/return 丢弃，命中其余四幕
  assert.ok(done.plan);
  assert.deepEqual(done.plan.acts.map((a: any) => a.key), ['rollout', 'climb', 'summit', 'descent']);
  const droppedKeys = done.plan.dropped.map((d: any) => d.key);
  assert.ok(droppedKeys.includes('departure'), `dropped=${droppedKeys}`);
  assert.ok(droppedKeys.includes('return'), `dropped=${droppedKeys}`);

  // 输出路径：与成片同目录、去 _dash 后缀
  assert.equal(done.out, path.join(path.dirname(VIDEO), 'DJI_20260906100100_virb_like_kuaijian.mp4'));

  // quickcuts.json 落盘
  const onDisk = readJson(path.join(paths.home, 'quickcuts.json'), []) as any[];
  const saved = onDisk.find((r) => r.id === rec.id);
  assert.ok(saved, 'quickcuts.json 未持久化该记录');
  assert.equal(saved.state, 'done');
  assert.equal(saved.plan.acts.length, 4);
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

test('create 校验：job 不存在 / 未 done / 未知场景 → 400', async () => {
  const done = mkJobDir('job-val-done');
  const queued = mkJobDir('job-val-queued', { state: 'queued' });
  const svc = mkService(new Map([[done.id, done], [queued.id, queued]]));
  await assert.rejects(() => svc.create({}), (e: any) => e.code === 400 && /job_id/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: 'ghost' }), (e: any) => e.code === 400 && /job not found/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: queued.id }), (e: any) => e.code === 400 && /done/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: done.id, scenario: 'nope' }), (e: any) => e.code === 400 && /未知快剪场景/.test(e.message));
});

test('create 校验：成片缺失 / 无 FIT 样本 → 400', async () => {
  const noOut = mkJobDir('job-val-noout');
  noOut.artifacts.output = '/nope/none.mp4';
  const noSamples = mkJobDir('job-val-nosamples', { withSamples: false });
  const svc = mkService(new Map([[noOut.id, noOut], [noSamples.id, noSamples]]));
  await assert.rejects(() => svc.create({ job_id: noOut.id }), (e: any) => e.code === 400 && /成片/.test(e.message));
  await assert.rejects(() => svc.create({ job_id: noSamples.id }), (e: any) => e.code === 400 && /FIT 样本/.test(e.message));
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
    id, job_id: 'job-happy', scenario: 'ride_4plus2', use_llm: true, llm_used: false,
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

// ---------- llm_status / llm_test（自定义方法，全部走注入 stub，禁真网络） ----------

// 假 ResolvedLlm：llm_status/llm_test 只读 describe/vision 两个字段
const fakeResolved = (over: Record<string, unknown> = {}) =>
  ({ describe: 'lmstudio/qwen3 @ http://127.0.0.1:1234/v1', vision: true, ...over }) as any;

const mkLlmService = (deps: Partial<QuickcutDeps> = {}) =>
  new QuickcutService({
    queue: { get: () => null },
    configRef: { current: {} as ActpipeConfig },
    log: () => {},
    ...deps,
  });

test('llm_status：未配置（resolve null）→ configured:false', async () => {
  const svc = mkLlmService({ resolveLlmFn: async () => null });
  const r = await svc.llm_status();
  assert.deepEqual(r, { configured: false, describe: null, vision: false });
});

test('llm_status：注入假 resolved → configured:true 且 describe/vision 透传', async () => {
  const svc = mkLlmService({ resolveLlmFn: async () => fakeResolved({ vision: false }) });
  const r = await svc.llm_status();
  assert.deepEqual(r, { configured: true, describe: 'lmstudio/qwen3 @ http://127.0.0.1:1234/v1', vision: false });
});

test('llm_test：resolve null → ok:false（未配置或端点不可达）', async () => {
  const svc = mkLlmService({ resolveLlmFn: async () => null });
  const r = await svc.llm_test({});
  assert.deepEqual(r, { ok: false, error: '未配置或端点不可达', describe: null, vision: false, latency_ms: null });
});

test('llm_test：resolve ok + 假 completeFn → ok:true 且 latency_ms 是数字（fresh 解析 + body.llm 覆盖）', async () => {
  const seen: { resolveArgs: any[]; pingCtx: any } = { resolveArgs: [], pingCtx: null };
  const svc = mkLlmService({
    resolveLlmFn: (async (...args: any[]) => {
      seen.resolveArgs.push(args);
      return fakeResolved();
    }) as any,
    completeFn: (async (_llm: any, ctx: any) => {
      seen.pingCtx = ctx;
      return { content: 'ok' };
    }) as any,
  });
  const override = { provider: 'openai-compat', base_url: 'http://x/v1', model: 'm' };
  const r = await svc.llm_test({ llm: override });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.describe, 'lmstudio/qwen3 @ http://127.0.0.1:1234/v1');
  assert.equal(r.vision, true);
  assert.ok(typeof r.latency_ms === 'number' && r.latency_ms >= 0, `latency_ms=${r.latency_ms}`);
  // fresh 重解析 + body.llm 优先于已保存配置
  assert.deepEqual(seen.resolveArgs, [[override, { fresh: true }]]);
  // ping 是真实极小一次性对话
  assert.equal(seen.pingCtx.messages.length, 1);
  assert.equal(seen.pingCtx.messages[0].role, 'user');
  assert.equal(seen.pingCtx.messages[0].content, '回复 ok 两个字');
  assert.ok(typeof seen.pingCtx.messages[0].timestamp === 'number');
});

test('llm_test：completeFn 抛错 → ok:false 且 error 含消息（describe/vision 透传）', async () => {
  const svc = mkLlmService({
    resolveLlmFn: async () => fakeResolved(),
    completeFn: (async () => {
      throw new Error('connection refused ECONNREFUSED');
    }) as any,
  });
  const r = await svc.llm_test({});
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes('connection refused'), `error=${r.error}`);
  assert.equal(r.describe, 'lmstudio/qwen3 @ http://127.0.0.1:1234/v1');
  assert.equal(r.vision, true);
  assert.equal(r.latency_ms, null);
});

test('llm_test：completeFn 返回 stopReason=error（pi-ai 失败不 reject）→ ok:false 且 error 取 errorMessage', async () => {
  const svc = mkLlmService({
    resolveLlmFn: async () => fakeResolved(),
    completeFn: (async () => ({ stopReason: 'error', errorMessage: 'fetch failed: ECONNREFUSED' })) as any,
  });
  const r = await svc.llm_test({});
  assert.equal(r.ok, false);
  assert.ok(r.error?.includes('ECONNREFUSED'), `error=${r.error}`);
  assert.equal(r.latency_ms, null);
});
