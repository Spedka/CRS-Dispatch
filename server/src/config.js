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
    'Installation Complete',
    'Waiting on Payment',
  ],

  // ---- Opportunity (the job) field API names ----
  fields: {
    oppName: 'Name',
    oppStatus: 'Project_Status__c',
    oppScheduledDate: 'Scheduled_Project_Start_Date__c',
    oppLid: 'LID__c',
    addrStreet: 'Account.ShippingStreet',
    addrCity: 'Account.ShippingCity',
    oppType: 'Opportunity_Type__c',

    // ---- Field Squared integration ----
    // External ID field on Opportunity — Text(50), External ID, Unique.
    // Create in SF Setup → Object Manager → Opportunity → Fields & Relationships.
    oppFsTaskId: 'FS_Task_Id__c',
    // WO number field — used as tertiary match fallback.
    oppWoNumber: 'WO_Number__c',
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
};