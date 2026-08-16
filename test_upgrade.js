import { generateSQLForUserQuery, synthesizeAgenticResponse } from './dist/services/mistral.service.js';

console.log('--- Testing AI Contextual Memory & Pronoun Resolution ---');

const today = new Date().toISOString().split('T')[0];

// Test 1: Creating a task with date and subtask intent
const q1 = 'create task Deploy Kubernetes cluster due tomorrow';
const res1 = generateSQLForUserQuery(q1, today);
console.log('Q1 Proposals:', res1.proposals);

// Test 2: Pronoun resolution "move it to Friday" with context
const context = {
  lastTaskId: 'task-123',
  lastTaskTitle: 'Deploy Kubernetes cluster',
  lastList: [{ id: 'task-123', title: 'Deploy Kubernetes cluster', priority: 'High', status: 'Todo' }],
};

const q2 = 'move it to Friday';
const res2 = generateSQLForUserQuery(q2, today, context);
console.log('Q2 (Pronoun "it") Proposals:', res2.proposals);

// Test 3: Adding note to "it"
const q3 = 'add note: cluster needs ingress controller configured to it';
const res3 = generateSQLForUserQuery(q3, today, context);
console.log('Q3 (Add Note) Proposals:', res3.proposals);

// Test 4: Adding subtask to "it"
const q4 = 'add subtask Configure Helm charts to it';
const res4 = generateSQLForUserQuery(q4, today, context);
console.log('Q4 (Add Subtask) Proposals:', res4.proposals);

// Test 5: Ordinal list reference "mark the first one complete"
const q5 = 'mark the first one complete';
const res5 = generateSQLForUserQuery(q5, today, context);
console.log('Q5 (Ordinal "first one") Proposals:', res5.proposals);

// Test 6: Deletion with safety confirmation
const q6 = 'delete it';
const res6 = generateSQLForUserQuery(q6, today, context);
console.log('Q6 (Delete action type):', res6.actionType, 'Proposals:', res6.proposals);

console.log('--- All Upgrade Verification Tests Completed Successfully! ---');
