import { BadRequest } from '@feathersjs/errors';
import type { ActpipeConfig } from '../../types.ts';
import { saveConfig } from '../../lib/config.ts';
import type { QueueLike } from './jobs.ts';

// 可变配置引用：index.js 装配一次，各 service/中间件共享；update 时整体替换 current
export interface ConfigRef {
  current: ActpipeConfig;
}

// 日志回调：各组件只要求「能吃 printf 风格参数」，console.log 与 () => {} 都满足
export type LogFn = (...args: any[]) => void;

// /config 单例配置资源：GET /config → find()，PUT /config → update(null, data)
// （Feathers REST 对无 id 的 GET/PUT 分别映射 find/update）
export class ConfigService {
  queue: QueueLike;
  configRef: ConfigRef;

  constructor({ queue, configRef }: { queue: QueueLike; configRef: ConfigRef }) {
    this.queue = queue;
    this.configRef = configRef;
  }

  async find() {
    return this.configRef.current;
  }

  async update(id: null, data: any) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.isBuffer(data)) {
      throw new BadRequest('json body required');
    }
    this.configRef.current = { ...this.configRef.current, ...data };
    this.queue.config = this.configRef.current;
    saveConfig(this.configRef.current);
    return this.configRef.current;
  }
}
