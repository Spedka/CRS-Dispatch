# Process Adoption & Enforcement

A living doc - not code documentation. Tracks the actual problem behind everything built in
this repo: **workflows and fields exist, but nothing forces or draws people to use them, and
their creator doesn't have the organizational seniority to compel compliance by mandate.**
Update this whenever something is tried, whether it works or not. Dated entries, not a clean
rewrite each time - the history of what's been tried is as valuable as the current state.

_Started 2026-08-20._

## The core diagnosis

Who's actually supposed to use the workflows that aren't sticking: **office/dispatch staff**
(in crs-dispatch, at a desk) and **warehouse/parts staff** - not primarily field techs.

Why they don't:
- **It's optional.** The job/invoice/whatever moves forward fine whether or not the field gets
  filled in, the PO gets logged, the status gets updated. Nothing blocks on it.
- **It adds friction.** A separate screen, a separate step, outside whatever they're already
  doing to get their actual job done.
- **Enforcement today is a "mix of both, but there are ways to get the job done without it -
  just with missing or wrong data."** i.e. soft gates exist in places but are routable-around.

The one thing that has worked, in the user's own words: *"It has worked when the job requires
the systems to be used. Problem is, when I don't have seniority or any draw with people that
don't want to use the systems, they just don't."* - hard technical gates work; asking nicely,
or a gate with an escape hatch, does not, because compliance can't be mandated from this seat.

## Who has authority over whom (context for every item below)

- **Darryl** (co-founder) - office-facing, wants the systems enforced.
- **Skip** (co-founder) - directs techs directly; techs answer to him more than to Darryl or to
  the systems. Low personal draw toward using the systems himself.
- **Paul** (manager) - sits between the two. Already does the right thing on his half (creates
  an FS work order, has status/SERVICE_ACK tooling available to hand off) - but can't force the
  tech to finish their half.
- The person building/maintaining these tools has **no authority over Skip or the techs**.
  Leverage has to come from (a) making compliance effort-free or independently valuable to the
  person doing it, or (b) surfacing facts to Darryl, who already wants this fixed and has the
  standing to act - not from asking anyone to comply.

## Design principles (derived from the diagnosis above, not generic advice)

1. **Capture as a byproduct of work already being done beats a separate data-entry step.**
   FS `SERVICE_ACK` hits ~94% coverage on billed jobs (measured 2026-08-20) because filling it
   out *is* how a tech closes a job in FS - not an extra errand. Contrast with PO tracking,
   which has no such built-in moment and is basically unused.
2. **A requirement that doesn't block the next action isn't a requirement.** If nothing stops
   forward progress when a field is skipped, it will be skipped under time pressure. Every
   proposed fix should be checked against: "what happens today if this is just left blank?"
   - **Correction, 2026-08-20: friction-reduction has a ceiling.** It only helps someone who is
     *willing but blocked by inconvenience*. It does nothing for someone who is simply not
     participating regardless of how easy the tool is (see Skip, #5 below) - that's a different
     category of person, not a harder version of the same problem, and needs a design that
     requires **zero participation from them**, not merely low friction.
3. **Where a true hard gate isn't possible (or would block someone from doing urgent real
   work), the next-best lever is VISIBILITY to someone who has the authority to act on it** -
   not a rule aimed at the person skipping the step. This seat can surface facts; it can't
   mandate compliance directly.
   - **Correction, 2026-08-20: "has the authority to act" needs to mean *enforceable* power,
     not just desire + standing.** Darryl (co-founder, wants enforcement) is the obvious escalation
     target for anything involving Skip - but confirmed: he "can kind of scold a partner into
     doing it but won't do it consistently and often just says no." A peer co-founder pushing
     another co-founder is not enforcement, it's persuasion with a bad hit rate. Visibility-based
     fixes still have value (they at least make the cost visible and create the option to push),
     but don't assume surfacing a fact to "the person who wants this fixed" reliably produces
     behavior change when that person can't actually compel the other party.
4. **Every hard gate has to survive the "phone call test."** If the real-world job can still
   get done by going around the system entirely (a call, a side arrangement), the gate isn't
   actually hard - it's just an inconvenience that gets routed around, same as an optional one.
5. Prefer deriving system-of-record state from an action someone already takes for their own
   reasons, over asking them to separately report that state.

## Known failure points (living tracker - update status/ideas as they develop)

### 1. Purchase orders - made, ordered, then lost, never revisited
- **Current state:** `Available_Inventory__c.PO_Number__c` (text) + `PO_Uploaded__c` (bool) exist
  but capture almost nothing structured - no line items, no real vendor cost, no follow-up step.
- **The intended workflow, per the owner (2026-08-20): a PO gets made, then sent to the
  accountant, who approves the order.** This is a real approval-gate concept, not just
  record-keeping - which is promising, *if* the approval actually controls something that must
  happen for the order to go out. Whether it does is the open question that decides everything
  else here (see below) - an approval step that can be bypassed by ordering some other way is
  just another optional step with the same failure mode as everything else in this doc.
- **Why it fails today:** no natural "closing the loop" moment - creating the PO is a side-errand
  with no personal payoff for whoever does it, and nothing ever comes back to check it resolved.
- **Confirmed 2026-08-20: it's a real chokepoint** - the accountant controls payment/ordering,
  nothing gets bought around them. This is the strongest hard-gate candidate in this whole doc:
  the enforcement mechanism already exists organically, it just isn't captured as data anywhere.
- **The exciting angle this opens up: the "PO data" this whole thread wanted might already
  exist, as a byproduct, in QBO.** An accountant tracking vendor payments is going to have
  Bills/Expenses in QBO regardless of anything CRS-specific being built - that's just their job.
  If those get tagged to a job/customer/class when entered, the real vendor cost per job may
  already be sitting there without asking anyone to do anything new (principle 1, the cleanest
  possible version of it - capture is already happening for a reason that has nothing to do with
  this project). This would need a QBO worker client either way, which already exists
  (`server/src/quickbooks.js`, built for the billing reconciliation) - extending it to read
  Bills/Expenses is a much smaller lift than it would've been from scratch.
- **Candidate fixes:**
  - Check whether vendor purchases actually get tagged to a job/customer/class in QBO today -
    if yes, pull real PO/material cost straight from there instead of building new PO tracking
    at all.
  - If not tagged today, a lightweight PO request → accountant-approve flow *inside the existing
    approval chokepoint* is still the right shape - it's a hard gate because the payment control
    already is one, not because the software makes it one.
- **Status:** open - next step is checking whether QBO Bills/Expenses are job-tagged.

### 2. Material requests - same pattern as POs
- **Status:** open, not yet explored separately from POs.

### 3. Work order status not updated as work progresses
- **Current state:** the FS↔SF status "drift badge" already flags disagreement between systems,
  but it's read-only / no forcing function - visibility without action per principle 3.
- **Why it's visibility-only, per the owner (2026-08-20): "I don't know always where the actual
  truth lies."** This is a different kind of problem from the others in this doc - not adoption,
  but genuine epistemic uncertainty. SF and FS are updated by different people, at different
  times, for different purposes, and there's no established rule for which one wins when they
  disagree. Auto-correcting either side on a drift would risk overwriting a status a human just
  deliberately set - which is exactly the bug this feature already had once before (see the
  dispatch drift-badge history: it used to auto-push and got walked back to display-only for
  this reason). Any forcing function needs a resolution rule first, not the other way around.
- **Answered 2026-08-20: genuinely varies, no reliable pattern.** So there's no heuristic to
  build - this confirms the current visibility-only design is the *correct* one, not a
  compromise waiting to be automated away. It's not solvable by better software at all; it's a
  human-judgment-every-time problem. The only lever left is the same one as #4: is anyone's job
  actually to look at the drift badge, or is even the visibility going unused?
- **Status:** effectively closed as "correctly can't be automated." Only remaining question is
  workflow ownership, same shape as #4.

### 4. Invoice follow-up not happening
- **Current state:** the QBO↔SF billing reconciliation report (built 2026-08) makes billed,
  received, and discrepant invoices visible - but visibility alone doesn't guarantee anyone
  looks, per principle 3.
- **Candidate fix:** push the gap at someone instead of waiting to be opened - e.g. a scheduled
  digest to whoever owns follow-up, rather than a dashboard that has to be remembered.
- **Owner's reaction, 2026-08-20: agrees a digest would help, "but it has to be done the right
  way."** Three specific concerns, in order given:
  1. **Alert fatigue** - too frequent/noisy and it gets ignored, same failure mode as everything
     else in this doc.
  2. **Wrong audience** - has to land with whoever actually owns follow-up, not a group.
  3. **"Our data could be wrong and we just didn't update our books right"** - the sharpest one.
     A digest built on the reconciliation report is only as trustworthy as the match underneath
     it, and a false positive (flagging a "gap" that's really just a bookkeeping mismatch, not a
     real unpaid/unbilled job) burns credibility fast - probably faster than being too quiet
     would. This is exactly what the invoice-matching accuracy work (duplicate-number pairing,
     full invoice-key normalization, the anchor+cross-lookup date-skew rescue) was already
     defending against, just not yet in digest form. **Implication: a digest should start
     conservative** - only the highest-confidence gaps (e.g. discrepant for N+ days, not
     transient data-entry lag), not everything the report currently surfaces.
- **Status:** open - concerns identified, cadence/audience/confidence-threshold still TBD.

### 5. Mid-day redirects bypass the system entirely - two different paths (detailed 2026-08-20)
Morning schedule is accurate (jobs/T&I/service calls assigned, everyone knows where they're
going). Mid-day, a call comes in and a tech gets redirected. **Two distinct paths, different
people, different fixes needed:**

**Path A - via Paul (manager).** Paul gets the call (e.g. from a contractor), redirects the
tech, and *does* create an FS work order - the tooling for status updates/SERVICE_ACK is handed
off correctly. But the tech's own follow-through (filling out the SERVICE_ACK, updating status)
is still inconsistent "a lot of the time." Paul already does his half; the gap is downstream of
him, on the tech.

**Path B - via Skip (co-founder).** Skip gets a call directly (a customer requesting service),
tells a tech to go, and **nothing touches the system until after the work is already done** -
Skip creates a work order retroactively only when he "comes in after." Concretely, this loses:
  - **Account status is unknown at dispatch time** - nobody checks whether the customer's bills
    are paid before sending a tech to do (possibly free) work for them. This is the highest-$
    risk of anything in this doc - it's not lost paperwork, it's potential free labor for a
    delinquent account, decided with zero visibility.
  - **No SERVICE_ACK is possible** - the record it would attach to (the work order) didn't exist
    until after the work was already done, so the byproduct-capture moment (principle 1) never
    existed. Not "the tech skipped it" - there was structurally nothing to fill out.
  - Parts used, follow-up notes - same: **total loss, not just missing data.**

**Why Path B needs a different strategy than Path A:** per principle 4 (the phone-call test),
Skip *is* the phone call. **Confirmed 2026-08-20: Skip will not use any system, no matter how
easy it is - this is refusal, not friction.** The "make a lookup fast enough that Skip would
want to use it mid-call" idea (previous version of this doc) is **invalidated** - it still
required him to touch a tool, and that's off the table categorically, not just for that one
idea. Every remaining option must require **zero participation from Skip**:
  - **Confirmed 2026-08-20: neither remaining lever is clean.** FS geo-pins exist only when a
    tech has the app open, and "sometimes they literally won't open it" - so passive detection
    can simply be absent for the exact cases that matter. And escalating to Darryl doesn't
    reliably work either (see principle 3 correction) - he can push, inconsistently, and Skip
    often just refuses. **There is currently no lever - tooling or authority - that reliably
    closes the billing-status-blindness gap when a tech doesn't have FS open.** Recording that
    plainly rather than continuing to search for a clever workaround around it.
  - **Geo-triggered nudge - checked against the live FS API AND official docs, 2026-08-20: not
    currently possible, but the reason turned out more interesting than "not enabled."**
    `User.Lat`/`Lon` are the *documented* location fields (confirmed via
    [docs.fieldsquared.com](https://docs.fieldsquared.com/knowledge-base/users-api/)) and are
    empty for every tech - matches what the raw API showed. `ActualRoute`/`ProposedRoute` (also
    empty) aren't part of the public API contract at all, just extra fields the raw endpoint
    happens to return. **But FS does run a real, separate "Team Location Tracking" feature**
    (continuous device GPS, cloud-synced, [1-year retention](https://aexinc.com/platform/team-location-tracking/))
    that's almost certainly what powers the live map - and it is **not** in FS's documented API
    list (Catalogs/Contacts/Teams/Documents/Users/Assets/Tasks/Custom Fields/Auth - no
    Locations API), and FS's own marketing page discloses nothing about API/export access for
    it. So the live map is real but likely reads from a separate, undocumented-or-higher-tier
    feed, not the `Lat`/`Lon` we have API access to. **Next step is a question to Field Squared
    support/account rep - "is GPS tracking enabled on our account, and is there an API path for
    it?" - not further API probing; the public docs don't disclose the answer.**
  - **The one tooling option actually available today: tech self-initiation, no location signal
    involved.** The lowest-possible-bar action a tech could self-initiate on arrival at an
    unplanned site (a one-tap "started here," deferring parts/description to later). This is a
    friction problem for techs, not a refusal problem like Skip's, so principles 1/2 still apply
    - but tech willingness to even do *that* is untested, not assumed.
- **Status:** open. Known unsolvable-for-now slice: Skip dispatches a tech who never opens FS -
  no current lever reaches this. Geo-detection is shelved pending one concrete next action: ask
  Field Squared support/account rep whether GPS tracking is enabled on our account and whether
  it has an API path - the public docs don't say. Until answered, the only tooling bet is the
  tech-side one-tap self-initiation idea, unvalidated.

### 6. Job parts used without checkout - no reconciliation against the quote
- **Current state:** on quoted job work (as opposed to service calls), techs take parts and use
  them without checking them out through the system.
- **Why it matters:** no way to tell whether actual material usage matches what was quoted, or
  whether a change order is needed - margin/scope risk, silent, discovered late if at all.
- **The real story, per the owner (2026-08-20): this used to be enforced by a person.** A
  dedicated warehouse employee physically wouldn't let a part go out without the checkout being
  done, and kept stock counts honest as a side effect. **That person quit, and nothing has
  replaced the function they served.** This reframes the problem: it was never really a
  tech-adoption problem - the tech was never the one being asked to comply, the warehouse
  gatekeeper was. What's missing isn't "get techs to want to use a checkout system," it's "a
  human chokepoint disappeared and nothing stands in its place." This is actually the cleanest
  illustration in the whole doc of principle 4 (the phone-call test) working *in reverse*: a
  hard gate existed, and it worked, precisely because a person was physically standing between
  "wants a part" and "has a part" - indistinguishable from any other hard gate in this doc that
  held.
- **Owner's framing: "have to find a way to automate it."** Two very different shapes this could
  take, worth resolving before designing anything:
  - **A physical/hardware chokepoint** (locked cage or bins, badge/barcode-gated release) that
    replaces the person's physical enforcement with equivalent physical enforcement - closest to
    what actually worked before, but real cost/complexity (hardware, install, per-part scanning).
  - **A software-only substitute** (a kiosk/checklist step at pickup) - cheaper, but without a
    physical barrier behind it, it's an honor-system step like everything else that's failed in
    this doc, unless it's paired with something that actually blocks physical access.
  - Not necessarily either/or - could also mean hiring a replacement for the role, which is an
    org decision, not a tooling one, but worth naming since it's the option most similar to what
    demonstrably worked before.
- **Owner's response, 2026-08-20: not sure yet, wants to see concrete options first** - before
  designing anything, sketched three shapes at a rough level (see chat same date for detail):
  1. Physical/hardware gate (locked cage or gated bins, badge/barcode release) - closest to what
     the warehouse person actually did; real cost/install, but a genuine hard gate.
  2. A middle option: keep parts accessible but require a checkout scan to *unlock* the room/cage
     itself (one barrier, not per-bin) - cheaper than full per-bin hardware, still a real barrier.
  3. Software-only (kiosk/checklist at pickup) - cheapest, but it's an honor-system step unless
     paired with something that blocks physical access; same failure mode as everything else in
     this doc if not.
  4. Hire a replacement for the role - org decision, not tooling, but the option most similar to
     what demonstrably worked.
- **Status:** open - awaiting a decision on which shape to pursue, no build started.

## Open questions to explore next
- For POs/material reqs specifically: what does "ordering" actually look like today (email? a
  vendor portal? a phone call?) - the capture point has to live wherever that already happens.
- ~~Who could visibility escalate to for principle 3?~~ **Revised 2026-08-20: Darryl is the
  only candidate, but "escalate to him" ≠ enforcement** - he can push, inconsistently, and Skip
  often just refuses. Visibility to Darryl is worth building (it's the only lever that exists),
  just don't expect it to reliably close the gap.
- ~~Does Skip carry a device where a fast lookup would be usable mid-call?~~ **Moot as of
  2026-08-20** - Skip won't use a tool regardless of ease, so device access no longer matters.
- ~~Does FS expose a passive signal (location/status) that needs no typing?~~ **Checked directly
  against the FS API, 2026-08-20: no, not currently.** The schema has the fields (`User.Location`,
  `User.ActualRoute` - a breadcrumb trail), but every tech checked shows `Location: {x:0,y:0}`
  and an **empty** `ActualRoute`, including techs with a `LastUpdated` from today. Not an
  app-open/closed issue as assumed - nothing is populating this at all, which points at GPS
  tracking not being enabled at the FS configuration/licensing level, not at tech behavior.
  (Task `Lat`/`Lon` *is* populated on ~19% of recent tasks, but that's the geocoded job-site
  address, not the tech's position - confirmed against real coordinates matching the job site.)
  **Passive geo-detection is off the table for now** - would need FS location tracking enabled
  first (an FS admin/settings question, separate from anything the API can provide), not
  something buildable today. The tech-side self-initiation idea is the only tooling option left
  for #5/Path B.
- Is there *any* existing moment, even informal (a text to someone, a truck restock habit),
  where techs already interact with parts/materials on job work? If one exists, #6's fix might
  be able to piggyback on it per principle 1, rather than needing a new deliberate step.

## Log of what's been tried
_(nothing logged yet - add an entry here every time something is actually rolled out, with the
outcome, even if it fails)_
