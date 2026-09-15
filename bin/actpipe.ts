#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, saveConfig, listLuts } from '../src/lib/config.ts';
import { paths, resolveSkinDir, ensureDirs, REPO_ROOT } from '../src/lib/paths.ts';
import { parseTimecode, fmtDuration, readJson, round } from '../src/lib/util.ts';
import { hashPassword } from '../src/server/auth.ts';
import type { Job } from '../src/types.ts';

const isBun = !!process.versions?.bun;

// 本地模块（playwright/chokidar/hono 等重依赖）不进 bun 编译产物：
// 用计算式 specifier 让 bundler 不可追踪，运行时从源码目录解析。
const loadModule = (rel: string): Promise<any> => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);

function needSourceRuntime(cmd: string): void {
  if (!isBun) return;
  console.error(`'${cmd}' 是模块本地调试入口，编译版 actpipe 是纯 HTTP/WS 瘦客户端（§9）。`);
  console.error(`请在源码目录用 Node 运行： node bin/actpipe.ts ${cmd} ...`);
  process.exit(2);
}

// CLI flag 值由命令行动态决定：无值 flag 为 true，其余为字符串
type CliFlags = Record<string, any>;

// GET /jobs 列表行形状（server 端摘要，不在共享 types.ts 里）
interface JobSummary {
  id: string;
  state: string;
  progress: { percent?: number | null } | null;
  video: string;
  error: string | null;
  output?: string | null;
}

// GET /api/inbox 条目形状（server 端定义，不在共享 types.ts 里）
interface InboxItem {
  id: string;
  src: string;
  status: string;
  ingest?: { state?: string; percent?: number; error?: string } | null;
}

function parseArgs(argv: string[]): { args: string[]; flags: CliFlags } {
  const args: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^--?[a-zA-Z]/.test(a)) {
      const key = a.replace(/^-+/, '');
      const next = argv[i + 1];
      if (next === undefined || /^--?[a-zA-Z]/.test(next)) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else args.push(a);
  }
  return { args, flags };
}

function baseUrl(): string {
  const cfg = loadConfig();
  return `http://127.0.0.1:${cfg.port ?? 8787}`;
}

async function api(method: string, p: string, body?: unknown): Promise<Response> {
  let res: Response;
  // 本机直通 token（鉴权开启时 CLI 不需要输密码）：数据目录 cli-token，0600
  let cliToken: string | null = null;
  try { cliToken = fs.readFileSync(path.join(paths.home, 'cli-token'), 'utf8').trim(); } catch {}
  try {
    res = await fetch(`${baseUrl()}${p}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cliToken ? { 'X-Actpipe-Token': cliToken } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    console.error('server 未运行。启动方式：actpipe watch（前台调试）或 pm2 start（常驻）');
    process.exit(2);
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = JSON.parse(text).error ?? text; } catch {}
    console.error(`HTTP ${res.status}: ${msg}`);
    process.exit(1);
  }
  return res;
}

const HELP = `actpipe — Action 5 Pro + FIT 仪表盘叠加流水线

服务控制：
  actpipe watch [--simulate <dir>]   前台启动 server（调试）；--simulate 注入假挂载事件
  actpipe inbox [--open]             素材确认列表 / 打开确认页面（相机素材先拷盘，人工确认后才入队）
  actpipe run --video x [--fit y] [--direct] [--offset -3.5] [--skin s] [--lut l]
  actpipe status [job_id]            任务列表 / 单个任务详情
  actpipe logs <job_id>              任务日志
  actpipe preview --video x --fit y -t 1:23 [--offset s] [--skin s] [--lut l] [--out p.png]
  actpipe config [--set k v]         读 / 改全局配置
  actpipe luts                       LUT 预设列表

模块独立调试入口（本地执行，不起 server）：
  actpipe probe <file>               ffprobe 探测 + D-Log 判定 -> probe.json
  actpipe ingest <src> [--out dir]   staging 拷贝 + 校验 -> ingest.json
  actpipe fit dump <x.fit>           FIT 解析摘要
  actpipe fit align --fit x --video y  计算 creation_time 锚定 offset
  actpipe render --fit x [--skin y] [--out dir] [--fps 10] [--from s] [--to s]
  actpipe compose <job_dir>          按 job_dir 内产物组装 ffmpeg 合成
`;

async function main(): Promise<void> {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd: string | undefined = args[0];

  switch (cmd) {
    case 'watch': {
      needSourceRuntime(cmd);
      const { startServer } = await loadModule('src/server/index.ts');
      const { watcher } = await startServer({});
      if (flags.simulate) {
        console.log(`[simulate] 注入挂载事件: ${flags.simulate}`);
        await watcher.simulate(path.resolve(flags.simulate));
      }
      break;
    }

    case 'run': {
      if (!flags.video) throw new Error('--video 必填');
      const body = {
        video: path.resolve(flags.video),
        fit: flags.fit ? path.resolve(flags.fit) : undefined,
        direct: !!flags.direct,
        skin: flags.skin,
        lut: flags.lut,
        offset_seconds: flags.offset != null ? Number(flags.offset) : undefined,
      };
      const res = await api('POST', '/jobs', body);
      const job = (await res.json()) as Job;
      console.log(`job ${job.id} 已创建：${path.basename(job.params.video)}`);
      await streamProgress(job.id);
      break;
    }

    case 'status': {
      if (args[1]) {
        const job = (await (await api('GET', `/jobs/${args[1]}`)).json()) as Job;
        console.log(JSON.stringify(job, null, 2));
      } else {
        const jobs = (await (await api('GET', '/jobs')).json()) as JobSummary[];
        for (const j of jobs) {
          const prog = j.progress?.percent != null ? ` ${round(j.progress.percent, 0)}%` : '';
          console.log(`${j.id}  ${j.state.padEnd(12)}${prog.padEnd(6)} ${j.video}${j.error ? `  错误: ${j.error}` : ''}${j.output ? `  -> ${j.output}` : ''}`);
        }
        if (!jobs.length) console.log('(无任务)');
      }
      break;
    }

    case 'logs': {
      if (!args[1]) throw new Error('logs 需要 job_id');
      const res = await api('GET', `/jobs/${args[1]}/log`);
      process.stdout.write(await res.text());
      break;
    }

    case 'preview': {
      if (!flags.video || !flags.fit) throw new Error('preview 需要 --video 和 --fit');
      const t = parseTimecode(flags.t ?? '0');
      const res = await api('POST', '/preview', {
        video: path.resolve(flags.video),
        fit: path.resolve(flags.fit),
        t,
        skin: flags.skin,
        lut: flags.lut ?? undefined,
        offset_seconds: flags.offset != null ? Number(flags.offset) : undefined,
      });
      const png = Buffer.from(await res.arrayBuffer());
      const sample = res.headers.get('X-Actpipe-Sample');
      const out = flags.out ?? `preview_${String(t).replace(/[^\d.-]/g, '_')}s.png`;
      fs.writeFileSync(out, png);
      console.log(`预览已写出: ${out}`);
      if (sample) console.log(`t=${t}s 读数: ${sample}`);
      break;
    }

    case 'passwd': {
      // 设置/关闭全站访问密码（公网映射前必做）。用法: actpipe passwd <密码> | actpipe passwd --off
      const cfg = loadConfig();
      if (flags.off) {
        cfg.auth = { password_hash: null };
        saveConfig(cfg);
        console.log('鉴权已关闭（auth.password_hash 已清空）');
        break;
      }
      const pw = args[1];
      if (!pw || pw.length < 6) throw new Error('用法: actpipe passwd <密码>（至少 6 位）；关闭用 actpipe passwd --off');
      cfg.auth = { password_hash: hashPassword(pw) };
      saveConfig(cfg);
      console.log('访问密码已设置（scrypt 哈希存入配置）。重启服务后生效：pm2 restart actpipe');
      break;
    }

    case 'config': {      if (flags.set !== undefined && flags.set !== true) {
        const key = flags.set;
        const value = args[1];
        if (value === undefined) throw new Error('用法: actpipe config --set <key> <value>');
        let parsed = value;
        try { parsed = JSON.parse(value); } catch {}
        await api('PUT', '/config', { [key]: parsed });
        console.log(`${key} = ${JSON.stringify(parsed)}`);
      } else {
        const cfg = await (await api('GET', '/config')).json();
        console.log(JSON.stringify(cfg, null, 2));
      }
      break;
    }

    case 'luts': {
      const cfg = loadConfig();
      for (const l of listLuts(cfg)) {
        console.log(`${l.default ? '*' : ' '} ${l.name.padEnd(20)} ${l.path}${l.exists ? '' : '  (缺失!)'}`);
      }
      break;
    }

    case 'inbox': {
      const items = (await (await api('GET', '/api/inbox')).json()) as InboxItem[];
      const pend = items.filter((i) => i.status === 'pending');
      if (!pend.length) console.log('(无待确认素材)');
      for (const i of pend) {
        const st =
          i.ingest?.state === 'ready' ? '就绪' :
          i.ingest?.state === 'copying' ? `拷贝中 ${i.ingest.percent ?? 0}%` :
          `失败: ${i.ingest?.error ?? '?'}`;
        console.log(`${i.id}  ${st.padEnd(12)} ${path.basename(i.src)}`);
      }
      const url = `${baseUrl()}/inbox`;
      if (flags.open || flags.o) {
        const { spawn } = await import('node:child_process');
        spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
        console.log(`已在浏览器打开 ${url}`);
      } else if (pend.length) {
        console.log(`\n在浏览器确认处理: ${url}（或 actpipe inbox --open）`);
      }
      break;
    }

    case 'probe': {
      needSourceRuntime(cmd);
      const file = args[1];
      if (!file) throw new Error('probe 需要文件路径');
      const { probeToFile } = await loadModule('src/modules/probe.ts');
      const out = flags.out ?? null;
      const result = await probeToFile(file, out, flags.policy ? { config: { ...loadConfig(), dlog_policy: flags.policy }, interact: mockInteract } : {});
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'ingest': {
      needSourceRuntime(cmd);
      const src = args[1];
      if (!src) throw new Error('ingest 需要源文件路径');
      const { ingestToJob } = await loadModule('src/modules/ingest.ts');
      const cfg = loadConfig();
      const jobDir = flags.out ? path.resolve(flags.out) : null;
      const result = await ingestToJob(path.resolve(src), jobDir, {
        stagingRoot: flags.out ? path.resolve(flags.out) : path.join(paths.staging, 'cli'),
        checksum: !!flags.checksum,
        onProgress: (p: any) => process.stderr.write(`\rcopy ${round(p.percent, 1)}%`),
      });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'fit': {
      needSourceRuntime(cmd);
      const sub = args[1];
      const { parseFit, processRecords, computeAnchor } = await loadModule('src/modules/fit.ts');
      if (sub === 'dump') {
        const file = args[2];
        const { records, session } = parseFit(path.resolve(file));
        const processed = processRecords(records, { smoothWindowS: loadConfig().smooth_window_s });
        console.log(JSON.stringify({
          file: path.resolve(file),
          records: records.length,
          fields: processed.fields,
          grade_recomputed: processed.grade_recomputed,
          start: processed.t0,
          duration_s: processed.count - 1,
          session,
          first_sample: processed.samples[0],
          last_sample: processed.samples[processed.count - 1],
        }, null, 2));
      } else if (sub === 'align') {
        if (!flags.fit || !flags.video) throw new Error('fit align 需要 --fit 和 --video');
        const { probeFile } = await loadModule('src/modules/probe.ts');
        const probe = await probeFile(path.resolve(flags.video));
        const { records } = parseFit(path.resolve(flags.fit));
        const anchor = computeAnchor({
          creationTimeUtcMs: probe.creation_time_utc_ms,
          videoFile: probe.file,
          fitStartMs: records[0].t,
          fitEndMs: records[records.length - 1].t,
          biasSeconds: loadConfig().global_bias_seconds,
        });
        console.log(JSON.stringify(anchor, null, 2));
      } else {
        throw new Error('fit 子命令: dump | align');
      }
      break;
    }

    case 'render': {
      needSourceRuntime(cmd);
      if (!flags.fit) throw new Error('render 需要 --fit');
      const cfg = loadConfig();
      const { fitToFiles } = await loadModule('src/modules/fit.ts');
      const { renderFrames, skinHash } = await loadModule('src/modules/render.ts');
      const fitFile = path.resolve(flags.fit);
      const { samples } = await fitToFiles(fitFile, { smoothWindowS: cfg.smooth_window_s });
      const skinDir = resolveSkinDir(flags.skin ?? cfg.skin);
      const outDir = flags.out ? path.resolve(flags.out) : path.join(paths.cache, `render-cli-${Date.now()}`);
      const fps = flags.fps ? Number(flags.fps) : cfg.overlay_fps;
      const fromS = flags.from != null ? parseTimecode(flags.from) : 0;
      const toS = flags.to != null ? parseTimecode(flags.to) : samples.count - 1;
      const result = await renderFrames({
        skinDir, samples, outDir, overlayFps: fps, fromFitS: fromS, toFitS: toS,
        width: flags.width ? Number(flags.width) : 3840,
        height: flags.height ? Number(flags.height) : 2160,
        tabs: cfg.render_tabs,
        onProgress: (p: any) => process.stderr.write(`\rrender ${p.done}/${p.total} (${p.percent}%)`),
        log: console.log,
      });
      console.log(`\nframes: ${result.framesDir} [${result.firstFrame}..${result.lastFrame}] skin_hash=${(await skinHash(skinDir)).slice(0, 8)}`);
      break;
    }

    case 'compose': {
      needSourceRuntime(cmd);
      const jobDir = args[1] ? path.resolve(args[1]) : null;
      if (!jobDir) throw new Error('compose 需要 job_dir');
      const job = readJson(path.join(jobDir, 'job.json'));
      if (!job) throw new Error(`${jobDir} 内无 job.json`);
      const probe = job.artifacts.probe ?? readJson(path.join(jobDir, 'probe.json'));
      const frames = job.artifacts.frames;
      if (!probe || !frames) throw new Error('job_dir 缺少 probe/frames 产物，先跑上游模块');
      const cfg = loadConfig();
      const { composeVideo, outputPathFor } = await loadModule('src/modules/compose.ts');
      const out = flags.out ? path.resolve(flags.out) : outputPathFor({ outputDir: cfg.output_dir, videoFile: job.params.video, skin: job.params.skin });
      const lut = probe.lut_decision?.apply ? probe.lut_decision.lut : null;
      await composeVideo(
        {
          video: job.artifacts.ingest.staged,
          framesPattern: frames.pattern,
          startNumber: frames.first_frame,
          overlayFps: frames.fps,
          videoFps: probe.fps,
          lut: lut && fs.existsSync(lut) ? lut : null,
          out,
          encoder: cfg.encoder,
          bitrate: cfg.bitrate,
          tenBit: cfg.ten_bit_output,
          durationS: probe.duration,
        },
        { durationS: probe.duration, onProgress: (p: any) => p.percent != null && process.stderr.write(`\rencode ${round(p.percent, 1)}% ${p.speed ?? ''}`), log: console.log }
      );
      console.log(`\n输出: ${out}`);
      break;
    }

    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      break;

    default:
      console.error(`未知命令: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

async function streamProgress(jobId: string): Promise<void> {
  const url = `${baseUrl().replace('http', 'ws')}/jobs/${jobId}/progress`;
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    let lastLine = '';
    ws.onmessage = (evt) => {
      const ev = JSON.parse(evt.data);
      if (ev.type === 'snapshot' || ev.type === 'state') {
        console.log(`\n[${ev.state}]${ev.error ? ' ' + ev.error : ''}`);
        if (ev.state === 'done' || ev.state === 'failed') {
          ws.close();
          resolve();
        }
      } else if (ev.type === 'progress') {
        const p = ev;
        const line = `[${p.stage}] ${round(p.percent ?? 0, 1)}%${p.speed ? ` speed=${p.speed}` : ''}`;
        if (line !== lastLine) {
          process.stdout.write(`\r${line.padEnd(50)}`);
          lastLine = line;
        }
      }
    };
    ws.onerror = () => {
      console.error('\nWS 连接失败（server 未运行？）');
      resolve();
    };
    ws.onclose = () => resolve();
  });
  const job = (await (await api('GET', `/jobs/${jobId}`)).json()) as Job;
  if (job.state === 'done') console.log(`完成: ${job.artifacts.output}`);
  else if (job.state === 'failed') {
    console.error(`失败: ${job.error}（actpipe logs ${job.id} 查看详情）`);
    process.exit(1);
  } else console.log(`当前状态: ${job.state}`);
}

const mockInteract = {
  confirm: async () => (process.env.ACTPIPE_MOCK_CONFIRM ?? 'ok') !== 'cancel',
};

ensureDirs();
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
