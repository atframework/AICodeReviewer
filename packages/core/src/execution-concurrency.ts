/** Shared, process-wide analysis admission across all scheduler entry points. */
export class ExecutionConcurrency {
  private active = 0;
  private readonly workspaces = new Map<string, number>();
  private readonly waiting: { workspaceId: string; start: (release: () => void) => void }[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly limits: () => { global: number; workspace: number }) {}

  get available(): boolean { return this.active < this.limits().global; }

  blockedWorkspaceIds(): string[] {
    const limit = this.limits().workspace;
    return [...this.workspaces].filter(([, count]) => count >= limit).map(([id]) => id);
  }

  tryAcquire(workspaceId: string): (() => void) | undefined {
    const limits = this.limits();
    const count = this.workspaces.get(workspaceId) ?? 0;
    if (this.active >= limits.global || count >= limits.workspace) return undefined;
    this.active++;
    this.workspaces.set(workspaceId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const remaining = (this.workspaces.get(workspaceId) ?? 1) - 1;
      if (remaining === 0) this.workspaces.delete(workspaceId);
      else this.workspaces.set(workspaceId, remaining);
      this.refresh();
    };
  }

  async run<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const release = await new Promise<() => void>((resolve) => {
      this.waiting.push({ workspaceId, start: resolve });
      this.refresh();
    });
    try { return await task(); } finally { release(); }
  }

  /** Re-read live limits without interrupting admitted work; skip busy workspaces. */
  refresh(): void {
    for (let index = 0; index < this.waiting.length && this.available;) {
      const entry = this.waiting[index]!;
      const release = this.tryAcquire(entry.workspaceId);
      if (!release) { index++; continue; }
      this.waiting.splice(index, 1);
      entry.start(release);
    }
    for (const listener of this.listeners) listener();
  }

  onAvailable(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
