// 帧状态容器：渲染驱动每帧调 renderFrame(t, sample)，皮肤组件经 getter 读取。
// 契约同旧引擎：纯数据驱动，禁墙钟、禁 CSS 自走动画，保证逐帧可复现、可并行、可续渲。
import type { FrameSample } from './fmt.ts';

// window.ACTPIPE 由皮肤宿主页（buildSkinHtml）注入，内容为动态 JSON，按 any 透传
declare global {
  interface Window {
    ACTPIPE?: { data?: any; [k: string]: any };
  }
}

export function createFrame() {
  let t = $state(0);
  let sample = $state<FrameSample>({});
  const data = (typeof window !== 'undefined' && window.ACTPIPE?.data) ?? null;
  return {
    get t() { return t; },
    get sample() { return sample; },
    data,
    renderFrame(time: number, s: FrameSample | null) {
      t = time;
      sample = s ?? {};
    },
  };
}
