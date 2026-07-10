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

  // FS user ObjectId → SF technician name.
  // Excludes Account Services (FL9_cUxsT0OmJLSNE9070w) and Paul Aldridge
  // (1bxTwRMv2dt6hpNYrZMI-QAA-Q) — not field techs, not synced.
  fsTechUsers: {
    'Vy7n4YPQsEa-pjadx4BAGA':     'Pedro Ortiz',
    'GemUv2xBrz3B9r8zIaKTJAAAJA': 'Mike Ellenburg',
    'ICA8ug9SUEGTj5jtgOA-ew':     'Perry Floyd',
    'JnO4ynVJ-EuO73og_pdGFw':     'Joseph Wyatt',
    '7b1I9-cJ4UK0slqoKZIPGQ':     'Jay Ebeling',
    'lGUm5YLzTEmfuY6mNZ2R2QAA2Q': 'Mason Ebeling',
    'EhHzICfmtUG6YTGPt1Y5wQ':     'Gabor Fogorasi',
    'F68pM1uEZ0is351UcbPrVg':     'Casey Berrier',
    'fGIGr86tOft4m2VPMlGTZQAAZQ': 'Skip Cashion',
    'UnYYVeGKq-9AeErKQAIl6AAA6A': 'Adrian Van Luven',
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
    assignmentCompleted: 'Completed__c',

    technician: 'Technician__c',
    technicianActive: 'Active__c',
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
};