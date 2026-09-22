export interface Release { (): void }

/** Fair async mutex for the mutation lane. */
export class Mutex {
  private queue: Array<() => void> = [];
  private locked = false;

  async acquire(): Promise<Release> {
    if (this.locked) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.locked = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next();
      else this.locked = false;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try { return await fn(); }
    finally { release(); }
  }
}

/** Serialized mutation keys, e.g. "doc:fixture-part" or "doc:part/op:17". */
export class KeyedLocks {
  private locks = new Map<string, Mutex>();

  for(key: string): Mutex {
    let lock = this.locks.get(key);
    if (!lock) {
      lock = new Mutex();
      this.locks.set(key, lock);
    }
    return lock;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.for(key).run(fn);
  }

  // Alias for older tests
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    return this.run(key, fn);
  }

  get activeKeys(): number {
    return this.locks.size;
  }
}
export const KeyedLock = KeyedLocks;
