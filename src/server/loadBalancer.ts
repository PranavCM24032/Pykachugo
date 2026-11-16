export interface UpstreamNodeState {
  id: string;
  url: string;
  healthy: boolean;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  totalRequests: number;
  totalFailures: number;
  avgLatencyMs: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_OPEN_MS = 30_000;
const MAX_TELEMETRY_QUEUE = 20_000;

export class LoadBalancer {
  private nodes: UpstreamNodeState[] = [];
  private rrCursor = 0;
  private inFlight = new Map<string, Promise<unknown>>();
  public coalescedHits = 0;
  private writeBehindQueue: Array<Record<string, unknown>> = [];
  private droppedTelemetryCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(upstreamUrls: string[]) {
    const clean = Array.from(
      new Set(
        upstreamUrls
          .map((u) => String(u || '').trim())
          .filter((u) => u.startsWith('http://') || u.startsWith('https://'))
      )
    );
    this.nodes = clean.map((url, idx) => ({
      id: `node-${idx + 1}`,
      url,
      healthy: true,
      consecutiveFailures: 0,
      circuitOpenUntil: 0,
      totalRequests: 0,
      totalFailures: 0,
      avgLatencyMs: 0,
    }));
  }

  hasUpstreams(): boolean {
    return this.nodes.length > 0;
  }

  /**
   * Deduplicates concurrent identical async operations (e.g. thundering herd on /api/bootstrap or /api/pokemon/:id.webp)
   */
  coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) {
      this.coalescedHits += 1;
      return existing as Promise<T>;
    }
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private pickNode(): UpstreamNodeState | null {
    if (this.nodes.length === 0) return null;
    const now = Date.now();
    const total = this.nodes.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.rrCursor + i) % total;
      const node = this.nodes[idx];
      if (node.circuitOpenUntil <= now) {
        this.rrCursor = (idx + 1) % total;
        return node;
      }
    }
    // All circuits open -> half-open probe on least-recently-failed
    const sorted = [...this.nodes].sort((a, b) => a.circuitOpenUntil - b.circuitOpenUntil);
    return sorted[0];
  }

  private recordResult(node: UpstreamNodeState, ok: boolean, latencyMs: number): void {
    node.totalRequests += 1;
    node.avgLatencyMs =
      node.totalRequests === 1
        ? latencyMs
        : Math.round(node.avgLatencyMs * 0.75 + latencyMs * 0.25);
    if (ok) {
      node.healthy = true;
      node.consecutiveFailures = 0;
      node.circuitOpenUntil = 0;
    } else {
      node.totalFailures += 1;
      node.consecutiveFailures += 1;
      if (node.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        node.healthy = false;
        node.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
      }
    }
  }

  async forwardGet(
    action: string,
    params: Record<string, string | number | boolean | undefined> = {},
    timeoutMs = 8000
  ): Promise<unknown> {
    const node = this.pickNode();
    if (!node) throw new Error('No Apps Script upstream configured');

    const url = new URL(node.url);
    url.searchParams.set('action', action);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v) !== '') {
        url.searchParams.set(k, String(v));
      }
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
      const json: unknown = await res.json();
      this.recordResult(node, true, Date.now() - started);
      return json;
    } catch (err) {
      this.recordResult(node, false, Date.now() - started);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async forwardPost(body: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
    const node = this.pickNode();
    if (!node) throw new Error('No Apps Script upstream configured');

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(node.url, {
        method: 'POST',
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);
      const json: unknown = await res.json();
      this.recordResult(node, true, Date.now() - started);
      return json;
    } catch (err) {
      this.recordResult(node, false, Date.now() - started);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  enqueueTelemetry(events: Array<Record<string, unknown>>): void {
    if (!this.hasUpstreams() || events.length === 0) return;
    for (const evt of events) {
      if (this.writeBehindQueue.length < MAX_TELEMETRY_QUEUE) {
        this.writeBehindQueue.push(evt);
      } else {
        this.droppedTelemetryCount += 1;
      }
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushTelemetryQueue();
      }, 1500);
    }
  }

  private async flushTelemetryQueue(): Promise<void> {
    if (this.flushing || this.writeBehindQueue.length === 0 || !this.hasUpstreams()) return;
    this.flushing = true;
    try {
      const first = this.writeBehindQueue[0];
      const groupKey = `${String(first?.tid || first?.teamName || '')}::${String(first?.sessionId || '')}`;
      const batch: Array<Record<string, unknown>> = [];
      const remaining: Array<Record<string, unknown>> = [];
      for (const event of this.writeBehindQueue) {
        const key = `${String(event.tid || event.teamName || '')}::${String(event.sessionId || '')}`;
        if (key === groupKey && batch.length < 25) batch.push(event);
        else remaining.push(event);
      }
      this.writeBehindQueue = remaining;
      const head = batch[0];
      try {
        await this.forwardPost(
          {
            action: 'SESSION_BATCH',
            tid: String(head?.tid || ''),
            teamName: String(head?.teamName || ''),
            sessionId: String(head?.sessionId || ''),
            events: batch,
          },
          12_000
        );
      } catch {
        // Re-queue on transient failure
        this.writeBehindQueue.unshift(...batch);
      }
    } finally {
      this.flushing = false;
      if (this.writeBehindQueue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          void this.flushTelemetryQueue();
        }, 4000);
      }
    }
  }

  getSnapshot() {
    return {
      upstreamCount: this.nodes.length,
      coalescedHits: this.coalescedHits,
      inFlightCount: this.inFlight.size,
      queuedTelemetry: this.writeBehindQueue.length,
      droppedTelemetry: this.droppedTelemetryCount,
      nodes: this.nodes.map((n) => ({
        id: n.id,
        healthy: n.healthy && n.circuitOpenUntil <= Date.now(),
        totalRequests: n.totalRequests,
        totalFailures: n.totalFailures,
        avgLatencyMs: n.avgLatencyMs,
      })),
    };
  }
}

let lbInstance: LoadBalancer | null = null;

export function getLoadBalancer(): LoadBalancer {
  if (lbInstance) return lbInstance;
  const rawPool = String(process.env.APPS_SCRIPT_URLS || '').trim();
  const single = String(process.env.VITE_APPS_SCRIPT_URL || '').trim();
  const urls = rawPool
    ? rawPool.split(',').map((s) => s.trim()).filter(Boolean)
    : single
      ? [single]
      : [];
  lbInstance = new LoadBalancer(urls);
  return lbInstance;
}
