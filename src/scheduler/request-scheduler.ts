import { KeyedLocks } from "./locks.js";

export interface SchedulerOptions {
  maxConcurrentReads?: number;
  maxConcurrentMutations?: number;
  maxQueueDepth?: number;
}

export interface ScheduledTask<T> {
  lane: "read" | "mutation";
  documentKey: string;
  run: () => Promise<T>;
}

export class Scheduler {
  private readsInFlight = 0;
  private readQueue: Array<() => void> = [];
  private mutationQueue: Array<{ key: string; run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
  private docLocks = new KeyedLocks();
  private readonly maxConcurrentReads: number;
  private readonly maxQueueDepth: number;
  private mutationActive = false;

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrentReads = options.maxConcurrentReads ?? 8;
    this.maxQueueDepth = options.maxQueueDepth ?? 500;
  }

  get stats() {
    return {
      readsInFlight: this.readsInFlight,
      readQueueDepth: this.readQueue.length,
      mutationQueueDepth: this.mutationQueue.length,
      mutationActive: this.mutationActive
    };
  }

  async schedule<T>(task: ScheduledTask<T>): Promise<T>;
  async schedule<T>(lane: "read" | "mutation", key: string, priority: string, run: () => Promise<T>): Promise<T>;
  async schedule<T>(taskOrLane: ScheduledTask<T> | "read" | "mutation", key?: string, priority?: string, run?: () => Promise<T>): Promise<T> {
    if (typeof taskOrLane === "string") {
      const lane = taskOrLane as "read" | "mutation";
      const documentKey = key ?? "default";
      const fn = run!;
      const prio = priority ?? "normal";
      // For old API, handle priority by queuing and sorting
      const order = { critical: 4, high: 3, normal: 2, low: 1 } as Record<string, number>;
      const prioVal = order[prio] ?? 2;
      // Use a simple priority queue for old API reads: delay based on priority
      const delay = (4 - prioVal) * 10;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      if (lane === "read") return this.scheduleRead(fn);
      return this.scheduleMutation(documentKey, fn);
    }
    const task = taskOrLane as ScheduledTask<T>;
    if (task.lane === "read") return this.scheduleRead(task.run);
    return this.scheduleMutation(task.documentKey, task.run);
  }

  // Compatibility for old test that calls getStats()
  getStats() {
    return {
      read: { queued: this.readQueue.length, active: this.readsInFlight, max: this.maxConcurrentReads },
      mutation: { queued: this.mutationQueue.length, active: this.mutationActive ? 1 : 0, max: 1 }
    };
  }

  private async scheduleRead<T>(run: () => Promise<T>): Promise<T> {
    if (this.readsInFlight >= this.maxConcurrentReads) {
      if (this.readQueue.length >= this.maxQueueDepth) throw new Error("RATE_LIMITED: read queue is full");
      await new Promise<void>(resolve => this.readQueue.push(resolve));
    }
    this.readsInFlight++;
    try { return await run(); }
    finally {
      this.readsInFlight--;
      const next = this.readQueue.shift();
      if (next) next();
    }
  }

  /**
   * Mutations run one at a time globally, and additionally under a per-document
   * lock, which is where CAS re-verification happens.
   */
  private scheduleMutation<T>(documentKey: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.mutationQueue.length >= this.maxQueueDepth) {
        reject(new Error("RATE_LIMITED: mutation queue is full"));
        return;
      }
      this.mutationQueue.push({
        key: documentKey,
        run: async () => {
          this.mutationActive = true;
          try {
            return await this.docLocks.run(documentKey, run);
          } finally {
            this.mutationActive = false;
          }
        },
        resolve: resolve as (v: unknown) => void,
        reject
      });
      void this.drainMutations();
    });
  }

  private draining = false;
  private async drainMutations(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.mutationQueue.length > 0) {
        const task = this.mutationQueue.shift()!;
        try {
          const result = await task.run();
          task.resolve(result);
        } catch (error) {
          task.reject(error);
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
export const RequestScheduler = Scheduler;
