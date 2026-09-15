import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import LlmPanel from '../../web/src/lib/components/LlmPanel.svelte';

describe('LlmPanel', () => {
  it('默认 lmstudio：base_url/api_key/model 可空 + 视觉开关默认开', () => {
    render(LlmPanel, { props: {} });
    expect(screen.getByPlaceholderText('http://127.0.0.1:1234/v1')).toBeTruthy();
    expect(screen.getByPlaceholderText('本机开了鉴权才需要')).toBeTruthy();
    expect(screen.getByPlaceholderText('留空自动发现')).toBeTruthy();
    const vision = screen.getByLabelText(/支持图片输入/) as HTMLInputElement;
    expect(vision.checked).toBe(true);
  });

  it('状态行：灰点 + 未配置退化提示；configured 时显示生效 describe', () => {
    const { unmount } = render(LlmPanel, { props: { st: null } });
    expect(document.querySelector('.dot.unconfigured')).toBeTruthy();
    expect(screen.getByText('未配置——快剪将只按数据优选')).toBeTruthy();
    unmount();
    render(LlmPanel, { props: { st: { configured: true, describe: 'lmstudio/qwen2.5-vl-7b', vision: true } } });
    expect(document.querySelector('.dot.unverified')).toBeTruthy(); // 已配置未验证 → 黄点
    expect(screen.getByText('lmstudio/qwen2.5-vl-7b')).toBeTruthy();
  });

  it('状态点随 lastTest 变化：通过 → 绿；失败 → 红', () => {
    const { unmount } = render(LlmPanel, { props: { st: { configured: true, describe: 'd' }, lastTest: 'ok' } });
    expect(document.querySelector('.dot.ok')).toBeTruthy();
    unmount();
    render(LlmPanel, { props: { st: { configured: true, describe: 'd' }, lastTest: 'fail' } });
    expect(document.querySelector('.dot.failed')).toBeTruthy();
  });

  it('按已保存配置预填表单（openai-compat：base_url/model 必填 + 视觉开关）', () => {
    render(LlmPanel, { props: { saved: { provider: 'openai-compat', base_url: 'http://x/v1', model: 'm1', api_key: 'k', vision: false } } });
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('openai-compat');
    expect((screen.getByPlaceholderText('https://your-endpoint/v1') as HTMLInputElement).value).toBe('http://x/v1');
    expect((screen.getByPlaceholderText('模型 id') as HTMLInputElement).value).toBe('m1');
    expect((screen.getByLabelText(/支持图片输入/) as HTMLInputElement).checked).toBe(false);
  });

  it('切到 deepseek：隐藏 base_url 与视觉开关，模型 placeholder 给推荐值；测试连接带出 trim 后的表单内容', async () => {
    const onTest = vi.fn();
    render(LlmPanel, { props: { onTest } });
    await fireEvent.change(document.querySelector('select')!, { target: { value: 'deepseek' } });
    expect(screen.queryByPlaceholderText('http://127.0.0.1:1234/v1')).toBeNull();
    expect(screen.queryByLabelText(/支持图片输入/)).toBeNull();
    const model = screen.getByPlaceholderText('deepseek-v4-flash-vision-exp');
    await fireEvent.input(document.querySelector('input[type=password]')!, { target: { value: ' sk-x ' } });
    await fireEvent.input(model, { target: { value: ' deepseek-v4 ' } });
    await fireEvent.click(screen.getByText('测试连接'));
    expect(onTest).toHaveBeenCalledWith({ provider: 'deepseek', base_url: null, api_key: 'sk-x', model: 'deepseek-v4', vision: null });
  });

  it('保存回调带出当前表单载荷；测试结果显示成功/失败文案', async () => {
    const onSave = vi.fn();
    const { unmount } = render(LlmPanel, { props: { onSave } });
    await fireEvent.click(screen.getByText('保存'));
    expect(onSave).toHaveBeenCalledWith({ provider: 'lmstudio', base_url: null, api_key: null, model: null, vision: true });
    unmount();

    const ok = render(LlmPanel, { props: { testResult: { ok: true, describe: 'lmstudio/qwen', vision: true, latency_ms: 87.6 } } });
    expect(screen.getByText('✓ lmstudio/qwen · 视觉 ✓ · 88ms')).toBeTruthy();
    ok.unmount();

    render(LlmPanel, { props: { testResult: { ok: false, error: '连接被拒' } } });
    expect(screen.getByText('连接被拒')).toBeTruthy();
  });
});
