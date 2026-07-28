# API Reference

Static companion to the live, interactive Swagger UI. The API process (`src/main.api.ts`) serves a full
OpenAPI document via `SwaggerModule.setup('api', app, document)` — browse it at:

- Development: `http://localhost:5000/api`
- Production: `http://localhost/api`

This file is a quick-reference index of every route; the Swagger UI is the source of truth for exact
request/response schemas, try-it-out, and validation rules.

## Conventions

- **Auth required** = the controller/route is decorated with `@UseGuards(JwtAuthGuard)`, which expects
  `Authorization: Bearer <access token>`.
- **Rate limit** = the `@Throttle({ default: { limit, ttl } })` value on that specific route, if present.
  Routes without an explicit `@Throttle` fall back to the global default configured in `AppModule`
  (`ThrottlerModule.forRootAsync`): **100 requests / 60s** per client (env-overridable via `THROTTLE_LIMIT`
  / `THROTTLE_TTL`), backed by Redis (`ThrottlerStorageRedisService`) so limits are shared across the 3 API
  replicas. `GET /health` and `GET /health/live` are exempt (`@SkipThrottle()`).
- All request bodies are validated with a global `ValidationPipe({ transform: true, whitelist: true })` —
  unknown fields are stripped, invalid fields return `400`.

---

## `AuthController` — `src/auth/auth.controller.ts` (base path: `/auth`)

| Method & Path | Auth | Rate limit | Body (DTO) | Purpose |
|---|---|---|---|---|
| `POST /auth/register` | No | 3 / hour | `CreateAccountDto` | Register a new account. |
| `POST /auth/login` | `LocalAuthGuard` (email+password) | 5 / min | `LoginDto` | Authenticate, returns the account and a JWT access token. |
| `GET /auth/me` | JWT (`JwtAuthGuard`) | global default | — | Return the currently authenticated account. |

**`CreateAccountDto`** (`src/users/dto/create-account.dto.ts`)
| Field | Type | Validation |
|---|---|---|
| `email` | `string` | `@IsEmail()` |
| `password` | `string` | `@IsStrongPassword()` — at least 6 chars, 1 uppercase, 1 number, 1 special character |

**`LoginDto`** (`src/auth/dto/login.dto.ts`)
| Field | Type | Validation |
|---|---|---|
| `email` | `string` | `@IsEmail()` |
| `password` | `string` | `@IsNotEmpty()` |

Notable responses: `register` → `201` with the created account, `400` on duplicate email. `login` → `200`
with `{ success, data: account, accessToken }`.

---

## `TransactionsController` — `src/transactions/transactions.controller.ts` (base path: none, `@UseGuards(JwtAuthGuard)` on the whole controller)

| Method & Path | Auth | Rate limit | Body (DTO) | Purpose |
|---|---|---|---|---|
| `POST /transfer` | JWT | 10 / min | `CreateTransactionDto` (+ required `X-Idempotency-Key` header) | Transfer money from the authenticated account to another account. |
| `GET /balance` | JWT | 20 / min | — | Compute and return the authenticated account's current balance. |

**`CreateTransactionDto`** (`src/transactions/dto/create-transaction.dto.ts`)
| Field | Type | Validation |
|---|---|---|
| `toAccountId` | `string` | `@IsString() @IsNotEmpty()` — destination account ID |
| `amount` | `number` | `@IsInt() @IsPositive()` — amount in cents (1 USD = 100 cents) |

`POST /transfer` requires the `X-Idempotency-Key` header; a missing header returns `400`. Documented
responses: `201` created transaction, `400` insufficient balance / same source & destination account /
idempotency key reused with a different payload, `404` destination account doesn't exist, `409` race
condition detected on the idempotency key.

---

## `WebhooksController` — `src/webhooks/webhooks.controller.ts` (base path: `/webhooks`, `@UseGuards(JwtAuthGuard)` on the whole controller)

| Method & Path | Auth | Rate limit | Body (DTO) | Purpose |
|---|---|---|---|---|
| `POST /webhooks` | JWT | global default | `CreateWebhookEndpointDto` | Register a webhook endpoint for the authenticated account. |
| `GET /webhooks` | JWT | global default | — | List all webhook endpoints owned by the authenticated account. |
| `GET /webhooks/:id` | JWT | global default | — | Fetch one webhook endpoint by ID (must belong to the caller, else `404`). |
| `PATCH /webhooks/:id` | JWT | global default | `UpdateWebhookEndpointDto` | Update a webhook endpoint (URL, subscribed events, active flag). |
| `DELETE /webhooks/:id` | JWT | global default | — | Soft-delete a webhook endpoint (`204` on success). |

**`CreateWebhookEndpointDto`** (`src/webhooks/dto/create-webhook-endpoint.dto.ts`)
| Field | Type | Validation |
|---|---|---|
| `url` | `string` | `@IsSecureWebhookUrl()` — must be a publicly reachable HTTPS URL |
| `subscribedEvents` | `WebhookEventType[]` | `@IsEnum(WebhookEventType, { each: true })` — values: `transfer.completed`, `transfer.failed`, `receipt.generated` |

**`UpdateWebhookEndpointDto`** (`src/webhooks/dto/update-webhook-endpoint.dto.ts`) — `PartialType` of
`CreateWebhookEndpointDto` (both fields optional) plus:
| Field | Type | Validation |
|---|---|---|
| `active` | `boolean` | `@IsBoolean() @IsOptional()` |

Notable responses: `create` → `400` duplicate URL for the same account, `201` on success. `findOne` → `404`
if not found or not owned by the caller. `update` → `404` not found, `400` if the endpoint is currently
being processed by a worker. `delete` → `204` no content.

---

## `HealthController` — `src/health/health.controller.ts` (base path: `/health`)

| Method & Path | Auth | Rate limit | Body | Purpose |
|---|---|---|---|---|
| `GET /health/live` | No | exempt (`@SkipThrottle()`) | — | Liveness probe — process is running, no dependency checks (used by Docker healthchecks in `compose.prod.yml`). |
| `GET /health` | No | exempt (`@SkipThrottle()`) | — | Readiness probe — checks Postgres and Redis connectivity via `@nestjs/terminus`. |

---

## `AppController` — `src/app.controller.ts` (base path: none)

| Method & Path | Auth | Rate limit | Body | Purpose |
|---|---|---|---|---|
| `GET /` | No | global default | — | Trivial root route (`getHello`), not part of the documented product surface. |

---

## Summary table

| Route | Method | Auth | Rate limit |
|---|---|---|---|
| `/` | GET | No | 100/60s (default) |
| `/auth/register` | POST | No | 3/hour |
| `/auth/login` | POST | No (local strategy) | 5/min |
| `/auth/me` | GET | JWT | 100/60s (default) |
| `/transfer` | POST | JWT | 10/min |
| `/balance` | GET | JWT | 20/min |
| `/webhooks` | POST | JWT | 100/60s (default) |
| `/webhooks` | GET | JWT | 100/60s (default) |
| `/webhooks/:id` | GET | JWT | 100/60s (default) |
| `/webhooks/:id` | PATCH | JWT | 100/60s (default) |
| `/webhooks/:id` | DELETE | JWT | 100/60s (default) |
| `/health/live` | GET | No | exempt |
| `/health` | GET | No | exempt |
