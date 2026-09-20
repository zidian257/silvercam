<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api, getJson, postJson } from '../../lib/api.ts';
  import { mmss, sampleAt, parseCube, dataWindow, autoOffset, findDataSegment, captionFor, lutOptionValue, savePlan, pinStatusFor } from '../../lib/studio.ts';
  import { LutPreviewer } from '../../lib/lutgl.ts';
  import SeekBar from '../../lib/components/SeekBar.svelte';
  import AppNav from '../../lib/components/AppNav.svelte';
  import { Play, Pause, ChevronsLeft, ChevronLeft, ChevronRight, ChevronsRight, Crosshair } from 'lucide-svelte';

  const qs = new URLSearchParams(location.search);

  // /api/align/source 响应（job/inbox/adhoc 三种 kind 的并集；非共享类型，本地定义）
  interface AlignSegment {
    i: number;
    name: string;
    duration: number | null;
    fps: number | null;
    creation_time_utc_ms: number | null;
    video: string | null;
    dlog_suspected?: boolean | null; // 仅 inbox/adhoc 来源带
    inbox_id?: string;
  }
  interface FitEntry {
    name: string;
    path: string;
    start_ms: number;
    end_ms: number;
    duration_s: number;
  }
  interface AlignSource {
    kind: string;
    id: string | null;
    state?: string;
    skin: string;
    fit: string | null;
    fits?: FitEntry[];
    bias_seconds?: number | null;
    lut?: string | null;
    default_lut?: string | null;
    running?: boolean;
    seg_idx?: number;
    segments: AlignSegment[];
  }
  // /luts 清单项
  interface LutInfo {
    name: string;
    label?: string | null;
    exists?: boolean;
    default?: boolean;
  }
  interface SelectOption {
    value: string;
    label: string;
  }
  // /api/align/samples 的 1Hz 采样网格：本页只直接读 count，其余经 lib/studio 纯函数消费
  // （t0_ms 服务端必给；autoOffset 的 SamplesAnchor 契约要求其为必填）
  interface FitSamples {
    count: number;
    t0_ms: number;
    fields: string[];
    samples: any[]; // 采样点字段由 fields 清单决定，经 sampleAt 插值消费
  }

  // ---- 响应式 UI 状态 ----
  let source = $state<AlignSource | null>(null);
  let segIdx = $state(0);
  let bias = $state(0);
  let fitPath = $state<string | null>(null);
  let skinName = $state('');
  let lutName = $state('none');
  let skins = $state<string[]>([]);
  let lutOpts = $state<SelectOption[]>([]);
  let fitOpts = $state<SelectOption[]>([]);
  let msg = $state('');
  let msgErr = $state(false);
  let srcName = $state('加载中…');
  let caption = $state('');
  let offsetInfo = $state('');
  let gotoSeg = $state<{ fitS: number; label: string } | null>(null);
  let timeLabel = $state('0:00 / 0:00');
  let seekFrac = $state(0);
  let seekWin = $state<[number, number] | null>(null); // [loPct, hiPct] | null
  let pinStatus = $state(''); // 定格后常驻：FIT 起点 @ mm:ss（随微调实时更新）
  let playing = $state(false);
  let ovlHeight = $state(200);

  // ---- 非响应式运行态（iframe 文档内的对象，不需要进响应式系统）----
  let stageEl: HTMLDivElement;
  let ovlEl: HTMLIFrameElement;
  let samples: FitSamples | null = null;
  // 皮肤 iframe 的 window：跨文档动态对象（皮肤运行时注入 renderFrame / ACTPIPE），按 any 处理
  let skinWin: any = null;
  let skinReady = false;
  let v: HTMLVideoElement | null = null; // 视频元素（皮肤 iframe 文档内最底层 #vsrc）
  let lut: { previewer: LutPreviewer | null; active: boolean } = { previewer: null, active: false };
  let lastFitS: number | null = null;
  let videoSrc: string | null = null;
  let pendingSeek: number | null = null;
  let pinned = false; // 是否已定格过（pinStatus 的投影由 refreshOverlays 显式维护，无需进响应式）
  let ready = false; // onMount 初始化完成后才允许回写（避免初始化过程把默认值写回去）
  let writebackTimer: ReturnType<typeof setTimeout> | null = null;

  const seg = () => source?.segments?.[segIdx] ?? null;
  const skinEl = (id: string) => skinWin?.document.getElementById(id) ?? null;
  const curOffset = () => {
    const a = autoOffset(seg(), samples);
    return a == null ? null : a + bias;
  };
  const save = $derived(savePlan(source));
  const showSegSel = $derived((source?.segments?.length ?? 0) > 1);
  const showFitSel = $derived(source != null && source.kind !== 'job' && (source.fits?.length ?? 0) > 0);

  function setMsg(t: string, isErr = false) {
    msg = t;
    msgErr = isErr;
  }

  // 只隐藏皮肤内容（视频层保持可见）：无数据的时段仪表盘不应出现
  function setSkinVisible(on: boolean) {
    if (!skinWin) return;
    for (const el of skinWin.document.body.children) {
      if (el.id !== 'vsrc' && el.id !== 'glc') el.style.visibility = on ? '' : 'hidden';
    }
  }

  // ---- 皮肤 iframe 即舞台：视频（#vsrc）+ LUT canvas（#glc）+ 皮肤 DOM 同文档叠放 ----
  async function loadSkin(name: string) {
    skinReady = false;
    lastFitS = null;
    await new Promise((resolve) => {
      ovlEl.onload = resolve;
      ovlEl.src = `/align/skin/${encodeURIComponent(name)}?fit=${encodeURIComponent(fitPath ?? '')}`;
    });
    const win = ovlEl.contentWindow as any; // 皮肤文档 window（跨文档动态对象）
    for (let i = 0; i < 100 && typeof win.renderFrame !== 'function'; i++) await new Promise((r2) => setTimeout(r2, 50));
    if (typeof win.renderFrame !== 'function') throw new Error('皮肤未暴露 renderFrame');
    skinWin = win;
    lut.previewer = null; // 换皮肤 = 新文档新 canvas，GL 上下文作废
    wireVideo();
    skinReady = true;
    applyZoom();
  }

  function wireVideo() {
    v = skinWin.document.getElementById('vsrc') as HTMLVideoElement;
    v.controls = false;
    v.muted = false; // 码表/手表开表 beep 是对齐的重要听觉线索
    v.volume = 1;
    v.addEventListener('play', () => (playing = true));
    v.addEventListener('pause', () => (playing = false));
    skinWin.document.addEventListener('click', (e: Event) => {
      if (e.target === v || e.target === skinEl('glc')) v!.paused ? v!.play() : v!.pause();
    });
    if (videoSrc) { v.src = videoSrc; v.load(); }
  }

  function applyZoom() {
    const cw = skinWin?.ACTPIPE?.binding?.canvas?.width ?? 3840;
    const ch = skinWin?.ACTPIPE?.binding?.canvas?.height ?? 2160;
    const w = stageEl?.clientWidth;
    if (!w) return;
    ovlHeight = (w * ch) / cw;
    if (skinWin) skinWin.document.body.style.zoom = String(w / cw);
  }

  // ---- LUT 预览 ----
  async function applyLut(name: string) {
    const cv = skinEl('glc');
    if (!v || !cv) return;
    let cubes = [];
    if (name && name !== 'none') {
      try {
        const body = await getJson(`/api/align/lut?name=${encodeURIComponent(name)}`);
        cubes = body.chain.map((c: { text: string }) => parseCube(c.text));
      } catch (e) {
        setMsg(`LUT 预览失败：${(e as Error).message}（按无 LUT 显示）`, true);
        cubes = [];
      }
    }
    if (!lut.previewer) lut.previewer = new LutPreviewer(cv);
    if (lut.previewer.available) {
      lut.previewer.setLuts(cubes);
      lut.active = true;
      cv.style.display = 'block';
      v.style.display = 'none';
    } else {
      lut.active = false;
      cv.style.display = 'none';
      v.style.display = 'block';
      if (name && name !== 'none') setMsg('浏览器不支持 WebGL2，无法预览 LUT', true);
    }
  }

  // ---- 数据窗口 / 读数 / 逐帧驱动 ----
  function refreshOverlays() {
    const g = seg();
    const off = curOffset();
    const win = g && samples ? dataWindow({ duration: g.duration, count: samples.count, offset: off }) : null;
    seekWin = g?.duration && win ? [win[0] / g.duration, win[1] / g.duration] as [number, number] : null;
    pinStatus = pinStatusFor(pinned, off); // 定格后常驻状态，微调（bias 变化）经此实时更新

    const biasTxt = `bias ${bias >= 0 ? '+' : ''}${bias.toFixed(2)}s`;
    if (off == null) {
      offsetInfo = '该段缺拍摄时刻，无法自动锚定';
      gotoSeg = null;
      return;
    }
    if (win) {
      offsetInfo = `${biasTxt} · offset=${off.toFixed(1)}s · 数据出现于 t=${mmss(win[0])}`;
      gotoSeg = null;
      return;
    }
    const other = findDataSegment(source?.segments, segIdx, bias, samples);
    if (other) {
      offsetInfo = `${biasTxt} · 本段无数据 ·`;
      gotoSeg = { fitS: other.fitS + 0.5, label: `数据在第 ${(other.seg.i as number) + 1} 段（${other.seg.name}）→ 跳过去` };
    } else {
      offsetInfo = `${biasTxt} · 整段无数据（bias 把它推出了 FIT 范围）`;
      gotoSeg = null;
    }
  }

  function tick() {
    requestAnimationFrame(tick);
    const g = seg();
    if (!g || !v) return;
    if (lut.active) lut.previewer?.draw(v);
    const t = v.currentTime;
    if (g.duration) {
      seekFrac = t / g.duration;
      timeLabel = `${mmss(t)} / ${mmss(g.duration)}`;
    }
    const off = curOffset();
    if (off == null || !samples || !skinReady) { setSkinVisible(false); return; }
    const fitS = t + off;
    const inWin = fitS >= 0 && fitS <= samples.count - 1;
    setSkinVisible(inWin);
    if (!inWin) { caption = '该时刻无 FIT 数据（成片里仪表盘不会出现）'; return; }
    if (lastFitS == null || Math.abs(fitS - lastFitS) > 0.03) {
      lastFitS = fitS;
      const sample = sampleAt(samples, fitS);
      try { skinWin.renderFrame(fitS, sample); } catch {}
      caption = captionFor(sample, fitS, t);
    }
  }

  // ---- 快捷跳转：找容易辨认的画面锚点（锚点落在哪段就自动切到哪段）----
  function jumpToFitS(fitS: number) {
    const off = curOffset();
    if (off == null || !samples) return;
    for (const g2 of source?.segments ?? []) {
      if (g2.creation_time_utc_ms == null) continue;
      const off2 = (autoOffset(g2, samples) as number) + bias; // 上面已排除 creation_time_utc_ms 为空，off 必非 null
      const t = fitS - off2;
      if (t >= 0 && t <= (g2.duration ?? 0)) {
        if (g2.i !== segIdx) {
          segIdx = g2.i;
          pendingSeek = t;
          loadSegment();
          setMsg(`锚点在第 ${g2.i + 1} 段（${g2.name}），已切换`);
        } else if (v) {
          v.currentTime = t;
        }
        lastFitS = null;
        return;
      }
    }
    setMsg(`该锚点不在任何一段内（FIT t=${fitS.toFixed(0)}s）`, true);
  }

  // ---- 播放控制 ----
  function togglePlay() { if (v) v.paused ? v.play() : v.pause(); }
  function onSeek(frac: number) {
    const g = seg();
    if (!v || !g?.duration) return;
    v.currentTime = frac * g.duration;
    lastFitS = null;
  }

  // ---- 定格 + 逐帧微调：唯一的对齐交互 ----
  // 播放 → 在出发/起步那一刻暂停 → 「定格起点」（可反复定格）→ 逐帧微调（带着起点一起走）。
  function setBias(b: number) {
    bias = Math.round(Number(b) * 100) / 100; // 帧级精度：保留两位小数
    lastFitS = null;
    refreshOverlays();
  }
  function pin() {
    if (!v) return;
    const a = autoOffset(seg(), samples);
    if (a == null) { setMsg('该段缺拍摄时刻，无法定格（换有拍摄时间的一段）', true); return; }
    v.pause();
    pinned = true; // 先置位再 setBias：refreshOverlays 才能投出定格状态
    setBias(-a - v.currentTime); // 令当前帧 fitS = 0
    setMsg(`FIT 起点已定格在 t=${mmss(v.currentTime)}，用逐帧微调校准（可再点「定格起点」重定）`);
  }
  function nudgeFrames(n: number) {
    if (!v) return;
    const fps = seg()?.fps ?? 30;
    const dt = n / fps;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + dt));
    if (pinned) setBias(bias - dt); // 视频帧右移 dt ⇒ 起点要跟着右移 ⇒ bias 减 dt
    lastFitS = null;
  }

  // ---- 段切换 / 选择器 ----
  function loadSegment() {
    const g = seg();
    if (!g) return;
    const groupNote = source!.segments.length > 1 ? `（同次录制 ${source!.segments.length} 段之 ${segIdx + 1}）` : '';
    srcName = g.name + groupNote + (source!.kind === 'job' ? ` · 任务 ${source!.id}` : '');
    if (!g.video) { setMsg('该段视频不可用（卡已拔出或 staging 已清理）', true); return; }
    videoSrc = `/api/align/video?src=${encodeURIComponent(g.video)}`;
    if (!v) return;
    v.src = videoSrc;
    v.load();
    if (pendingSeek != null) {
      const target = pendingSeek;
      pendingSeek = null;
      v.addEventListener('loadedmetadata', () => { v!.currentTime = Math.min(target, v!.duration || target); }, { once: true });
    }
    lastFitS = null;
    pinned = false;
    refreshOverlays();
  }

  async function loadSamples(fit: string | null) {
    fitPath = fit || null;
    if (!fit) { samples = null; setMsg('未选 FIT：可预览 LUT/皮肤，但无时间轴可校准'); return; }
    samples = await getJson(`/api/align/samples?fit=${encodeURIComponent(fit)}`);
    lastFitS = null;
    refreshOverlays();
  }

  async function onSkinChange() {
    await loadSkin(skinName).catch((e) => setMsg(e.message, true));
    await applyLut(lutName); // loadSkin 换文档后 GL 上下文已作废，重建
    scheduleWriteback();
  }
  async function onFitChange() {
    await loadSamples(fitPath);
    await loadSkin(skinName).catch(() => {});
    await applyLut(lutName);
    scheduleWriteback();
  }
  async function onLutChange() {
    await applyLut(lutName);
    scheduleWriteback();
  }

  // ---- 选择回写：studio 里看到的选择即下次处理的默认（600ms 防抖合并连续改动）----
  // inbox 来源写 pre_align（含当前 fit/bias：pre_align 语义=当前所见对齐）；job 来源写任务 params
  function scheduleWriteback() {
    if (!ready || !source) return;
    if (writebackTimer) clearTimeout(writebackTimer);
    writebackTimer = setTimeout(async () => {
      writebackTimer = null;
      try {
        if (source!.kind === 'inbox') {
          await postJson(`/api/inbox/${source!.id}/align`, { skin: skinName, lut: lutName, fit: fitPath, bias_seconds: bias });
        } else if (source!.kind === 'job') {
          await postJson(`/jobs/${source!.id}/prefs`, { skin: skinName, lut: lutName });
        }
      } catch (e) {
        setMsg(`选择回写失败：${(e as Error).message}`, true);
      }
    }, 600);
  }

  // ---- 保存 ----
  async function saveBias() {
    if (!source) return;
    if (source.kind === 'job') {
      if (save.heavy && !confirm(`将把该任务 bias 设为 ${bias}s 并重跑渲染+转码（合并任务全段重编码，耗时较长；旧成片保留）。确定？`)) return;
      try {
        await postJson(`/jobs/${source.id}/bias`, { bias_seconds: bias });
        setMsg(save.heavy ? '已入队重渲，去总控台看进度' : '已保存，出片时将应用该 bias');
      } catch (e) { setMsg((e as Error).message, true); }
    } else if (source.kind === 'inbox') {
      try {
        const b = await postJson(`/api/inbox/${source.id}/align`, { fit: fitPath, bias_seconds: bias });
        setMsg(b.group_propagated ? `已保存：同次录制其余 ${b.group_propagated} 段一并生效` : '已保存：提交处理时随任务生效（换 FIT 则作废）');
      } catch (e) { setMsg((e as Error).message, true); }
    }
  }

  function onKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT' || !v) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeFrames(e.shiftKey ? -10 : -1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); nudgeFrames(e.shiftKey ? 10 : 1); }
  }

  let ro: ResizeObserver | undefined;
  onMount(async () => {
    ro = new ResizeObserver(applyZoom);
    ro.observe(stageEl);
    document.addEventListener('keydown', onKey);
    try {
      const param = qs.get('job') ? `job=${encodeURIComponent(qs.get('job')!)}`
        : qs.get('inbox') ? `inbox=${encodeURIComponent(qs.get('inbox')!)}`
        : qs.get('video') ? `video=${encodeURIComponent(qs.get('video')!)}${qs.get('fit') ? `&fit=${encodeURIComponent(qs.get('fit')!)}` : ''}${qs.get('skin') ? `&skin=${encodeURIComponent(qs.get('skin')!)}` : ''}`
        : null;
      if (!param) { setMsg('缺少 job / inbox / video 参数', true); return; }
      source = (await getJson(`/api/align/source?${param}`)) as AlignSource;
      bias = Number(source.bias_seconds ?? 0) || 0;
      segIdx = source.seg_idx ?? 0;

      const [sk, luts] = await Promise.all([getJson('/skins').catch(() => []), getJson('/luts').catch(() => [])]);
      skins = sk;
      skinName = qs.get('skin') && sk.includes(qs.get('skin')) ? qs.get('skin')! : source.skin;
      const lutsAvail = ((luts || []) as LutInfo[]).filter((l) => l.exists !== false);
      lutName = lutOptionValue({
        qsLut: qs.get('lut'), sourceLut: source.lut,
        dlogSuspected: !!seg()?.dlog_suspected, defaultLut: source.default_lut,
        optionValues: ['none', ...lutsAvail.map((l) => l.name)],
      });
      lutOpts = [{ value: 'none', label: '不套 LUT' }, ...lutsAvail.map((l) => ({ value: l.name, label: l.label ?? l.name }))];
      if (!lutOpts.some((o) => o.value === lutName)) {
        lutOpts = [...lutOpts, { value: lutName, label: String(lutName).split('/').pop() || lutName }];
      }
      if (source.kind !== 'job' && source.fits) {
        fitOpts = source.fits.map((f) => {
          const d = new Date(f.start_ms);
          const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          return { value: f.path, label: `${f.name ?? f.path.split('/').pop()}（${hm} 起 ${Math.round((f.duration_s ?? 0) / 60)}min）` };
        });
      }
      if (source.kind === 'job') fitPath = source.fit;
      // inbox/adhoc：预选 FIT 不在库清单里时回落到第一个选项（与旧版一致）
      else fitPath = fitOpts.some((f) => f.value === source!.fit) ? source.fit : (fitOpts[0]?.value ?? null);

      await loadSamples(fitPath);
      await loadSkin(skinName); // 先建皮肤文档（视频元素在其中），再装载视频
      loadSegment();
      await applyLut(lutName);
      tick();
      const off = curOffset();
      const win = seg() && samples ? dataWindow({ duration: seg()!.duration, count: samples.count, offset: off }) : null;
      if (win) jumpToFitS(win[0] + (off ?? 0) + 3);
      ready = true; // 初始化完成，之后的选择改动才回写
    } catch (e) {
      setMsg((e as Error).message, true);
    }
  });
  onDestroy(() => {
    ro?.disconnect();
    document.removeEventListener('keydown', onKey);
    if (writebackTimer) clearTimeout(writebackTimer);
  });
</script>

<AppNav current="studio">
  <span class="srcname" title={srcName}>{srcName}</span>
</AppNav>

{#if msg}
  <div class="banner" class:err={msgErr}>{msg}</div>
{/if}

<main>
  <div class="stageWrap" bind:this={stageEl}>
    <iframe bind:this={ovlEl} title="对齐舞台" style="height:{ovlHeight}px"></iframe>
  </div>

  <div class="toolbar">
    <button class="btn icon" onclick={togglePlay} title={playing ? '暂停（空格）' : '播放（空格）'}>
      {#if playing}<Pause size={16} />{:else}<Play size={16} />{/if}
    </button>
    <div class="stepper">
      <button class="btn icon" onclick={() => nudgeFrames(-10)} title="后退 10 帧（Shift+←）"><ChevronsLeft size={16} /></button>
      <button class="btn icon" onclick={() => nudgeFrames(-1)} title="后退 1 帧（←）"><ChevronLeft size={16} /></button>
      <button class="btn icon" onclick={() => nudgeFrames(1)} title="前进 1 帧（→）"><ChevronRight size={16} /></button>
      <button class="btn icon" onclick={() => nudgeFrames(10)} title="前进 10 帧（Shift+→）"><ChevronsRight size={16} /></button>
    </div>
    {#if pinStatus}<span class="pinstatus" title="当前 bias 下 FIT 起点（t=0）落在本段视频的这个时刻">{pinStatus}</span>{/if}
    <SeekBar frac={seekFrac} dataWin={seekWin} label={timeLabel} {onSeek} />
    <div class="tbsels">
      {#if showSegSel}
        <select value={String(segIdx)} onchange={(e) => { segIdx = Number((e.target as HTMLSelectElement).value); pendingSeek = null; loadSegment(); }} title="选择段">
          {#each source!.segments as g}<option value={String(g.i)}>seg{g.i + 1} {g.name}</option>{/each}
        </select>
      {/if}
      {#if showFitSel}
        <select bind:value={fitPath} onchange={onFitChange} title="FIT">
          {#each fitOpts as f}<option value={f.value}>{f.label}</option>{/each}
        </select>
      {/if}
      <select bind:value={skinName} onchange={onSkinChange} title="仪表盘皮肤">
        {#each skins as s}<option value={s}>{s}</option>{/each}
      </select>
      <select bind:value={lutName} onchange={onLutChange} title="LUT 预览">
        {#each lutOpts as o}<option value={o.value}>{o.label}</option>{/each}
      </select>
    </div>
  </div>

  <div class="pinrow">
    <button class="btn primary pinbtn" onclick={pin} title="把 FIT 起点（t=0）定在当前这一帧。可反复点：每次都以当前帧重新定格；定格后用逐帧微调校准">
      <Crosshair size={16} />定格起点
    </button>
  </div>
  <div class="offsetline">
    {offsetInfo}
    {#if gotoSeg}<a href="#goto" onclick={(e) => { e.preventDefault(); jumpToFitS(gotoSeg!.fitS); }}>{gotoSeg.label}</a>{/if}
  </div>

  <div class="caption">{caption}</div>
  <div class="hint" title="播放找到出发/起步那一刻（开表会有 beep 声）→ 暂停 → 「定格起点」（可反复定格）→ 逐帧微调（定格后带着 FIT 起点一起走）。进度条高亮区段 = 有 FIT 数据；预览为原片实时套 LUT 的近似效果，成片以 ffmpeg 渲染为准。">播放找到出发/起步那一刻（开表会有 beep 声）→ 暂停 → 「定格起点」（可反复定格）→ 逐帧微调（定格后带着 FIT 起点一起走）。进度条高亮区段 = 有 FIT 数据；预览为原片实时套 LUT 的近似效果，成片以 ffmpeg 渲染为准。</div>

  {#if save.visible}
    <div class="saverow">
      <button class="btn primary" onclick={saveBias} disabled={save.disabled}>{save.label}</button>
      <span class="savehint">{save.hint}</span>
    </div>
  {:else}
    <div class="hint">{save.hint}</div>
  {/if}
</main>

<style>
  .srcname {
    font-size: 12px;
    color: var(--text-3);
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .banner {
    padding: 8px 24px;
    font-size: 12px;
    color: var(--text-2);
    background: var(--bg-1);
    border-bottom: 1px solid var(--line);
  }
  .banner.err { color: var(--danger); background: rgba(214, 69, 69, .08); border-bottom-color: rgba(214, 69, 69, .25); }
  main { padding: 24px; max-width: 1100px; margin: 0 auto; }
  .stageWrap {
    position: relative;
    background: #000;
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    overflow: hidden;
  }
  /* ovl 即舞台：视频与仪表盘都在皮肤文档内同层叠放（透明 iframe 盖加速层会白屏） */
  .stageWrap iframe { display: block; width: 100%; border: 0; background: #000; }
  .toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    margin-top: 12px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-card);
    padding: 10px 14px;
  }
  .stepper { display: flex; flex: none; }
  .stepper .btn { border-radius: 0; margin-left: -1px; }
  .stepper .btn:first-child { border-radius: var(--r-ctl) 0 0 var(--r-ctl); margin-left: 0; }
  .stepper .btn:last-child { border-radius: 0 var(--r-ctl) var(--r-ctl) 0; }
  .stepper .btn:hover { position: relative; z-index: 1; }
  .pinstatus {
    flex: none;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--accent);
    white-space: nowrap;
  }
  .tbsels { display: flex; gap: 8px; align-items: center; flex: none; }
  .tbsels select { max-width: 160px; }
  .pinrow { display: flex; justify-content: center; margin-top: 16px; }
  .pinbtn { font-size: 14px; padding: 9px 20px; }
  .offsetline {
    margin-top: 10px;
    text-align: center;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .caption { font: 12px/1.6 ui-monospace, monospace; color: var(--accent); margin-top: 14px; }
  .hint {
    font-size: 12px;
    color: var(--text-3);
    margin-top: 8px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .saverow { display: flex; gap: 12px; align-items: center; margin-top: 14px; }
  .savehint { font-size: 12px; color: var(--text-3); }
</style>
