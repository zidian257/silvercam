import fs from 'node:fs';
import path from 'node:path';
import { BadRequest, NotFound } from '@feathersjs/errors';
import type { Params } from '@feathersjs/feathers';
import type { ActpipeConfig, Job } from '../../types.ts';

// 队列的结构面：JobQueue（生产）与 API 测试里的最小桩都满足。
// 字段在 queue.ts 补声明前可能不在类型上，故标可选；方法签名按 Job 域类型。
export interface QueueLike {
  config?: ActpipeConfig | null;
  currentId?: string | null;
  running?: boolean;
  on(event: string, cb: (...args: any[]) => void): unknown;
  list(): Job[];
  get(id: string): Job | null;
  add(params: any): Job; // params 是 HTTP body / CLI 组装的原始入队参数
  attachFit(id: string, fitPath: string): unknown;
  setOffset(id: string, offsetSeconds: number): unknown;
  realign(id: string, biasSeconds: number): unknown;
  updatePrefs(id: string, prefs: { skin?: string; lut?: string | null }): unknown;
}

// /jobs 任务资源：列表摘要/详情/创建 + custom methods fit/offset/bias
// （URL 契约 POST /jobs/:id/fit 等由 app.js 的 customMethodBridge 翻译成 x-service-method，
//   id 经 params.route.__id 传入，custom method 签名为 (data, params)）
export class JobsService {
  queue: QueueLike;

  constructor({ queue }: { queue: QueueLike }) {
    this.queue = queue;
  }

  async find() {
    return this.queue.list().map((j) => ({
      id: j.id,
      state: j.state,
      created_at: j.created_at,
      video: path.basename(j.params.video),
      segments: j.params.segments?.length ?? null,
      skin: j.params.skin,
      fit: !!(j.params.fit && j.params.fit !== 'none'),
      bias_seconds: j.params.bias_seconds ?? null,
      // 出片后会自动快剪的任务（dash 列表标记；无 FIT 的任务永不自动快剪）
      quickcut: !!(j.params.fit && j.params.fit !== 'none') && !!(j.params.quickcut ?? this.queue.config?.quickcut_auto ?? false),
      progress: j.progress,
      error: j.error,
      output: j.artifacts?.output ?? null,
    }));
  }

  async get(id: string) {
    const job = this.queue.get(id);
    if (!job) throw new NotFound('not found');
    return job;
  }

  async create(data: any) {
    const body = data ?? {};
    if (!body.video || !fs.existsSync(body.video)) {
      throw new BadRequest(`video not found: ${body.video}`);
    }
    return this.queue.add(body);
  }

  async fit(data: any, params: Params) {
    const body = data ?? {};
    if (!body.fit || !fs.existsSync(body.fit)) throw new BadRequest('fit file not found');
    try {
      return this.queue.attachFit(params.route!.__id, body.fit);
    } catch (e) {
      throw new NotFound((e as Error).message);
    }
  }

  async offset(data: any, params: Params) {
    const body = data ?? {};
    if (typeof body.offset_seconds !== 'number') throw new BadRequest('offset_seconds (number) required');
    try {
      return this.queue.setOffset(params.route!.__id, body.offset_seconds);
    } catch (e) {
      throw new NotFound((e as Error).message);
    }
  }

  // 应用 bias 并重渲（重编码整段，旧成片保留）；realign 的校验错误对外是 400
  async bias(data: any, params: Params) {
    const body = data ?? {};
    if (typeof body.bias_seconds !== 'number' || !Number.isFinite(body.bias_seconds)) {
      throw new BadRequest('bias_seconds (number) required');
    }
    try {
      return this.queue.realign(params.route!.__id, body.bias_seconds);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  }

  // studio 预览选择回写（皮肤/LUT）：只写给出的键，不重跑任务；队列错误同 bias 一律 400
  async prefs(data: any, params: Params) {
    const body = data ?? {};
    if ('skin' in body && typeof body.skin !== 'string') throw new BadRequest('skin 必须是字符串');
    if ('lut' in body && body.lut !== null && typeof body.lut !== 'string') throw new BadRequest('lut 必须是字符串或 null');
    const patch: { skin?: string; lut?: string | null } = {};
    if ('skin' in body) patch.skin = body.skin;
    if ('lut' in body) patch.lut = body.lut;
    if (!Object.keys(patch).length) throw new BadRequest('skin/lut 至少给一个');
    try {
      return this.queue.updatePrefs(params.route!.__id, patch);
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  }
}
