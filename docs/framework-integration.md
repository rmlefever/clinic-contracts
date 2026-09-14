# Cardinal Framework ↔ Cardinal Contracts integration

Handover brief for adding contract sending into the Cardinal Framework (the clinic/patient system). The Framework creates and tracks contracts; the Cardinal Contracts app handles templates, emailing the signer, capturing signatures, and producing signed PDFs.

Related: [Technical overview](technical-overview.md) (architecture, data model, [Access Control](technical-overview.md#access-control)).

## 1. What you're integrating with

**Cardinal Contracts** is a standalone Fastify app (this repo) that replaces a DocuSeal-Pro workflow: upload a contract PDF once, place fields on it, then send a signing link to a patient's payer from a patient record. It emails the signer (Resend), captures signatures, stamps the values onto the PDF, appends a signing certificate, and keeps an audit log.

- **Base URL:** `https://contracts.docuseal.ink`
- **Status:** live. Cardinal Clinic is set up; PROMIS London and PROMIS Hay Farm are pending their contract PDFs (see §4).

## 2. Connection & authentication (read first)

- **Server-side only.** Call the API from the Framework's server (it runs on the `cardinal` host, public IP `88.202.143.245`, which is allowlisted to reach this app's admin API). **Never put the admin token in browser/client code** — the public internet cannot reach the admin surface by design.
- **Auth header:** `Authorization: Bearer <CONTRACTS_ADMIN_TOKEN>`.
- **Config (Framework env):**
  ```
  CONTRACTS_API_URL=https://contracts.docuseal.ink
  CONTRACTS_ADMIN_TOKEN=<ask operator; same as the app's ADMIN_TOKEN>
  ```
- All admin endpoints require the token. Signer endpoints (`/api/sign/...`) are public and token-less (the signer uses a per-contract URL token).

## 3. API reference (what the Framework needs)

All admin requests: `Authorization: Bearer $CONTRACTS_ADMIN_TOKEN`. JSON in/out unless noted.

### Clinics
```http
GET /api/clinics
→ [{ "id": "clinic_cardinal", "name": "Cardinal Clinic", "email_from": "...", "created_at": "..." }, ...]
```

### Templates
```http
GET /api/templates?clinicId=clinic_cardinal
→ [{ "id": "tpl_...", "clinic_id": "...", "name": "...", "status": "active", "fields": [ ... ] }]
```
Only `status: "active"` templates can be sent. Each `field` has `{ id, label, type, required, source, page, x, y, w, h }`. `source` ∈ `patientName | patientAge | payerName | payerEmail | manual` — fields with a `source` are auto-filled at creation from the values you pass; `manual` fields are filled by the signer.

### Create + send a contract (the main call)
```http
POST /api/contracts
{
  "templateId": "tpl_hVY5WxTWLO",
  "clinicId":   "clinic_cardinal",
  "patientRecordId": "<the framework's patient id>",
  "patientName": "Jane Doe",
  "patientAge":  "42",
  "payerName":   "John Doe",
  "payerEmail":  "john@example.com"
}
```
| field | required | notes |
|---|---|---|
| `templateId` | yes | must be `active` |
| `clinicId` | yes (defaults `clinic_cardinal`) | determines the "from" email |
| `patientRecordId` | no | your patient id — **store this mapping** so you can list contracts per patient |
| `patientName` | yes | pre-fills fields with `source: patientName` |
| `patientAge` | no (string) | pre-fills `source: patientAge` |
| `payerName` | yes | the signer; pre-fills `source: payerName` |
| `payerEmail` | yes | the signer's email; the signing link is sent here (Resend) |

**Response:**
```json
{
  "id": "ctr_...", "clinic_id": "...", "template_id": "...", "patient_record_id": "...",
  "patient_name": "...", "patient_age": "...", "payer_name": "...", "payer_email": "...",
  "status": "pending", "signing_token": "...", "signed_pdf_path": null,
  "expires_at": "...", "completed_at": null, "archived_at": null, "created_at": "...", "updated_at": "...",
  "signingUrl": "https://contracts.docuseal.ink/sign.html?token=...",
  "email": { "sent": true, "...": "..." }
}
```
Persist `id` against your patient record. `signingUrl` is included for fallback/testing; in normal use the app emails it automatically (`email.sent`). The link **expires after 30 days** (`expires_at`); if a payer lets one lapse, `POST /api/contracts/:id/extend {"days":30}` then `POST /api/contracts/:id/resend` re-opens and re-sends it.

> The signer experience now includes an email verification step (a 6-digit code emailed to the payer before they may sign) and a mandatory consent checkbox — both automatic, nothing for the Framework to build.

### Track status
```http
GET /api/contracts?clinicId=clinic_cardinal&archived=false     # list active
GET /api/contracts?clinicId=clinic_cardinal&archived=true      # list archived
```
A contract's `status` goes `pending` → `completed`; once completed, `signed_pdf_path` is set (serves at `https://contracts.docuseal.ink/storage/<basename>` — reachable from the Framework host). **There are no webhooks yet** — poll this endpoint for status changes, or store `id` and fetch on demand when the patient record is viewed.

### Audit trail, integrity checks, link lifecycle (optional)
```http
GET /api/contracts/:id/audit
→ [{ "event_type": "contract.created|contract.opened|document.viewed|identity.challenged|identity.verified|contract.completed|contract.copy_sent|...", "actor": "system|signer|admin", "created_at": "...", "prev_hash": "...", "hash": "...", ... }]

GET /api/contracts/:id/evidence  # COMPLETE evidence bundle for patient-file archiving (see below)
GET /api/contracts/:id/verify    # re-hash the stored signed PDF vs the SHA-256 sealed at signing → { ok: true }
GET /api/audit/verify            # walk the tamper-evident audit hash chain → { ok: true, eventCount: N }
POST /api/contracts/:id/extend   # { "days": 30 } — fresh expiry window for a pending contract
POST /api/contracts/:id/resend   # re-send the signing email (pending, unexpired only)
```

### Evidence bundle (`GET /api/contracts/:id/evidence`)

One call returns everything a clinic app needs to archive the signing evidence on the patient record, independently of the Contracts server:

- `contract` — the full contract record (signing token redacted), with `signed_pdf_sha256` / `content_sha256` seals, timestamps, expiry
- `template` — id/name/status snapshot
- `consent` — the verbatim consent statement + version the signer accepted
- `auditEvents` — the contract's full audit trail in chain order, with `prev_hash`/`hash` per event
- `chain` — global chain status at export time (`verified`, `eventCount`, `headHash`)
- `pdf` — the signed PDF itself (`base64`), its SHA-256, and whether it matches the completion seal (`matchesSeal`); omit with `?includePdf=false`
- `bundleSha256` — sha256 over the compact JSON serialization of everything above (the object without this field). Verify a stored copy with `sha256(Buffer.from(JSON.stringify(bundleWithoutSha)))` (Node; other languages: compact separators, no whitespace, key order as received)

On completion the contract row also carries `signed_pdf_sha256` and `content_sha256`, the signed PDF's certificate page records consent + signer IP + the content hash, and the signer is emailed a copy of the signed PDF.

> Note: `contract.created` currently records `actor: "system"` (the API doesn't yet accept the acting user). If you need per-staff audit, flag it — that's a small app-side change.

## 4. Clinic & template state today

| Clinic | `clinicId` | Template | Status |
|---|---|---|---|
| Cardinal Clinic | `clinic_cardinal` | `tpl_hVY5WxTWLO` — "Cardinal Standard Room Contract - 2026" | ✅ active, 5 fields |
| PROMIS London | `clinic_promis_london` | — | ⛔ not uploaded yet |
| PROMIS Hay Farm | `clinic_promis_hay_farm` | — | ⛔ not uploaded yet |

Cardinal's template fields (so you know what pre-fills): Patient Name (`patientName`), Patient Age (`patientAge`), Name of Signatory (`payerName`) are auto-filled; Payer Signature and Date of Signing are filled by the signer.

**PROMIS is blocked on the contract PDFs** — different company names/bank details per clinic, so two separate PDFs/templates are needed. The operator is supplying them; until those are uploaded and activated, the Framework can only send Cardinal contracts. Build the integration clinic-agnostic (config-driven template map) so PROMIS slots in without code changes.

Suggested config map in the Framework:
```
CONTRACTS_TEMPLATES = {
  "clinic_cardinal":       "tpl_hVY5WxTWLO",
  "clinic_promis_london":  "<to be set>",
  "clinic_promis_hay_farm":"<to be set>"
}
```

## 5. End-to-end flow

1. Staff opens a patient record in the Framework, clicks **Send contract** (choosing clinic/template — or defaulted by the patient's clinic).
2. Framework server `POST /api/contracts` with the patient + payer details and the clinic's template id.
3. Contracts app creates the contract (`status: pending`), pre-fills mapped fields, emails the signer via Resend.
4. Signer opens `signingUrl`, verifies their email with a 6-digit code, views the document, ticks the consent statement, fills signature/date, submits → app stamps the PDF (with signing certificate + SHA-256 seals), sets `status: completed`, stores `signed_pdf_path`, and emails the signer their copy.
5. Framework shows status (poll or fetch on view) and links the signed PDF once completed.
6. On completion, the Framework **archives the evidence bundle on the patient file** (`GET /api/contracts/:id/evidence`): the signed PDF and the audit/hashes/consent bundle are stored as patient documents, with the seals (`bundleSha256`, `signedPdfSha256`) recorded on the signing request. The evidence then lives with the patient record, not only on the Contracts server.

## 6. What to build

1. **Config/env:** `CONTRACTS_API_URL`, `CONTRACTS_ADMIN_TOKEN`, and the clinic→template map above.
2. **Server-side client module** (one helper per endpoint in §3). Keep it small; it's just `fetch` + bearer header + JSON.
3. **Patient record UI:** a *Send contract* action that gathers payer name/email (+ patient name/age) and calls create. Show a status badge (`pending` / `completed`) and, when completed, a link to the signed PDF.
4. **Status sync:** fetch the contract by `id` (filter your local table by `patient_record_id`) when the record is viewed, or a periodic poll. (Webhooks are a future enhancement — not available yet.)
5. **Evidence archiving:** when a contract completes, pull `GET /api/contracts/:id/evidence` and store the signed PDF + evidence JSON on the patient file, recording `bundleSha256` and `signedPdfSha256` locally. Verify the bundle seal (`sha256` over the compact JSON of the bundle without `bundleSha256`) before trusting the copy. (The Cardinal Framework does this automatically in its refresh flow.)
6. **Error handling:** surface email-send failures (`email.sent: false`) to staff so they can use the returned `signingUrl` manually.

## 7. Worked example (run from the Framework host)

```bash
curl -sS -X POST https://contracts.docuseal.ink/api/contracts \
  -H "Authorization: Bearer $CONTRACTS_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "tpl_hVY5WxTWLO",
    "clinicId": "clinic_cardinal",
    "patientRecordId": "PT-0001",
    "patientName": "Jane Doe",
    "patientAge": "42",
    "payerName": "John Doe",
    "payerEmail": "john@example.com"
  }' | jq '{ id, status, signingUrl, emailSent: .email.sent }'
```
Expected: `status: "pending"`, a `signingUrl`, and `emailSent: true` (Resend is configured).

## 8. Open items / decisions

- **PROMIS templates** not yet created (blocked on PDFs) — build config-driven so they slot in.
- **No webhooks** — status is poll/fetch-on-demand for now.
- **Per-staff audit** isn't passed through yet (`actor` is `system`); request it if needed.
- **Signing tokens don't expire** (known tech debt) — acceptable for now.
- The signer email's "from" is set per clinic (`clinics.email_from`), not per-send.
