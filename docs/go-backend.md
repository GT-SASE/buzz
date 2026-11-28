# Go backend

`sites/backend` is a Go service that will replace the TypeScript backend (`packages/api`, `packages/mcp`, the bot) one router at a time. Today it has two routes. Vercel does not run it. The deployed project still builds `sites/web` alone.

## What exists

The module is `github.com/GT-SASE/buzz/sites/backend`. It has no dependencies. The server uses only the standard library.

| Route | Answer |
| --- | --- |
| `GET /api/backend/version` | JSON `{"version", "commit"}` |
| `GET /healthz` | `200 ok` |

`/healthz/db` is not here. It needs the database layer, which a later PR adds.

The server listens on `$PORT` and defaults to 3001. On SIGTERM or Ctrl-C it stops accepting connections and gives in-flight requests 10 seconds to finish.

`version` is `dev` unless the build sets it with `-ldflags "-X main.version=<MAJOR.MINOR.PATCH>"`. `commit` is the first 7 characters of `VERCEL_GIT_COMMIT_SHA`, as in `sites/web/build-version.ts`. Nothing sets `version` yet, because nothing deploys the service.

Go comes only from the `toolchain` line in `sites/backend/go.mod`. With `GOTOOLCHAIN=auto` (the default), any Go 1.21 or later downloads the pinned release. `sites/backend/package.json` holds the repo version and no dependencies, so Bun links the workspace and creates no `node_modules` there.

`sites/backend/tools/go.mod` pins golangci-lint and govulncheck with `tool` directives. It is a separate module so the service has no tool dependencies. Run a tool from `sites/backend` with `go tool -modfile=tools/go.mod <name>`. The first build of golangci-lint takes a few minutes.

## Run it

From `sites/backend`, or through `bun run --cwd sites/backend <script>`:

| Script | Runs |
| --- | --- |
| `dev` | `go run ./cmd/server` |
| `typecheck` | `go vet ./... && go build ./...` |
| `lint` | `go tool -modfile=tools/go.mod golangci-lint run` |
| `test` | `go test -short ./...` |

`bun run check` from the repo root runs `lint`, `typecheck` and `test` here through turbo, with `**/*.go`, `go.mod` and `go.sum` as inputs (`sites/backend/turbo.json`). The `go` job in `.github/workflows/ci.yml` runs the same checks with `-race` on tests, then `go tool -modfile=tools/go.mod govulncheck ./...`.

## Assumptions to prove

The plan rests on these. Each stays unproven until the Vercel Services spike runs in a scratch project with a root `vercel.toml`.

- [ ] A1. "project root" for `go.mod` means the service root (`sites/backend`). Unproven, P1 spike.
- [ ] A2. A Go service can be the target of a binding. Unproven, P1 spike.
- [ ] A3. Top-level `crons` reach a service through the top-level rewrites. Unproven, P1 spike.
- [ ] A4. A per-service `functions` `maxDuration` applies to the Go service. Unproven, P1 spike.
- [ ] A5. After the Go handler flushes a `Content-Length` response, Discord and curl on HTTP/1.1 and HTTP/2 get the whole reply while the handler keeps working, and the instance is not frozen until the handler returns. Unproven, P1 spike.
- [ ] A6. Both services share environment variables, and it is unknown whether they can be scoped per service. Unproven, P1 spike.
- [ ] A7. Where `regions`, `bunVersion` and `env` go in services mode, and whether the Next functions keep the Bun runtime. Unproven, P1 spike.
- [ ] A8. Vercel's builder fetches go1.27.4. Unproven, P1 spike.
- [ ] A9. The Neon pooler works with pgx statement caching. Unproven, P1 spike.
- [ ] A10. With the project's Root Directory at the repo root, the frontend's Bun workspace install still works. Unproven, P1 spike.
- [ ] A11. `/` stays a CDN HIT after the move to services. Unproven, P1 spike.
- [ ] A12. A cold Go start plus a Neon compute wake fits Discord's 3 second limit. Unproven, P1 spike.
