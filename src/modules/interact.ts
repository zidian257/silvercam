import { escapeAppleScript, run, which } from '../lib/util.ts';

const MOCK = !!process.env.ACTPIPE_MOCK_INTERACT;

export async function notify({ title, message, subtitle = '', sound = 'Glass', openPath = null, openUrl = null }: {
  title: string;
  message: string;
  subtitle?: string;
  sound?: string;
  openPath?: string | null;
  openUrl?: string | null;
}): Promise<void> {
  if (MOCK) {
    const target = openUrl ?? (openPath ? `open -R ${openPath}` : null);
    console.log(`[mock notify] ${title} — ${message}${target ? ` (click -> ${target})` : ''}`);
    return;
  }
  const tn = await which('terminal-notifier');
  if (tn) {
    const args = ['-title', title, '-message', message, '-sound', sound];
    if (subtitle) args.push('-subtitle', subtitle);
    if (openUrl) args.push('-open', openUrl); // 点击通知在默认浏览器打开
    else if (openPath) args.push('-execute', `open -R ${JSON.stringify(openPath)}`);
    await run(tn, args);
    return;
  }
  // osascript 的 display notification 不支持点击动作；URL 只能写在正文里
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"${
    subtitle ? ` subtitle "${escapeAppleScript(subtitle)}"` : ''
  } sound name "${escapeAppleScript(sound)}"`;
  await run('osascript', ['-e', script]);
}

export async function chooseFile({ prompt = '选择 .fit 文件', types = ['fit'], defaultDir = null }: {
  prompt?: string;
  types?: string[];
  defaultDir?: string | null;
} = {}): Promise<string | null> {
  if (MOCK) {
    console.log(`[mock chooseFile] ${prompt}`);
    return process.env.ACTPIPE_MOCK_CHOOSE || null;
  }
  const typeClause = types.length ? ` of type {${types.map((t) => `"${t}"`).join(', ')}}` : '';
  const dirClause = defaultDir ? ` default location (POSIX file "${escapeAppleScript(defaultDir)}")` : '';
  const script = `POSIX path of (choose file with prompt "${escapeAppleScript(prompt)}"${typeClause}${dirClause})`;
  const r = await run('osascript', ['-e', script]).catch(() => null);
  if (!r || r.code !== 0) return null; // user cancel (-128) 或进程超时/无 GUI 会话
  return r.stdout.trim() || null;
}

// 三态返回：true/false = 用户明确点击；null = 无人应答（弹窗 90s 自动放弃、进程超时、无 GUI 会话）
// 调用方必须为 null 准备默认路径——任务不该因为「人不在电脑旁」而失败
export async function confirm({ title, message, okLabel = '套用 LUT', cancelLabel = '不套' }: {
  title?: string;
  message?: string;
  okLabel?: string;
  cancelLabel?: string;
} = {}): Promise<boolean | null> {
  if (MOCK) {
    const v = process.env.ACTPIPE_MOCK_CONFIRM ?? 'ok';
    console.log(`[mock confirm] ${title} — ${message} -> ${v}`);
    return v === 'timeout' ? null : v !== 'cancel';
  }
  const script =
    `display dialog "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}" ` +
    `buttons {"${escapeAppleScript(cancelLabel)}", "${escapeAppleScript(okLabel)}"} default button "${escapeAppleScript(okLabel)}" giving up after 90`;
  const r = await run('osascript', ['-e', script]).catch(() => null);
  if (!r || r.code !== 0) return null;
  if (r.stdout.includes('gave up:true')) return null; // 90 秒无人点击
  return r.stdout.includes(okLabel);
}
