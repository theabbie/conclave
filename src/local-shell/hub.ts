import {
  LocalShellClient,
  type LocalCommandOptions,
  type LocalCommandResult,
} from "./client";

export type ShellCommandSource = "agent" | "manual" | "test";
export type ShellCommandStatus = "queued" | "running" | "succeeded" | "failed";

export interface ShellCommandEntry {
  id: string;
  command: string;
  source: ShellCommandSource;
  status: ShellCommandStatus;
  output: string;
  createdAt: number;
  exitCode?: number;
  durationMs?: number;
  error?: string;
}

type ClientFactory = (url: string) => Pick<LocalShellClient, "run">;

export class LocalShellHub {
  private url = "";
  private entries: readonly ShellCommandEntry[] = Object.freeze([]);
  private listeners = new Set<() => void>();
  private queue = Promise.resolve();

  constructor(
    private readonly clientFactory: ClientFactory = (url) =>
      new LocalShellClient(url),
  ) {}

  configure(url: string): void {
    this.url = url;
  }

  isConfigured(): boolean {
    return Boolean(this.url);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly ShellCommandEntry[] => this.entries;

  clear(): void {
    this.entries = Object.freeze([]);
    this.notify();
  }

  run(
    command: string,
    options: LocalCommandOptions = {},
  ): Promise<LocalCommandResult> {
    return this.execute(command, "agent", options);
  }

  runManual(command: string): Promise<LocalCommandResult> {
    return this.execute(command, "manual");
  }

  test(url: string): Promise<LocalCommandResult> {
    return this.execute("pwd; uname -s", "test", { timeoutMs: 10_000 }, url);
  }

  private execute(
    command: string,
    source: ShellCommandSource,
    options: LocalCommandOptions = {},
    url = this.url,
  ): Promise<LocalCommandResult> {
    if (!url) return Promise.reject(new Error("Local shell is not configured"));
    const id = crypto.randomUUID();
    this.append({
      id,
      command: command.trim(),
      source,
      status: "queued",
      output: "",
      createdAt: Date.now(),
    });
    const operation = this.queue.then(async () => {
      this.update(id, { status: "running" });
      try {
        const result = await this.clientFactory(url).run(command, {
          ...options,
          onOutput: (output) => {
            this.update(id, { output });
            options.onOutput?.(output);
          },
        });
        this.update(id, {
          status: result.exitCode === 0 ? "succeeded" : "failed",
          output: result.output,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.update(id, { status: "failed", error: message });
        throw error;
      }
    });
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private append(entry: ShellCommandEntry): void {
    this.entries = Object.freeze([...this.entries, Object.freeze(entry)]);
    this.notify();
  }

  private update(
    id: string,
    patch: Partial<Omit<ShellCommandEntry, "id" | "command" | "source">>,
  ): void {
    this.entries = Object.freeze(
      this.entries.map((entry) =>
        entry.id === id ? Object.freeze({ ...entry, ...patch }) : entry,
      ),
    );
    this.notify();
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener());
  }
}
