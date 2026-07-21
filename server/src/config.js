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
    'Pending Customer Approval',
    'Quoted',
    'Parts Ordered',
    'Ready to be scheduled',
    'Scheduled',
    'In Progress',
    'Installation Completed',
    'Waiting on Payment',
  ],

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

    // ---- Field Squared integration ----
    // External ID field on Opportunity — Text(50), External ID, Unique.
    // Create in SF Setup → Object Manager → Opportunity → Fields & Relationships.
    oppFsTaskId: 'FS_Task_Id__c',
    // WO number field — used as tertiary match fallback.
    oppWoNumber: 'WO_Number__c',
    // Raw FS task status + its LastUpdated timestamp, written ONLY by the FS
    // sync path (fsSync.js + the manual fs-link endpoint) — never by the
    // dispatch-status write path. Read-only snapshot for the drift badge.
    // Create in SF: FS_Status__c (Text), FS_Last_Modified__c (DateTime).
    oppFsStatus: 'FS_Status__c',
    oppFsLastModified: 'FS_Last_Modified__c',
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
    // sentinel — this, not the sentinel Opportunity Id, is how the tech app
    // identifies a time-off assignment.
    assignmentTimeOff: 'Time_Off__c',

    technician: 'Technician__c',
    technicianActive: 'Active__c',
    // FS user ObjectId for this tech, or blank if not synced to Field Squared.
    // Text(50) on Technician__c — create in SF Setup before deploying. The
    // FS↔SF tech mapping used to be a hardcoded object here (fsTechUsers); it's
    // now read live from Salesforce via getTechDirectory() in assignments.js
    // so "Add Tech" in the board UI works without a code deploy.
    technicianFsUserId: 'FS_User_Id__c',
    // Hand-picked hex color (e.g. "#2563EB") shown on the /tv warehouse
    // calendar. Text(7) on Technician__c — create in SF Setup before
    // deploying. Optional: a tech with no color set falls back to the /tv
    // page's own deterministic hash-based color (see TvBoard.jsx).
    technicianColor: 'Color__c',
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
    // Mirrors whether `opportunity` is set — driven entirely by the picker in
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
    // "Street"/"City"/etc. in Setup) — Shipping* is labeled "Mailing Street"
    // and holds a c/o-style mailing address, not the building's address.
    street: 'BillingStreet',
    city: 'BillingCity',
    state: 'BillingState',
    zip: 'BillingPostalCode',
    propertyContact: 'Property_Contact_Name__c',  // lookup -> Contact
    parent: 'ParentId',                           // self-lookup, management company
  },
};