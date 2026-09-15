// 迷你流水线调度器：任务声明 deps（先决任务名）与 lane（并发车道）。
// 全部依赖完成且车道有空位才启动；任一任务失败即 abort 全部 in-flight
// （run 收到 AbortSignal，执行器据此自杀），收尾后以首个错误 reject。
// isDone 返回 true 的任务直接跳过（视为成功），支撑 job.json 断点续跑。

export interface PipelineTask {
  name: string;
  deps: string[];
  lane?: string;
  run: (signal: AbortSignal) => unknown;
}

export interface PipelineEvent {
  type: 'start' | 'end';
  name: string;
  lane: string;
}

export interface PipelineOptions {
  lanes?: Record<string, number>;
  isDone?: (name: string) => boolean;
  onEvent?: (ev: PipelineEvent) => void;
}

type TaskState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export function runPipeline(tasks: PipelineTask[], { lanes = {}, isDone = () => false, onEvent = () => {} }: PipelineOptions = {}) {
  const state = new Map<string, TaskState>(
    tasks.map((t): [string, TaskState] => [t.name, isDone(t.name) ? 'skipped' : 'pending'])
  );
  const laneBusy = new Map<string, number>();
  const controller = new AbortController();
  const active = new Set<Promise<unknown>>();
  let firstError: unknown = null;

  const laneOf = (t: PipelineTask) => t.lane ?? 'default';
  const laneFree = (t: PipelineTask) => (laneBusy.get(laneOf(t)) ?? 0) < (lanes[laneOf(t)] ?? Infinity);
  const depsMet = (t: PipelineTask) => t.deps.every((d) => ['done', 'skipped'].includes(state.get(d) as string));
  const settled = () => [...state.values()].every((s) => ['done', 'skipped'].includes(s));

  return new Promise<void>((resolve, reject) => {
    const pump = () => {
      if (firstError) {
        if (active.size === 0) reject(firstError);
        return; // 等 in-flight 被 abort 收尾
      }
      let started = 0;
      for (const t of tasks) {
        if (state.get(t.name) !== 'pending' || !depsMet(t) || !laneFree(t)) continue;
        state.set(t.name, 'running');
        laneBusy.set(laneOf(t), (laneBusy.get(laneOf(t)) ?? 0) + 1);
        started++;
        onEvent({ type: 'start', name: t.name, lane: laneOf(t) });
        const p = Promise.resolve()
          .then(() => t.run(controller.signal))
          .then(() => state.set(t.name, 'done'))
          .catch((e) => {
            state.set(t.name, 'failed');
            if (!firstError) {
              firstError = e;
              controller.abort();
            }
          })
          .finally(() => {
            laneBusy.set(laneOf(t), laneBusy.get(laneOf(t))! - 1);
            active.delete(p);
            onEvent({ type: 'end', name: t.name, lane: laneOf(t) });
            pump();
          });
        active.add(p);
      }
      // 无 in-flight 且本轮无人能启动：要么全完成，要么依赖失败/死锁
      if (active.size === 0 && started === 0) {
        if (settled()) resolve();
        else if (firstError) reject(firstError);
        else {
          const stuck = tasks.filter((t) => state.get(t.name) === 'pending').map((t) => t.name);
          reject(new Error(`pipeline 死锁：${stuck.join(',')} 的依赖未满足`));
        }
      }
    };
    pump();
  });
}
