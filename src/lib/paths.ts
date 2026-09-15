import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const HOME_DIR =
  process.env.ACTPIPE_HOME || path.join(os.homedir(), '.config', 'actpipe');

export const paths = {
  home: HOME_DIR,
  config: path.join(HOME_DIR, 'config.json'),
  dashboards: path.join(HOME_DIR, 'dashboards'),
  luts: path.join(HOME_DIR, 'luts'),
  jobs: path.join(HOME_DIR, 'jobs'),
  staging: path.join(HOME_DIR, 'staging'),
  cache: path.join(HOME_DIR, 'cache'),
  thumbs: path.join(HOME_DIR, 'thumbs'),
  fits: path.join(HOME_DIR, 'fits'),
  renderCache: path.join(HOME_DIR, 'cache', 'render'),
  db: path.join(HOME_DIR, 'jobs.db'),
  dbJson: path.join(HOME_DIR, 'jobs.db.json'),
  logs: path.join(os.homedir(), 'Library', 'Logs', 'actpipe'),
};

export function ensureDirs(): typeof paths {
  for (const key of ['home', 'dashboards', 'luts', 'jobs', 'staging', 'renderCache', 'thumbs', 'fits', 'logs'] as const) {
    fs.mkdirSync(paths[key], { recursive: true });
  }
  return paths;
}

export function expandHome(p: string): string;
export function expandHome(p: string | null | undefined): string | null | undefined;
export function expandHome(p: string | null | undefined): string | null | undefined {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function resolveSkinDir(nameOrPath: string | null | undefined): string | null {
  if (!nameOrPath) return null;
  if (nameOrPath.includes('/') || nameOrPath.endsWith('.html')) return expandHome(nameOrPath);
  const installed = path.join(paths.dashboards, nameOrPath);
  if (fs.existsSync(installed)) return installed;
  const bundled = path.join(REPO_ROOT, 'dashboards', nameOrPath); // 未安装时回退到仓库内置皮肤
  return fs.existsSync(bundled) ? bundled : installed;
}
