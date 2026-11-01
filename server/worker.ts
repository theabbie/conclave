import sourceSnapshot from "./generated/source.snapshot.txt";
import { routeApiUnit } from "./api-router";
import {
  activateRelease,
  authorize,
  HttpError,
  stageRelease,
  type ReleaseEnvironment,
} from "./releases";

const allowedOrigin = "https://theabbie.github.io";
const allowedMethods = ["GET", "HEAD", "POST", "OPTIONS"];
const allowedHeaders = ["authorization", "content-type"];

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");

  if (request.headers.get("Origin") === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", allowedMethods.join(", "));
    headers.set("Access-Control-Allow-Headers", allowedHeaders.join(", "));
    headers.set("Access-Control-Max-Age", "86400");
  }

  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function route(
  request: Request,
  env: ReleaseEnvironment,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    const origin = request.headers.get("Origin");
    const method = request.headers.get("Access-Control-Request-Method");
    const headers = (
      request.headers.get("Access-Control-Request-Headers") ?? ""
    )
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);

    if (
      origin !== allowedOrigin ||
      (method !== null && !allowedMethods.includes(method)) ||
      headers.some((header) => !allowedHeaders.includes(header))
    ) {
      return Response.json(
        { error: "Preflight request is not allowed" },
        { status: 403 },
      );
    }

    return new Response(null, { status: 204 });
  }

  if (!allowedMethods.includes(request.method)) {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { Allow: allowedMethods.join(", ") } },
    );
  }

  const path = new URL(request.url).pathname;

  if (path === "/api/source" || path.startsWith("/api/releases")) {
    await authorize(request, env);
    if (path === "/api/source" && ["GET", "HEAD"].includes(request.method)) {
      return Response.json(
        {
          versionId: env.VERSION?.id ?? null,
          source: JSON.parse(sourceSnapshot),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    if (path === "/api/releases" && request.method === "POST")
      return stageRelease(request, env);
    if (path === "/api/releases/activate" && request.method === "POST")
      return activateRelease(request, env);
  }

  if (path === "/api/health" && ["GET", "HEAD"].includes(request.method)) {
    return Response.json({ service: "conclave", status: "ok" });
  }

  const apiResponse = await routeApiUnit(
    request,
    env as Record<string, unknown>,
  );
  if (apiResponse) return apiResponse;

  return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(
    request: Request,
    env: ReleaseEnvironment = {},
  ): Promise<Response> {
    try {
      return withCors(request, await route(request, env));
    } catch (error) {
      return withCors(
        request,
        Response.json(
          {
            error:
              error instanceof HttpError
                ? error.message
                : "Internal server error",
          },
          { status: error instanceof HttpError ? error.status : 500 },
        ),
      );
    }
  },
};
