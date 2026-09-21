import { EventEmitter } from "node:events";

export type RequestPriority = "low" | "normal" | "high" | "critical";
export type RequestLane = "read" | "mutation";

export interface ScheduledRequest<T = unknown> {
  id: string;
  lane: RequestLane;
  priority: RequestPriority;
  key: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout?: NodeJS.Timeout;
  startedAt: number;
}

export class RequestScheduler<T = unknown> extends EventEmitter {
  private readQueue: ScheduledRequest<T>[] = [];
  private mutationQueue: ScheduledRequest<T>[] = [];
  private activeReads = 0;
  private activeMutations = 0;
  private readonly maxConcurrentReads: number;
  private readonly maxConcurrentMutations: number;
  private readonly mutationLock = new Map<string, Promise<unknown>>();

  constructor(options: { maxConcurrentReads?: number; maxConcurrentMutations?: number } = {}) {
    super();
    this.maxConcurrentReads = options.maxConcurrentReads ?? 4;
    this.maxConcurrentMutations = options.maxConcurrentMutations ?? 1;
  }

  schedule(lane: RequestLane, key: string, priority: RequestPriority, execute: () => Promise<T>, timeoutMs?: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: ScheduledRequest<T> = {
        id: crypto.randomUUID(),
        lane,
        priority,
        key,
        execute,
        resolve,
        reject,
        startedAt: Date.now()
      };
      if (timeoutMs) {
        request.timeout = setTimeout(() => {
          this.remove(request);
          reject(new Error(`Request ${request.id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      if (lane === "read") this.readQueue.push(request);
      else this.mutationQueue.push(request);
      this.process();
    });
  }

  private process() {
    this.processLane("read", this.readQueue, () => this.activeReads < this.maxConcurrentReads);
    this.processLane("mutation", this.mutationQueue, () => this.activeMutations < this.maxConcurrentMutations);
  }

  private processLane(lane: RequestLane, queue: ScheduledRequest<T>[], canRun: () => boolean) {
    while (canRun() && queue.length > 0) {
      queue.sort((a, b) => this.priorityWeight(b.priority) - this.priorityWeight(a.priority));
      const request = queue.shift()!;
      if (lane === "mutation") {
        const existing = this.mutationLock.get(request.key);
        if (existing) {
          existing.then(() => this.run(request)).catch(() => this.run(request));
          continue;
        }
        const promise = this.run(request);
        this.mutationLock.set(request.key, promise);
        promise.finally(() => this.mutationLock.delete(request.key));
      } else {
        this.run(request);
      }
    }
  }

  private async run(request: ScheduledRequest<T>) {
    const { lane, key } = request;
    if (lane === "read") this.activeReads++; else this.activeMutations++;
    this.emit("start", { id: request.id, lane, key });
    try {
      const result = await request.execute();
      if (request.timeout) clearTimeout(request.timeout);
      request.resolve(result);
      this.emit("complete", { id: request.id, lane, key, duration: Date.now() - request.startedAt });
    } catch (error) {
      if (request.timeout) clearTimeout(request.timeout);
      request.reject(error instanceof Error ? error : new Error(String(error)));
      this.emit("error", { id: request.id, lane, key, error });
    } finally {
      if (lane === "read") this.activeReads--; else this.activeMutations--;
      this.process();
    }
  }

  private remove(request: ScheduledRequest<T>) {
    const queue = request.lane === "read" ? this.readQueue : this.mutationQueue;
    const idx = queue.indexOf(request);
    if (idx >= 0) queue.splice(idx, 1);
  }

  private priorityWeight(p: RequestPriority): number {
    switch (p) { case "critical": return 4; case "high": return 3; case "normal": return 2; case "low": return 1; }
  }

  getStats() {
    return {
      read: { queued: this.readQueue.length, active: this.activeReads, max: this.maxConcurrentReads },
      mutation: { queued: this.mutationQueue.length, active: this.activeMutations, max: this.maxConcurrentMutations }
    };
  }
}

export const scheduler = new RequestScheduler();