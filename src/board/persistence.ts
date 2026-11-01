import type { BoardState, Ticket, TicketComment } from "./store";
import type { DeploymentTask } from "../domain/api-units";

export interface BoardRecordIds {
  tickets: Record<string, string>;
  comments: Record<string, string>;
  deployments: Record<string, string>;
}

export interface BoardDelta {
  tickets: {
    upsert: Ticket[];
    remove: { id: string; recordId: string }[];
  };
  comments: {
    upsert: TicketComment[];
    remove: { id: string; recordId: string }[];
  };
  deployments: {
    upsert: DeploymentTask[];
    remove: { id: string; recordId: string }[];
  };
  records: BoardRecordIds;
}

export interface BoardLoadResult {
  board: BoardState;
  records: BoardRecordIds;
}

export interface BoardSaveResult {
  records: BoardRecordIds;
}

export interface BoardPersistence {
  load(): Promise<BoardState>;
  save(previous: BoardState, next: BoardState): Promise<void>;
}

export function emptyRecordIds(): BoardRecordIds {
  return { tickets: {}, comments: {}, deployments: {} };
}

function changed<T>(previous: T | undefined, next: T): boolean {
  return (
    previous === undefined || JSON.stringify(previous) !== JSON.stringify(next)
  );
}

function entityDelta<T extends { id: string }>(
  previous: T[],
  next: T[],
  records: Record<string, string>,
): { upsert: T[]; remove: { id: string; recordId: string }[] } {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Set(next.map((item) => item.id));
  return {
    upsert: next.filter((item) => changed(before.get(item.id), item)),
    remove: previous
      .filter((item) => !after.has(item.id))
      .map((item) => ({ id: item.id, recordId: records[item.id] }))
      .filter(
        (item): item is { id: string; recordId: string } =>
          typeof item.recordId === "string",
      ),
  };
}

export function diffBoard(
  previous: BoardState,
  next: BoardState,
  records: BoardRecordIds,
): BoardDelta {
  return {
    tickets: entityDelta(previous.tickets, next.tickets, records.tickets),
    comments: entityDelta(previous.comments, next.comments, records.comments),
    deployments: entityDelta(
      previous.deployments ?? [],
      next.deployments ?? [],
      records.deployments,
    ),
    records,
  };
}
