# CRS Salesforce Parts & Inventory Tracking

## Purpose

Track service parts inventory natively in Salesforce, no license upgrade, no AppExchange package. Reuses the existing Product2 catalog as the list of trackable parts. Adds stock location, stock ledger, and per-Opportunity part need tracking. Enforces Bronwyn's warehouse checklist (PO discipline on ordering, material req verification on checkout) as Flow-level gates, not tribal knowledge.

Field Squared remains the tech-facing system for submitting material requests. That request currently only exists as a PDF, no API, no structured data feed into Salesforce. The PDF is uploaded directly to the Opportunity as the audit trail. There is no Material_Request__c object; that was scoped out. Everything hangs off Opportunity.

## Why Product2 alone doesn't solve this

Product2 is the catalog: what parts exist. It has no quantity field and isn't meant to. "How much do we have and where" is a separate concern, handled by the objects below.

## Object model

**Inventory_Location__c**
One record per physical bucket: main warehouse, each truck/service stock, storage room.
- `Name`
- `Type__c` (picklist: Warehouse, Truck/Service Stock, Storage Room)

**Stock_Movement__c**
Immutable ledger. Every stock change is a new row, never an edit to an existing quantity. Current stock is always a derived sum of this table, never mutated directly.
- `Product__c` (lookup, Product2)
- `Location__c` (lookup, Inventory_Location__c)
- `Quantity__c` (number, signed: positive for stock-in, negative for stock-out)
- `Movement_Type__c` (picklist: Received, Consumed, Adjustment, Transfer)
- `Opportunity__c` (lookup, populated on Consumed rows so every part pulled traces to a job)
- `Purchase_Order__c` (lookup, populated on Received rows)
- `Flagged_For_Review__c` (checkbox, manually set true when a part is pulled from service stock without a PO)
- `Date__c`

**Stock_On_Hand__c**
Derived current-quantity table. One row per Product + Location pair. This is what the warehouse manager actually looks at day to day.
- `Product__c` (lookup, Product2)
- `Location__c` (lookup, Inventory_Location__c)
- `Quantity_On_Hand__c` (number, kept current by a record-triggered Flow on Stock_Movement__c create, which finds/upserts the matching row and adds the signed delta)

**Opportunity_Part_Line__c**
What a specific job needs, built by the warehouse manager off the PDF or stamped in from a kit template. Lives directly under Opportunity, no intermediate request object.
- `Opportunity__c` (lookup, required)
- `Product__c` (lookup, Product2)
- `Quantity_Needed__c` (number)
- `Quantity_Available__c` (Flow-populated from matching Stock_On_Hand__c)
- `Variance__c` (formula: Available minus Needed, negative means shortfall)

**Job_Kit__c / Job_Kit_Line__c** (optional, v1 nice-to-have not required for the checklist to work)
Reusable part templates for recurring job types, so Opportunity_Part_Line__c rows can be stamped in bulk instead of hand-picked every time.

## Enforcement points (this is where the checklist actually lives)

**Ordering checklist:** every PO must be generated and attached to an Opportunity or flagged as service stock replenishment.
Implementation: validation rule on the PO object. Cannot save unless `Opportunity__c` is populated OR `Is_Service_Stock_Replenishment__c` is checked.

**Checkout checklist:** material req exists, matches quote (Jobs only), PO exists if one was needed, no-PO pulls get flagged.
Implementation: a checkout Screen Flow, not a passive convention. Before it is allowed to write a Stock_Movement__c (Consumed) against an Opportunity, it:
1. Runs Get Records on ContentDocumentLink where LinkedEntityId = the Opportunity Id. No PDF attached, no checkout, Flow throws an error screen.
2. For Job-type Opportunities (Job vs Service Call vs T&I determined by Opportunity Record Type): compares Opportunity_Part_Line__c rows against Quote Line Items for the same Opportunity. Mismatch halts and surfaces the discrepancy.
3. T&I Opportunities are blocked from having Opportunity_Part_Line__c records created at all (T&I never needs parts), enforced at record-creation time so bad data can't enter the queue.
4. If no PO exists for a needed part, checkout is still allowed but requires the warehouse manager to explicitly check `Flagged_For_Review__c` on the resulting Stock_Movement__c. This is a deliberate human decision, not an automatic fallback. Bronwyn's team runs a list view filtered on that checkbox as the review queue.

## UI / reporting (native, no custom pages needed)

- **Full stock matrix** (every part x every bucket): Matrix Report on Stock_On_Hand__c, rows grouped by Product, columns grouped by Location, summarize Quantity_On_Hand__c as Sum. Pin to a dashboard for the warehouse manager's daily view.
- **Single-part stock lookup**: Stock_On_Hand__c added as a related list on the Product2 page layout.
- **Need vs have per job**: report or related list on Opportunity_Part_Line__c, filtered to negative Variance__c for the shortfall view.

## Open questions

1. **Job_Kit__c scope**: build the kit/template layer in v1, or defer until the base ledger and checkout flow are live and being used?
2. **PO-to-service-stock validation rule wording**: exact field name and picklist values for `Is_Service_Stock_Replenishment__c`, confirm with however POs are currently modeled (native or custom object).
3. **Reorder thresholds**: is a `Reorder_Point__c` field on Product2 with a "needs ordering" report a v1 requirement or a v2 addition?
4. **Quote Line Item matching logic**: exact field-level comparison for step 2 of the checkout Flow (product + quantity match, or looser), and what counts as an acceptable variance before it blocks checkout.
5. **PDF attachment enforcement point**: should the ContentDocumentLink check block checkout only, or also block creation of Opportunity_Part_Line__c records earlier in the process?
6. **Service Call material needs**: confirmed Jobs and Service Calls both need parts (T&I never does), but is there any Service Call specific validation beyond what's listed here (Jobs get quote-matching, do Service Calls need an equivalent check against anything)?
7. **Location model for trucks**: one Inventory_Location__c per truck, or a shared "Service Stock" bucket with a sub-field for which truck? Affects whether variance checks are per-truck or pooled.
8. **Bulk transcription risk**: no validation currently catches typos when the warehouse manager manually keys in Opportunity_Part_Line__c rows off a PDF. Worth a lightweight double-check step (e.g. Status can't leave Draft without at least one line item present) if volume is high enough to matter.