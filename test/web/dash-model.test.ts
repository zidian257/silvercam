import { describe, it, expect } from 'vitest';
import { computeCards } from '../../web/src/lib/dash.ts';

const status = (over = {}) => ({
  uptime_s: 3661,
  store: 'sqlite',
  watcher: { active: true, volumes_seen: 2 },
  jobs: { total: 5, by_state: {}, current_id: null },
  ...over,
});

describe('computeCards', () => {
  it('待确认素材 >0 时带 /inbox 链接', () => {
    const cards = computeCards(status(), [{}, {}], []);
    expect(cards[0]).toMatchObject({ n: 2, k: '待确认素材', link: '/inbox' });
    const empty = computeCards(status(), [], []);
    expect(empty[0].link).toBeNull();
  });

  it('队列卡 = 运行中 + 排队数', () => {
    const st = status({ jobs: { total: 4, by_state: { rendering: 1, queued: 2, done: 1 }, current_id: 'x' } });
    const cards = computeCards(st, [], []);
    expect(cards[1].n).toBe(3);
    expect(cards[1].k).toBe('队列（运行 1 / 排队 2）');
  });

  it('失败/待 FIT 卡：有失败时 warn 标红', () => {
    const st = status({ jobs: { total: 2, by_state: { failed: 1, awaiting_fit: 1 }, current_id: null } });
    const cards = computeCards(st, [], []);
    expect(cards[3].n).toBe(2);
    expect(cards[3].k).toBe('失败 1 / 待 FIT 1');
    expect(cards[3].warn).toBe(true);
    const ok = computeCards(status({ jobs: { total: 0, by_state: {}, current_id: null } }), [], []);
    expect(ok[3].warn).toBeFalsy();
  });

  it('watcher 未启用显示 关', () => {
    const cards = computeCards(status({ watcher: { active: false } }), [], []);
    expect(cards[4].n).toBe('关');
    expect(cards[4].k).toContain('未启用');
  });

  it('运行时长格式化 + store 类型', () => {
    const cards = computeCards(status(), [], []);
    expect(cards[5].n).toBe('1h1m');
    expect(cards[5].k).toContain('sqlite');
  });
});
