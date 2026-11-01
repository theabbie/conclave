export const httpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof httpMethods)[number];
export type JsonSchema = Record<string, unknown>;

export interface ApiUnitSpec {
  id: string;
  name: string;
  method: HttpMethod;
  path: string;
  requestSchema: JsonSchema;
  responseSchema: JsonSchema;
  handlerSource: string;
}

export const deploymentStatuses = [
  "queued",
  "in_progress",
  "succeeded",
  "failed",
] as const;
export type DeploymentStatus = (typeof deploymentStatuses)[number];

export interface DeploymentTask {
  id: string;
  unitId: string;
  ticketId: string;
  status: DeploymentStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface DeploymentStatusEvent {
  type: "deployment.status_changed";
  id: string;
  taskId: string;
  status: DeploymentStatus;
  occurredAt: number;
  error?: string;
}

export interface ApiUnitState {
  units: ApiUnitSpec[];
  tasks: DeploymentTask[];
}

export type ApiUnitAction =
  | { type: "unit.add"; unit: ApiUnitSpec }
  | { type: "unit.update"; unit: ApiUnitSpec }
  | { type: "deployment.queue"; task: DeploymentTask }
  | DeploymentStatusEvent;

export function validateApiUnit(unit: ApiUnitSpec): void {
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(unit.id) ||
    typeof unit.name !== "string" ||
    !unit.name.trim() ||
    typeof unit.handlerSource !== "string" ||
    !unit.handlerSource.trim() ||
    unit.handlerSource.length > 50_000
  )
    throw new Error("Unit ID, name and handler source are required");
  if (/\beval\s*\(|\bnew\s+Function\b/.test(unit.handlerSource))
    throw new Error("Dynamic code evaluation is not allowed");
  if (!httpMethods.includes(unit.method))
    throw new Error("Unsupported HTTP method");
  if (
    typeof unit.path !== "string" ||
    !/^\/api\/[a-zA-Z0-9_\-/:]*$/.test(unit.path) ||
    unit.path.includes("//")
  )
    throw new Error("Invalid API path");
  if (
    ["/api/health", "/api/source", "/api/releases"].some(
      (path) => unit.path === path || unit.path.startsWith(`${path}/`),
    )
  )
    throw new Error("API path is reserved");
  for (const schema of [unit.requestSchema, unit.responseSchema]) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new Error("Schemas must be JSON objects");
    try {
      JSON.stringify(schema);
    } catch {
      throw new Error("Schemas must be JSON serializable");
    }
  }
}

export function transitionDeployment(
  task: DeploymentTask,
  event: DeploymentStatusEvent,
): DeploymentTask {
  if (task.id !== event.taskId) throw new Error("Deployment task not found");
  if (
    !deploymentStatuses.includes(event.status) ||
    !Number.isFinite(event.occurredAt)
  )
    throw new Error("Invalid deployment event");
  if (event.occurredAt < task.updatedAt) return task;
  if (event.status === task.status) return task;
  const allowed: Record<DeploymentStatus, DeploymentStatus[]> = {
    queued: ["in_progress", "failed"],
    in_progress: ["succeeded", "failed"],
    succeeded: [],
    failed: [],
  };
  if (!allowed[task.status].includes(event.status))
    throw new Error(
      `Invalid deployment transition: ${task.status} → ${event.status}`,
    );
  if (event.status === "failed" && !event.error?.trim())
    throw new Error("Failed deployment requires an error");
  return {
    ...task,
    status: event.status,
    updatedAt: event.occurredAt,
    ...(event.error ? { error: event.error } : {}),
  };
}

export function reduceApiUnits(
  state: ApiUnitState,
  action: ApiUnitAction,
): ApiUnitState {
  if (action.type === "unit.add" || action.type === "unit.update") {
    validateApiUnit(action.unit);
    const exists = state.units.some((unit) => unit.id === action.unit.id);
    if (action.type === "unit.add" && exists)
      throw new Error("API unit already exists");
    if (action.type === "unit.update" && !exists)
      throw new Error("API unit not found");
    if (
      state.units.some(
        (unit) =>
          unit.id !== action.unit.id &&
          unit.method === action.unit.method &&
          unit.path === action.unit.path,
      )
    )
      throw new Error("API route already exists");
    const unit = structuredClone(action.unit);
    return {
      ...state,
      units:
        action.type === "unit.add"
          ? [...state.units, unit]
          : state.units.map((previous) =>
              previous.id === unit.id ? unit : previous,
            ),
    };
  }
  if (action.type === "deployment.queue") {
    const task = action.task;
    if (!state.units.some((unit) => unit.id === task.unitId))
      throw new Error("API unit not found");
    validateQueuedTask(task);
    if (state.tasks.some((previous) => previous.id === task.id))
      throw new Error("Deployment task already exists");
    return { ...state, tasks: [...state.tasks, { ...task }] };
  }
  const task = state.tasks.find((task) => task.id === action.taskId);
  if (!task) throw new Error("Deployment task not found");
  const updated = transitionDeployment(task, action);
  return updated === task
    ? state
    : {
        ...state,
        tasks: state.tasks.map((task) =>
          task.id === updated.id ? updated : task,
        ),
      };
}

export function validateQueuedTask(task: DeploymentTask): void {
  if (
    ![task.id, task.unitId, task.ticketId].every(
      (value) => typeof value === "string" && value.trim(),
    ) ||
    task.status !== "queued" ||
    !Number.isFinite(task.createdAt) ||
    !Number.isFinite(task.updatedAt) ||
    task.updatedAt < task.createdAt
  )
    throw new Error("Invalid queued deployment task");
}
