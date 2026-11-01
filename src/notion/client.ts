import type { BoardState } from "../board/store";

export interface NotionStatus {
  connected: boolean;
  initialized: boolean;
  workspaceName: string;
  workspaceIcon: string | null;
  boardUrl: string | null;
}

export interface NotionPage {
  id: string;
  title: string;
  url: string | null;
}

const sessionKey = "conclave.notion.session";

export class NotionClient {
  constructor(
    private baseUrl = "https://conclave.abbie.workers.dev",
    private storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    > = localStorage,
  ) {}

  captureCallback(): void {
    const hash = new URLSearchParams(location.hash.slice(1));
    const token = hash.get("notion_session");
    if (!token) return;
    this.storage.setItem(sessionKey, token);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }

  isConnected(): boolean {
    return Boolean(this.storage.getItem(sessionKey));
  }

  connectUrl(): string {
    return `${this.baseUrl}/api/integrations/notion/start`;
  }

  disconnect(): void {
    this.storage.removeItem(sessionKey);
  }

  async status(): Promise<NotionStatus> {
    return this.request("/api/integrations/notion/status");
  }

  async pages(): Promise<NotionPage[]> {
    const result = await this.request<{ pages: NotionPage[] }>(
      "/api/integrations/notion/pages",
    );
    return result.pages;
  }

  async setup(parentPageId: string): Promise<BoardState> {
    const result = await this.request<{ token: string; board: BoardState }>(
      "/api/integrations/notion/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentPageId }),
      },
    );
    this.storage.setItem(sessionKey, result.token);
    return result.board;
  }

  async loadBoard(): Promise<BoardState> {
    const result = await this.request<{ board: BoardState }>("/api/board");
    return result.board;
  }

  async saveBoard(board: BoardState): Promise<void> {
    await this.request("/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ board }),
    });
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.storage.getItem(sessionKey);
    if (!token) throw new Error("Connect Notion to continue");
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) this.disconnect();
      const message =
        value &&
        typeof value === "object" &&
        "error" in value &&
        typeof value.error === "string"
          ? value.error
          : `Conclave server returned ${response.status}`;
      throw new Error(message);
    }
    return value as T;
  }
}
