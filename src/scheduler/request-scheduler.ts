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

  async schedule<T>(task: ScheduledTask<T>): Promise<T> {
    if (task.lane === "read") return this.scheduleRead(task.run);
    return this.scheduleMutation(task.documentKey, task.run);
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
