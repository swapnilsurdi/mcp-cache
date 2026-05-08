/**
 * Session management for mcp-cache.
 * Sessions are identified by time-sortable IDs and support fork/branch hierarchies.
 */

import { randomBytes } from 'crypto';
import { mkdir, writeFile, readFile, readdir, unlink } from 'fs/promises';
import { join } from 'path';

export interface Session {
  id: string;
  forkOf?: string;       // parent session ID if this is a fork
  forkAtTool?: string;   // tool call that triggered the fork
  label?: string;        // human-readable name
  createdAt: string;
  lastActiveAt: string;
}

export interface SessionTreeNode extends Session {
  forks: SessionTreeNode[];
}

/**
 * Generates a time-sortable session ID.
 * Format: sess_[9-char base36 timestamp][16-char hex random]
 * Lexicographic order == creation time order.
 */
function generateSessionId(): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(8).toString('hex');
  return `sess_${ts}${rand}`;
}

export class SessionManager {
  private readonly sessionsDir: string;
  private _current?: Session;

  constructor(cacheBaseDir: string) {
    // cacheBaseDir is e.g. ~/.mcp-cache/cache — sessions live at ~/.mcp-cache/sessions
    const parts = cacheBaseDir.replace(/\/$/, '').split('/');
    parts[parts.length - 1] = 'sessions';
    this.sessionsDir = parts.join('/');
  }

  async init(options: { id?: string; forkOf?: string; label?: string } = {}): Promise<Session> {
    await mkdir(this.sessionsDir, { recursive: true });

    if (options.id) {
      const existing = await this.get(options.id);
      if (existing) {
        existing.lastActiveAt = new Date().toISOString();
        await this._save(existing);
        this._current = existing;
        return existing;
      }
    }

    const session: Session = {
      id: options.id || generateSessionId(),
      ...(options.forkOf ? { forkOf: options.forkOf } : {}),
      ...(options.label ? { label: options.label } : {}),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    await this._save(session);
    this._current = session;
    return session;
  }

  /** Fork the current session, creating a new child session. */
  async fork(label?: string, forkAtTool?: string): Promise<Session> {
    if (!this._current) throw new Error('No active session to fork');

    const child: Session = {
      id: generateSessionId(),
      forkOf: this._current.id,
      ...(forkAtTool ? { forkAtTool } : {}),
      ...(label ? { label } : {}),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };

    await this._save(child);
    return child;
  }

  getCurrent(): Session | undefined {
    return this._current;
  }

  async touch(): Promise<void> {
    if (!this._current) return;
    this._current.lastActiveAt = new Date().toISOString();
    this._save(this._current).catch(() => {});
  }

  async get(id: string): Promise<Session | null> {
    try {
      const raw = await readFile(join(this.sessionsDir, `${id}.json`), 'utf8');
      return JSON.parse(raw) as Session;
    } catch {
      return null;
    }
  }

  async list(): Promise<Session[]> {
    try {
      const files = await readdir(this.sessionsDir);
      const results = await Promise.all(
        files.filter(f => f.endsWith('.json')).map(async f => {
          try {
            const raw = await readFile(join(this.sessionsDir, f), 'utf8');
            return JSON.parse(raw) as Session;
          } catch {
            return null;
          }
        })
      );
      return (results.filter(Boolean) as Session[]).sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt)
      );
    } catch {
      return [];
    }
  }

  /** Returns sessions as a tree rooted at sessions without a parent. */
  async getTree(): Promise<SessionTreeNode[]> {
    const all = await this.list();
    const byId = new Map(all.map(s => [s.id, s]));

    const buildNode = (s: Session): SessionTreeNode => ({
      ...s,
      forks: all.filter(c => c.forkOf === s.id).map(buildNode),
    });

    return all.filter(s => !s.forkOf).map(buildNode);
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(join(this.sessionsDir, `${id}.json`));
    } catch {}
  }

  private async _save(session: Session): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await writeFile(
      join(this.sessionsDir, `${session.id}.json`),
      JSON.stringify(session, null, 2),
      'utf8'
    );
  }
}
