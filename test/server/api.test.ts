import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Application } from '@feathersjs/express';
import type { AddressInfo } from 'node:net';
import type { QueueLike } from '../../src/server/services/jobs.ts';

// createApp 内部用 paths.home 做鉴权数据目录、paths.fits 等：临时 ACTPIPE_HOME 隔离
process.env.ACTPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-api-'));
const { createApp } = await import('../../src/server/app.ts');
const { DEFAULTS } = await import('../../src/lib/config.ts');
// @ts-expect-error -- fitsdk 的 index.d.ts 用无扩展名 re-export，nodenext 解析不到（同 src/modules/fit.ts）
const { Encoder, Profile } = await import('@garmin/fitsdk');

const FIT = path.resolve('fixtures/out/activity.fit');
const VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4');
const LUT = path.resolve('fixtures/out/identity.cube');

// 室内骑行台形态的最小 FIT：有 record，无 position（轨迹端点的空 GPS 用例）
function makeNoGpsFit(file: string) {
  const t0 = new Date(2026, 8, 1, 8, 0, 0);
  const enc = new Encoder();
  enc.writeMesg({ mesgNum: Profile.MesgNum.FILE_ID, type: 'activity', manufacturer: 'garmin', product: 0, timeCreated: t0 });
  for (let i = 0; i <= 60; i++) {
    enc.writeMesg({ mesgNum: Profile.MesgNum.RECORD, timestamp: new Date(t0.getTime() + i * 1000), heartRate: 120 });
  }
  enc.writeMesg({ mesgNum: Profile.MesgNum.SESSION, timestamp: new Date(t0.getTime() + 61_000), startTime: t0, sport: 'cycling', totalElapsedTime: 60 });
  fs.writeFileSync(file, enc.close());
}

// Hono 的 app.request 不存在于 Feathers/Express：起真实 HTTP 端口发请求
// （redirect: manual 保持不跳转语义；断言语义与原 app.request 一致）
async function request(app: Application, path: string, init: RequestInit = {}) {
  const server = await app.listen(0);
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try {
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { redirect: 'manual', ...init });
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
}

// 最小 queue 桩：只覆盖路由用到的面（on 是 createApp 装配 realtime 时的订阅点）
type StubJob = {
  id: string;
  state: string;
  created_at: string;
  params: Record<string, unknown>;
  steps: Record<string, string>;
  artifacts: Record<string, unknown>;
  progress: null;
  error: null;
};
type QueueStub = {
  jobs: StubJob[];
  currentId: string | null;
  config: { smooth_window_s?: number } | null;
  on(): void;
  list(): StubJob[];
  get(id: string): StubJob | null;
  add(params: Record<string, unknown>): StubJob;
  attachFit(id: string): StubJob;
  setOffset(id: string, off: number): StubJob;
  realign(id: string, bias: number): StubJob;
};
const mkQueue = (): QueueStub => ({
  jobs: [],
  currentId: null,
  config: null,
  on() {},
  list() { return this.jobs; },
  get(id) { return this.jobs.find((j) => j.id === id) ?? null; },
  add(params) {
    const j = { id: `job-${this.jobs.length + 1}`, state: 'queued', created_at: new Date().toISOString(), params, steps: {}, artifacts: {}, progress: null, error: null };
    this.jobs.push(j);
    return j;
  },
  attachFit(id) { const j = this.get(id); if (!j) throw new Error(`job not found: ${id}`); j.params.fit = 'attached.fit'; return j; },
  setOffset(id, off) { const j = this.get(id); if (!j) throw new Error(`job not found: ${id}`); j.params.offset_seconds = off; return j; },
  realign(id, bias) { const j = this.get(id); if (!j) throw new Error(`job not found: ${id}`); j.params.bias_seconds = bias; return j; },
});

const mkApp = ({ inbox = null } = {}) => {
  const queue = mkQueue();
  const fitLib = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-fitlib-'));
  const configRef = { current: { ...DEFAULTS, fit_library_dir: fitLib, auth: { password_hash: null } } };
  // 桩只覆盖被测路由用到的面（无 dir 等完整 Job 字段），边界处断言一次
  return { app: createApp({ queue: queue as unknown as QueueLike, configRef, inbox }), queue, configRef, fitLib };
};

test('GET /：落地页重定向到 /dash', async () => {
  const { app } = mkApp();
  const r = await request(app, '/');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/dash');
});

test('GET /favicon.ico：SVG 图标（鉴权豁免由 auth.test 保证）', async () => {
  const { app } = mkApp();
  const r = await request(app, '/favicon.ico');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /image\/svg\+xml/);
  assert.match(await r.text(), /<svg/);
});

test('POST /jobs：视频不存在 400，存在则 201 入队', async () => {
  const { app, queue } = mkApp();
  const bad = await request(app, '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video: '/nope.mp4' }) });
  assert.equal(bad.status, 400);
  const ok = await request(app, '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ video: VIDEO, skin: 'topline' }) });
  assert.equal(ok.status, 201);
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].params.skin, 'topline');
});

test('GET /jobs 列表摘要 + GET /jobs/:id 404', async () => {
  const { app, queue } = mkApp();
  queue.add({ video: VIDEO, skin: 's', fit: 'none' });
  const list = (await (await request(app, '/jobs')).json()) as { video: string; fit: boolean }[];
  assert.equal(list.length, 1);
  assert.equal(list[0].video, 'DJI_20260906100100.MP4');
  assert.equal(list[0].fit, false); // fit:'none' 展示为 false
  const r = await request(app, '/jobs/ghost');
  assert.equal(r.status, 404);
});

test('GET /api/align/samples：FIT 采样 1Hz 网格；缺文件/非 .fit 404', async () => {
  const { app } = mkApp();
  const r = await request(app, `/api/align/samples?fit=${encodeURIComponent(FIT)}`);
  assert.equal(r.status, 200);
  const data = (await r.json()) as { count: number; fields: string[] };
  assert.equal(data.count, 601);
  assert.ok(data.fields.includes('power') && data.fields.includes('position'));

  assert.equal((await request(app, '/api/align/samples?fit=/nope.fit')).status, 404);
  assert.equal((await request(app, '/api/align/samples?fit=package.json')).status, 404);
});

test('GET /api/align/lut：none → 空链；绝对路径 → 单环链；缺失 → 404', async () => {
  const { app } = mkApp();
  assert.deepEqual(await (await request(app, '/api/align/lut?name=none')).json(), { chain: [] });
  const r = await request(app, `/api/align/lut?name=${encodeURIComponent(LUT)}`);
  assert.equal(r.status, 200);
  const { chain } = (await r.json()) as { chain: { text: string }[] };
  assert.equal(chain.length, 1);
  assert.match(chain[0].text, /LUT_3D_SIZE/);
  assert.equal((await request(app, '/api/align/lut?name=bogus_lut_name')).status, 404);
});

test('GET /luts 返回数组（含 exists 标记）', async () => {
  const { app } = mkApp();
  const r = await request(app, '/luts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(await r.json()));
});

test('POST /api/fits：上传有效 FIT 入库；无效字节 422 不留文件', async () => {
  const { app, fitLib } = mkApp();
  const buf = fs.readFileSync(FIT);
  const ok = await request(app, '/api/fits?name=uploaded.fit', { method: 'POST', body: buf });
  assert.equal(ok.status, 201);
  const fit = (await ok.json()) as { name: string; duration_s: number };
  assert.equal(fit.name, 'uploaded.fit');
  assert.equal(fit.duration_s, 600);
  assert.ok(fs.existsSync(path.join(fitLib, 'uploaded.fit')));

  const bad = await request(app, '/api/fits?name=bad.fit', { method: 'POST', body: Buffer.from('garbage') });
  assert.equal(bad.status, 422);
  assert.ok(!fs.existsSync(path.join(fitLib, 'bad.fit')));

  const wrongExt = await request(app, '/api/fits?name=x.txt', { method: 'POST', body: buf });
  assert.equal(wrongExt.status, 400);
});

test('GET /api/fits：库内 FIT 按开始时间倒序', async () => {
  const { app, fitLib } = mkApp();
  fs.copyFileSync(FIT, path.join(fitLib, 'a.fit'));
  const r = await request(app, '/api/fits');
  assert.equal(r.status, 200);
  const fits = (await r.json()) as { start_ms: number; sport: string; distance_m: number | null; has_gps: boolean }[];
  assert.equal(fits.length, 1);
  assert.equal(fits[0].start_ms, Date.parse('2026-09-06T02:00:00.000Z'));
  assert.equal(fits[0].sport, 'cycling');
  assert.equal(fits[0].distance_m, 5400);
  assert.equal(fits[0].has_gps, true);
});

test('GET /api/fits/track/:name：GPS 轨迹抽稀到 ≤240 个 [lat,lon] 点', async () => {
  const { app, fitLib } = mkApp();
  fs.copyFileSync(FIT, path.join(fitLib, 'ride.fit'));
  const r = await request(app, '/api/fits/track/ride.fit');
  assert.equal(r.status, 200);
  const { points } = (await r.json()) as { points: [number, number][] };
  assert.ok(points.length > 2 && points.length <= 240, `points=${points.length}`);
  // fixture 是绕 (31.23, 121.47) 的圆轨迹
  for (const [lat, lon] of points) {
    assert.ok(Math.abs(lat - 31.23) < 0.01 && Math.abs(lon - 121.47) < 0.01);
  }
});

test('GET /api/fits/track/:name：无 GPS → 空点；缺文件/路径穿越 404', async () => {
  const { app, fitLib } = mkApp();
  makeNoGpsFit(path.join(fitLib, 'indoor.fit'));
  const indoor = await request(app, '/api/fits/track/indoor.fit');
  assert.equal(indoor.status, 200);
  assert.deepEqual(await indoor.json(), { points: [] });
  assert.equal((await request(app, '/api/fits/track/ghost.fit')).status, 404);
  assert.equal((await request(app, '/api/fits/track/..%2F..%2Fpackage.json')).status, 404);
});

test('GET /api/fits/file/:name：原始 .fit 附件下载；缺文件 404', async () => {
  const { app, fitLib } = mkApp();
  fs.copyFileSync(FIT, path.join(fitLib, 'ride.fit'));
  const r = await request(app, '/api/fits/file/ride.fit');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') ?? '', /attachment/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.length, fs.statSync(FIT).size);
  assert.equal((await request(app, '/api/fits/file/ghost.fit')).status, 404);
});

test('inbox 未启用：相关路由统一 503', async () => {
  const { app } = mkApp({ inbox: null });
  assert.equal((await request(app, '/api/inbox')).status, 503);
  const commit = await request(app, '/api/inbox/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: [{ id: 'x' }] }) });
  assert.equal(commit.status, 503);
});

test('GET /api/status：watcher/inbox/队列汇总', async () => {
  const { app, queue } = mkApp();
  queue.add({ video: VIDEO });
  const r = await request(app, '/api/status');
  assert.equal(r.status, 200);
  const s = (await r.json()) as {
    watcher: { active: boolean };
    inbox: { pending: number; total: number };
    jobs: { total: number; by_state: Record<string, number> };
  };
  assert.equal(s.watcher.active, false);
  assert.deepEqual(s.inbox, { pending: 0, total: 0 });
  assert.equal(s.jobs.total, 1);
  assert.equal(s.jobs.by_state.queued, 1);
});

test('GET /api/align/source：三参数必给其一', async () => {
  const { app } = mkApp();
  assert.equal((await request(app, '/api/align/source')).status, 400);
});

test('PUT /config：合并写入并同步 queue.config', async () => {
  const { app, queue, configRef } = mkApp();
  const r = await request(app, '/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ smooth_window_s: 5 }) });
  assert.equal(r.status, 200);
  assert.equal(configRef.current.smooth_window_s, 5);
  assert.equal(queue.config!.smooth_window_s, 5);
});

test('POST /jobs/:id/fit 与 /jobs/:id/offset：校验与 404', async () => {
  const { app, queue } = mkApp();
  const job = queue.add({ video: VIDEO });
  const noFit = await request(app, `/jobs/${job.id}/fit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fit: '/nope.fit' }) });
  assert.equal(noFit.status, 400);
  const okFit = await request(app, `/jobs/${job.id}/fit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fit: FIT }) });
  assert.equal(okFit.status, 200);
  const badOffset = await request(app, `/jobs/${job.id}/offset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offset_seconds: 'x' }) });
  assert.equal(badOffset.status, 400);
  assert.equal((await request(app, '/jobs/ghost/fit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fit: FIT }) })).status, 404);
});

test('POST /jobs/:id/bias：转发 realign，错误 400', async () => {
  const { app, queue } = mkApp();
  const job = queue.add({ video: VIDEO });
  const bad = await request(app, `/jobs/${job.id}/bias`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bias_seconds: 'x' }) });
  assert.equal(bad.status, 400);
  const ok = await request(app, `/jobs/${job.id}/bias`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bias_seconds: -2.5 }) });
  assert.equal(ok.status, 200);
  assert.equal(queue.get(job.id)!.params.bias_seconds, -2.5);
  assert.equal((await request(app, '/jobs/ghost/bias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bias_seconds: 1 }) })).status, 400);
});

test('GET /quickcuts/:id/log：有记录回日志文本；无记录 404', async () => {
  const home = process.env.ACTPIPE_HOME!;
  // createApp 内部构造 QuickcutService 时读 quickcuts.json：先落一条 done 记录 + 日志文件
  fs.writeFileSync(path.join(home, 'quickcuts.json'), JSON.stringify([
    { id: 'qc1', job_id: 'job-1', cuts: null, use_llm: true, llm_used: false, state: 'done', percent: 100, plan: null, out: '/x.mp4', error: null, created_at: '2026-09-18T00:00:00.000Z' },
  ]));
  fs.mkdirSync(path.join(home, 'quickcuts'), { recursive: true });
  fs.writeFileSync(path.join(home, 'quickcuts', 'qc1.log'), '[10:00:00] L0 兜底出 4 幕\n');
  const { app } = mkApp();
  const ok = await request(app, '/quickcuts/qc1/log');
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /L0 兜底出 4 幕/);
  assert.equal((await request(app, '/quickcuts/ghost/log')).status, 404);
});
