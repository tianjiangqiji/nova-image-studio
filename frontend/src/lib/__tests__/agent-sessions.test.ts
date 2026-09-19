import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentSession,
  deleteAgentSession,
  getActiveAgentSessionId,
  listAgentSessions,
  renameAgentSession,
  setActiveAgentSessionId,
} from '@/lib/agent-sessions';

vi.mock('@/lib/uuid', () => ({
  generateUUID: vi.fn(() => 'generated-session-id'),
}));

const DEFAULT_SESSION = { id: 'default', name: '默认会话' };

describe('listAgentSessions', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('存储为空或损坏时回退到默认会话', () => {
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);

    localStorage.setItem('nova-agent-sessions', '{broken');
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);

    localStorage.setItem('nova-agent-sessions', JSON.stringify({ id: 'not-an-array' }));
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);
  });

  it('创建会话时使用 UUID 并持久化到默认会话之后', () => {
    const created = createAgentSession('商品图会话');

    expect(created).toEqual({ id: 'generated-session-id', name: '商品图会话' });
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION, created]);
    expect(JSON.parse(localStorage.getItem('nova-agent-sessions') || 'null')).toEqual([
      DEFAULT_SESSION,
      created,
    ]);
  });

  it('创建会话时 trim 名称并拒绝空名称', () => {
    expect(createAgentSession('  商品图会话  ')).toEqual({
      id: 'generated-session-id',
      name: '商品图会话',
    });
    expect(() => createAgentSession('   ')).toThrow('会话名称不能为空');
    expect(listAgentSessions()).toEqual([
      DEFAULT_SESSION,
      { id: 'generated-session-id', name: '商品图会话' },
    ]);
  });

  it('按 id 改名并保留会话顺序', () => {
    createAgentSession('旧名称');

    expect(renameAgentSession('generated-session-id', '新名称')).toBe(true);
    expect(listAgentSessions()).toEqual([
      DEFAULT_SESSION,
      { id: 'generated-session-id', name: '新名称' },
    ]);
    expect(renameAgentSession('missing', '不存在')).toBe(false);
  });

  it('改名时 trim 名称并拒绝空名称', () => {
    createAgentSession('旧名称');

    expect(renameAgentSession('generated-session-id', '  新名称  ')).toBe(true);
    expect(renameAgentSession('generated-session-id', '   ')).toBe(false);
    expect(listAgentSessions()).toEqual([
      DEFAULT_SESSION,
      { id: 'generated-session-id', name: '新名称' },
    ]);
  });

  it('default 不可删除，删除活动会话后回到 default', () => {
    const created = createAgentSession('待删除');

    expect(setActiveAgentSessionId(created.id)).toBe(true);
    expect(getActiveAgentSessionId()).toBe(created.id);
    expect(deleteAgentSession('default')).toBe(false);
    expect(deleteAgentSession(created.id)).toBe(true);
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);
    expect(getActiveAgentSessionId()).toBe('default');
    expect(localStorage.getItem('nova-agent-active-session')).toBe('default');
  });

  it('只允许把 active 指针设为注册表中存在的会话', () => {
    const created = createAgentSession('活动会话');

    expect(setActiveAgentSessionId(created.id)).toBe(true);
    expect(setActiveAgentSessionId('missing')).toBe(false);
    expect(localStorage.getItem('nova-agent-active-session')).toBe(created.id);
    expect(getActiveAgentSessionId()).toBe(created.id);
  });

  it('持久化 active 指针，未知指针读取时回退到 default', () => {
    const created = createAgentSession('活动会话');

    expect(setActiveAgentSessionId(created.id)).toBe(true);
    expect(getActiveAgentSessionId()).toBe(created.id);

    localStorage.setItem('nova-agent-active-session', 'missing');
    expect(getActiveAgentSessionId()).toBe('default');
  });
});

describe('agent session storage fallback', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('SSR 环境下返回默认值且不抛异常', () => {
    vi.stubGlobal('window', undefined);

    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);
    expect(getActiveAgentSessionId()).toBe('default');
    expect(() => createAgentSession('SSR 会话')).not.toThrow();
    expect(() => renameAgentSession('default', '改名')).not.toThrow();
    expect(() => deleteAgentSession('default')).not.toThrow();
    expect(() => setActiveAgentSessionId('default')).not.toThrow();
  });

  it('localStorage 读写异常时降级而不抛异常', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(listAgentSessions()).toEqual([DEFAULT_SESSION]);
    expect(getActiveAgentSessionId()).toBe('default');

    vi.restoreAllMocks();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    expect(() => createAgentSession('离线会话')).not.toThrow();
    expect(() => setActiveAgentSessionId('default')).not.toThrow();
  });
});
