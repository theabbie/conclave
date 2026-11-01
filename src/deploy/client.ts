import type { ReleasePayload, ReleaseReceipt, SourceArchive } from "./types";

export class ReleaseClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.endpoint), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error ?? `Release request failed: ${response.status}`,
      );
    return result as T;
  }

  current(): Promise<{ versionId: string; source: SourceArchive }> {
    return this.request("/api/source");
  }

  stage(release: ReleasePayload): Promise<ReleaseReceipt> {
    return this.request("/api/releases", release);
  }

  activate(receipt: ReleaseReceipt): Promise<{
    deploymentId: string;
    versionId: string;
    sourceRevision: string;
  }> {
    return this.request("/api/releases/activate", receipt);
  }
}
