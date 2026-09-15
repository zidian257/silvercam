import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离真实数据目录（paths 在模块加载时定死，必须先设 env 再动态 import）
process.env.ACTPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-skinbuild-'));

const { buildSkin, buildSkinHtml, skinInputs } = await import('../../src/modules/skin-build.ts');

const SKIN = `<script module>export const CANVAS = { width: 1920, height: 1080 };</script>
<script>
  let v = $state('--');
  export function renderFrame(t, s) { v = String(s?.speed ?? '--'); }
</script>
<div id="stage"><span class="val">{v}</span></div>
<style>.val { color: red; }</style>
`;

function fixtureSkin(contents = SKIN) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-skin-'));
  const dir = path.join(root, 'mini');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Skin.svelte'), contents);
  return dir;
}

test('buildSkin：编译出 entry.js/entry.css，内容含 renderFrame 契约', async () => {
  const dir = fixtureSkin();
  const { buildId, dir: out } = await buildSkin({ skinDir: dir, name: 'mini' });
  assert.match(buildId, /^mini-[0-9a-f]{12}$/);
  const js = fs.readFileSync(path.join(out, 'entry.js'), 'utf8');
  assert.ok(js.includes('renderFrame'));
  assert.ok(js.includes('flushSync'));
  assert.ok(fs.existsSync(path.join(out, 'entry.css')));
});

test('buildSkin：内容不变命中缓存（同 buildId），改动后重新构建', async () => {
  const dir = fixtureSkin();
  const a = await buildSkin({ skinDir: dir, name: 'mini' });
  const b = await buildSkin({ skinDir: dir, name: 'mini' });
  assert.equal(a.buildId, b.buildId);
  fs.writeFileSync(path.join(dir, 'Skin.svelte'), SKIN.replace('red', 'blue'));
  const c = await buildSkin({ skinDir: dir, name: 'mini' });
  assert.notEqual(a.buildId, c.buildId);
  assert.ok(fs.existsSync(path.join(c.dir, 'entry.js')));
});

test('buildSkin：缺少 Skin.svelte 时报错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'actpipe-skin-'));
  await assert.rejects(() => buildSkin({ skinDir: dir, name: 'x' }), /Skin\.svelte/);
});

test('skinInputs：包含皮肤文件与 _lib 共享件', () => {
  const dir = fixtureSkin();
  fs.mkdirSync(path.join(path.dirname(dir), '_lib'));
  fs.writeFileSync(path.join(path.dirname(dir), '_lib', 'fmt.js'), 'export {};\n');
  const inputs = skinInputs(dir).map((p) => path.basename(p));
  assert.ok(inputs.includes('Skin.svelte'));
  assert.ok(inputs.includes('fmt.js'));
});

test('buildSkinHtml：注入 ACTPIPE 数据、base 与视频层；base 为空则全相对引用', () => {
  const html = buildSkinHtml({ buildId: 'mini-abc123def456', data: { count: 1 } });
  assert.ok(html.includes('<base href="/skin-build/mini-abc123def456/">'));
  assert.ok(html.includes('window.ACTPIPE = {"data":{"count":1}}'));
  assert.ok(html.includes('id="vsrc"'));
  const noBase = buildSkinHtml({ data: null });
  assert.ok(!noBase.includes('<base'));
  assert.ok(noBase.includes('src="entry.js"'));
});

test('buildSkinHtml：渲染管线（无 base）不带视频层——黑底会毁掉透明 PNG', () => {
  const renderDoc = buildSkinHtml({ data: null });
  assert.ok(!renderDoc.includes('id="vsrc"'));
  const studioDoc = buildSkinHtml({ buildId: 'b', data: null });
  assert.ok(studioDoc.includes('id="vsrc"'));
});
