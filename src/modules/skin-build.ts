import fs from 'node:fs';
import path from 'node:path';
import esbuild from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { paths, REPO_ROOT } from '../lib/paths.ts';
import { hashFiles } from '../lib/util.ts';

// Svelte 皮肤按需编译层：皮肤是运行期数据（用户随时改 dashboards/<name>/Skin.svelte），
// 不能走 build-time 编译，在这里做「内容哈希定 buildId + 命中即复用」的按需构建。
// 产物：entry.js（iife，含 mount + flushSync 包裹的 renderFrame）+ entry.css + 字体资产。

// 构建输入 = 皮肤目录全部文件（字体也参与哈希）+ 共享件 _lib（皮肤 import 它，改动必须触发重建）
export function skinInputs(skinDir: string): string[] {
  const files: string[] = [];
  for (const f of fs.readdirSync(skinDir).sort()) {
    const p = path.join(skinDir, f);
    if (!f.startsWith('.') && f !== 'preview.png' && fs.statSync(p).isFile()) files.push(p);
  }
  const libDir = path.join(path.dirname(skinDir), '_lib');
  if (fs.existsSync(libDir)) {
    for (const f of fs.readdirSync(libDir).sort()) {
      const p = path.join(libDir, f);
      if (!f.startsWith('.') && fs.statSync(p).isFile()) files.push(p);
    }
  }
  return files;
}

// bootstrap：挂上组件、回填 ACTPIPE.binding.canvas（studio/渲染管线读它做缩放）、
// 把组件导出的 renderFrame 包成「同步提交」契约——flushSync 保证截屏拿到的是当前帧
const BOOTSTRAP = `
import { mount, flushSync } from 'svelte';
import Skin from './Skin.svelte';
import * as mod from './Skin.svelte';
const app = mount(Skin, { target: document.getElementById('app') });
const canvas = mod.CANVAS ?? { width: 3840, height: 2160 };
window.ACTPIPE = window.ACTPIPE || {};
window.ACTPIPE.binding = { ...(window.ACTPIPE.binding || {}), canvas };
const v = document.getElementById('vsrc');
if (v) { v.style.width = canvas.width + 'px'; v.style.height = canvas.height + 'px'; }
const rf = typeof app.renderFrame === 'function' ? app.renderFrame : () => {};
window.renderFrame = (t, s) => flushSync(() => rf(t, s));
`;

export async function buildSkin({ skinDir, name }: { skinDir: string; name: string }): Promise<{ buildId: string; dir: string }> {
  if (!fs.existsSync(path.join(skinDir, 'Skin.svelte'))) {
    throw new Error(`皮肤缺少 Skin.svelte：${skinDir}`);
  }
  const hash = (await hashFiles(skinInputs(skinDir))).slice(0, 12);
  const buildId = `${name}-${hash}`;
  const dir = path.join(paths.cache, 'skin-build', buildId);
  if (fs.existsSync(path.join(dir, 'entry.js'))) return { buildId, dir };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await esbuild.build({
    stdin: { contents: BOOTSTRAP, resolveDir: skinDir, loader: 'js', sourcefile: 'entry.js' },
    bundle: true,
    format: 'iife',
    outfile: path.join(dir, 'entry.js'),
    // esbuild-svelte 是 CJS（运行时 module.exports = 工厂函数）但 d.ts 写成 export default，
    // nodenext 下默认导入被定成命名空间类型，这里按运行时的真实形状调用
    plugins: [(esbuildSvelte as unknown as (typeof import('esbuild-svelte'))['default'])()],
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.otf': 'file' },
    // 皮肤在用户目录（~/.config/actpipe），bare import（svelte 运行时）回退到仓库 node_modules
    nodePaths: [path.join(REPO_ROOT, 'node_modules')],
    logLevel: 'silent',
  });
  return { buildId, dir };
}

// 皮肤页文档：studio 走 HTTP（base 指向 /skin-build/），渲染管线走 file://（base=null 全相对）。
// media（studio 用）注入 <video>/<canvas> 底层：透明 iframe 盖在非同文档视频上会被 Chrome 画成白块，
// 所以视频必须在皮肤页文档内最底层。渲染管线绝不能带——video 的黑底会毁掉透明 PNG。
export function buildSkinHtml({ buildId = null, data = null, media = buildId != null }: {
  buildId?: string | null;
  data?: unknown;
  media?: boolean;
} = {}): string {
  const base = buildId ? `<base href="/skin-build/${encodeURIComponent(buildId)}/">` : '';
  const mediaEls = media
    ? `<video id="vsrc" playsinline preload="auto" style="position:fixed;left:0;top:0;width:3840px;height:2160px;z-index:-2;background:#000"></video><canvas id="glc" style="display:none;position:fixed;left:0;top:0;width:3840px;height:2160px;z-index:-1"></canvas>`
    : '';
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
${base}<link rel="stylesheet" href="entry.css">
<script>window.ACTPIPE = ${JSON.stringify({ data })};</script>
</head>
<body style="margin:0">
${mediaEls}<div id="app"></div>
<script src="entry.js"></script>
</body>
</html>`;
}
