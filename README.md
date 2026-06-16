# CRS Dispatch — Field Work Board

A small hosted web app that reads outstanding field-work jobs from Salesforce
(filtered by status) and lets dispatch assign any number of technicians to each
job. Salesforce stays the single source of truth — this app holds no copy of the
data, so it can't drift.

```
crs-dispatch/
  server/   Express API  -> talks to Salesforce
  web/      React (Vite) -> the board people use
```

---

## 1. Salesforce setup (one-time, point-and-click)

Do this in **Setup → Object Manager**. No code.

### a. `Technician__c` (your tech list)
- Create Object: Label `Technician`, plural `Technicians`.
- It gets a `Name` field automatically.
- Add field `Active__c` — Checkbox, default **checked**.
- Add a few technician records (Tab → New).

### b. Opportunity fields (the job)
- Add `Scheduled_Date__c` — Date. (The work date. `CloseDate` is the *deal* close
  date, not when the tech shows up.)
- Address: this scaffold reads `Account.ShippingStreet` / `ShippingCity`. If your
  job address doesn't come from the Account, add custom address fields on
  Opportunity and point `config.js` at them.

### c. `Job_Assignment__c` (one tech on one job)
- Create Object: Label `Job Assignment`.
- Add `Opportunity__c` — Lookup → **Opportunity**.
  - In that lookup's settings, set **Child Relationship Name** to `Job_Assignments`
    (so the API exposes it as `Job_Assignments__r`).
- Add `Technician__c` — Lookup → **Technician**.
- Add `Work_Date__c` — Date.

> A job with three techs is just three `Job_Assignment__c` rows. That's the
> "dynamic number" behavior.

### d. Confirm your status values
Open `server/src/config.js` and set `jobStatusValues` to the **exact** Opportunity
`StageName` (or custom status) values that mean "needs field work."

---

## 2. Run it

**Backend**
```bash
cd server
cp .env.example .env        # fill in SF_CLIENT_ID / SF_CLIENT_SECRET
npm install
npm run dev                 # http://localhost:3001
```
Reuse the connected app from your QBO pipeline (Client Credentials flow). Confirm
the running user has read/create/delete on `Job_Assignment__c` and read on
`Technician__c` and `Opportunity`.

**Frontend** (separate terminal)
```bash
cd web
npm install
npm run dev                 # http://localhost:5173
```
Vite proxies `/api` to the backend, so just open the web URL.

Sanity check the API alone: `curl localhost:3001/api/jobs`.

---

## 3. API

| Method | Path | Does |
|---|---|---|
| GET | `/api/jobs` | Field-ready jobs + their assigned techs |
| GET | `/api/jobs?status=Emergency` | Just that status |
| GET | `/api/technicians` | Active techs for the dropdown |
| POST | `/api/jobs/:oppId/assignments` | Add a tech (`{ technicianId, workDate }`) |
| DELETE | `/api/assignments/:id` | Remove a tech |

---

## Notes

- **config.js is the only file that knows your org's names.** If a field name is
  wrong, fix it there — not scattered through the code.
- **Auth:** backend↔Salesforce uses Client Credentials. App *user* login is not
  built yet (deferred per scope). When you add it, fronting this with CRS
  Google/Microsoft SSO gets you MFA for free.
- **Picklist gotcha:** if `StageName` is a restricted picklist, the status values
  in `config.js` must match exactly or the query returns nothing.

### Next up
- Tech availability is day-level today. Hourly would mean adding start/end times
  to `Job_Assignment__c` and a timeline view.
- App login + hosting.
