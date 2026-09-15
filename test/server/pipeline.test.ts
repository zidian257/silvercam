import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPipeline } from '../../src/server/pipeline.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('依赖顺序：deps 未完成前不启动', async () => {
  const order: string[] = [];
  const t = (name: string, deps: string[] = [], ms = 10) => ({
    name, deps, lane: 'x',
    run: async () => { await sleep(ms); order.push(name); },
  });
  await runPipeline([t('c', ['b']), t('b', ['a']), t('a')], { lanes: { x: 3 } });
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('车道并发上限：limit 2 时最大并发为 2 且确实并行', async () => {
  let cur = 0;
  let max = 0;
  const tasks = Array.from({ length: 5 }, (_, i) => ({
    name: `t${i}`, deps: [], lane: 'enc',
    run: async () => { cur++; max = Math.max(max, cur); await sleep(30); cur--; },
  }));
  await runPipeline(tasks, { lanes: { enc: 2 } });
  assert.equal(max, 2); // 5 个任务全跑完且峰值并发顶到上限
});

test('无 lane 声明的任务不受限', async () => {
  let max = 0;
  let cur = 0;
  const tasks = Array.from({ length: 4 }, (_, i) => ({
    name: `t${i}`, deps: [],
    run: async () => { cur++; max = Math.max(max, cur); await sleep(20); cur--; },
  }));
  await runPipeline(tasks);
  assert.equal(max, 4);
});

test('isDone 跳过：run 不执行，下游照常', async () => {
  const ran: string[] = [];
  await runPipeline(
    [
      { name: 'a', deps: [], run: async () => ran.push('a') },
      { name: 'b', deps: ['a'], run: async () => ran.push('b') },
    ],
    { isDone: (n: string) => n === 'a' }
  );
  assert.deepEqual(ran, ['b']);
});

test('失败即 abort：in-flight 收到 signal，pending 不再启动，以首个错误 reject', async () => {
  let observedAbort = false;
  const ran: string[] = [];
  const tasks = [
    {
      name: 'slow', deps: [], lane: 'x',
      run: async (signal: AbortSignal) => {
        ran.push('slow');
        for (let i = 0; i < 100 && !signal.aborted; i++) await sleep(5);
        observedAbort = signal.aborted;
      },
    },
    { name: 'bad', deps: [], lane: 'x', run: async () => { ran.push('bad'); await sleep(10); throw new Error('boom'); } },
    { name: 'later', deps: ['slow'], run: async () => ran.push('later') },
  ];
  await assert.rejects(runPipeline(tasks, { lanes: { x: 2 } }), /boom/);
  assert.equal(observedAbort, true);
  assert.ok(!ran.includes('later'));
});

test('依赖不存在/环：报死锁而非挂起', async () => {
  await assert.rejects(
    runPipeline([{ name: 'a', deps: ['ghost'], run: async () => {} }]),
    /死锁/
  );
});

test('onEvent 上报 start/end，可用于外部状态聚合', async () => {
  const events: string[] = [];
  await runPipeline(
    [{ name: 'a', deps: [], lane: 'enc', run: async () => {} }],
    { lanes: { enc: 1 }, onEvent: (e: { type: string; name: string; lane: string }) => events.push(`${e.type}:${e.name}:${e.lane}`) }
  );
  assert.deepEqual(events, ['start:a:enc', 'end:a:enc']);
});

test('空任务集立即完成', async () => {
  await runPipeline([]);
});
