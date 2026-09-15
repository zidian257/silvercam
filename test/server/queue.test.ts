import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Job } from '../../src/types.ts';

// JobQueue 读写 paths.jobs / paths.staging：临时 ACTPIPE_HOME 隔离；通知走 mock
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-queue-'));
process.env.ACTPIPE_HOME = TMP_HOME;
process.env.ACTPIPE_MOCK_INTERACT = '1';
const { JobQueue, STATES, mergeProgress, mergeJobPercent, MERGE_STAGE_WEIGHTS } = await import('../../src/server/queue.ts');
const { DEFAULTS } = await import('../../src/lib/config.ts');

const VIDEO = path.resolve('fixtures/out/DJI_20260906100100.MP4');
const FIT = path.resolve('fixtures/out/activity.fit');
const OUT_DIR = path.join(TMP_HOME, 'out');

const mkQueue = () =>
  new JobQueue({
    config: { ...DEFAULTS, output_dir: OUT_DIR, auth: { password_hash: null } },
    store: null,
  });

const waitState = (queue: InstanceType<typeof JobQueue>, jobId: string, want: string, timeoutMs = 30000) =>
  new Promise<Job>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`等 ${want} 超时（当前 ${queue.get(jobId)?.state}）`)), timeoutMs);
    queue.on('event', (e) => {
      if (e.jobId !== jobId || e.type !== 'state') return;
      if (e.state === want) { clearTimeout(to); resolve(queue.get(jobId)!); }
      if (e.state === 'failed' && want !== 'failed') { clearTimeout(to); reject(new Error(`任务失败: ${e.error}`)); }
    });
  });

test('STATES 状态集合稳定', () => {
  assert.deepEqual(STATES, ['queued', 'ingesting', 'probing', 'awaiting_fit', 'rendering', 'encoding', 'copying', 'done', 'failed']);
});

test('mergeProgress：字段合并而非覆盖（percent 不被 speed 事件冲掉）', () => {
  let p = mergeProgress(null, { stage: 'encode', percent: 62 });
  p = mergeProgress(p, { stage: 'encode', speed: '0.3x' });
  assert.equal(p.percent, 62);
  assert.equal(p.speed, '0.3x');
  assert.equal(p.stage, 'encode');
});

test('纯拷贝任务（fit=none）端到端：ingest → copy → done，输出进 raw 子目录', async () => {
  const queue = mkQueue();
  const job = queue.add({ video: VIDEO, fit: 'none' });
  assert.equal(job.state, 'queued');
  assert.ok(fs.existsSync(path.join(job.dir, 'job.json'))); // 入队即落盘

  const done = await waitState(queue, job.id, 'done');
  // <output_dir>/<拍摄日期>/raw/原名.MP4
  const expectOut = path.join(OUT_DIR, '2026-09-06', 'raw', 'DJI_20260906100100.MP4');
  assert.equal(done.artifacts.output, expectOut);
  assert.ok(fs.existsSync(expectOut));
  assert.equal(fs.statSync(expectOut).size, fs.statSync(VIDEO).size); // 原样拷贝不转码
  assert.deepEqual(done.steps, { ingest: 'done', copy: 'done' }); // 无 FIT 不 probe/render
});

test('任务落盘后可被新实例恢复（done 状态保留）', async () => {
  const queue1 = mkQueue();
  const job = queue1.add({ video: VIDEO, fit: 'none' });
  await waitState(queue1, job.id, 'done');

  const queue2 = mkQueue(); // 模拟进程重启
  const revived = queue2.get(job.id);
  assert.ok(revived, '新实例应从磁盘加载历史任务');
  assert.equal(revived.state, 'done');
  assert.equal(queue2.list().length >= 1, true);
});

test('同名输出自动加序号（重跑不覆盖已有成片）', async () => {
  const freshOut = path.join(TMP_HOME, 'out-numbering'); // 独立输出目录，与前后用例隔离
  const queue = new JobQueue({ config: { ...DEFAULTS, output_dir: freshOut, auth: { password_hash: null } }, store: null });
  const j1 = queue.add({ video: VIDEO, fit: 'none' });
  const done1 = await waitState(queue, j1.id, 'done');
  const j2 = queue.add({ video: VIDEO, fit: 'none' });
  const done2 = await waitState(queue, j2.id, 'done');
  assert.match(done1.artifacts.output!, /DJI_20260906100100\.MP4$/);
  assert.match(done2.artifacts.output!, /DJI_20260906100100_2\.MP4$/);
});

test('attachFit / setOffset / realign 的校验与状态重置', async () => {
  const queue = mkQueue();
  const job = queue.add({ video: VIDEO, fit: 'none' });
  await waitState(queue, job.id, 'done');

  assert.throws(() => queue.attachFit('ghost', 'x.fit'), /job not found/);

  // realign：无 FIT 任务拒绝；bias 必须是数字
  assert.throws(() => queue.realign(job.id, 5), /没有 FIT/);
  assert.throws(() => queue.realign(job.id, 'x'), /必须是数字/);

  // setOffset：重置 fit/render/compose 步骤；done 状态不被打回 queued
  job.steps.fit = 'done';
  job.steps.render = 'done';
  queue.setOffset(job.id, 12);
  assert.equal(job.params.offset_seconds, 12);
  assert.equal(job.steps.fit, undefined);
  assert.equal(job.steps.render, undefined);
  assert.equal(job.state, 'done');
});

test('多任务串行执行：同一时刻只有一个在跑', async () => {
  const queue = mkQueue();
  let concurrent = 0;
  let maxConcurrent = 0;
  queue.on('event', (e) => {
    if (e.type !== 'state') return;
    if (e.state === 'ingesting') { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); }
    if (e.state === 'done' || e.state === 'failed') concurrent--;
  });
  const j1 = queue.add({ video: VIDEO, fit: 'none' });
  const j2 = queue.add({ video: VIDEO, fit: 'none' });
  const j3 = queue.add({ video: VIDEO, fit: 'none' });
  await Promise.all([waitState(queue, j1.id, 'done'), waitState(queue, j2.id, 'done'), waitState(queue, j3.id, 'done')]);
  assert.equal(maxConcurrent, 1); // SD 卡随机读会掉速，串行是特性
});

test('mergeJobPercent：阶段权重折算与 concat 保留 1%', () => {
  assert.equal(mergeJobPercent([]), 0);
  assert.equal(mergeJobPercent([{}, {}]), 0); // 全未开始
  assert.equal(mergeJobPercent([{ ingest: 'done', prep: 'done', render: 'done', encode: 'done' }]), 99);
  // 一段全完成、一段未开始 → 一半
  assert.equal(mergeJobPercent([{ ingest: 'done', prep: 'done', render: 'done', encode: 'done' }, {}]), 49.5);
  // 权重和必须是 1，否则进度失真
  const wSum = Object.values(MERGE_STAGE_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(wSum - 1) < 1e-9, `权重和=${wSum}`);
  // 进行中按比例折算：encode 50% → encode 权重的一半
  const pct = mergeJobPercent([{ ingest: 'done', prep: 'done', render: 'done', encode: 50 }]);
  assert.equal(pct, Math.round((MERGE_STAGE_WEIGHTS.ingest + MERGE_STAGE_WEIGHTS.prep + MERGE_STAGE_WEIGHTS.render + MERGE_STAGE_WEIGHTS.encode / 2) * 990) / 10);
});

test('两段合并任务端到端：段流水线 + concat，步骤键全部落盘', async () => {
  const VIDEO2 = path.join(TMP_HOME, 'DJI_20260906100500.MP4'); // 10:05，仍在 FIT 10:00-10:10 窗口内
  if (!fs.existsSync(VIDEO2)) fs.copyFileSync(VIDEO, VIDEO2);
  const queue = mkQueue();
  const states: string[] = [];
  queue.on('event', (e) => {
    if (e.type === 'state') states.push(e.state);
  });
  const job = queue.add({
    video: VIDEO,
    fit: FIT,
    lut: 'none',
    segments: [{ video: VIDEO }, { video: VIDEO2 }],
  });
  const done = await waitState(queue, job.id, 'done', 300000);

  for (const k of ['seg0:ingest', 'seg0:probe', 'seg0:fit', 'seg0:render', 'seg0:compose', 'seg1:ingest', 'seg1:probe', 'seg1:fit', 'seg1:render', 'seg1:compose', 'concat']) {
    assert.equal(done.steps[k], 'done', `步骤 ${k} 应完成`);
  }
  for (const art of done.artifacts.segments!) {
    assert.ok(fs.existsSync(art.intermediate!), `中间成片应存在: ${art.intermediate}`);
  }
  assert.ok(fs.existsSync(done.artifacts.output!), '合并成片应存在');
  assert.match(done.artifacts.output!, /merged/);
  assert.equal(states[0], 'ingesting'); // 状态解析：首个活跃车道是 ingest
  assert.ok(states.includes('encoding'));
  assert.equal(states.at(-1), 'done');
});
