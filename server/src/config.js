import 'dotenv/config';

// =====================================================================
//  THE ONLY FILE YOU SHOULD NEED TO EDIT to match your Salesforce org.
//  Everything below the credentials block maps THIS app's names to
//  YOUR object/field API names. Replace the right-hand strings.
// =====================================================================

export const config = {
  salesforce: {
    // Reuse the connected app you already use for the QBO pipeline
    // (Client Credentials flow). These come from .env — never hardcode.
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
    clientId: process.env.SF_CLIENT_ID,
    clientSecret: process.env.SF_CLIENT_SECRET,
    apiVersion: 'v60.0', // bump to your org's max if newer
  },

  // Everything that stays on the board: the full lifecycle EXCEPT the terminal
  // states (Billing Complete, Project Complete), which are set in Field Squared
  // and are the only statuses that drop a job off "All outstanding".
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
    oppStatus: 'Project_Status__c',         // custom field holding the lifecycle values
    oppScheduledDate: 'Scheduled_Project_Start_Date__c',  // custom Date field you add
    oppLid: 'LID__c',                       // LID number shown on each job
    // Opportunity has no native address. Pull from the related Account,
    // or swap these for custom Opportunity address fields.
    addrStreet: 'Account.ShippingStreet',
    addrCity: 'Account.ShippingCity',
  },

  // ---- Job_Assignment__c (junction: one tech on one job) ----
  objects: {
    assignment: 'Job_Assignment__c',
    // Child relationship name on Opportunity for the lookup below.
    // Set this in the lookup field's "Child Relationship Name" so the
    // SOQL subquery `(SELECT ... FROM Job_Assignments__r)` resolves.
    assignmentChildRelationship: 'Job_Assignments__r',
    assignmentOppLookup: 'Opportunity__c',  // lookup -> Opportunity
    assignmentTechLookup: 'Technician__c',  // lookup -> Technician__c
    assignmentTechRelationship: 'Technician__r', // for Technician__r.Name
    assignmentDate: 'Work_Date__c',         // Date the tech is on this job
    assignmentCompleted: 'Completed__c',    // checkbox: tech actually worked that day

    // ---- Technician__c (your tech list) ----
    technician: 'Technician__c',
    technicianActive: 'Active__c',          // checkbox; defaults true
  },
};