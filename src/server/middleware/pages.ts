import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { paths, REPO_ROOT } from '../../lib/paths.ts';

const ASSET_MIME: Record<string, string> = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript',
  '.png': 'image/png', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json',
};

// 页面路由：/ 重定向到 dash + 四个页面（Svelte 构建产物）+ 皮肤静态资源（状态接口在 /api/status）
const WEB_DIST = path.join(REPO_ROOT, 'web', 'dist');
const servePage = (name: string) => (req: Request, res: Response) => {
  const file = path.join(WEB_DIST, 'pages', name, 'index.html');
  if (!fs.existsSync(file)) return res.status(503).type('text').send('前端未构建：npm run build:web');
  return res.type('html').send(fs.readFileSync(file, 'utf8'));
};

export function createPagesRouter() {
  const router = Router();

  router.get('/', (req: Request, res: Response) => res.redirect('/dash'));

  // studio = 编辑预览工作台（对齐页）：看视频、LUT/皮肤实时预览、定格校准时间轴
  router.get('/studio', servePage('studio'));
  // 旧链接兼容：/align → /studio
  router.get('/align', (req: Request, res: Response) => {
    const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    res.redirect(`/studio${q}`);
  });
  router.get('/inbox', servePage('inbox'));
  router.get('/fits', servePage('fits'));
  router.get('/dash', servePage('dash'));

  // Svelte 皮肤编译产物（entry.js/entry.css/字体，按内容哈希分目录，见 modules/skin-build.js）
  router.get('/skin-build/:buildId/:file', (req: Request, res: Response) => {
    const buildId = path.basename(req.params.buildId);
    const file = path.basename(req.params.file);
    const full = path.join(paths.cache, 'skin-build', buildId, file);
    if (!fs.existsSync(full)) return res.status(404).type('text').send('not found');
    res.setHeader('Content-Type', ASSET_MIME[path.extname(file)] ?? 'application/octet-stream');
    fs.createReadStream(full).pipe(res);
  });

  return router;
}
