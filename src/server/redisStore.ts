import fs from 'node:fs';
import path from 'node:path';

export interface RedisClientLike {
  readonly backend: 'upstash-rest' | 'memory-redis';
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean>;
  pipeline(commands: Array<Array<string | number>>): Promise<unknown[]>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  hset(key: string, field: string, value: string): Promise<void>;
  hget(key: string, field: string): Promise<string | null>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, field: string): Promise<void>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>>;
  keysByPrefix(prefix: string): Promise<string[]>;
  deleteByPrefix(prefix: string): Promise<number>;
  stats(): Promise<{ backend: 'upstash-rest' | 'memory-redis'; keyCount: number; connected: boolean }>;
}

interface MemoryEntry {
  value: string;
  expiresAt: number | null;
}

interface SnapshotShape {
  kv: Record<string, MemoryEntry>;
  hashes: Record<string, Record<string, string>>;
  zsets: Record<string, Record<string, number>>;
}

const SNAPSHOT_PATH = '/tmp/pykachu-redis-snapshot.json';

class InMemoryRedisStore implements RedisClientLike {
  readonly backend = 'memory-redis' as const;
  private kv = new Map<string, MemoryEntry>();
  private hashes = new Map<string, Map<string, string>>();
  private zsets = new Map<string, Map<string, number>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadSnapshot();
  }

  private loadSnapshot(): void {
    try {
      if (!fs.existsSync(SNAPSHOT_PATH)) return;
      const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SnapshotShape>;
      const now = Date.now();
      if (parsed.kv && typeof parsed.kv === 'object') {
        for (const [k, entry] of Object.entries(parsed.kv)) {
          if (entry && (!entry.expiresAt || entry.expiresAt > now)) {
            this.kv.set(k, entry);
          }
        }
      }
      if (parsed.hashes && typeof parsed.hashes === 'object') {
        for (const [k, obj] of Object.entries(parsed.hashes)) {
          this.hashes.set(k, new Map(Object.entries(obj)));
        }
      }
      if (parsed.zsets && typeof parsed.zsets === 'object') {
        for (const [k, obj] of Object.entries(parsed.zsets)) {
          this.zsets.set(k, new Map(Object.entries(obj)));
        }
      }
    } catch {
      // ignore corrupted snapshot
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        const now = Date.now();
        const kvOut: Record<string, MemoryEntry> = {};
        for (const [k, v] of this.kv.entries()) {
          if (v.expiresAt !== null && v.expiresAt <= now) {
            this.kv.delete(k);
            continue;
          }
          // Skip huge binary pokemon webp blobs from /tmp snapshot
          if (k.startsWith('pokemon:webp:')) continue;
          kvOut[k] = v;
        }
        const hashesOut: Record<string, Record<string, string>> = {};
        for (const [k, m] of this.hashes.entries()) {
          hashesOut[k] = Object.fromEntries(m.entries());
        }
        const zsetsOut: Record<string, Record<string, number>> = {};
        for (const [k, m] of this.zsets.entries()) {
          zsetsOut[k] = Object.fromEntries(m.entries());
        }
        fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
        fs.writeFileSync(
          SNAPSHOT_PATH,
          JSON.stringify({ kv: kvOut, hashes: hashesOut, zsets: zsetsOut }),
          'utf8'
        );
      } catch {
        // ignore snapshot errors
      }
    }, 600);
  }

  private isExpired(entry: MemoryEntry | undefined): boolean {
    return Boolean(entry && entry.expiresAt !== null && Date.now() >= entry.expiresAt);
  }

  async get(key: string): Promise<string | null> {
    const entry = this.kv.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.kv.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.kv.set(key, { value, expiresAt });
    this.schedulePersist();
  }

  async setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== null) return false;
    await this.set(key, value, ttlSeconds);
    return true;
  }

  async pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const command of commands) {
      const [rawName, ...args] = command;
      const name = String(rawName || '').toUpperCase();
      const key = String(args[0] || '');
      switch (name) {
        case 'GET':
          results.push(await this.get(key));
          break;
        case 'SET': {
          const ttlIndex = args.findIndex((arg) => String(arg).toUpperCase() === 'EX');
          const ttl = ttlIndex >= 0 ? Number(args[ttlIndex + 1]) : undefined;
          await this.set(key, String(args[1] || ''), ttl);
          results.push('OK');
          break;
        }
        case 'HGET':
          results.push(await this.hget(key, String(args[1] || '')));
          break;
        case 'HSET':
          await this.hset(key, String(args[1] || ''), String(args[2] || ''));
          results.push(1);
          break;
        case 'ZADD':
          await this.zadd(key, Number(args[1]), String(args[2] || ''));
          results.push(1);
          break;
        default:
          throw new Error(`Unsupported in-memory Redis pipeline command: ${name}`);
      }
    }
    return results;
  }

  async del(key: string): Promise<void> {
    this.kv.delete(key);
    this.hashes.delete(key);
    this.zsets.delete(key);
    this.schedulePersist();
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const cur = await this.get(key);
    const next = (cur ? Number(cur) || 0 : 0) + 1;
    const existingEntry = this.kv.get(key);
    const expiresAt =
      existingEntry && existingEntry.expiresAt
        ? existingEntry.expiresAt
        : ttlSeconds && ttlSeconds > 0
          ? Date.now() + ttlSeconds * 1000
          : null;
    this.kv.set(key, { value: String(next), expiresAt });
    return next;
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    this.schedulePersist();
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const h = this.hashes.get(key);
    if (!h) return {};
    return Object.fromEntries(h.entries());
  }

  async hdel(key: string, field: string): Promise<void> {
    this.hashes.get(key)?.delete(field);
    this.schedulePersist();
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    let z = this.zsets.get(key);
    if (!z) {
      z = new Map();
      this.zsets.set(key, z);
    }
    z.set(member, score);
    this.schedulePersist();
  }

  async zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    const z = this.zsets.get(key);
    if (!z) return [];
    const sorted = Array.from(z.entries())
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => b.score - a.score || a.member.localeCompare(b.member));
    const endIdx = stop < 0 ? sorted.length : stop + 1;
    return sorted.slice(Math.max(0, start), endIdx);
  }

  async keysByPrefix(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    const now = Date.now();
    for (const [k, entry] of this.kv.entries()) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        this.kv.delete(k);
        continue;
      }
      if (k.startsWith(prefix)) out.add(k);
    }
    for (const k of this.hashes.keys()) {
      if (k.startsWith(prefix)) out.add(k);
    }
    for (const k of this.zsets.keys()) {
      if (k.startsWith(prefix)) out.add(k);
    }
    return Array.from(out);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const keys = await this.keysByPrefix(prefix);
    keys.forEach((k) => {
      this.kv.delete(k);
      this.hashes.delete(k);
      this.zsets.delete(k);
    });
    if (keys.length > 0) this.schedulePersist();
    return keys.length;
  }

  async stats() {
    return {
      backend: this.backend,
      keyCount: this.kv.size + this.hashes.size + this.zsets.size,
      connected: true,
    };
  }
}

class UpstashRestRedisStore implements RedisClientLike {
  readonly backend = 'upstash-rest' as const;
  private url: string;
  private token: string;
  private fallback: InMemoryRedisStore;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.fallback = new InMemoryRedisStore();
  }

  private async cmd<T = unknown>(args: Array<string | number>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Upstash HTTP ${res.status}`);
      const data = (await res.json()) as { result?: T; error?: string };
      if (data.error) throw new Error(data.error);
      return data.result as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      const r = await this.cmd<string | null>(['GET', key]);
      return r ?? null;
    } catch {
      return this.fallback.get(key);
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.fallback.set(key, value, ttlSeconds);
    try {
      if (ttlSeconds && ttlSeconds > 0) {
        await this.cmd(['SET', key, value, 'EX', Math.floor(ttlSeconds)]);
      } else {
        await this.cmd(['SET', key, value]);
      }
    } catch {
      // keep fallback updated
    }
  }

  async setNX(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      const args: Array<string | number> = ['SET', key, value, 'NX'];
      if (ttlSeconds && ttlSeconds > 0) args.push('EX', Math.floor(ttlSeconds));
      const res = await this.cmd<string | null>(args);
      if (res === 'OK') {
        await this.fallback.set(key, value, ttlSeconds);
        return true;
      }
      return false;
    } catch {
      return this.fallback.setNX(key, value, ttlSeconds);
    }
  }

  async pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
    const fallbackResults = await this.fallback.pipeline(commands);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const res = await fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(commands),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Upstash pipeline HTTP ${res.status}`);
      const data = (await res.json()) as Array<{ result?: unknown; error?: string }>;
      if (!Array.isArray(data)) throw new Error('Invalid Upstash pipeline response');
      const failed = data.find((item) => item?.error);
      if (failed?.error) throw new Error(failed.error);
      return data.map((item) => item?.result);
    } catch {
      return fallbackResults;
    } finally {
      clearTimeout(timer);
    }
  }

  async del(key: string): Promise<void> {
    await this.fallback.del(key);
    try {
      await this.cmd(['DEL', key]);
    } catch {
      // ignore
    }
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    try {
      const val = await this.cmd<number>(['INCR', key]);
      if (val === 1 && ttlSeconds && ttlSeconds > 0) {
        await this.cmd(['EXPIRE', key, Math.floor(ttlSeconds)]);
      }
      return Number(val || 1);
    } catch {
      return this.fallback.incr(key, ttlSeconds);
    }
  }

  async hset(key: string, field: string, value: string): Promise<void> {
    await this.fallback.hset(key, field, value);
    try {
      await this.cmd(['HSET', key, field, value]);
    } catch {
      // ignore
    }
  }

  async hget(key: string, field: string): Promise<string | null> {
    try {
      const res = await this.cmd<string | null>(['HGET', key, field]);
      return res ?? null;
    } catch {
      return this.fallback.hget(key, field);
    }
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      const raw = await this.cmd<string[] | Record<string, string> | null>(['HGETALL', key]);
      if (!raw) return {};
      if (!Array.isArray(raw)) return raw;
      const out: Record<string, string> = {};
      for (let i = 0; i < raw.length; i += 2) {
        out[String(raw[i])] = String(raw[i + 1] ?? '');
      }
      return out;
    } catch {
      return this.fallback.hgetall(key);
    }
  }

  async hdel(key: string, field: string): Promise<void> {
    await this.fallback.hdel(key, field);
    try {
      await this.cmd(['HDEL', key, field]);
    } catch {
      // ignore
    }
  }

  async zadd(key: string, score: number, member: string): Promise<void> {
    await this.fallback.zadd(key, score, member);
    try {
      await this.cmd(['ZADD', key, score, member]);
    } catch {
      // ignore
    }
  }

  async zrevrangeWithScores(key: string, start: number, stop: number): Promise<Array<{ member: string; score: number }>> {
    try {
      const raw = await this.cmd<string[]>(['ZREVRANGE', key, start, stop, 'WITHSCORES']);
      if (!Array.isArray(raw)) return [];
      const out: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < raw.length; i += 2) {
        out.push({ member: String(raw[i]), score: Number(raw[i + 1] || 0) });
      }
      return out;
    } catch {
      return this.fallback.zrevrangeWithScores(key, start, stop);
    }
  }

  async keysByPrefix(prefix: string): Promise<string[]> {
    try {
      const keys = await this.cmd<string[]>(['KEYS', `${prefix}*`]);
      return Array.isArray(keys) ? keys : [];
    } catch {
      return this.fallback.keysByPrefix(prefix);
    }
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    const localDeleted = await this.fallback.deleteByPrefix(prefix);
    try {
      const remoteKeys = await this.keysByPrefix(prefix);
      if (remoteKeys.length > 0) {
        await this.cmd(['DEL', ...remoteKeys]);
        return remoteKeys.length;
      }
      return localDeleted;
    } catch {
      return localDeleted;
    }
  }

  async stats() {
    try {
      const size = await this.cmd<number>(['DBSIZE']);
      return { backend: this.backend, keyCount: Number(size || 0), connected: true };
    } catch {
      const fb = await this.fallback.stats();
      return { backend: this.backend, keyCount: fb.keyCount, connected: false };
    }
  }
}

let singletonStore: RedisClientLike | null = null;

export function getRedisStore(): RedisClientLike {
  if (singletonStore) return singletonStore;
  const restUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
  const restToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
  if (restUrl && restToken) {
    singletonStore = new UpstashRestRedisStore(restUrl, restToken);
  } else {
    singletonStore = new InMemoryRedisStore();
  }
  return singletonStore;
}
