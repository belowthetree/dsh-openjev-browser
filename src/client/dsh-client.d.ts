/**
 * Ambient declaration for the loader-provided client store external.
 * The real package is injected by the DSH client runtime; we only need the
 * createSnapshotStore surface used by the settings controller.
 */
declare module '@deepseek-ai/dsh-client-store' {
  export interface SnapshotStore<S> {
    getSnapshot(): S
    update(fn: (state: S) => void): void
  }
  export function createSnapshotStore<S>(initial: S): SnapshotStore<S>
}
