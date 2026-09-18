import { describe, it, expect, vi, afterEach } from 'vitest';
import { getJson, postJson, putJson, setUnauthorizedHandler } from '../../web/src/lib/api.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(null);
});

describe('getJson', () => {
  it('200 返回解析后的 json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"a":1}', { status: 200 })));
    expect(await getJson('/api/status')).toEqual({ a: 1 });
  });
  it('非 200 抛错带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    await expect(getJson('/api/inbox')).rejects.toThrow('503');
  });
  it('401 触发未登录处理（跳登录页）并抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const spy = vi.fn();
    setUnauthorizedHandler(spy);
    await expect(getJson('/api/inbox')).rejects.toThrow('unauthorized');
    expect(spy).toHaveBeenCalledOnce();
  });
});

describe('postJson', () => {
  it('错误响应抛出服务端 error 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"拷贝中，稍候"}', { status: 400 })));
    await expect(postJson('/api/inbox/commit', {})).rejects.toThrow('拷贝中，稍候');
  });
  it('成功返回 json', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    expect(await postJson('/x', { b: 2 })).toEqual({ ok: true });
  });
});

describe('putJson', () => {
  it('以 PUT 发 json 并返回解析结果', async () => {
    const spy = vi.fn(async () => new Response('{"encoder":"h264_videotoolbox"}', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    expect(await putJson('/config', { encoder: 'h264_videotoolbox' })).toEqual({ encoder: 'h264_videotoolbox' });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ encoder: 'h264_videotoolbox' });
  });
  it('错误响应抛出服务端 error 文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"json body required"}', { status: 400 })));
    await expect(putJson('/config', {})).rejects.toThrow('json body required');
  });
});
