import fs from 'node:fs';
import path from 'node:path';
import { BadRequest, NotFound, Unavailable } from '@feathersjs/errors';
import type { Params } from '@feathersjs/feathers';
import type { SegmentArtifacts } from '../../types.ts';
import { parseClipName } from '../../lib/util.ts';
import type { Inbox, InboxItem } from '../inbox.ts';
import type { QueueLike } from './jobs.ts';
import type { ConfigRef } from './config.ts';

// /api/inbox 素材确认资源：列表（find）、删除（remove）+ custom methods
// commit（集合级，POST /api/inbox/commit）/ align / reopen（实例级，POST /api/inbox/:id/{align,reopen}）
// custom method 签名为 (data, params)，实例 id 经 params.route.__id 传入。
export class InboxService {
  queue: QueueLike;
  configRef: ConfigRef;
  inbox: Inbox | null;

  constructor({ queue, configRef, inbox }: { queue: QueueLike; configRef: ConfigRef; inbox: Inbox | null }) {
    this.queue = queue;
    this.configRef = configRef;
    this.inbox = inbox;
  }

  needInbox(): asserts this is this & { inbox: Inbox } {
    if (!this.inbox) throw new Unavailable('inbox 未启用');
  }

  async find() {
    this.needInbox();
    return this.inbox.list();
  }

  async remove(id: string, params: Params) {
    this.needInbox();
    try {
      const item = this.inbox.dismiss(id, { deleteStaged: params.query?.delete_staged === '1' });
      return { ok: true, removed: item.id };
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  }

  // 素材库条目保存预校准（fit + bias），提交入队时随决策生效；
  // 同次录制的切段共享同一 FIT，bias 一并传播（合并任务全段用同一 bias）
  async align(data: any, params: Params) {
    this.needInbox();
    const body = data ?? {};
    if (!body.fit || !fs.existsSync(body.fit)) throw new BadRequest('fit 文件不存在');
    if (typeof body.bias_seconds !== 'number' || !Number.isFinite(body.bias_seconds)) throw new BadRequest('bias_seconds (number) required');
    try {
      const id = params.route!.__id;
      const saved = this.inbox.setAlign(id, { fit: body.fit, bias_seconds: body.bias_seconds });
      let propagated = 0;
      for (const g2 of this.inbox.recordingGroup(id)) {
        if (g2.id === id || g2.status !== 'pending') continue;
        this.inbox.setAlign(g2.id, { fit: body.fit, bias_seconds: body.bias_seconds });
        propagated++;
      }
      return { ...saved, group_propagated: propagated };
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  }

  // 已处理条目重新拉回待处理（素材是资产不是待办）：优先复用 job staging 副本，不用插卡
  async reopen(data: any, params: Params) {
    this.needInbox();
    const id = params.route!.__id;
    const item = this.inbox.get(id);
    if (!item) throw new NotFound('not found');
    try {
      let adopt: string | null = null;
      if (item.staged && fs.existsSync(item.staged)) adopt = item.staged;
      else if (fs.existsSync(item.src)) adopt = null; // 卡上的原件还在，直接用
      else if (item.job_id) {
        // 卡已拔出且 inbox 未预拷贝：找该素材上次出片任务的 staging 副本
        const job = this.queue.get(item.job_id);
        const arts: SegmentArtifacts[] = (job?.params.segments?.length as number) > 1 ? (job!.artifacts.segments ?? []) : job ? [job.artifacts] : [];
        const hit = arts.find((a) => a?.ingest && (a.ingest.src === item.src || a.ingest.src === item.staged) && fs.existsSync(a.ingest.staged));
        if (hit) adopt = hit.ingest!.staged;
      }
      return this.inbox.reopen(item.id, { adoptStaged: adopt });
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  }

  // 批量提交审核决定：[{ id, action: 'process'|'skip', skin, lut, fit }]
  // skin: 皮肤名（缺省用全局默认）；lut: null=自动 / 'none'=不套 / 名字或路径
  // fit: FIT 路径 / 'none'=无 FIT 纯拷贝（不进 overlay 流程）/ 缺省=旧行为（autopick 或人工选）
  // 多段选了同一显式 FIT（且皮肤/LUT 一致）→ 判定为同一次录制的切段，合并为一个任务出一条成片
  async commit(data: any) {
    this.needInbox();
    const { queue, inbox } = this;
    const body = data ?? {};
    const decisions = Array.isArray(body.decisions) ? body.decisions : [];
    if (!decisions.length) throw new BadRequest('decisions 不能为空');
    const results: Record<string, unknown>[] = [];

    // 对齐页预校准（pre_align）随决策生效：所选 FIT 与校准时一致才带 bias，换了 FIT 则作废
    const biasOf = (item: InboxItem | null, fit: string | null) => (item?.pre_align && item.pre_align.fit === fit ? item.pre_align.bias_seconds : null);

    const spawnSingle = (d: any) => {
      const fit = d.fit === 'none' ? 'none' : d.fit || null;
      if (fit && fit !== 'none' && !fs.existsSync(fit)) throw new Error(`FIT 文件不存在：${fit}`);
      const bias = biasOf(inbox.get(d.id), fit === 'none' ? null : fit);
      const item = inbox.approve(d.id, { skin: d.skin || null, lut: d.lut ?? null, fit, bias_seconds: bias });
      // 预拷贝的用 staging 副本（origin 记账）；默认直接从卡上读，job 的 ingest 步骤负责拷贝
      const preStaged = item.staged && fs.existsSync(item.staged);
      const job = queue.add({
        video: preStaged ? item.staged : item.src,
        skin: d.skin || undefined,
        lut: d.lut ?? null,
        ...(fit ? { fit } : {}),
        ...(bias != null ? { bias_seconds: bias } : {}),
        ...(preStaged ? { origin: item.src, origin_size: item.size, origin_mtime: item.mtime_ms } : {}),
      });
      inbox.markJob(d.id, job.id);
      results.push({ id: d.id, job_id: job.id });
    };

    // 拍摄起点：文件名时间戳 > 视频 meta creation_time > 文件 mtime（与 inbox.list 的口径一致）
    const startMsOf = (item: InboxItem) =>
      parseClipName(item.src, null)?.start_ms ?? item.probe?.creation_time_utc_ms ?? item.mtime_ms ?? 0;

    const mergeGroups = new Map<string, any[]>(); // `${fit}|${skin}|${lut}` -> [decision]
    for (const d of decisions) {
      if (d.action === 'skip') {
        try {
          inbox.skip(d.id);
          results.push({ id: d.id, skipped: true });
        } catch (e) {
          results.push({ id: d.id, error: (e as Error).message });
        }
        continue;
      }
      const fit = d.fit === 'none' ? null : d.fit || null;
      if (!fit || d.merge === false) { // merge:false = 用户在确认弹窗里选了分段输出
        try {
          spawnSingle(d);
        } catch (e) {
          results.push({ id: d.id, error: (e as Error).message });
        }
        continue;
      }
      const key = `${fit}|${d.skin || ''}|${d.lut ?? ''}`;
      if (!mergeGroups.has(key)) mergeGroups.set(key, []);
      mergeGroups.get(key)!.push(d);
    }

    for (const group of mergeGroups.values()) {
      if (group.length === 1) {
        try {
          spawnSingle(group[0]);
        } catch (e) {
          results.push({ id: group[0].id, error: (e as Error).message });
        }
        continue;
      }
      try {
        const fit = group[0].fit;
        if (!fs.existsSync(fit)) throw new Error(`FIT 文件不存在：${fit}`);
        // 先整组校验再逐个 approve，避免半途部分入列
        const members = group.map((d) => {
          const item = inbox.get(d.id);
          if (!item) throw new Error(`inbox item not found: ${d.id}`);
          if (item.status !== 'pending') throw new Error(`${path.basename(item.src)} 状态为 ${item.status}，不能重复确认`);
          if (item.ingest?.state === 'copying') throw new Error(`${path.basename(item.src)} 拷贝中，稍候`);
          if (item.ingest?.state === 'failed') throw new Error(`${path.basename(item.src)} 拷贝/探测失败：${item.ingest.error}`);
          const file = item.staged ?? item.src;
          if (!fs.existsSync(file)) throw new Error(`${path.basename(item.src)} 文件不可用（卡已拔出？）`);
          return { d, item, file };
        });
        members.sort((a, b) => startMsOf(a.item) - startMsOf(b.item) || a.item.src.localeCompare(b.item.src));
        const segments = members.map(({ item, file }) => ({
          video: file,
          ...(item.staged && file === item.staged
            ? { origin: item.src, origin_size: item.size, origin_mtime: item.mtime_ms }
            : {}),
        }));
        const d0 = members[0].d;
        // 同一次录制的切段共用同一对相机+码表，时钟偏差相同：组内首个非空 bias 传播全组
        const gbias = members.map(({ item }) => biasOf(item, fit)).find((b) => b != null) ?? null;
        const job = queue.add({
          video: segments[0].video,
          segments,
          skin: d0.skin || undefined,
          lut: d0.lut ?? null,
          fit,
          ...(gbias != null ? { bias_seconds: gbias } : {}),
        });
        for (const { d } of members) {
          inbox.approve(d.id, { skin: d.skin || null, lut: d.lut ?? null, fit, bias_seconds: gbias });
          inbox.markJob(d.id, job.id);
          results.push({ id: d.id, job_id: job.id, merged: segments.length });
        }
      } catch (e) {
        for (const d of group) results.push({ id: d.id, error: (e as Error).message });
      }
    }
    return { results };
  }
}
