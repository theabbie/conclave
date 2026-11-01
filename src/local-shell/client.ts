export interface LocalCommandResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

export interface LocalCommandOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  onOutput?(output: string): void;
}

type SocketFactory = (url: string) => WebSocket;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function localHostname(hostname: string): boolean {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "[::1]"
  )
    return true;
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function validateLocalShellUrl(value: string): string {
  const url = new URL(value);
  if (!["ws:", "wss:"].includes(url.protocol))
    throw new Error("Local shell URL must use ws:// or wss://");
  if (url.username || url.password)
    throw new Error("Put shell credentials in the URL query, not user info");
  if (url.protocol === "ws:" && !localHostname(url.hostname))
    throw new Error("Use wss:// for non-local or tunneled shell URLs");
  return url.toString();
}

export class LocalShellClient {
  readonly url: string;

  constructor(
    url: string,
    private readonly socketFactory: SocketFactory = (value) =>
      new WebSocket(value),
  ) {
    this.url = validateLocalShellUrl(url);
  }

  run(
    command: string,
    options: LocalCommandOptions = {},
  ): Promise<LocalCommandResult> {
    const source = command.trim();
    if (!source) throw new Error("Command is required");
    if (source.length > 50_000) throw new Error("Command is too long");
    const timeoutMs = Math.min(
      300_000,
      Math.max(1_000, options.timeoutMs ?? 30_000),
    );
    const maxOutputBytes = Math.min(
      1_000_000,
      Math.max(1_024, options.maxOutputBytes ?? 128_000),
    );
    const marker = `__CONCLAVE_EXIT_${crypto.randomUUID().replaceAll("-", "")}__`;
    const script = `bash -lc ${shellQuote(source)}; __conclave_status=$?; printf '\\n${marker}=%s\\n' "$__conclave_status"; exit\n`;
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const socket = this.socketFactory(this.url);
      let output = "";
      let settled = false;
      const finish = (error?: Error, result?: LocalCommandResult) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (socket.readyState === 1) socket.close(1000);
        if (error) reject(error);
        else resolve(result!);
      };
      const timer = globalThis.setTimeout(() => {
        finish(new Error(`Local command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      socket.addEventListener("open", () => socket.send(script));
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          finish(new Error("Local shell returned non-text output"));
          return;
        }
        output += event.data;
        if (new TextEncoder().encode(output).byteLength > maxOutputBytes) {
          finish(
            new Error(`Local command exceeded ${maxOutputBytes} output bytes`),
          );
          return;
        }
        const match = output.match(
          new RegExp(`\\n?${marker}=(-?\\d+)\\r?\\n?`),
        );
        const visible = output
          .slice(0, match?.index ?? output.length)
          .replace(/\r\n/g, "\n")
          .trim();
        options.onOutput?.(visible);
        if (!match || match.index === undefined) return;
        finish(undefined, {
          output: visible,
          exitCode: Number(match[1]),
          durationMs: Math.round(performance.now() - startedAt),
        });
      });
      socket.addEventListener("error", () => {
        finish(
          new Error(
            "Could not connect to the local shell. Check the URL and browser local-network permission.",
          ),
        );
      });
      socket.addEventListener("close", () => {
        if (!settled)
          finish(new Error("Local shell closed before the command completed"));
      });
    });
  }
}
