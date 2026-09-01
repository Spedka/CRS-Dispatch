# Roadmap — long-term direction

The broader "where is this all going," across **crs-dispatch + crs-board +
scheduler-investigation**. For concrete next actions, see [`TODO.md`](TODO.md)
instead — this file is vision/direction, not a task list, and shouldn't need
updating every time something ships.

---

## The overall bet

Salesforce is CRS's single source of truth on purpose — nothing in any of these
apps holds its own copy of the data that can drift out of sync. The bet across
all of this work is the same one, applied to three different surfaces:

1. **crs-dispatch** is the office's operating tool — the one place staff work
   from instead of juggling Salesforce directly, Field Squared, and QuickBooks
   Online separately.
2. **crs-board** is the same bet for techs — a purpose-built mobile surface
   instead of texting the office to find out the schedule or request work.
3. **scheduler-investigation** is a bet that the *office's own scheduling
   judgment* can eventually be partially automated — but only after it's proven
   itself against real history, never before.

The throughline: every integration below exists to close a gap where two
systems (or a system and a person) currently have to be manually kept in sync,
and every process-adoption item exists because closing that gap in software
doesn't automatically mean anyone uses it. Both halves matter — see
`PROCESS-ADOPTION.md`'s core diagnosis for why the second half keeps turning out
to be the harder one.

## crs-dispatch: the QBO ↔ SF ↔ FS pipeline

Full detail, real numbers, and shipped/parked/in-progress status live in
[`INTEGRATION-ROADMAP.md`](INTEGRATION-ROADMAP.md) — this is just the shape of
where it's headed. The target end state is a full lifecycle with per-stage
visibility: quote → PO (material cost) → scheduled work → proof of completion →
invoice → billing reconciliation, with each stage's real data pulled from
whichever system actually owns it (SF for the job/schedule, FS for field
execution proof, QBO for money), rather than re-entered by hand at each
handoff. Create PO (the material-cost stage) and QBO↔SF billing reconciliation
are the two stages actually shipped so far; invoice drafting and full pipeline
visibility are the two biggest still-unbuilt pieces of that shape.

The vendor price sync (ADI/Potter/Notifier catalog import) is a separate,
narrower integration — closing the gap between what CRS actually pays vendors
and what's in the SF product catalog — currently blocked on ADI's side, not a
design question.

## Process adoption: the harder half

[`PROCESS-ADOPTION.md`](PROCESS-ADOPTION.md) is the living record of a
recurring finding: several of the gaps above aren't really missing software,
they're missing *enforcement* — a process that worked because a specific person
stood in the way of skipping it (the warehouse gatekeeper on parts checkout is
the clearest example), and nothing has replaced that function since. The
design principles that doc derives are worth internalizing before proposing a
fix for anything in `TODO.md`'s process-decisions section:

- Capture data as a **byproduct** of something someone already has to do for
  their own reasons, not as new work with no personal payoff.
- **Visibility isn't enforcement** — a dashboard nobody's job it is to check is
  the same as no dashboard.
- A **hard gate** (something that physically or procedurally can't be
  bypassed) beats an honor-system step every time real money or real
  compliance risk is on the line.
- The **phone-call test**: if someone would still just call/text a person
  instead of touching the tool, the tool doesn't fix anything for that path,
  no matter how good it is.

The mid-day-redirect problem (Skip's path) is the sharpest live example of the
phone-call test actually failing — worth reading in full before anyone
proposes a tooling fix for it, since two tooling ideas have already been
invalidated by exactly this principle.

## crs-board: from tech tool to shared surface

crs-board started as a one-way mirror (techs see their schedule, request time).
It's been drifting toward a genuinely shared surface with crs-dispatch instead
of a strictly one-directional read:

- **Job notes** now flow both ways (`Dispatch_Note__c`, the same object the
  office's own Notes panel uses) — a tech can flag something on-site and the
  office sees it immediately, not after the fact.
- **The hidden Admin login** lets office staff view (read-only) the same crew
  board techs see, without inventing a parallel auth system or a fake
  technician identity that shows up anywhere real techs are listed.

The natural next question, if this direction continues: what else currently
lives only on one side that would be more useful shared? (Time-off visibility,
job detail richness, and real-time status are the more obvious candidates —
none currently planned, worth raising before building.)

## scheduler-investigation: prove it before it ships

Deliberately kept out of crs-dispatch entirely until the prototype earns its
way in — see `scheduler-investigation/README.md` and
`autoschedulingdesign.md`'s "Resolved decisions" for the full design. The
standing bar for "ready to even discuss wiring in for real," not yet met:

- Backtest overlap needs to be consistently explained, not just observed (the
  21%–74% week-to-week swing is still a mystery, not a known-acceptable
  variance).
- The weight-feedback loop needs a real signal on more than one of its eight
  score terms — right now `backtest.py`'s blank-slate calendar structurally
  prevents `cont`/`load`/`pref` from ever moving, which means most of the
  model's own self-correction is currently theoretical, not real.
- Solver hosting (CP-SAT can't run in a Cloudflare Worker) needs an actual
  answer, not just a known gap.

Even once all of that's resolved, the design's own confirmation-call gate
means no `Job_Assignment__c` would ever get created by this without a human
actually confirming with the customer first — this was never scoped as a
fully autonomous scheduler, and that's a deliberate, permanent constraint, not
a v1 limitation to remove later.
