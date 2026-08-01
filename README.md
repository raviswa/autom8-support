# autom8-support — Standalone support ticketing

Greenfield service (not part of autom8-backend). Owns `support_tickets`, Groq triage, and a minimal admin UI at `/admin`.

Dashboard **Support** chip lives in `autom8-frontend` and posts to this service via `VITE_SUPPORT_API_URL`. WhatsApp outbound goes through `autom8-backend` `POST /api/internal/notify/whatsapp` (reuses `sendWhatsAppMessage`).

## Before first run

1. In Supabase SQL editor confirm the table is absent:
   ```sql
   select to_regclass('public.support_tickets');
   ```
2. Case A (`null`): run [`migrations/20260801_support_tickets.sql`](migrations/20260801_support_tickets.sql).
3. Case B (table exists): do not drop; keep this migration as history only.

## Env — autom8-support (this service)

Copy `.env.example` → `.env`:

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (8090) | HTTP port |
| `SUPABASE_URL` | yes | Same Supabase project as Autom8 |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Tickets + JWT validation |
| `GROQ_API_KEY` | recommended | Triage (without it, all tickets escalate as `other`) |
| `GROQ_MODEL` | no | Default `llama-3.3-70b-versatile` |
| `SUPPORT_ADMIN_EMAILS` | yes for admin UI | Comma-separated emails for queue list/patch |
| `SUPPORT_ADMIN_WHATSAPP` | recommended | Digits-only phone for escalation WhatsApp |
| `AUTOM8_API_BASE` | yes for notify | e.g. `https://api.autom8.works` |
| `AUTOM8_KDS_SECRET` | yes for notify | **Same** value as autom8-backend |
| `FRONTEND_ORIGIN` | no | CORS for SupportChip (`https://app.autom8.works`) |
| `SUPPORT_PUBLIC_URL` | no | Base URL used in escalation deep links (`/admin#ticket=…`) |
| `ADMIN_APP_BASE` | no | Fallback link base |
| `SUPPORT_STORAGE_BUCKET` | no | Supabase Storage bucket (default `support-attachments`) |

### Attachments

1. Run [`migrations/20260802_support_ticket_attachments.sql`](migrations/20260802_support_ticket_attachments.sql) (adds `attachments` jsonb + creates the private Storage bucket).
2. Dashboard Support chip can attach up to **5** images (JPEG/PNG/WebP/GIF, ≤5 MB each) via multipart field `images`.
3. Admin detail view shows signed thumbnail links (1 hour).

```bash
npm install
npm start
```

## Env — autom8-backend (notify only)

Already mounted: `POST /api/internal/notify/whatsapp` (auth via `AUTOM8_KDS_SECRET`).

| Var | Notes |
|---|---|
| `AUTOM8_KDS_SECRET` | Must match autom8-support |

## Env — autom8-frontend (SupportChip)

| Var | Required | Purpose |
|---|---|---|
| `VITE_SUPPORT_API_URL` | yes for chip | Base URL of this service, no trailing slash — e.g. `http://localhost:8090` or `https://support.autom8.works` |

Chip posts to `${VITE_SUPPORT_API_URL}/tickets` with the dashboard Bearer JWT.

## Endpoints

- `POST /tickets` — tenant user (Bearer JWT) or WhatsApp ingest (`x-internal-secret` + `source: whatsapp`)
- `GET /tickets?queue=actionable` — support admin (`SUPPORT_ADMIN_EMAILS`)
- `GET /tickets/:id` — support admin
- `PATCH /tickets/:id` — support admin (`status`, `notes`, `resolution_type`, …)
- `GET /admin` — static queue UI (paste `authToken`)

## Policy

- Auto-resolve only when confidence ≥ 0.75 **and** a known answer exists for the category.
- `KNOWN_ANSWERS` starts empty → everything escalates until you fill answers after ~15–20 real tickets.
- Never auto-resolve `subscription_billing` / `payment_failure`.

## TODO(scale)

- Replace `SUPPORT_ADMIN_EMAILS` with a `platform_role` column.
- Optional dedicated host `support.autom8.works` for admin UI if support staff should not use the owner app.
