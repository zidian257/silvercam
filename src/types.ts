// 领域类型：任务 / 配置 / 探测 / FIT 会话 / 渲染产物。
// 外部边界（ffprobe 原始输出、FIT 记录字段、皮肤 binding）形状由外部决定，按 unknown/any 处理并注释。

export interface LutDecision {
  apply: boolean;
  lut: string | null; // 可为 '+' 连接的链（依次套用）
  reason: string;
  remember_key?: string;
}

export interface ProbeResult {
  file: string;
  width: number;
  height: number;
  fps: number;
  duration: number; // 秒
  codec: string;
  bit_depth: number;
  creation_time?: string | null;
  color_primaries?: string | null;
  color_transfer?: string | null;
  color_space?: string | null;
  is_dlog?: boolean;
  lut_decision?: LutDecision;
  [k: string]: unknown; // ffprobe 其余透传字段
}

export interface FitSample {
  t: number | string; // processRecords 产出 ISO 字符串；sampleAt 插值透传
  i?: number;
  position?: { lat: number; lon: number } | null;
  [field: string]: unknown; // 心率/功率/速度等可选字段，皮肤按 fields 清单消费
}

export interface SamplesGrid {
  count: number;
  fields: string[];
  samples: FitSample[];
}

export interface SessionInfo {
  offset_seconds: number | null; // 锚定失败/未锚定时为 null
  fields: string[];
  activity?: { start: string; end: string; duration_s: number };
  anchor?: { ok: boolean; warnings: string[] } & Record<string, unknown>;
  fit_file?: string;
  [k: string]: unknown;
}

export interface FramesArtifact {
  empty?: boolean;
  framesDir: string | null;
  pattern: string | null;
  fps: number;
  width: number | null;
  height: number | null;
  first_frame: number;
  delay_s: number;
  cache?: string;
}

export interface IngestArtifact {
  src: string;
  staged: string;
  size: number;
  mtime_ms: number;
  direct: boolean;
  pre_staged?: boolean;
}

export interface SegmentArtifacts {
  ingest?: IngestArtifact;
  probe?: ProbeResult;
  session?: SessionInfo;
  frames?: FramesArtifact;
  intermediate?: string;
}

export interface JobParams {
  video: string;
  fit: string | null; // 'none' = 纯拷贝路径
  skin: string;
  lut: string | null; // null = 按 probe 决策自动；'none' = 显式不套
  offset_seconds: number | null;
  bias_seconds: number | null; // 时间轴整体平移（正 = 数据延后），null = 用全局 global_bias_seconds
  direct: boolean;
  // 多段合并：同一次录制被相机切段且共用同一 FIT 时，按拍摄时间排序，逐段处理后拼接
  segments: { video: string; origin?: string | null; origin_size?: number | null; origin_mtime?: number | null }[] | null;
  origin: string | null;
  origin_size: number | null;
  origin_mtime: number | null;
}

export interface JobArtifacts extends SegmentArtifacts {
  segments?: SegmentArtifacts[];
  merge_lut?: LutDecision | null;
  output?: string | null;
}

export interface ProgressPayload {
  stage?: string;
  percent?: number;
  speed?: string;
  fps?: number;
  out_s?: number;
  frame?: number;
  done?: number;
  total?: number;
  [k: string]: unknown;
}

export type JobState = 'queued' | 'ingesting' | 'probing' | 'awaiting_fit' | 'rendering' | 'encoding' | 'copying' | 'done' | 'failed';

export interface Job {
  id: string;
  dir: string;
  created_at: string;
  state: JobState | string;
  error: string | null;
  params: JobParams;
  steps: Record<string, string | undefined>;
  artifacts: JobArtifacts;
  progress: ProgressPayload | null;
}

export interface ActpipeConfig {
  port: number;
  output_dir: string;
  staging_retention: 'keep' | 'delete_on_success';
  delete_from_card_after_success: boolean;
  staging_checksum: boolean;
  dlog_policy: 'always_lut' | 'never_lut' | 'ask';
  dlog_memory: Record<string, 'lut' | 'no_lut'>;
  camera_serial: string;
  default_lut: string;
  luts: Record<string, string>;
  lut_names: Record<string, string>;
  global_bias_seconds: number;
  fit_autopick: 'ask' | 'newest_in_dir';
  fit_dirs: string[];
  fit_library_dir: string | null;
  raw_subdir: string;
  fit_watch_dir: string | null;
  inbox_copy_on_detect: boolean;
  skin: string;
  overlay_fps: number;
  render_tabs: number;
  smooth_window_s: number;
  pregen: { enabled: boolean; fps: number | null; resolutions: string[]; boot_days: number };
  encoder: string;
  bitrate: string;
  ten_bit_output: boolean;
  encode_concurrency: number;
  render_concurrency: number;
  max_swap_mb: number;
  volume_whitelist: string[];
  cache: { ttl_days: number; max_gb: number };
  notify_sound: string;
  auth: { password_hash: string | null };
  // BYOK LLM（快剪 skill runner 用）；null/缺省 = 自动探测本机 LM Studio，字段见 server/llm.ts
  llm?: import('./server/llm.ts').LlmConfig | null;
  strava: {
    client_id: string | null;
    client_secret: string | null;
    access_token: string | null;
    refresh_token: string | null;
    expires_at: number;
    athlete: unknown;
    auto_sync: boolean;
    sync_days: number;
  };
  [k: string]: unknown; // 用户 config.json 允许额外键
}
