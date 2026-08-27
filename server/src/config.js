// =====================================================================
//  THE ONLY FILE YOU SHOULD NEED TO EDIT to match your Salesforce org.
//  Everything below the credentials block maps THIS app's names to
//  YOUR object/field API names. Replace the right-hand strings.
// =====================================================================

export const config = {
  salesforce: {
    apiVersion: 'v60.0',
  },

  jobStatusValues: [
    // Added 2026-08-25: a job still needing a quote can legitimately need a
    // tech dispatched first (a pre-quote site visit to gather what the quote
    // needs) - so "Needs Quote" has to be board-visible too, not confined to
    // the Quotes tab the way it originally was. Real case: WO 011 2026 T&I
    // Discrepancies @ 9695 Red Stone Drive needed a site-visit assignment
    // while still genuinely in "Needs Quote" - not a status data-entry error.
    'Needs Quote',
    'Pending Customer Approval',
    'Quoted',
    'Parts ordered', // NOTE: lowercase 'o' - matches the real Project_Status__c picklist in the org
    'Ready to be scheduled',
    'Scheduled',
    'In Progress',
    'Installation Completed',
    'Waiting on Payment',
  ],

  // ---- Opportunity record types (2026 restructure) ----
  // Most Opportunities have NO record type (legacy) and carry their lifecycle
  // status in Project_Status__c - that stays the default/fallback path.
  // The new record types diverge: each keeps its lifecycle status in a
  // different field. `statusFieldForType()` below is the single resolver every
  // read/write goes through.
  recordTypeStatus: {
    // record-type DeveloperName -> the field holding that type's board status
    fieldByType: {
      Service_Call: 'Service_Status__c',
      Test_Inspection: 'Inspection_Status__c',
      Monitoring: 'Monitoring_Status__c',
      // Default / Job / Work_Order / null -> fallbackField below.
      // Work_Order rides Project_Status__c on purpose: every Work_Order Opp in
      // the org carries a real Project_Status__c; Job_Or_Work_Order_Status__c
      // is only a coarse Active/Inactive flag, useless for scheduling.
    },
    fallbackField: 'Project_Status__c',
    // Board-relevant status VALUES per record type (drives the status dropdown
    // in App.jsx and the crs-board picker). Types not listed use jobStatusValues,
    // which as of 2026-08-25 DOES include 'Needs Quote' (a pre-quote site visit
    // is a real, legitimate reason to dispatch a tech before quoting is done --
    // see jobStatusValues' own comment). Service_Call/Test_Inspection below
    // still deliberately exclude the quote-pipeline values -- only extend these
    // too if the same site-visit-before-quote need comes up for those types.
    valuesByType: {
      Service_Call: [
        'Pending Customer Approval',
        'Ready to be Scheduled',
        'Scheduled',
        'In Progress',
        'Completed',
      ],
      Test_Inspection: [ // Inspection_Status__c board values (no In Progress on that field)
        'Pending Customer Approval',
        'Unscheduled',
        'Scheduled',
        'Completed',
      ],
    },
    // Record types kept OFF the dispatch board entirely.
    boardExcludedTypes: ['Monitoring'],
  },

  // ---- Opportunity (the job) field API names ----
  fields: {
    oppName: 'Name',
    oppStatus: 'Project_Status__c',
    oppScheduledDate: 'Scheduled_Project_Start_Date__c',
    oppLid: 'LID__c',
    addrStreet: 'Job_Street_Address2__c',
    addrCity: 'Job_City__c',
    addrState: 'Job_State__c',
    addrZip: 'Job_Zip_Code__c',
    oppType: 'Opportunity_Type__c',
    // Quoting due date - Date field on Opportunity. Used only by the Quotes tab.
    oppBidDate: 'Bid_Date__c',
    // Standard Account lookup - the bidding customer account. Used only by the Quotes tab.
    oppAccountRelationship: 'Account',
    // Checkbox stamped true once the "Sent" email actually goes out - not
    // when status merely changes, so the plain status dropdown never sets it.
    // (Renamed from Quote_Sent__c.)
    oppSentToCustomer: 'Sent_To_Customer__c',
    // Checkbox stamped true once the "Review" email actually goes out - same
    // convention as oppSentToCustomer above.
    oppReadyForReview: 'Ready_For_Review__c',
    // DateTime field - internal review deadline, shown alongside oppBidDate
    // and used to place a second calendar entry for a quote.
    oppReviewDeadline: 'Review_Deadline__c',

    // ---- Field Squared integration ----
    // External ID field on Opportunity - Text(50), External ID, Unique.
    // Create in SF Setup → Object Manager → Opportunity → Fields & Relationships.
    oppFsTaskId: 'FS_Task_Id__c',
    // NOTE: the old 'WO_Number__c' field was removed from the org in the 2026
    // restructure (replaced by Job__c "Job #" / Awarded_Quote__c). It was never
    // queried by the FS matching code, so it stayed dropped there - but
    // purchaseOrders.js DOES read it now (below), as the "Job/WO#" tag stamped
    // onto QBO Purchase Orders.
    // Raw FS task status + its LastUpdated timestamp, written ONLY by the FS
    // sync path (fsSync.js + the manual fs-link endpoint) - never by the
    // dispatch-status write path. Read-only snapshot for the drift badge.
    // Create in SF: FS_Status__c (Text), FS_Last_Modified__c (DateTime).
    oppFsStatus: 'FS_Status__c',
    oppFsLastModified: 'FS_Last_Modified__c',

    // ---- QBO purchasing integration (purchaseOrders.js) ----
    // "Job #" - real text field, already populated org-wide (e.g. "WO 31034",
    // "0108-CKX-010"). Stamped into the PO's "Job/WO#" custom field.
    oppJobNumber: 'Job__c',
    // This app's own crosswalk memory, NOT populated by SF or QBO on their own -
    // written back the first time purchaseOrders.js resolves or creates a QBO
    // "Project" (a Job:true sub-Customer) for this Opportunity, so every later
    // PO against the same job reuses it instead of re-matching or duplicating.
    // Create in SF: QBO_Project_Id__c (Text, 18).
    oppQboProjectId: 'QBO_Project_Id__c',

    // ---- Expense Tracking (jobCost.js) ----
    // Text field, NOT a real Quote lookup (confirmed live 2026-08-26) - values
    // like "1877-GRU000-0009Q" reference something outside Salesforce
    // entirely most of the time (80% of a real sample had zero Quote records
    // at all for that Opportunity). Where a real Quote does exist, its first
    // two dash-separated segments reliably match the start of the real
    // Quote.Name - jobCost.js's resolveQuote() does that prefix match, never
    // a direct lookup.
    oppAwardedQuote: 'Awarded_Quote__c',
  },

  // ---- Job_Assignment__c ----
  objects: {
    assignment: 'Job_Assignment__c',
    assignmentChildRelationship: 'Job_Assignments__r',
    assignmentOppLookup: 'Opportunity__c',
    assignmentTechLookup: 'Technician__c',
    assignmentTechRelationship: 'Technician__r',
    assignmentDate: 'Work_Date__c',
    assignmentStartTime: 'Start_Time__c',
    assignmentEndTime: 'End_Time__c',
    assignmentCompleted: 'Completed__c',
    // Set true by createAssignment() only for the TIME_OFF_OPPORTUNITY_ID
    // sentinel - this, not the sentinel Opportunity Id, is how the tech app
    // identifies a time-off assignment.
    assignmentTimeOff: 'Time_Off__c',

    technician: 'Technician__c',
    technicianActive: 'Active__c',
    // FS user ObjectId for this tech, or blank if not synced to Field Squared.
    // Text(50) on Technician__c - create in SF Setup before deploying. The
    // FS↔SF tech mapping used to be a hardcoded object here (fsTechUsers); it's
    // now read live from Salesforce via getTechDirectory() in assignments.js
    // so "Add Tech" in the board UI works without a code deploy.
    technicianFsUserId: 'FS_User_Id__c',
    // Hand-picked hex color (e.g. "#2563EB") shown on the /tv warehouse
    // calendar. Text(7) on Technician__c - create in SF Setup before
    // deploying. Optional: a tech with no color set falls back to the /tv
    // page's own deterministic hash-based color (see TvBoard.jsx).
    technicianColor: 'Color__c',
    // Plaintext chalkboard login password (office-set / tech-changed). Blank =>
    // the tech uses DEFAULT_TECH_PASSWORD until they set one. Restrict FLS to
    // office/admin profiles in SF.
    technicianPassword: 'Password__c',
  },

  // ---- Schedule_Request__c (chalkboard tech <-> office negotiation) ----
  scheduleRequest: {
    sobject: 'Schedule_Request__c',
    job: 'Job__c',                        // lookup -> Opportunity
    jobRelationship: 'Job__r',
    type: 'Type__c',                      // picklist: Job | Time off
    tech: 'Technician__c',
    techRelationship: 'Technician__r',
    requestedBy: 'Requested_By__c',
    requestedByRelationship: 'Requested_By__r',
    proposedDate: 'Proposed_Date__c',
    proposedStart: 'Proposed_Start__c',
    proposedEnd: 'Proposed_End__c',
    status: 'Status__c',
    lastOfferBy: 'Last_Offer_By__c',      // picklist: Tech | Office
    note: 'Note__c',                      // technician's note
    officeNote: 'Office_Note__c',         // office's counter/deny reason
    resolvedAt: 'Resolved_At__c',
    resultingAssignment: 'Resulting_Assignment__c',
  },

  // ---- Dispatch_Note__c (shared team notes, optionally linked to a job) ----
  dispatchNote: {
    sobject: 'Dispatch_Note__c',
    body: 'Body__c',
    opportunity: 'Opportunity__c',             // lookup -> Opportunity
    opportunityRelationship: 'Opportunity__r',
    // Mirrors whether `opportunity` is set - driven entirely by the picker in
    // the UI (see NoteEditModal in App.jsx), never toggled independently.
    opportunitySpecific: 'Opportunity_Specific__c',
  },

  // ---- Account (the building/property Accounts tab reads/writes) ----
  account: {
    sobject: 'Account',
    lid: 'LID__c',
    type: 'Type',
    industry: 'Industry',
    phone: 'Phone',
    website: 'Website',
    // Billing* is the actual site/street address in this org (labeled just
    // "Street"/"City"/etc. in Setup) - Shipping* is labeled "Mailing Street"
    // and holds a c/o-style mailing address, not the building's address.
    street: 'BillingStreet',
    city: 'BillingCity',
    state: 'BillingState',
    zip: 'BillingPostalCode',
    propertyContact: 'Property_Contact_Name__c',  // lookup -> Contact
    apContact: 'Accounts_Payable_Contact_Name__c', // lookup -> Contact, AP contact on management/Customer accounts
    apContactLid: 'AP_Contact__c',                 // lookup -> Contact, AP contact on LID/property accounts (was AR_Contact__c)
    parent: 'ParentId',                           // self-lookup, management company
    // Installed-system manufacturer info, read through Opportunity.Account.* and
    // surfaced on quote cards (see shapeQuote / QuotesTab "System Info" modal).
    // Fire Alarm and Intrusion have no literal "*_Manufacturer__c" field on
    // Account -- they map to the Fire System / Security System manufacturers.
    fireAlarmMfr: 'Fire_System_Manufacturer__c',
    accessControlMfr: 'Access_Control_Manufacturer__c',
    cctvMfr: 'CCTV_Manufacturer__c',
    intrusionMfr: 'Security_System_Manufacturer__c',
  },

  // ---- Quotes tab (Opportunities in the pre-scheduling quoting stage) ----
  // The three views filter each Opp's RESOLVED status field (statusFieldForType)
  // by these VALUES -- uniform across record types now that Project_Status__c,
  // Inspection_Status__c, Monitoring_Status__c and Service_Status__c all carry
  // them. Reads use status only; writes co-write StageName too (see stageByStatus).
  quotes: {
    status: 'Needs Quote',              // default "Needs Quote" view
    reviewStatus: 'Ready for Review',   // "Review" view (status-field spelling: lowercase 'for')
    sentStatus: 'Pending Customer Approval', // "Sent" view (still also requires Sent_To_Customer__c)
    // On a quote status change, co-write StageName to keep the SF sales pipeline
    // in sync. NOTE the casing differs: the status field says "Ready for Review",
    // StageName says "Ready For Review".
    stageByStatus: {
      'Needs Quote': 'Proposal/Price Quote',
      'Ready for Review': 'Ready For Review',
      'Pending Customer Approval': 'Negotiation/Review',
    },
    // Record types whose StageName must NOT be touched on a quote transition --
    // Service Call lives in an Open Service/* stage that never changes.
    stageWriteSkipTypes: ['Service_Call'],
  },

  // ---- Invoicing__c (invoice records tied to a Job/Opportunity) ----
  invoicing: {
    sobject: 'Invoicing__c',
    job: 'Job__c',            // lookup -> Opportunity
    date: 'Invouce_Date__c',  // sic - typo'd API name in this org; label is "Invoice Date"
    amount: 'Invoice_Amount__c',
    status: 'Invoice_Status__c',           // picklist: Unpaid | Paid | Partial Payment Received | Voided
    totalInvoice: 'Total_Invoice__c',
    nextExpectedPayment: 'Next_Expected_Payment_Date__c',
    arAccount: 'AR_Account__c',
    arNumber: 'AR_Number__c',
    percentOfProject: 'Percent_of_Project__c',
    billingType: 'Billing_Type__c',
    // Cash-received tracking, used by the billing reconciliation (routes.js
    // /finance/reconciliation). paymentReceived is a single cumulative amount per
    // record with one paymentReceivedDate - multi-installment partials aren't fully
    // modeled here (see the reconciliation route's SF-received caveat).
    paymentReceived: 'Payment_Amount_Received__c',
    paymentReceivedDate: 'Payment_Received_Date__c',
    paymentMethod: 'Payment_Method__c',    // picklist: Check | ACH | Credit Card
    qboId: 'QBO_Id__c',        // QBO's own Invoice.Id (external id, unique) - see routes.js /finance/qbo-id-backfill
    // Create Invoice's own crosswalk memory (invoices.js), NOT populated by SF
    // or QBO on their own - stamped with the real CustomerRef.value every time
    // an invoice is created here, same "capture as byproduct" pattern as
    // Opportunity.QBO_Project_Id__c. Deliberately NOT an Account-level field -
    // confirmed live 2026-08-25 a single Account often spans many different
    // real paying customers (property/building Accounts with rotating
    // tenants), so history is read per-Account as a ranked frequency
    // suggestion, never a single assumed-correct value. Create in SF:
    // QBO_Customer_Id__c (Text, 18).
    qboCustomerId: 'QBO_Customer_Id__c',
  },

  // ---- Available_Inventory__c (current parts stock at a location). A
  // "location" is an Opportunity lookup - either a real job Opportunity, or
  // the single sentinel "Service Stock" Opportunity (its Id lives in the env
  // var SERVICE_STOCK_OPPORTUNITY_ID, same convention as
  // TIME_OFF_OPPORTUNITY_ID/NEW_WO_OPPORTUNITY_ID). Service Stock is kept off
  // the dispatch board by giving it a Project_Status__c value outside
  // jobStatusValues ("AR Approval", matching TIME_OFF_OPPORTUNITY_ID) - no
  // extra exclusion logic needed anywhere. One row per Opportunity+Product
  // pair - Add Inventory upserts into it, Part Checkout decrements it.
  inventory: {
    sobject: 'Available_Inventory__c',
    opportunity: 'Opportunity__c',
    opportunityRelationship: 'Opportunity__r',
    product: 'Product__c',                      // lookup -> standard Product2
    productRelationship: 'Product__r',
    quantity: 'Quantity__c',                    // allowed to go negative, see parts.js adjustInventory()
    price: 'Price__c',                          // mirrored from PricebookEntry.UnitPrice on every Add Inventory write - not a formula field, Product2 has no price field of its own
    poNumber: 'PO_Number__c',
    poUploaded: 'PO_Uploaded__c',
  },

  // ---- Part_Checkout__c (append-only log of a checkout event - one row per
  // part per checkout submission, never updated after creation).
  // Material_Req_Attached__c is required-in-the-UI only - deliberately no SF
  // validation rule or Flow enforces it, same no-Flow convention as the rest
  // of this feature.
  checkout: {
    sobject: 'Part_Checkout__c',
    opportunity: 'Opportunity__c',
    opportunityRelationship: 'Opportunity__r',
    checkedOutBy: 'Checked_Out_By__c',           // lookup -> Technician__c, active-only filtered in UI
    checkedOutByRelationship: 'Checked_Out_By__r',
    checkoutDate: 'Checkout_Date__c',            // defaults to today in UI, editable
    truckNumber: 'Truck_Number__c',              // required (live validation rule confirms it, matches UI)
    materialRequestNumber: 'Material_Request_Number__c',
    materialReqAttached: 'Material_Req_Attached__c',
    product: 'Product__c',
    productRelationship: 'Product__r',
    quantity: 'Quantity__c',
    flaggedForReview: 'Flag_For_Review__c',      // NOT required - confirmed live API name (no "ged")
    inventory: 'Inventory__c',                   // lookup -> Available_Inventory__c, the row this checkout decremented
    inventoryRelationship: 'Inventory__r',
  },

  // ---- Product2 (standard parts catalog - confirmed live in this org: real,
  // populated, already the catalog QuoteLineItem.Product2Id points to for
  // quoting). Product2 has no price field itself - Price__c on
  // Available_Inventory__c is sourced from PricebookEntry.UnitPrice on the
  // Standard Price Book instead (see parts.js's catalog query, which joins
  // the two client-side).
  product: {
    sobject: 'Product2',
    name: 'Name',
    code: 'ProductCode',
    description: 'Description',
    family: 'Family',
    vendor: 'Vendor__c',
    brand: 'Brand__c',
    category: 'Product_Category__c',
    subCategory: 'Product_SubCategory__c',
  },

  // ---- QuickBooks Online purchasing (purchaseOrders.js) ----
  // Org-specific QBO ids/values live here, same convention as everything
  // above being SF-specific config. `poCustomFields` are the two
  // PurchaseOrder.CustomField DefinitionIds this company file already has
  // provisioned for "LID #" / "Job/WO#" (confirmed live, 2026-08-21) - a free
  // secondary tag stamped alongside the real mechanism, which is the per-line
  // CustomerRef pointing at a QBO "Project" (a Job:true sub-Customer).
  qbo: {
    poCustomFields: {
      lid: { definitionId: '2', name: 'LID #' },
      jobWo: { definitionId: '3', name: 'Job/WO#' },
    },
    // Invoice's own CustomField DefinitionIds -- confirmed live 2026-08-25
    // these are a SEPARATE numbering from PurchaseOrder's (definitionId '3'
    // here vs. '2' for a PO's "LID #", each transaction type has its own
    // DefinitionId space in this company file). Real invoices also carry an
    // unused "P.O. Number" CustomField slot (DefinitionId '1') - not stamped
    // by this app.
    invoiceCustomFields: {
      lid: { definitionId: '3', name: 'LID #' },
    },
    // Default expense account for a PO line. QBO's Item catalog here is
    // category-level (Labor/Parts/Fire Alarm/T&I/...), not per-SKU, and
    // confirmed live 2026-08-21: this company's Items aren't mapped to an
    // account, so an ItemBasedExpenseLineDetail line gets rejected
    // ("Select an account for this transaction"). AccountBasedExpenseLineDetail
    // with an explicit AccountRef works, and matches how real historical
    // vendor Bills are actually built here - "Materials" (Cost of Goods Sold)
    // is by far the most common account on real Bill lines (439 of ~1,500
    // sampled, next closest 124), so it's the sensible default. The real
    // part identity goes in the line Description either way.
    defaultExpenseAccountName: 'Materials',
    // Real QBO Term.Id for "Due on receipt" -- confirmed live 2026-08-27
    // against this company file's actual Term list (Id '34', Name
    // "Due on receipt", Active). Per direction: every invoice this app
    // creates is service work, always due on receipt, never whatever the
    // customer's own default term happens to be (which QBO otherwise falls
    // back to silently when SalesTermRef is left unset).
    dueOnReceiptTermId: '34',
  },

  // ---- Office/dispatch users (standard Salesforce User object) ----
  // Auth + tracking identity for the dispatch app. Password__c / Dispatch_Access__c
  // / Dispatch_Admin__c are custom fields on User (NOT the real SF login
  // password). Restrict Password__c FLS to admins.
  officeUser: {
    sobject: 'User',
    name: 'Name',
    email: 'Email',
    active: 'IsActive',
    password: 'Password__c',      // app-only login password (plaintext by design)
    access: 'Dispatch_Access__c',  // checkbox: may log into the dispatch app
    admin: 'Dispatch_Admin__c',    // checkbox: Admin role (else regular User)
  },
};

// ---- Record-type status resolvers (single source of truth) ----
// Which SF field holds the board/lifecycle status for a given Opportunity
// record type. `devName` is RecordType.DeveloperName (null/undefined for the
// ~47k legacy Opps with no record type -> Project_Status__c).
export function statusFieldForType(devName) {
  const rt = config.recordTypeStatus;
  return rt.fieldByType[devName] || rt.fallbackField;
}

// The set of every distinct status field across all record types - used to
// build the SOQL SELECT so shapeJob can resolve the right one per row.
export function allStatusFields() {
  const rt = config.recordTypeStatus;
  return [...new Set([rt.fallbackField, ...Object.values(rt.fieldByType)])];
}

// Dropdown values a dispatcher may set for a given record type.
export function statusValuesForType(devName) {
  return config.recordTypeStatus.valuesByType[devName] || config.jobStatusValues;
}

// True if this record type should never appear on the dispatch board.
export function isBoardExcludedType(devName) {
  return config.recordTypeStatus.boardExcludedTypes.includes(devName);
}

// For a quote status transition, the StageName to co-write alongside the status
// field (keeps the SF sales pipeline in sync) -- or null when `statusValue`
// isn't a quote-lifecycle value, or this record type's stage must not change
// (e.g. Service Call, which stays in its Open Service/* stage).
export function stageForQuoteStatus(devName, statusValue) {
  if (config.quotes.stageWriteSkipTypes.includes(devName)) return null;
  return config.quotes.stageByStatus[statusValue] || null;
}