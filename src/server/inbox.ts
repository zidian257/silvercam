import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths, ensureDirs } from '../lib/paths.ts';
import { readJson, writeJsonAtomic, parseClipName, fmtDateTime } from '../lib/util.ts';
import { ingestFile } from '../modules/ingest.ts';
import type { IngestProgress } from '../modules/ingest.ts';
import { probeFile, looksDlog } from '../modules/probe.ts';
import { generateFilmstrip, thumbPath } from '../modules/thumb.ts';
import { listFits, suggestFit } from '../modules/fitlib.ts';
import type { ConfigRef, LogFn } from './services/config.ts';

// 条目的 probe 摘要（#probe 从 ProbeInfo 摘出；ffprobe 派生字段透传）。
// 全部可选：inbox.json 旧数据与测试构造的条目只带部分字段
export interface InboxProbe {
  width?: number;
  height?: number;
  fps?: number;
  duration?: number | null;
  codec?: string;
  bit_depth?: number;
  dlog_suspected?: boolean;
  pix_fmt?: string | null;
  bitrate?: number | null;
  color?: unknown; // ffprobe color 元数据透传
  audio?: unknown; // ffprobe 音频流摘要透传
  creation_time?: string | null;
  creation_time_utc_ms?: number | null;
  tags?: Record<string, unknown>;
}

export interface InboxIngest {
  state: string; // copying | ready | on_card | failed
  percent?: number;
  reused?: boolean;
  error?: string;
}

export interface InboxDecision {
  skin: string | null;
  lut: string | null;
  fit: string | null;
  bias_seconds: number | null;
}

export interface InboxItem {
  id: string;
  src: string;
  size: number;
  mtime_ms: number | null;
  volume: { name?: string | null; uuid?: string | null };
  found_at: string;
  staged: string | null; // copy_on_detect 时填入 staging/inbox/<id>/<basename>
  ingest?: InboxIngest | null;
  probe: InboxProbe | null;
  status: string; // pending | approved | skipped
  decision: InboxDecision | null;
  job_id: string | null;
  pre_align?: { fit: string | null; bias_seconds: number | null };
}

// list() 输出 = 条目 + 派生展示字段（src_exists / 拍摄时间 / FIT 预选）
export interface InboxListEntry extends InboxItem {
  src_exists: boolean;
  recorded_at: string | null;
  seq: number | null;
  recorded_src: string | null;
  fit_suggestion: string | null;
}

// recordingGroup 的中间形态：可定位到时间轴的条目
interface GroupMeta {
  it: InboxItem;
  seq: number | null;
  start: number;
  end: number;
}

// 相机素材待确认列表：插入相机后先拷贝到本机 staging 并 probe，
// 人类在 /inbox 页面确认（选哪些、套不套 LUT、用哪套皮肤）后才创建 job。
export class Inbox extends EventEmitter {
  configRef: ConfigRef;
  log: LogFn;
  file: string;
  items: InboxItem[];
  ioQueue: Promise<unknown>;

  constructor({ configRef, log = console.log }: { configRef?: ConfigRef; log?: LogFn } = {}) {
    super();
    this.configRef = configRef as ConfigRef; // 生产必传；默认值只兜底裸 new 场景
    this.log = log;
    ensureDirs();
    this.file = path.join(paths.home, 'inbox.json');
    this.items = readJson<InboxItem[]>(this.file, []);
    // 卡上只读后台任务的串行队列（缩略图、老数据补 probe；一次一个，别抢卡 IO）
    this.ioQueue = Promise.resolve();
    for (const it of this.items) {
      if (it.ingest?.state === 'copying') it.ingest = { state: 'failed', error: '进程重启，拷贝中断' };
      if (it.status === 'pending' && it.ingest?.state === 'ready' && !fs.existsSync(it.staged as string)) {
        it.ingest = { state: 'failed', error: 'staging 文件已丢失' };
      }
    }
    // 一次性自愈：同一路径的待确认条目去重（拔卡重插曾导致重复入列），保留先入列的
    const seenSrc = new Set<string>();
    const before = this.items.length;
    this.items = this.items.filter((it) => {
      if (it.status !== 'pending') return true;
      if (seenSrc.has(it.src)) return false;
      seenSrc.add(it.src);
      return true;
    });
    if (this.items.length !== before) this.log(`[inbox] 清理重复待确认条目 ${before - this.items.length} 条`);
    this.#save();
    // 启动时处理存量待确认素材：旧结构 probe（无 color 字段）惰性补 probe 拿全 meta；否则补缺失的缩略图
    for (const it of this.items) {
      if (it.status !== 'pending' || !it.probe) continue;
      if (it.probe.color === undefined) this.#enqueueReprobe(it);
      else if (!fs.existsSync(thumbPath(it.id))) this.#enqueueThumb(it);
    }
  }

  list(): InboxListEntry[] {
    return this.items
      .slice()
      // src_exists：job 实际要读的那份文件（staging 副本或卡上原件）是否还在
      // recorded_at/recorded_src：拍摄时间，优先级 文件名 > 视频 creation_time(meta) > 文件 mtime；seq 仅来自文件名
      // fit_suggestion：按 recorded_at+duration 与 FIT 库时间重叠自动预选（null = 无重叠，默认纯拷贝）
      .map((i) => {
        const info = parseClipName(i.src, null);
        let recorded_at = info?.recorded_at ?? null;
        let recorded_src: string | null = info ? info.source : null;
        let startMs = info?.start_ms ?? null;
        if (!recorded_at && i.probe?.creation_time_utc_ms != null) {
          recorded_at = fmtDateTime(new Date(i.probe.creation_time_utc_ms));
          recorded_src = 'meta';
          startMs = i.probe.creation_time_utc_ms;
        }
        if (!recorded_at && i.mtime_ms != null) {
          recorded_at = fmtDateTime(new Date(i.mtime_ms));
          recorded_src = 'mtime';
          startMs = i.mtime_ms;
        }
        const fit_suggestion =
          i.status === 'pending' ? suggestFit(listFits(this.configRef.current), { startMs, durationS: i.probe?.duration as number | null }) : null;
        return {
          ...i,
          src_exists: fs.existsSync(i.staged ?? i.src),
          recorded_at,
          seq: info?.seq ?? null,
          recorded_src,
          fit_suggestion,
        };
      })
      // 最新拍摄的排最顶上；无拍摄时间的排最后，其次按发现时间
      .sort((a, b) =>
        (b.recorded_at ?? '').localeCompare(a.recorded_at ?? '') || b.found_at.localeCompare(a.found_at)
      );
  }

  // 同一次录制的切段分组（分段录制 ~20GB 一切，而 FIT 通常只有一个）：
  // DJI 文件名 seq 相邻且首尾间隙 <30s 视为同组，按拍摄时间升序返回。
  recordingGroup(id: string): InboxItem[] {
    const item = this.get(id);
    if (!item) return [];
    const meta = (it: InboxItem): GroupMeta | null => {
      const info = parseClipName(it.src, null);
      const start = it.probe?.creation_time_utc_ms ?? info?.start_ms ?? null;
      const dur = it.probe?.duration ?? null;
      return start != null && dur != null ? { it, seq: info?.seq ?? null, start, end: start + dur * 1000 } : null;
    };
    const m0 = meta(item);
    if (!m0) return [item];
    const all = (this.items.map(meta).filter(Boolean) as GroupMeta[]).sort((a, b) => a.start - b.start);
    const idx = all.findIndex((m) => m.it.id === id);
    const linked = (a: GroupMeta, b: GroupMeta) => {
      const gap = b.start - a.end;
      return a.seq != null && b.seq === a.seq + 1 && gap < 30000 && gap > -60000;
    };
    let lo = idx, hi = idx;
    while (lo > 0 && linked(all[lo - 1], all[lo])) lo--;
    while (hi < all.length - 1 && linked(all[hi], all[hi + 1])) hi++;
    return all.slice(lo, hi + 1).map((m) => m.it);
  }

  get(id: string) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  #save() {
    writeJsonAtomic(this.file, this.items);
  }

  // 状态变更才落盘；拷贝进度只发事件（崩溃恢复时 copying 会被标记 failed）
  #changed(item: InboxItem, { persist = true }: { persist?: boolean } = {}) {
    if (persist) this.#save();
    this.emit('change', item);
  }

  // files: [{ path, size, mtime }]（watcher 已做过去重和稳定性检查）
  // 默认（inbox_copy_on_detect=false）只在卡上 probe 不落盘，确认后才由 job 拷贝；
  // 配置为 true 则立即串行拷贝到 staging。
  async addPending({ volume, files }: { volume: { name?: string | null; uuid?: string | null }; files: { path: string; size: number; mtime: number }[] }) {
    const copyOnDetect = !!this.configRef.current.inbox_copy_on_detect;
    const added: InboxItem[] = [];
    for (const f of files) {
      // 同一路径已在列（含已确认/已跳过）则跳过：拔卡重插、服务重启都会让 watcher 重新报同一批文件
      if (this.items.some((it) => it.src === f.path)) {
        this.log(`[inbox] 已在列表中，跳过重复入列：${path.basename(f.path)}`);
        continue;
      }
      const item: InboxItem = {
        id: crypto.randomUUID().slice(0, 8),
        src: f.path,
        size: f.size,
        mtime_ms: f.mtime,
        volume: { name: volume.name ?? null, uuid: volume.uuid ?? null },
        found_at: new Date().toISOString(),
        staged: null,
        ingest: { state: copyOnDetect ? 'copying' : 'on_card', percent: 0 },
        probe: null,
        status: 'pending',
        decision: null,
        job_id: null,
      };
      if (copyOnDetect) item.staged = path.join(paths.staging, 'inbox', item.id, path.basename(f.path));
      this.items.push(item);
      this.#changed(item);
      added.push(item);
    }
    // 串行拷贝/探测：SD 卡随机读会掉速，也不抢后续出片的 IO
    for (const item of added) {
      await this.#prepare(item, { copy: copyOnDetect });
    }
    return added;
  }

  async #prepare(item: InboxItem, { copy }: { copy: boolean }) {
    try {
      let reused = false;
      if (copy) {
        const result = await ingestFile(item.src, {
          stagingDir: path.dirname(item.staged as string),
          checksum: this.configRef.current.staging_checksum,
          onProgress: (p: IngestProgress) => {
            item.ingest = { state: 'copying', percent: Math.round(p.percent) };
            this.#changed(item, { persist: false });
          },
        });
        item.staged = result.staged;
        reused = result.reused ?? false;
      }
      // 不拷贝时直接在卡上 probe（ffprobe 只读文件头，很快）
      item.probe = await this.#probe(item.staged ?? item.src);
      item.ingest = copy
        ? { state: 'ready', percent: 100, reused }
        : { state: 'on_card', percent: 0 };
      this.log(`[inbox] 就绪：${path.basename(item.src)} (${item.probe.width}x${item.probe.height}@${Math.round(item.probe.fps as number)})${copy ? '' : '，在卡上未拷贝'}`);
      this.#enqueueThumb(item);
    } catch (e) {
      item.ingest = { state: 'failed', error: (e as Error).message };
      this.log(`[inbox] 拷贝/探测失败：${item.src}：${(e as Error).message}`);
    }
    this.#changed(item);
  }

  // 串行执行卡上只读后台任务；失败只记日志，不影响 inbox 流程
  #enqueueIo(fn: () => Promise<unknown>) {
    this.ioQueue = this.ioQueue.then(fn).catch(() => {});
    return this.ioQueue;
  }

  async #genThumb(item: InboxItem) {
    const file = item.staged ?? item.src;
    if (!item.probe || !fs.existsSync(file)) return;
    await generateFilmstrip(file, item.probe.duration as number, item.id);
    this.log(`[inbox] 缩略图就绪：${path.basename(item.src)}`);
  }

  // probe 成功后后台生成胶片条缩略图
  #enqueueThumb(item: InboxItem) {
    return this.#enqueueIo(async () => {
      try {
        await this.#genThumb(item);
      } catch (e) {
        this.log(`[inbox] 缩略图生成失败：${item.src}：${(e as Error).message}`);
      }
    });
  }

  // 旧结构 probe（缺 color/audio 等新字段）且源文件还在时，惰性重 probe 一次补全 meta（ffprobe 只读）
  #enqueueReprobe(item: InboxItem) {
    return this.#enqueueIo(async () => {
      try {
        const file = item.staged ?? item.src;
        if (!fs.existsSync(file)) return;
        item.probe = await this.#probe(file);
        this.#changed(item);
        this.log(`[inbox] 已补全 meta：${path.basename(item.src)}`);
        if (!fs.existsSync(thumbPath(item.id))) await this.#genThumb(item);
      } catch (e) {
        this.log(`[inbox] 补全 meta 失败：${item.src}：${(e as Error).message}`);
      }
    });
  }

  async #probe(file: string): Promise<InboxProbe> {
    const probe = await probeFile(file);
    return {
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      duration: probe.duration,
      codec: probe.codec,
      bit_depth: probe.bit_depth,
      dlog_suspected: looksDlog(probe),
      pix_fmt: probe.pix_fmt ?? null,
      bitrate: probe.bitrate || null,
      color: probe.color ?? null,
      audio: probe.audio ?? null,
      creation_time: probe.creation_time ?? null,
      creation_time_utc_ms: probe.creation_time_utc_ms ?? null,
      tags: probe.tags ?? {},
    };
  }

  // 对齐页保存的预校准：{ fit, bias_seconds }；提交时若所选 FIT 与此一致则随任务入队
  setAlign(id: string, { fit, bias_seconds }: { fit: string | null; bias_seconds: number | null }) {
    const item = this.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    if (item.status !== 'pending') throw new Error(`素材状态为 ${item.status}，不能对齐`);
    item.pre_align = { fit, bias_seconds };
    this.#changed(item);
    return item;
  }

  // 已处理条目拉回待处理重新编辑（素材是资产不是待办：出片不消耗它）。
  // adoptStaged：卡已拔出时复用上次任务的 staging 副本作为素材来源
  reopen(id: string, { adoptStaged = null }: { adoptStaged?: string | null } = {}) {
    const item = this.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    if (item.status === 'pending') throw new Error('素材本就在待处理中');
    if (adoptStaged) {
      item.staged = adoptStaged;
      item.ingest = { state: 'ready', percent: 100, reused: true };
    } else if (item.staged && fs.existsSync(item.staged)) {
      item.ingest = { state: 'ready', percent: 100 };
    } else if (fs.existsSync(item.src)) {
      item.ingest = { state: 'on_card', percent: 0 };
    } else {
      throw new Error('源文件不可用（卡已拔出且无 staging 副本），请插卡后再试');
    }
    item.status = 'pending';
    this.#changed(item);
    return item;
  }

  approve(id: string, decision: Partial<InboxDecision> = {}) {
    const item = this.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    if (item.status !== 'pending') throw new Error(`素材状态为 ${item.status}，不能重复确认`);
    if (item.ingest?.state === 'copying') throw new Error('文件拷贝中，稍候');
    if (item.ingest?.state === 'failed') throw new Error(`拷贝/探测失败：${item.ingest.error}`);
    const file = item.staged ?? item.src; // 预拷贝的读 staging，否则读卡上原件
    if (!fs.existsSync(file)) {
      throw new Error(item.staged ? 'staging 副本已丢失' : '卡已拔出或文件被移除，无法处理');
    }
    item.status = 'approved';
    item.decision = { skin: decision.skin ?? null, lut: decision.lut ?? null, fit: decision.fit ?? null, bias_seconds: decision.bias_seconds ?? null };
    this.#changed(item);
    return item;
  }

  markJob(id: string, jobId: string) {
    const item = this.get(id);
    if (!item) return;
    item.job_id = jobId;
    this.#changed(item);
  }

  skip(id: string) {
    const item = this.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    if (item.status !== 'pending') throw new Error(`素材状态为 ${item.status}`);
    item.status = 'skipped';
    this.#changed(item);
    return item;
  }

  // 从列表移除（仅 approved/skipped/拷贝失败）；deleteStaged 时连带删除 staging 副本
  dismiss(id: string, { deleteStaged = false }: { deleteStaged?: boolean } = {}) {
    const item = this.get(id);
    if (!item) throw new Error(`inbox item not found: ${id}`);
    if (item.status === 'pending' && item.ingest?.state !== 'failed') throw new Error('待确认素材不能直接移除，请先处理或跳过');
    this.items = this.items.filter((i) => i.id !== id);
    if (deleteStaged && item.staged) {
      fs.rmSync(path.dirname(item.staged), { recursive: true, force: true });
    }
    fs.rmSync(thumbPath(item.id), { force: true }); // 连带删缓存缩略图
    this.#save();
    this.emit('change', { id, removed: true });
    return item;
  }
}
