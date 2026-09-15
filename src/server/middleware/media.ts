import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { resolveSkinDir, paths, ensureDirs } from '../../lib/paths.ts';
import { resolveLutPath, listLuts, saveConfig } from '../../lib/config.ts';
import { parseClipName, parseTimecode, runOk } from '../../lib/util.ts';
import { storeKind } from '../../lib/db.ts';
import { probeFile, looksDlog } from '../../modules/probe.ts';
import { listFits, suggestFit } from '../../modules/fitlib.ts';
import { decodeFit, processRecords, fitToFiles } from '../../modules/fit.ts';
import type { ProcessedSamples } from '../../modules/fit.ts';
import { renderPreviewFrame } from '../../modules/render.ts';
import { buildSkin, buildSkinHtml } from '../../modules/skin-build.ts';
import { generateFilmstrip, thumbPath } from '../../modules/thumb.ts';
import * as strava from '../../modules/strava.ts';
import type { Job, SegmentArtifacts } from '../../types.ts';
import type { AppContext } from '../app.ts';

// 媒体/元信息路由：时间轴对齐数据源、Range 视频流、预览截图、日志、LUT/皮肤清单、全局状态、Strava。
// 这些端点保持普通 Express handler（JSON 直写或流式），不扭成 service。
export function createMediaRouter({ queue, configRef, inbox, refs }: AppContext) {
  const router = Router();

  // 收集任务的段产物（单段任务伪装成一段）
  const segArts = (job: Job): { i: number; name: string; art: SegmentArtifacts }[] =>
    (job.params.segments?.length as number) > 1
      ? job.params.segments!.map((s, i) => ({ i, name: path.basename(s.video), art: job.artifacts.segments?.[i] ?? {} }))
      : [{ i: 0, name: path.basename(job.params.video), art: job.artifacts }];

  router.get('/jobs/:id/align', (req: Request, res: Response) => {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const hasFit = !!(job.params.fit && job.params.fit !== 'none');
    const running = queue.currentId === job.id || ['ingesting', 'probing', 'rendering', 'encoding'].includes(job.state);
    const segments = segArts(job).map(({ i, name, art }) => {
      const probe = art.probe;
      const session = art.session;
      const offset = session?.offset_seconds ?? null;
      const bias = (session?.anchor?.bias_seconds ?? null) as number | null; // anchor 是动态字段集
      const fitLenS = session?.activity?.duration_s ?? null;
      const duration = probe?.duration ?? null;
      // 数据在视频里的出现窗口 [start_t, end_t]；start>=end 即整段无数据
      let start_t = null;
      let end_t = null;
      if (offset != null && duration != null && fitLenS != null) {
        start_t = Math.max(0, -offset);
        end_t = Math.min(duration, fitLenS - offset);
      }
      return {
        i,
        name,
        duration,
        staged_exists: art.ingest?.staged ? fs.existsSync(art.ingest.staged) : false,
        offset,
        auto_offset: offset != null && bias != null ? offset - bias : null,
        data_start_t: start_t,
        data_end_t: end_t,
        empty: start_t != null && end_t != null ? start_t >= end_t : null,
      };
    });
    return res.json({
      id: job.id,
      state: job.state,
      fit: hasFit ? job.params.fit : null,
      skin: job.params.skin,
      job_bias: job.params.bias_seconds ?? null,
      bias_seconds: job.params.bias_seconds ?? configRef.current.global_bias_seconds ?? 0,
      running,
      can_realign: hasFit && !running && segments.every((s) => s.staged_exists),
      segments,
    });
  });

  router.get('/jobs/:id/log', (req: Request, res: Response) => {
    const job = queue.get(req.params.id);
    if (!job) return res.status(404).type('text').send('not found');
    const file = path.join(job.dir, 'log.txt');
    return res.type('text').send(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(no log yet)');
  });

  // 对齐页数据源：返回统一形态 { kind, skin, fit, bias_seconds, fits?, segments: [{i,name,duration,creation_time_utc_ms,video}] }
  // video 是给 /api/align/video?src= 用的 token（job:<id>:<seg> | inbox:<id> | file:<path>），null = 源不可用
  router.get('/api/align/source', async (req: Request, res: Response) => {
    const jobId = req.query.job as string | undefined;
    const inboxId = req.query.inbox as string | undefined;
    const videoPath = req.query.video as string | undefined;
    if (jobId) {
      const job = queue.get(jobId);
      if (!job) return res.status(404).json({ error: 'job not found' });
      if (!job.params.fit || job.params.fit === 'none') return res.status(422).json({ error: '该任务没有 FIT（纯拷贝），无需对齐' });
      const isMerge = (job.params.segments?.length as number) > 1;
      const segs = isMerge
        ? job.params.segments!.map((s, i) => ({ i, name: path.basename(s.origin ?? s.video), art: job.artifacts.segments?.[i] ?? {} }))
        : [{ i: 0, name: path.basename(job.params.video), art: job.artifacts }];
      return res.json({
        kind: 'job',
        id: job.id,
        state: job.state,
        skin: job.params.skin,
        fit: job.params.fit,
        bias_seconds: job.params.bias_seconds ?? configRef.current.global_bias_seconds ?? 0,
        lut: (isMerge ? job.artifacts.segments?.[0]?.probe : job.artifacts.probe)?.lut_decision?.lut ?? null,
        default_lut: configRef.current.default_lut ?? null,
        running: ['ingesting', 'probing', 'rendering', 'encoding'].includes(job.state),
        segments: segs.map(({ i, name, art }) => ({
          i,
          name,
          duration: art.probe?.duration ?? null,
          fps: art.probe?.fps ?? null,
          creation_time_utc_ms: art.probe?.creation_time_utc_ms ?? null,
          video: art.ingest?.staged && fs.existsSync(art.ingest.staged) ? `job:${job.id}:${i}` : null,
        })),
      });
    }
    if (inboxId) {
      if (!inbox) return res.status(503).json({ error: 'inbox 未启用' });
      const item = inbox.get(inboxId);
      if (!item) return res.status(404).json({ error: 'not found' });
      const file = item.staged ?? item.src;
      const exists = fs.existsSync(file);
      const info = parseClipName(item.src, null);
      const startMs = item.probe?.creation_time_utc_ms ?? info?.start_ms ?? null;
      const duration = item.probe?.duration ?? null;
      const suggestion = suggestFit(listFits(configRef.current), { startMs, durationS: duration });
      // 同一次录制的全部切段：FIT 可能骑在任何一段上，对齐页要能在段间切换/跨段跳锚点
      const group = inbox.recordingGroup(item.id);
      const segments = group.map((g2, gi) => {
        const gfile = g2.staged ?? g2.src;
        const ginfo = parseClipName(g2.src, null);
        return {
          i: gi,
          inbox_id: g2.id,
          name: path.basename(g2.src),
          duration: g2.probe?.duration ?? null,
          fps: g2.probe?.fps ?? null,
          creation_time_utc_ms: g2.probe?.creation_time_utc_ms ?? ginfo?.start_ms ?? null,
          dlog_suspected: g2.probe?.dlog_suspected ?? null,
          video: fs.existsSync(gfile) ? `inbox:${g2.id}` : null,
        };
      });
      const segIdx = Math.max(0, group.findIndex((g2) => g2.id === item.id));
      return res.json({
        kind: 'inbox',
        id: item.id,
        state: item.status,
        skin: configRef.current.skin,
        fits: listFits(configRef.current),
        fit: item.pre_align?.fit ?? item.decision?.fit ?? suggestion ?? null,
        bias_seconds: item.pre_align?.bias_seconds ?? item.decision?.bias_seconds ?? configRef.current.global_bias_seconds ?? 0,
        lut: null,
        default_lut: configRef.current.default_lut ?? null,
        running: false,
        seg_idx: segIdx,
        segments,
      });
    }
    if (videoPath) {
      if (!fs.existsSync(videoPath)) return res.status(404).json({ error: `video not found: ${videoPath}` });
      const probe = await probeFile(videoPath);
      return res.json({
        kind: 'adhoc',
        id: null,
        state: 'adhoc',
        skin: req.query.skin ?? configRef.current.skin,
        fits: listFits(configRef.current),
        fit: req.query.fit ?? null,
        bias_seconds: configRef.current.global_bias_seconds ?? 0,
        lut: null,
        default_lut: configRef.current.default_lut ?? null,
        running: false,
        segments: [{
          i: 0,
          name: path.basename(videoPath),
          duration: probe.duration,
          fps: probe.fps ?? null,
          creation_time_utc_ms: probe.creation_time_utc_ms ?? parseClipName(videoPath, null)?.start_ms ?? null,
          dlog_suspected: looksDlog(probe),
          video: `file:${videoPath}`,
        }],
      });
    }
    return res.status(400).json({ error: '需要 job / inbox / video 参数之一' });
  });

  // 处理后的 FIT 采样（1Hz 网格），按 路径+mtime 缓存：对齐页浏览器端实时驱动皮肤用
  const alignSamplesCache = new Map<string, { mtimeMs: number; data: ProcessedSamples }>();
  const getAlignSamples = (fit: string) => {
    const mtimeMs = fs.statSync(fit).mtimeMs;
    const hit = alignSamplesCache.get(fit);
    if (hit?.mtimeMs === mtimeMs) return hit.data;
    const { records } = decodeFit(fs.readFileSync(fit));
    const data = processRecords(records, { smoothWindowS: configRef.current.smooth_window_s });
    alignSamplesCache.set(fit, { mtimeMs, data });
    if (alignSamplesCache.size > 8) alignSamplesCache.delete(alignSamplesCache.keys().next().value as string);
    return data;
  };
  router.get('/api/align/samples', (req: Request, res: Response) => {
    const fit = req.query.fit as string | undefined;
    if (!fit || !fit.toLowerCase().endsWith('.fit') || !fs.existsSync(fit)) return res.status(404).json({ error: 'fit not found' });
    try {
      return res.json(getAlignSamples(fit));
    } catch (e) {
      return res.status(422).json({ error: `FIT 解析失败：${(e as Error).message}` });
    }
  });

  // 对齐页皮肤：经真实 URL 提供（srcdoc iframe 在 Chrome 里是不透明白底，透明叠加必须 src 加载）。
  // Svelte 皮肤按需编译（内容哈希缓存），编译错误直接回给页面方便调试
  router.get('/align/skin/:name', async (req: Request, res: Response) => {
    const skinName = req.params.name;
    const skinDir = resolveSkinDir(skinName) as string; // skinName 非空时 resolveSkinDir 不返回 null
    if (!fs.existsSync(path.join(skinDir, 'Skin.svelte'))) return res.status(404).type('text').send(`skin not found: ${skinName}`);
    let data: ProcessedSamples | null = null;
    const fit = req.query.fit as string | undefined;
    if (fit && fit.toLowerCase().endsWith('.fit') && fs.existsSync(fit)) {
      try { data = getAlignSamples(fit); } catch { /* 数据留空，页面只影响轨迹类静态层 */ }
    }
    try {
      const { buildId } = await buildSkin({ skinDir, name: path.basename(skinDir) });
      return res.type('html').send(buildSkinHtml({ buildId, data }));
    } catch (e) {
      return res.status(500).type('text').send(`皮肤编译失败：${(e as Error).message}`);
    }
  });

  // 单帧合成预览：ffmpeg 抓帧+套 LUT 作为皮肤页背景，渲染 t 时刻仪表盘后整页截图（CLI `actpipe preview` 用）
  // t：视频相对秒；t_fit：FIT 时间轴绝对秒——经 offset 换算回视频时刻。lut：'none'/null=不套，支持 '+' 链
  router.post('/preview', async (req: Request, res: Response) => {
    const body = req.body ?? {};
    const { video, fit } = body;
    if (!video || !fs.existsSync(video)) return res.status(400).json({ error: `video not found: ${video}` });
    if (!fit || !fs.existsSync(fit)) return res.status(400).json({ error: `fit not found: ${fit}` });
    const skinDir = resolveSkinDir(body.skin ?? configRef.current.skin) as string;
    if (!fs.existsSync(skinDir)) return res.status(400).json({ error: `skin not found: ${body.skin}` });

    const probe = await probeFile(video);
    const { samples, session } = await fitToFiles(fit, {
      probe,
      videoFile: video,
      biasSeconds: configRef.current.global_bias_seconds,
      smoothWindowS: configRef.current.smooth_window_s,
      offsetOverride: body.offset_seconds ?? null,
    });
    const offset = session.offset_seconds;
    if (offset == null) return res.status(422).json({ error: '无法锚定（creation_time 缺失），请提供 offset_seconds', warnings: session.anchor?.warnings });

    let tS;
    if (body.t_fit != null) {
      tS = Number(body.t_fit) - offset;
      if (tS < 0 || tS > probe.duration) {
        return res.status(422).json({ error: `FIT 时刻 ${body.t_fit}s 换算后视频时刻 ${tS.toFixed(1)}s 超出视频范围 [0, ${probe.duration}]（offset=${offset}）` });
      }
    } else {
      tS = typeof body.t === 'number' ? body.t : parseTimecode(body.t ?? '0');
    }

    const lutName = body.lut === 'none' || body.lut === null || body.lut === false ? null : body.lut ?? probe.lut_decision?.lut ?? null;
    const lut = lutName && !lutName.includes('/') ? resolveLutPath(configRef.current, lutName) : lutName;
    const bg = await extractFrame(video, tS, lut);

    // renderPreviewFrame 的 samples 声明为 SamplesGrid；fitToFiles 产出 ProcessedSamples（领域类型差，见汇报）
    const { png, sample } = await renderPreviewFrame({
      skinDir,
      samples,
      width: probe.width,
      height: probe.height,
      atFitS: offset + tS,
      backgroundImage: bg,
    } as any);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Actpipe-Sample', JSON.stringify(sample));
    return res.send(png);
  });

  // 视频流（支持 Range，浏览器 <video> 拖动进度条需要 206）
  router.get('/api/align/video', (req: Request, res: Response) => {
    const src = (req.query.src ?? '') as string;
    let file = null;
    if (src.startsWith('job:')) {
      const [, id, seg] = src.split(':');
      const job = queue.get(id);
      const art = job ? ((job.params.segments?.length as number) > 1 ? job.artifacts.segments?.[Number(seg)] : job.artifacts) : null;
      file = art?.ingest?.staged ?? null;
    } else if (src.startsWith('inbox:')) {
      const item = inbox?.get(src.slice(6));
      file = item ? item.staged ?? item.src : null;
    } else if (src.startsWith('file:')) {
      file = src.slice(5);
    }
    if (!file || !fs.existsSync(file)) return res.status(404).type('text').send('视频不可用（卡已拔出或 staging 已清理）');
    const stat = fs.statSync(file);
    const type = file.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m?.[1] ? Number(m[1]) : 0;
      let end = m?.[2] ? Number(m[2]) : stat.size - 1;
      if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - Number(m[2])); end = stat.size - 1; } // suffix range
      start = Math.max(0, Math.min(start, stat.size - 1));
      end = Math.max(start, Math.min(end, stat.size - 1));
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': String(stat.size), 'Accept-Ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
  });

  // 对齐页 WebGL 预览用：返回 .cube 原文（链式返回数组，按叠加顺序）；name 也接受已解析的绝对路径/路径链
  router.get('/api/align/lut', (req: Request, res: Response) => {
    const name = req.query.name as string | undefined;
    if (!name || name === 'none') return res.json({ chain: [] });
    const resolved = name.includes('/') ? name : resolveLutPath(configRef.current, name);
    if (!resolved) return res.status(404).json({ error: `lut not found: ${name}` });
    const chain = [];
    for (const p of String(resolved).split('+')) {
      if (!fs.existsSync(p)) return res.status(404).json({ error: `LUT 文件缺失: ${p}` });
      chain.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
    }
    return res.json({ chain });
  });

  // 素材胶片条预览：4 帧横拼 jpg，有缓存直接返回；无缓存且源文件还在则按需生成兜底
  router.get('/inbox/:id/thumb.jpg', async (req: Request, res: Response) => {
    if (!inbox) return res.status(503).json({ error: 'inbox 未启用' });
    const item = inbox.get(req.params.id);
    if (!item) return res.status(404).type('text').send('not found');
    const out = thumbPath(item.id);
    if (!fs.existsSync(out)) {
      const file = item.staged ?? item.src;
      if (!item.probe || !fs.existsSync(file)) return res.status(404).type('text').send('预览不可用（卡已拔出或文件已移除）');
      try {
        await generateFilmstrip(file, item.probe.duration as number, item.id);
      } catch (e) {
        return res.status(500).type('text').send(`预览生成失败：${(e as Error).message}`);
      }
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.send(fs.readFileSync(out));
  });

  router.get('/luts', (req: Request, res: Response) => res.json(listLuts(configRef.current)));

  router.get('/skins', (req: Request, res: Response) => {
    ensureDirs();
    const skins = fs
      .readdirSync(paths.dashboards)
      .filter((d) => fs.existsSync(path.join(paths.dashboards, d, 'Skin.svelte')));
    return res.json(skins);
  });

  // 全局状态：watcher / inbox / 队列 / 存储
  router.get('/api/status', (req: Request, res: Response) => {
    const jobs = queue.list();
    const byState: Record<string, number> = {};
    for (const j of jobs) byState[j.state] = (byState[j.state] ?? 0) + 1;
    const items = inbox ? inbox.list() : [];
    const watcher = refs.watcher ?? null;
    return res.json({
      version: '0.1.0',
      uptime_s: Math.round(process.uptime()),
      store: storeKind(),
      watcher: watcher
        ? { active: true, root: watcher.volumesRoot, volumes_seen: watcher.listVolumes().length }
        : { active: false },
      inbox: {
        pending: items.filter((i) => i.status === 'pending').length,
        total: items.length,
      },
      jobs: { total: jobs.length, by_state: byState, current_id: queue.currentId },
    });
  });

  // ---- Strava：OAuth 授权 + streams → 合成 FIT 入库 ----
  router.get('/api/strava/status', (req: Request, res: Response) => {
    const cfg = configRef.current;
    return res.json({
      configured: strava.isConfigured(cfg),
      connected: strava.isConnected(cfg),
      athlete: cfg.strava?.athlete ?? null,
      auto_sync: cfg.strava?.auto_sync ?? false,
      sync_days: cfg.strava?.sync_days ?? 14,
    });
  });

  // 保存 client_id/client_secret（在 strava.com/settings/api 免费创建应用获得）
  router.post('/api/strava/config', (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.client_id || !body.client_secret) return res.status(400).json({ error: 'client_id 和 client_secret 必填' });
    const cfg = configRef.current;
    cfg.strava = { ...(cfg.strava ?? {}), client_id: String(body.client_id).trim(), client_secret: String(body.client_secret).trim() };
    saveConfig(cfg);
    res.json({ ok: true });
  });

  // 发起 OAuth：浏览器 302 到 Strava 授权页，授权后回跳 /api/strava/callback
  router.get('/api/strava/auth', (req: Request, res: Response) => {
    const cfg = configRef.current;
    if (!strava.isConfigured(cfg)) return res.status(400).json({ error: '先保存 client_id/client_secret' });
    const redirectUri = `${req.protocol}://${req.get('host')}/api/strava/callback`;
    return res.redirect(strava.authUrl(cfg, redirectUri));
  });

  router.get('/api/strava/callback', async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    if (!code) return res.redirect('/dash?strava=denied');
    try {
      const athlete = await strava.exchangeCode(configRef.current, code);
      return res.redirect(`/dash?strava=ok&who=${encodeURIComponent(athlete?.name ?? athlete?.id ?? '')}`);
    } catch (e) {
      return res.redirect(`/dash?strava=err&msg=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // 手动触发同步（自动同步由 index.js 定时器做）
  router.post('/api/strava/sync', async (req: Request, res: Response) => {
    try {
      const body = req.body ?? {};
      const r = await strava.syncFits(configRef.current, { days: body.days ?? null });
      return res.json(r);
    } catch (e) {
      return res.status(502).json({ error: (e as Error).message });
    }
  });

  return router;
}

// 抓一帧视频并套 LUT（链式依次叠加），作为预览背景图
async function extractFrame(video: string, tS: number, lut: string | null) {
  const out = path.join(paths.cache, `preview-bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', String(tS), '-i', video, '-frames:v', '1'];
  if (lut) {
    const chain = String(lut).split('+').filter((p) => p && fs.existsSync(p));
    if (chain.length) args.push('-vf', chain.map((p) => `lut3d='${p.replace(/'/g, "'\\''")}'`).join(','));
  }
  args.push('-y', out);
  await runOk('ffmpeg', args);
  return out;
}
