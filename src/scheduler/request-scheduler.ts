import { KeyedLocks } from "./locks.js";

export type RequestPriority = "critical" | "high" | "normal" | "low";

export interface SchedulerOptions {
  maxConcurrentReads?: number;
  /** Mastercam mutations are deliberately serialized; values other than 1 are rejected. */
  maxConcurrentMutations?: number;
  maxQueueDepth?: number;
}

export interface ScheduledTask<T> {
  lane: "read" | "mutation";
  documentKey: string;
  priority?: RequestPriority;
  run: () => Promise<T>;
}

interface ReadWaiter {
  priority: number;
  sequence: number;
  resolve: () => void;
}

interface MutationWaiter {
  key: string;
  priority: number;
  sequence: number;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const PRIORITY: Record<RequestPriority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1
};

export class Scheduler {
  private readsInFlight = 0;
  private readQueue: ReadWaiter[] = [];
  private mutationQueue: MutationWaiter[] = [];
  private docLocks = new KeyedLocks();
  private readonly maxConcurrentReads: number;
  private readonly maxQueueDepth: number;
  private mutationActive = false;
  private sequence = 0;
  private draining = false;

  constructor(options: SchedulerOptions = {}) {
    this.maxConcurrentReads = options.maxConcurrentReads ?? 8;
    this.maxQueueDepth = options.maxQueueDepth ?? 500;
    const mutationConcurrency = options.maxConcurrentMutations ?? 1;
    if (!Number.isInteger(this.maxConcurrentReads) || this.maxConcurrentReads <= 0) {
      throw new Error("maxConcurrentReads must be a positive integer");
    }
    if (!Number.isInteger(this.maxQueueDepth) || this.maxQueueDepth <= 0) {
      throw new Error("maxQueueDepth must be a positive integer");
    }
    if (mutationConcurrency !== 1) {
      throw new Error("maxConcurrentMutations must be 1 because live Mastercam mutations are serialized");
    }
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
      const lane = taskOrLane;
      const documentKey = key ?? "default";
      const normalized = this.normalizePriority(priority);
      const fn = run;
      if (!fn) throw new Error("Scheduled task is missing run()");
      if (lane === "read") return this.scheduleRead(fn, normalized);
      return this.scheduleMutation(documentKey, fn, normalized);
    }

    const task = taskOrLane;
    const normalized = task.priority ?? "normal";
    if (task.lane === "read") return this.scheduleRead(task.run, normalized);
    return this.scheduleMutation(task.documentKey, task.run, normalized);
  }

  getStats() {
    return {
      read: { queued: this.readQueue.length, active: this.readsInFlight, max: this.maxConcurrentReads },
      mutation: { queued: this.mutationQueue.length, active: this.mutationActive ? 1 : 0, max: 1 }
    };
  }

  private normalizePriority(value: string | undefined): RequestPriority {
    return value === "critical" || value === "high" || value === "low" ? value : "normal";
  }

  private sortQueue<T extends { priority: number; sequence: number }>(queue: T[]): void {
    queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence);
  }

  private async scheduleRead<T>(run: () => Promise<T>, priority: RequestPriority): Promise<T> {
    if (this.readsInFlight >= this.maxConcurrentReads) {
      if (this.readQueue.length >= this.maxQueueDepth) throw new Error("RATE_LIMITED: read queue is full");
      await new Promise<void>(resolve => {
        this.readQueue.push({ priority: PRIORITY[priority], sequence: this.sequence++, resolve });
        this.sortQueue(this.readQueue);
      });
    }

    this.readsInFlight++;
    try {
      return await run();
    } finally {
      this.readsInFlight--;
      const next = this.readQueue.shift();
      next?.resolve();
    }
  }

  /**
   * Mutations remain globally serialized and additionally execute under a
   * per-document lock, where CAS/revision re-verification belongs. Priority
   * affects queue order without injecting artificial sleep latency.
   */
  private scheduleMutation<T>(documentKey: string, run: () => Promise<T>, priority: RequestPriority): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.mutationQueue.length >= this.maxQueueDepth) {
        reject(new Error("RATE_LIMITED: mutation queue is full"));
        return;
      }
      this.mutationQueue.push({
        key: documentKey,
        priority: PRIORITY[priority],
        sequence: this.sequence++,
        run: async () => {
          this.mutationActive = true;
          try {
            return await this.docLocks.run(documentKey, run);
          } finally {
            this.mutationActive = false;
          }
        },
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.sortQueue(this.mutationQueue);
      void this.drainMutations();
    });
  }

  private async drainMutations(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.mutationQueue.length > 0) {
        const task = this.mutationQueue.shift()!;
        try {
          task.resolve(await task.run());
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
