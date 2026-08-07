/**
 * A tiny typed event bus.
 *
 * The Phaser game and the React UI are separate worlds; this is the only wire
 * between them. Keeping it explicit (rather than reaching into each other's
 * internals) is what lets the game canvas be torn down and rebuilt without the
 * UI noticing.
 */

export type Listener<T> = (payload: T) => void;

export class Emitter<Events extends object> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      listener(payload);
    });
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy before iterating: handlers routinely unsubscribe themselves.
    for (const listener of Array.from(set)) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (err) {
        if (import.meta.env.DEV) console.error(`[events] handler for "${String(event)}" threw`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
