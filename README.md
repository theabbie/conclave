# Conclave

A self-improving conclave of agents.

This first slice is a static TypeScript/React board, an in-memory Pi agent runtime, and a deployed Cloudflare Worker shell. The interface uses Lucide icons and the cream, pink, outline, and hard-shadow direction observed in the supplied Gumroad Figma reference.

## Run

```sh
npm ci
npm run dev
npm run build
npm test
npm run server:dev
npm run server:deploy
```

The client builds into `dist/` with relative asset paths, suitable for a static host such as GitHub Pages. It has not been published to Pages. The server is deployed at https://conclave.abbie.workers.dev/api/health.

## Current behavior

Only the user interface creates top-level tickets. Backlog holds ideas. Moving a ticket to Ready starts its agent when a backend is configured. A single agent runs at a time, with sequential tools, cancellation, and a 20-turn budget. Finished runs move to Review; the user chooses Done. Failures return the ticket to Ready with the error recorded.

The agent can read the board, read its assigned subtree, create subtasks within that subtree, update those subtasks, and record progress. With a deployment token configured it can also list, read, add, update, and deploy atomic API units. Every deployment is linked to a subtask. Queued, running, successful, and failed deployment events update that subtask automatically.

Manual board changes and deployment changes are delivered to an active Pi run through Pi's steering queue. The event inbox is scoped to the active ticket tree, deduplicated, bounded, and kept in memory. Codemode is not used for notification delivery; it can be added later as a capability sandbox for composing tool calls.

Board tickets and progress are working memory stored under `conclave.board.v1` in localStorage. Interrupted work returns to Backlog after reload. Agent conversations, model configuration, and access tokens stay in memory and disappear on reload. Runs stop when the page closes. No personas, persisted sessions, background workers, or durable database have been added.

## Backend contract

Connection settings take a complete streaming endpoint URL, model ID, and optional bearer token. The Conclave server is not an LLM backend. It serves health, protected source retrieval, staged releases, release activation, and generated atomic APIs.

The transport follows [Webiome's worker](https://github.com/theabbie/webiome/blob/master/src/worker.js): POST JSON containing `model`, `context`, and `options`, receiving SSE `data:` frames with full Pi assistant events. Pi's normalized system/tool transcript is converted into the backend's context shape. The compact `streamProxy` protocol is different and is deliberately rejected. The live endpoint `https://webiome.abbie.workers.dev/api/stream` was verified with `google/gemini-2.5-flash` and no token. The optional token is a Webiome-issued sealed token, not a provider API key.

## Boundaries

- `src/board/store.ts`: immutable board state, validation, hierarchy, persistence.
- `src/agent/transport.ts`: Webiome stream adapter and protocol validation.
- `src/agent/runtime.ts`: Pi lifecycle and scoped tool capabilities.
- `src/agent/external-events.ts`: bounded Pi steering and follow-up delivery.
- `src/domain/api-units.ts`: atomic API and deployment state machine.
- `src/deploy/`: browser compiler, release client, and API workspace.
- `src/App.tsx`: board interaction and run orchestration.
- `src/components/Modal.tsx`: accessible native modal shell.
- `server/worker.ts`: outer CORS handling, health, preflight, and errors.

CORS allows exactly `https://theabbie.github.io`. All server response paths use the same wrapper. Node compatibility is enabled, but Workers are not persistent Node processes.

## Later durability

[Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) provides an experimental durable harness with IndexedDB and Cloudflare Durable Object SQLite storage adapters. It is not installed or activated here. The board adapter and runtime factory isolate capabilities from storage, so a durable host can replace the in-memory lifecycle later. That integration still requires single ownership, replay semantics, tool idempotency, and a migration of persisted state; adding a database alone does not make external side effects exactly-once.

[Pi Agent](https://github.com/earendil-works/pi/tree/main/packages/agent) powers the loop now. Dependencies are pinned to the verified 1.4.0 agent packages.

## Self-deployment

Wrangler bundles TypeScript and npm imports before uploading a Worker. The [deployed script content API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/) returns build artifacts, not the original editable project. Preserve source snapshots independently.

The same Worker exposes a Git-independent release protocol:

1. `GET /api/source` fetches the exact UTF-8 source snapshot and deployed version.
2. The web client edits API-unit JSON files and builds `server/worker.ts` with `esbuild-wasm`.
3. `POST /api/releases` validates source and artifact hashes, required check receipts, imports, and the base version, then stages a Cloudflare version.
4. `POST /api/releases/activate` verifies the signed receipt and activates that version.

The [version upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/) and [deployment API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/deployments/methods/create/) support this without Git. Source travels as a separate Worker text module, so R2 is not required.

Set the Worker secrets `CONCLAVE_DEPLOY_TOKEN` and `CLOUDFLARE_API_TOKEN`. The latter needs Workers Scripts Edit for this Worker. The owner token is kept only in browser memory. The local equivalent is:

```sh
npm run release:prepare -- /tmp/conclave-release.json
npm run release:publish -- stage /tmp/conclave-release.json /tmp/conclave-receipt.json
npm run release:publish -- activate /tmp/conclave-receipt.json
```

References: [Wrangler bundling](https://developers.cloudflare.com/workers/wrangler/bundling/), [Node compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/), [workers.dev routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
