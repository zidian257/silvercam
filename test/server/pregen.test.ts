import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PregenService 读写 paths.fits / paths.dashboards：临时 ACTPIPE_HOME 隔离
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-pregen-'));
process.env.ACTPIPE_HOME = TMP_HOME;
const { PregenService } = await import('../../src/server/pregen.ts');
const { DEFAULTS } = await import('../../src/lib/config.ts');
const { paths, ensureDirs } = await import('../../src/lib/paths.ts');

const FIT = path.resolve('fixtures/out/activity.fit');
ensureDirs();
const FIT_IN_LIB = path.join(paths.fits, 'activity.fit');
if (!fs.existsSync(FIT_IN_LIB)) fs.copyFileSync(FIT, FIT_IN_LIB);

const mkCfg = (over = {}) => ({
  ...DEFAULTS,
  max_swap_mb: 0, // 测试机 swap 常年超预算：关门，水位门逻辑另有 util 层测试
  skin: 'virb_like',
  ...over,
});
// 渲染 fake 只消费这几个字段（真实 spec 还有 skinDir/samples/toFitS 等）
type RenderSpec = { fitFile: string; width: number; height: number; fps: number; fromFitS: number };
type SvcOpts = {
  cfg?: ReturnType<typeof mkCfg>;
  queue?: { running: boolean } | null;
  render?: (spec: RenderSpec) => Promise<void>;
  cacheComplete?: (key: string) => boolean;
};
const mkSvc = ({ cfg = mkCfg(), queue = null, render, cacheComplete }: SvcOpts = {}) => {
  const calls: RenderSpec[] = [];
  const svc = new PregenService({
    configRef: { current: cfg },
    queue,
    log: () => {},
    render: render ?? (async (spec: RenderSpec) => { calls.push(spec); }),
    cacheComplete: cacheComplete ?? (() => false),
  });
  return { svc, calls };
};
const settle = (svc: InstanceType<typeof PregenService>) => svc.whenIdle();

test('enqueue 去重：同一 FIT 重复入队只渲染一次', async () => {
  const { svc, calls } = mkSvc();
  svc.enqueue(FIT_IN_LIB);
  svc.enqueue(FIT_IN_LIB);
  await settle(svc);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].fps, 10); // fps null → 跟随 overlay_fps 生产规格
  assert.equal(calls[0].width, 3840);
  assert.equal(calls[0].fromFitS, 0);
});

test('串行消化：两个 FIT 依次渲染，不并发', async () => {
  const FIT2 = path.join(paths.fits, 'activity2.fit');
  fs.copyFileSync(FIT, FIT2);
  let inflight = 0;
  let maxInflight = 0;
  const order: string[] = [];
  const { svc } = mkSvc({
    render: async (spec) => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      order.push(path.basename(spec.fitFile));
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
    },
  });
  svc.enqueue(FIT_IN_LIB);
  svc.enqueue(FIT2);
  await settle(svc);
  assert.deepEqual(order, ['activity.fit', 'activity2.fit']);
  assert.equal(maxInflight, 1);
  fs.rmSync(FIT2, { force: true });
});

test('失败隔离：第一个 FIT 渲染抛错，第二个照常', async () => {
  const FIT2 = path.join(paths.fits, 'activity3.fit');
  fs.copyFileSync(FIT, FIT2);
  const done: string[] = [];
  const { svc } = mkSvc({
    render: async (spec) => {
      if (spec.fitFile.endsWith('activity.fit')) throw new Error('boom');
      done.push(path.basename(spec.fitFile));
    },
  });
  svc.enqueue(FIT_IN_LIB);
  svc.enqueue(FIT2);
  await settle(svc);
  assert.deepEqual(done, ['activity3.fit']);
  fs.rmSync(FIT2, { force: true });
});

test('闲时纪律：生产队列忙时预生成等待，空闲后才渲染', async () => {
  const queue = { running: true };
  let renderedAt = 0;
  const { svc } = mkSvc({ queue, render: async () => { renderedAt = Date.now(); } });
  const t0 = Date.now();
  setTimeout(() => { queue.running = false; }, 100);
  svc.enqueue(FIT_IN_LIB);
  await settle(svc);
  assert.ok(renderedAt - t0 >= 90, `应等队列空闲（实际 ${renderedAt - t0}ms）`);
});

test('缓存完整即跳过：不发起渲染', async () => {
  const { svc, calls } = mkSvc({ cacheComplete: () => true });
  svc.enqueue(FIT_IN_LIB);
  await settle(svc);
  assert.equal(calls.length, 0);
});

test('start 的启动补扫：近期 FIT 入队，过期 FIT 不扫', async () => {
  const NEW = path.join(paths.fits, 'new-recent.fit');
  const OLD = path.join(paths.fits, 'old-stale.fit');
  fs.copyFileSync(FIT, NEW);
  fs.copyFileSync(FIT, OLD);
  const old = Date.now() - 30 * 86400_000;
  fs.utimesSync(OLD, old / 1000, old / 1000);
  const { svc, calls } = mkSvc({ cfg: mkCfg({ pregen: { enabled: true, fps: null, resolutions: ['3840x2160'], boot_days: 7 } }) });
  await svc.start();
  await settle(svc);
  await svc.stop();
  const rendered = calls.map((c) => path.basename(c.fitFile));
  assert.ok(rendered.includes('new-recent.fit'), '近期 FIT 应补扫');
  assert.ok(!rendered.includes('old-stale.fit'), '过期 FIT 不应补扫');
  fs.rmSync(NEW, { force: true });
  fs.rmSync(OLD, { force: true });
});

test('pregen.enabled=false：start 直接退出，不监听不补扫', async () => {
  const { svc, calls } = mkSvc({ cfg: mkCfg({ pregen: { enabled: false, fps: null, resolutions: ['3840x2160'], boot_days: 7 } }) });
  await svc.start();
  assert.equal(svc.watcher, null);
  assert.equal(calls.length, 0);
});
