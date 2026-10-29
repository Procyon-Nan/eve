type Delivery = {
  readonly recovery: boolean;
  readonly run: () => Promise<number | undefined>;
  readonly finish: () => void;
  readonly fail: (error: unknown) => void;
  due: number;
  ready: boolean;
};

/** Schedules delivery attempts, not the lifetime of durable workflows. */
export function createLocalQueueScheduler(input: {
  concurrency: number;
  recoveryBuffer: number;
  signal: AbortSignal;
}) {
  const waiting = new Set<Delivery>();
  const active = new Set<Promise<void>>();
  const capacityWaiters = new Set<() => void>();
  const recoveryConcurrency = Math.max(1, Math.floor(input.concurrency / 2));
  let activeRecovery = 0;
  let preferRecovery = true;
  let enabled = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function recoveryReadyCount() {
    let count = 0;
    for (const job of waiting) if (job.recovery && job.ready) count++;
    return count;
  }

  function notifyCapacity() {
    for (const resume of capacityWaiters) resume();
    capacityWaiters.clear();
  }

  function pump() {
    clearTimeout(timer);
    timer = undefined;
    if (input.signal.aborted || !enabled) return;
    const now = Date.now();
    let available = input.recoveryBuffer - recoveryReadyCount();
    for (const job of waiting) {
      if (!job.ready && job.due <= now && (!job.recovery || available > 0)) {
        job.ready = true;
        if (job.recovery) available--;
      }
    }
    while (active.size < input.concurrency) {
      let normal: Delivery | undefined;
      let recovery: Delivery | undefined;
      for (const job of waiting) {
        if (!job.ready) continue;
        if (job.recovery) recovery ??= job;
        else normal ??= job;
        if (normal && recovery) break;
      }
      if (activeRecovery >= recoveryConcurrency) recovery = undefined;
      const job = preferRecovery ? (recovery ?? normal) : (normal ?? recovery);
      if (!job) break;
      waiting.delete(job);
      preferRecovery = !job.recovery;
      if (job.recovery) activeRecovery++;
      const running = Promise.resolve()
        .then(job.run)
        .then((delay) => {
          if (delay !== undefined && !input.signal.aborted) {
            job.due = Date.now() + delay;
            job.ready = false;
            waiting.add(job);
          } else {
            job.finish();
          }
        })
        .catch((error: unknown) => {
          try {
            job.fail(error);
          } finally {
            job.finish();
          }
        })
        .finally(() => {
          active.delete(running);
          if (job.recovery) activeRecovery--;
          notifyCapacity();
          pump();
        });
      active.add(running);
    }
    notifyCapacity();
    let next = Infinity;
    const canPromoteRecovery = recoveryReadyCount() < input.recoveryBuffer;
    for (const job of waiting) {
      if (!job.ready && (!job.recovery || canPromoteRecovery)) next = Math.min(next, job.due);
    }
    // When all slots are busy, completion will pump overdue deliveries.
    if (next !== Infinity && (next > now || active.size < input.concurrency)) {
      timer = setTimeout(pump, Math.min(Math.max(0, next - now), 2_147_483_647));
    }
  }

  input.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      for (const job of waiting) job.finish();
      waiting.clear();
      notifyCapacity();
    },
    { once: true },
  );

  return {
    add(job: Omit<Delivery, "due" | "ready">, delay: number) {
      input.signal.throwIfAborted();
      waiting.add({ ...job, due: Date.now() + delay, ready: delay === 0 });
      pump();
    },
    async admitRecovery<T>(enqueue: () => T): Promise<T> {
      while (!input.signal.aborted && recoveryReadyCount() >= input.recoveryBuffer) {
        await new Promise<void>((resolve) => capacityWaiters.add(resolve));
      }
      input.signal.throwIfAborted();
      return enqueue();
    },
    pause() {
      enabled = false;
      clearTimeout(timer);
    },
    resume() {
      enabled = true;
      pump();
    },
    async drain() {
      await Promise.allSettled(active);
    },
  };
}

export function readLocalQueueLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
