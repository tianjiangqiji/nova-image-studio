import { generateUUID } from '@/lib/uuid';

export interface AgentSession {
  id: string;
  name: string;
}

const SESSIONS_KEY = 'nova-agent-sessions';
const ACTIVE_SESSION_KEY = 'nova-agent-active-session';
const DEFAULT_SESSION: AgentSession = { id: 'default', name: '默认会话' };

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function cloneSession(session: AgentSession): AgentSession {
  return { id: session.id, name: session.name };
}

function normalizeSessions(values: unknown[]): AgentSession[] {
  const unique = new Map<string, AgentSession>();
  for (const value of values) {
    if (!isAgentSession(value) || unique.has(value.id)) continue;
    unique.set(value.id, cloneSession(value));
  }

  const defaultSession = unique.get(DEFAULT_SESSION.id) || cloneSession(DEFAULT_SESSION);
  const otherSessions = [...unique.values()].filter(session => session.id !== DEFAULT_SESSION.id);
  return [defaultSession, ...otherSessions];
}

function getStoredSessions(): AgentSession[] {
  const storage = getStorage();
  if (!storage) return [cloneSession(DEFAULT_SESSION)];

  try {
    const raw = storage.getItem(SESSIONS_KEY);
    if (!raw) return [cloneSession(DEFAULT_SESSION)];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [cloneSession(DEFAULT_SESSION)];
    return normalizeSessions(parsed);
  } catch {
    return [cloneSession(DEFAULT_SESSION)];
  }
}

function isAgentSession(value: unknown): value is AgentSession {
  if (!value || typeof value !== 'object') return false;
  const session = value as Record<string, unknown>;
  return typeof session.id === 'string' && session.id.length > 0
    && typeof session.name === 'string' && session.name.length > 0;
}

function saveSessions(sessions: AgentSession[]): void {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Keep the in-memory registry usable when storage is unavailable.
  }
}

export function listAgentSessions(): AgentSession[] {
  return getStoredSessions();
}

export function createAgentSession(name = '新会话'): AgentSession {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error('会话名称不能为空');

  const session = { id: generateUUID(), name: normalizedName };
  saveSessions([...getStoredSessions(), session]);
  return session;
}

export function renameAgentSession(id: string, name: string): boolean {
  const normalizedName = name.trim();
  if (!normalizedName) return false;

  const sessions = getStoredSessions();
  const index = sessions.findIndex(session => session.id === id);
  if (index < 0) return false;

  const renamed = sessions.map(session => session.id === id ? { ...session, name: normalizedName } : session);
  saveSessions(renamed);
  return true;
}

export function deleteAgentSession(id: string): boolean {
  if (id === DEFAULT_SESSION.id) return false;

  const sessions = getStoredSessions();
  if (!sessions.some(session => session.id === id)) return false;
  const wasActive = getActiveAgentSessionId() === id;

  saveSessions(sessions.filter(session => session.id !== id));
  if (wasActive) setActiveAgentSessionId(DEFAULT_SESSION.id);
  return true;
}

export function getActiveAgentSessionId(): string {
  const storage = getStorage();
  if (!storage) return DEFAULT_SESSION.id;

  try {
    const activeId = storage.getItem(ACTIVE_SESSION_KEY);
    if (!activeId || !getStoredSessions().some(session => session.id === activeId)) {
      return DEFAULT_SESSION.id;
    }
    return activeId;
  } catch {
    return DEFAULT_SESSION.id;
  }
}

export function setActiveAgentSessionId(id: string): boolean {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (!getStoredSessions().some(session => session.id === id)) return false;

  const storage = getStorage();
  if (!storage) return false;

  try {
    storage.setItem(ACTIVE_SESSION_KEY, id);
    return true;
  } catch {
    return false;
  }
}
