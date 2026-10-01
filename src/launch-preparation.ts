import { ApiLaunchError, resolveApiLaunch, type ResolvedApiLaunch } from "./api-launch.js";
import type { PublicClient } from "viem";

/** Bounded, process-local preparation. A hit is evidence reuse, never permission to trade. */
export class LaunchPreparation<C extends 1 | 11155111> {
  private readonly pending = new Map<string, Promise<ResolvedApiLaunch<C>>>();
  private readonly ready = new Map<string, { at: number; launch: ResolvedApiLaunch<C> }>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private epoch = 0;
  private cooldownUntil = 0;
  constructor(private readonly client: PublicClient, private readonly chainId: C,
    private readonly signal: AbortSignal,
    private readonly resolver: typeof resolveApiLaunch<C> = resolveApiLaunch<C>,
    private readonly now = () => performance.now()) {}
  clear() { this.epoch++; this.ready.clear(); }
  defer(retryAfterMs: number) {
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) throw Error("invalid_preparation_cooldown");
    this.cooldownUntil = Math.max(this.cooldownUntil, Math.min(Number.MAX_SAFE_INTEGER, this.now() + retryAfterMs));
  }
  async settle() { await Promise.allSettled([...this.pending.values()]); }
  prepare(id: string): Promise<ResolvedApiLaunch<C>> {
    this.signal.throwIfAborted();
    const cooling = this.cooldown();
    if (cooling) return Promise.reject(cooling);
    const retained = this.ready.get(id);
    if (retained && this.now() - retained.at <= 10000) return Promise.resolve(retained.launch);
    this.ready.delete(id);
    const key = `${this.epoch}:${id}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    if (this.pending.size >= 32) return Promise.reject(Error("launch_preparation_queue_full"));
    const epoch = this.epoch;
    let resolve!: (launch: ResolvedApiLaunch<C>) => void, reject!: (error: unknown) => void;
    const promise = new Promise<ResolvedApiLaunch<C>>((yes, no) => { resolve = yes; reject = no; });
    this.pending.set(key, promise);
    this.queue.push(() => {
      this.active++;
      void (async () => {
        try {
          this.signal.throwIfAborted();
          const cooling = this.cooldown();
          if (cooling) throw cooling;
          if (epoch !== this.epoch) throw this.invalidated();
          const launch = await this.resolver(id, this.client, { chainId: this.chainId, signal: this.signal });
          this.signal.throwIfAborted();
          if (epoch !== this.epoch) throw this.invalidated();
          if (epoch === this.epoch) {
            this.ready.set(id, { at: this.now(), launch });
            while (this.ready.size > 32) this.ready.delete(this.ready.keys().next().value!);
          }
          resolve(launch);
        } catch (error) {
          if (error instanceof ApiLaunchError && error.retryAfterMs !== null)
            this.defer(error.retryAfterMs);
          reject(error);
        }
        finally { if (this.pending.get(key) === promise) this.pending.delete(key); this.active--; this.drain(); }
      })();
    });
    this.drain();
    return promise;
  }
  private drain() {
    while (this.active < 2 && this.queue.length) this.queue.shift()!();
  }
  private cooldown(): ApiLaunchError | undefined {
    const remaining = Math.ceil(this.cooldownUntil - this.now());
    if (remaining > 0) return new ApiLaunchError("api_unavailable", "官方 API 要求冷却，保留候选等待", true, remaining);
  }
  private invalidated() { return new ApiLaunchError("preparation_invalidated", "发行资料已变化，重新准备", true); }
}
