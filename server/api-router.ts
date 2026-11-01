import { apiUnits } from "./generated/api-units";

interface ApiUnit {
  id: string;
  method: string;
  path: string;
  handler: (
    request: Request,
    env: Record<string, unknown>,
    params: Record<string, string>,
  ) => Promise<Response> | Response;
}

function matchPath(
  pattern: string,
  pathname: string,
): Record<string, string> | undefined {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith(":")) {
      if (!actual[index]) return undefined;
      params[segment.slice(1)] = decodeURIComponent(actual[index]);
    } else if (segment !== actual[index]) {
      return undefined;
    }
  }
  return params;
}

export async function routeApiUnit(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response | undefined> {
  const pathname = new URL(request.url).pathname;
  for (const unit of apiUnits as ApiUnit[]) {
    if (unit.method !== request.method) continue;
    const params = matchPath(unit.path, pathname);
    if (!params) continue;
    try {
      const response = await unit.handler(request, env, params);
      if (!(response instanceof Response))
        return Response.json(
          { error: `API unit ${unit.id} returned an invalid response` },
          { status: 500 },
        );
      return response;
    } catch (error) {
      return Response.json(
        {
          error: "API unit failed",
          unitId: unit.id,
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      );
    }
  }
  return undefined;
}
