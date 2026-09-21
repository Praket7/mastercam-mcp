export class AsyncLock {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise(resolve => {
      this.waiters.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  private release() {
    this.locked = false;
    const next = this.waiters.shift();
    if (next) next();
  }

  isLocked(): boolean { return this.locked; }
}

export class KeyedLock {
  private locks = new Map<string, AsyncLock>();

  getLock(key: string): AsyncLock {
    let lock = this.locks.get(key);
    if (!lock) { lock = new AsyncLock(); this.locks.set(key, lock); }
    return lock;
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.getLock(key).acquire();
    try { return await fn(); } finally { release(); }
  }

  removeLock(key: string) { this.locks.delete(key); }
}

export const keyedLock = new KeyedLock();