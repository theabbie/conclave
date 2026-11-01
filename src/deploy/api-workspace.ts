import {
  reduceApiUnits,
  type ApiUnitSpec,
  type ApiUnitState,
  type DeploymentStatusEvent,
  type DeploymentTask,
} from "../domain/api-units";
import {
  apiUnitsFromSource,
  buildRelease,
  upsertApiUnitSource,
} from "./browser-builder";
import { ReleaseClient } from "./client";
import type { SourceArchive } from "./types";

export interface ApiWorkspaceEvents {
  taskQueued(task: DeploymentTask): void;
  statusChanged(event: DeploymentStatusEvent): void;
}

export class ApiWorkspace {
  private source?: SourceArchive;
  private baseVersion?: string;
  private state: ApiUnitState = { units: [], tasks: [] };

  constructor(
    private readonly client: ReleaseClient,
    private readonly events: ApiWorkspaceEvents,
  ) {}

  async refresh(): Promise<ApiUnitSpec[]> {
    const current = await this.client.current();
    this.source = current.source;
    this.baseVersion = current.versionId;
    this.state = { ...this.state, units: apiUnitsFromSource(current.source) };
    return structuredClone(this.state.units);
  }

  async listApiUnits(): Promise<ApiUnitSpec[]> {
    await this.ensureLoaded();
    return structuredClone(this.state.units);
  }

  async readApiUnit(id: string): Promise<ApiUnitSpec> {
    await this.ensureLoaded();
    return this.getApiUnit(id);
  }

  private getApiUnit(id: string): ApiUnitSpec {
    const unit = this.state.units.find((candidate) => candidate.id === id);
    if (!unit) throw new Error("API unit not found");
    return structuredClone(unit);
  }

  async addApiUnit(unit: ApiUnitSpec): Promise<ApiUnitSpec> {
    await this.ensureLoaded();
    const state = reduceApiUnits(this.state, { type: "unit.add", unit });
    const source = await upsertApiUnitSource(this.source!, unit, "add");
    this.state = state;
    this.source = source;
    return this.getApiUnit(unit.id);
  }

  async updateApiUnit(unit: ApiUnitSpec): Promise<ApiUnitSpec> {
    await this.ensureLoaded();
    const state = reduceApiUnits(this.state, { type: "unit.update", unit });
    const source = await upsertApiUnitSource(this.source!, unit, "update");
    this.state = state;
    this.source = source;
    return this.getApiUnit(unit.id);
  }

  async deployApiUnit(
    unitId: string,
    ticketId: string,
  ): Promise<DeploymentTask & { url?: string }> {
    await this.ensureLoaded();
    const unit = this.getApiUnit(unitId);
    const now = Date.now();
    const task: DeploymentTask = {
      id: crypto.randomUUID(),
      unitId,
      ticketId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.state = reduceApiUnits(this.state, {
      type: "deployment.queue",
      task,
    });
    this.events.taskQueued(task);
    await this.runDeployment(task);
    const completed = this.state.tasks.find((item) => item.id === task.id);
    if (!completed) throw new Error("Deployment task was lost");
    return {
      ...completed,
      ...(completed.status === "succeeded"
        ? {
            url: new URL(
              unit.path,
              "https://conclave-workspace.abbie.workers.dev",
            ).toString(),
          }
        : {}),
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.source || !this.baseVersion) await this.refresh();
  }

  private status(
    task: DeploymentTask,
    status: DeploymentStatusEvent["status"],
    error?: string,
  ): DeploymentStatusEvent {
    const event: DeploymentStatusEvent = {
      type: "deployment.status_changed",
      id: crypto.randomUUID(),
      taskId: task.id,
      status,
      occurredAt: Date.now(),
      ...(error ? { error } : {}),
    };
    this.state = reduceApiUnits(this.state, event);
    this.events.statusChanged(event);
    return event;
  }

  private async runDeployment(task: DeploymentTask): Promise<void> {
    try {
      this.status(task, "in_progress");
      const release = await buildRelease(
        this.baseVersion!,
        structuredClone(this.source!),
      );
      const receipt = await this.client.stage(release);
      await this.client.activate(receipt);
      this.status(task, "succeeded");
      await this.refresh();
    } catch (error) {
      this.status(
        task,
        "failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
