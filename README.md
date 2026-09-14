# Cardinal Contracts

Self-hosted contract sending and signing layer for clinics. It provides the Pro-style workflow we wanted: template upload, visual field placement, one-click sending, signer emails, status tracking, signed PDF generation, and audit logs.

Signing evidence is built in: signers verify by emailed one-time code and accept a recorded consent statement before signing; links expire; the signed PDF carries a signing certificate page (signer identity, IP, timestamps, consent, document SHA-256); the audit log is hash-chained (tamper-evident) and archived — not destroyed — when a contract is permanently deleted; and signers automatically receive a copy of the completed PDF by email.

## Documentation

- [Technical overview](docs/technical-overview.md): architecture, feature behaviour, API flows, database relationships, [access control](docs/technical-overview.md#access-control), technical debt, and deployment assumptions.
- [Framework integration](docs/framework-integration.md): handover brief for wiring contract sending into the Cardinal Framework (API reference, auth, current clinic/template state, what to build).
- [Build plan](PLAN.md): original implementation phases and remaining hardening work.

## Retention and archive model

DocuSeal treats storage and retention as a core capability: completed submissions remain available in the dashboard, signed files can be downloaded with their audit log, and archiving is a reversible soft-delete step before permanent removal. We mirror that model here.

- Active contracts stay in the main Contracts view with their status and signed PDF link.
- Archiving moves a contract out of the active view, keeps its database record, field values, audit events, and signed PDF, and blocks the signer URL.
- The archived view can restore a contract or permanently remove it. Permanent removal deletes the contract record and its stored signed PDF.

## Run locally

```bash
cp .env.example .env
npm install
npm run seed:clinics
npm run dev
```

Open `http://localhost:4321` (override with `PORT`). Set `ADMIN_TOKEN` in `.env`; API calls can use `Authorization: Bearer <token>`. Start the app from the repository root: the admin UI is served from `./public` relative to the working directory. `npm test` runs the suite against a throwaway database; `npm run build` type-checks and emits `dist/`.

The app stores SQLite data in `DATABASE_PATH`, uploaded template PDFs in `UPLOAD_DIR`, and signed PDFs in `STORAGE_DIR`. The defaults from `.env.example` are local paths under the repository.

## Patient record integration

Create a contract from a patient record with:

```http
POST /api/contracts
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

```json
{
  "templateId": "tpl_xxx",
  "clinicId": "clinic_cardinal",
  "patientRecordId": "PAT-123",
  "patientName": "Example Patient",
  "patientAge": "42",
  "payerName": "Example Payer",
  "payerEmail": "payer@example.com"
}
```

If `RESEND_API_KEY` is configured, the signer receives an email. Without it, the API response includes the signing URL for testing.
