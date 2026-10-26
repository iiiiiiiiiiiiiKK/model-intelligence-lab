# Deployment guide

## Prerequisites

- Node.js **22.5 or newer** (the project uses the built-in `node:sqlite`)
- A writable directory for the SQLite database
- Network egress to your model provider(s)

No Postgres, no Docker, no cloud account is required for a single-host deploy.

---

## 1. Local production run

```bash
npm ci
npm run build          # tsc -b && vite build  -> dist/
cp .env.example .env   # then fill in a provider key
npm run db:seed -- --no-demo   # schema + registry, no demo rows
NODE_ENV=production PORT=8080 npm start
```

`server/index.ts` serves `dist/` and `/api/*` from the same origin, so one process
serves the whole app. Open `http://<host>:8080`.

Health check:

```bash
curl -s http://127.0.0.1:8080/api/health | jq
```

Expect `status: ok` once at least one provider key is configured, otherwise
`status: degraded` with `providers.<name>: "unconfigured"` — that is the honest
answer, not an error.

---

## 2. Docker

A working `Dockerfile` is committed, so there is nothing to write by hand:

```bash
docker build -t model-lab .

docker run -d --name model-lab \
  -p 127.0.0.1:8080:8080 \
  -v model-lab-data:/app/data \
  -e MODEL_LAB_ACCESS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  -e MODEL_LAB_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")" \
  model-lab
```

Or with Compose, which reads both secrets from `.env`:

```bash
cp .env.example .env
# put a MODEL_LAB_ACCESS_TOKEN in .env, then:
docker compose up -d
```

The committed image is a two-stage build: the builder compiles the client, the
runtime carries only `node_modules` + `dist/` + the server sources and runs as the
unprivileged `node` user under `tini`, so `SIGTERM` reaches the evaluation worker
instead of killing it mid-run.

The volume at `/app/data` is the entire database — back it up, and never run two
containers against the same file.

`node scripts/verify-container-contract.mjs` checks what can be verified without a
Docker daemon: that every `COPY` source exists, that `.dockerignore` does not
exclude a needed path, that `.env` and `data/` are excluded, that the runtime
command resolves, and that the exposure guard is wired.

### Fly.io

`fly.toml` is committed with a single machine, a mounted volume and
`auto_stop_machines = false` (the worker must not be frozen):

```bash
fly launch --no-deploy --copy-config
fly volumes create model_lab_data --size 1
fly secrets set MODEL_LAB_ACCESS_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fly secrets set MODEL_LAB_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fly deploy
```

### Render

`render.yaml` is a blueprint with a persistent disk and `numInstances: 1`. Point
Render at the repository and fill in the two `sync: false` secrets in the
dashboard.

---

## 2b. Access control

The app has a built-in access gate, and it is **on by default whenever the bind
address is not loopback**:

```bash
MODEL_LAB_ACCESS_TOKEN=<a long random string>
```

With it set, every API route except `/api/health`, `/api/auth/*` and reads of an
individual shared report returns `401 UNAUTHENTICATED`, and the browser shows a
sign-in screen before any data is fetched. The token is compared in constant time
(both sides are hashed first, so length does not leak either), and sign-in attempts
are limited to 10 per IP per 5 minutes.

Sessions are a signed cookie — `expiry.HMAC` — where the HMAC key is derived from
the credential master key. There is no session table, so a restart does not sign
anyone out, and rotating `MODEL_LAB_SECRET` (or deleting `data/.master-key`)
invalidates every session at once.

If `HOST` is not loopback and no token is set, `bootstrap()` **refuses to start**
and prints the command to generate one. That check exists because an exposed
instance hands out encrypted provider keys and a way to spend your budget.

`MODEL_LAB_ALLOW_ANONYMOUS=true` skips that check, for the case where a trusted
reverse proxy already authenticates. Set `MODEL_LAB_COOKIE_SECURE=true` when
serving over HTTPS so the cookie carries `Secure`.

Verify the gate end to end against a running instance:

```bash
node scripts/check-auth-ui.mjs <your-token>
```

---

## 3. Platform suitability

| Platform | Verdict | Reason |
| --- | --- | --- |
| VPS / bare VM | ✅ Recommended | Persistent disk, long-lived worker, no cold starts |
| Docker hosts (Fly.io, Railway, Render) | ✅ Works | Attach a persistent volume; keep exactly one instance |
| Kubernetes | ⚠️ Single replica only | SQLite file cannot be shared; use a `ReadWriteOnce` volume |
| Vercel / Netlify / AWS Lambda | ❌ Not as-is | Ephemeral FS and no background worker; would need Postgres + a queue |
| Cloudflare Workers | ❌ | No `node:sqlite`, no long-lived process |

Scaling past one instance requires replacing `server/db/index.ts` with a
Postgres implementation of `getRow` / `getRows` / `exec` and moving the worker to
an external queue. The repository interface was kept small for exactly this.

---

## 4. Provider configuration

Keys live only in the server environment.

```bash
# .env
OPENAI_API_KEY=sk-...
DEEPSEEK_API_KEY=sk-...
# or any OpenAI-compatible gateway:
OPENAI_COMPATIBLE_API_KEY=...
OPENAI_COMPATIBLE_BASE_URL=https://your-gateway.example.com/v1
```

Restart the process after editing `.env` — the config is parsed once at boot and
credential flags are derived from the live environment, never from the database.
An explicit `*_BASE_URL` in `.env` also **pins the provider row** at boot, so a
freshly seeded database honours your relay instead of the vendor default.

### Using an OpenAI-compatible relay (中转站)

This is the common case when you buy credits through a reseller.

**Preferred: configure it in the app.** Settings → Providers → Add provider, then
fill in the name, the type (`openai-compatible`), a base URL ending in `/v1`, and
the key. Click **Test connection** (a real request that reports status, latency
and the models the provider serves), then **Fetch models → Register all**. Keys
are encrypted at rest and take effect immediately — no restart, no file editing.

**Headless / scripted alternative:** use `.env` instead. A key saved in the UI
always takes precedence over these variables.

```bash
# .env
OPENAI_COMPATIBLE_BASE_URL=https://your-relay.example.com/v1   # 必须带 /v1
OPENAI_COMPATIBLE_API_KEY=sk-xxxxxxxx
```

Rules that trip people up:

| Symptom | Cause |
| --- | --- |
| `404` from every call | `BASE_URL` is wrong — usually a missing `/v1`, or you pasted the full `/chat/completions` path (the code appends it) |
| `401` / `403` | Key is wrong, expired, or the relay expects a different auth header |
| `network: fetch failed` | Host unreachable, or an `http://`/private address without `ALLOW_LOOPBACK_PROVIDER=true` |
| Run completes but every score is 0 | Model returned prose where an exact answer was expected — check the per-item raw response before blaming the model |
| `PROVIDER_NOT_CONFIGURED` | No key saved for this provider. Add one in Settings → Providers — no restart needed — or set the environment variable and restart. |

Relays frequently rename models, so never guess the model id. Verify it against
the relay itself:

```bash
# 1. fill .env, then probe the relay and optionally register + smoke-test
node scripts/configure-relay.mjs                # list what the relay actually serves
node scripts/configure-relay.mjs --register     # register those models in the app
node scripts/configure-relay.mjs --register --smoke
node scripts/configure-relay.mjs --model <id> --smoke
```

The script validates the URL shape, performs a real `GET {base}/models`, registers
the discovered ids through the public API, and can run a 3-item evaluation to
prove the whole chain works. It never prints the key.

### Self-hosted gateways (Ollama, vLLM, LM Studio)

These listen on loopback or a private address, which the SSRF guard blocks by
default. Opt in explicitly:

```bash
OPENAI_COMPATIBLE_BASE_URL=http://127.0.0.1:11434/v1
ALLOW_LOOPBACK_PROVIDER=true
# and either run the API on the same host, or allow the private host:
ALLOWED_PROVIDER_HOSTS=192.168.1.50
```

Only do this when the provider really is yours. It disables the private-range
check for outbound provider calls.

---

## 5. Hardening checklist before public exposure

The app has a built-in access token gate, but defence in depth still applies.

1. **Set `MODEL_LAB_ACCESS_TOKEN`.** It is mandatory when `HOST` is not loopback —
   the process refuses to start without it. Generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Terminate TLS at a reverse proxy and set `MODEL_LAB_COOKIE_SECURE=true`, or the
   session cookie would travel in clear text.
3. Optionally keep your own auth in front too (basic auth, OAuth proxy, VPN) and
   set `MODEL_LAB_ALLOW_ANONYMOUS=true` only if that proxy is the sole entry point.
4. Set `ALLOWED_PROVIDER_HOSTS` to your exact provider hostnames.
5. Leave `ALLOW_LOOPBACK_PROVIDER` unset in production.
6. Lower `RATE_LIMIT_MAX_REQUESTS` to what your traffic justifies.
7. Set `ADMIN_TOKEN` if you want community moderation enabled; without it the
   review endpoint refuses every request.
8. Keep `data/model-lab.db` out of any web-served directory (the default already
   is outside `dist/`).
9. Back up the database file **and** `data/.master-key` together on a schedule —
   one without the other is useless.

Example nginx front end:

```nginx
server {
  listen 443 ssl;
  server_name lab.example.com;

  auth_basic "Model Lab";
  auth_basic_user_file /etc/nginx/.htpasswd;

  location / {
    proxy_pass http://127.0.0.1:8790;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

`app.set('trust proxy', 1)` is already enabled so rate limiting sees the real
client IP behind one proxy hop.

---

## 6. Operations

| Task | Command / action |
| --- | --- |
| Apply schema | automatic at boot (`migrate()`) |
| Seed registry | `npm run db:seed -- --no-demo` |
| Back up | copy `data/model-lab.db` (stop the process or use `sqlite3 .backup`) |
| Inspect runs | `GET /api/evaluations` |
| Resume interrupted runs | automatic on restart (`resumeInterruptedRuns`) |
| Rotate a provider key | edit `.env`, restart; nothing else stores it |
| Clear demo data | `DELETE FROM evaluation_runs WHERE is_demo = 1;` plus dependent rows |

Logs go to stdout. Provider errors are redacted by pattern before logging, so a
leaked key cannot appear in a log line.

---

## 7. Verifying a deployment

```bash
# 1. service and database reachable
curl -sf http://HOST:PORT/api/health

# 2. real evaluation with the configured provider
curl -sX POST http://HOST:PORT/api/evaluations \
  -H 'content-type: application/json' \
  -d '{"modelId":"<id from /api/models>","itemLimit":5}' | jq

# 3. follow progress until the status leaves queued/running
curl -s http://HOST:PORT/api/evaluations/<runId>/progress | jq

# 4. per-item evidence exists
curl -s http://HOST:PORT/api/evaluations/<runId>/results | jq '.results[0]'

# 5. public share link works without any token
curl -s http://HOST:PORT/api/reports/<publicId> | jq '.report.publicId'
```

If step 2 returns `PROVIDER_NOT_CONFIGURED`, no key is saved for that provider.
Add one in Settings → Providers — it takes effect immediately, with no restart —
or set the matching environment variable and restart the process. The tool
deliberately refuses to fabricate a run.
