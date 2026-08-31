# CRS Dispatch - Field Work Board

A small hosted web app that reads outstanding field-work jobs from Salesforce
(filtered by status) and lets dispatch assign any number of technicians to each
job. Salesforce stays the single source of truth - this app holds no copy of the
data, so it can't drift.

Since first written, this has grown well beyond scheduling - it's now the office's
main tool for Field Squared linking/sync, QuickBooks Online purchasing/invoicing,
billing reconciliation, and per-job cost tracking too. **See [`CLAUDE.md`](CLAUDE.md)
for the full, current picture** - this file stays focused on local setup/running.

```
crs-dispatch/
  server/src/   Cloudflare Worker (Hono) -> talks to Salesforce/Field Squared/QuickBooks
  web/          React (Vite) SPA -> the app people use
```

There is no `server/package.json` - the backend has no dependency of its own beyond
`hono` (declared at the repo root); `wrangler` runs it locally and deploys it.

---

## 1. Salesforce setup (one-time, point-and-click)

Do this in **Setup → Object Manager**. No code.

### a. `Technician__c` (your tech list)
- Create Object: Label `Technician`, plural `Technicians`.
- It gets a `Name` field automatically.
- Add field `Active__c` - Checkbox, default **checked**.
- Add a few technician records (Tab → New).

### b. Opportunity fields (the job)
- Add `Scheduled_Date__c` - Date. (The work date. `CloseDate` is the *deal* close
  date, not when the tech shows up.)
- Address: this scaffold reads `Account.ShippingStreet` / `ShippingCity`. If your
  job address doesn't come from the Account, add custom address fields on
  Opportunity and point `config.js` at them.

### c. `Job_Assignment__c` (one tech on one job)
- Create Object: Label `Job Assignment`.
- Add `Opportunity__c` - Lookup → **Opportunity**.
  - In that lookup's settings, set **Child Relationship Name** to `Job_Assignments`
    (so the API exposes it as `Job_Assignments__r`).
- Add `Technician__c` - Lookup → **Technician**.
- Add `Work_Date__c` - Date.

> A job with three techs is just three `Job_Assignment__c` rows. That's the
> "dynamic number" behavior.

### d. Confirm your status values
Open `server/src/config.js` and set `jobStatusValues` to the **exact** `Project_Status__c`
values that mean "needs field work" (the default/fallback status field). If your org uses
Opportunity **record types** with per-type status fields, also configure
`config.recordTypeStatus` (`fieldByType` / `valuesByType` / `boardExcludedTypes`) - see
`CLAUDE.md` → "Opportunity record types" for how the resolver picks a status field per type.
Strings must match the SF picklists exactly (e.g. `Parts ordered`, lowercase o).

---

## 2. Run it

From the repo root, install once (`npm install` at the root **and** inside `web/`),
then run both of these together, in two terminals:

```bash
npm run dev:api              # wrangler dev, the real Workers runtime, http://localhost:8787
```
```bash
npm run dev:web               # cd web && vite dev, http://localhost:5173
```
Reads `wrangler.toml`'s `[vars]` for non-secret config and Cloudflare secrets
(`wrangler secret put NAME`, or a local `.dev.vars` file for dev-only overrides) for
`SF_CLIENT_ID`/`SF_CLIENT_SECRET`/`FS_EMAIL`/`FS_PASSWORD`/`FS_WORKSPACE`/
`QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`/`QBO_REFRESH_TOKEN`/`AUTH_SECRET`/etc — see
`CLAUDE.md`'s environment-variable table for the full list. Vite proxies `/api/*`
(including WebSocket upgrades, needed for the `/tv` kiosk board's live push - only
works when the API side is `dev:api`, not any plain-Node alternative, since Durable
Objects need the real Workers runtime) to `localhost:8787` - just open the `dev:web`
URL and log in.

`npm run build` / `npm run deploy` (root) build the SPA and deploy the whole thing
as one Worker (`wrangler deploy`) - same origin for API + static assets, no CORS.

Sanity check the API alone once both are running:
`curl -H "Authorization: Bearer <name>" localhost:8787/api/jobs` (the auth
middleware also accepts a raw tech/office name as a dev convenience bearer value).

---

## 3. Notes

- **`server/src/config.js` is the only file that knows your org's Salesforce/QBO
  names.** If a field name is wrong, fix it there - not scattered through the code.
- **Auth:** the Worker↔Salesforce link uses a Client Credentials Connected App
  (server-to-server, no per-user SF login). **App user login is built** - office
  staff log in with email + password against custom fields on the standard SF
  `User` object (`CLAUDE.md` → "Auth (office login)").
- **Picklist gotcha:** status values in `config.js` must match the real SF
  picklist exactly (case included, e.g. `Parts ordered` - lowercase o) or a query
  returns zero rows with no error.

For everything past initial setup - the full screen tour, the Field Squared and
QuickBooks Online integrations, business-process context, and the environment
variable/secrets/bindings reference - see [`CLAUDE.md`](CLAUDE.md).
