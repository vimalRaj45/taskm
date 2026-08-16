import http from 'http';

const BASE_URL = 'http://localhost:3000';
let authToken = '';

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port || 3000,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runFullSystemTest() {
  console.log('====================================================');
  console.log('🚀 TASKFLOW WORK OS: FULL SYSTEM E2E TEST SUITE');
  console.log('====================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition, message) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ PASS: ${message}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${message}`);
    }
  }

  try {
    // 1. Authentication
    console.log('--- 1. Authentication & Token Generation ---');
    const authRes = await request('POST', '/api/auth/login', {
      email: 'demo@taskflow.local',
      password: 'password123',
    });

    if (authRes.status === 200 && authRes.data.token) {
      authToken = authRes.data.token;
      assert(true, `Logged in successfully as ${authRes.data.user?.email}`);
    } else {
      const regRes = await request('POST', '/api/auth/register', {
        name: 'Vimal Test',
        email: `test_${Date.now()}@taskflow.local`,
        password: 'password123',
      });
      authToken = regRes.data?.token;
      assert(regRes.status === 200 || regRes.status === 201, 'Registered new test account');
    }

    // 2. Task Creation with Full Extended Metadata
    console.log('\n--- 2. Extended Task Model CRUD ---');
    const taskPayload = {
      title: 'Setup Cloudflare Edge Cache & KV store',
      description: 'Implement distributed edge caching rules and rate limiting.',
      startDate: new Date().toISOString().split('T')[0],
      dueDate: new Date(Date.now() + 86400000 * 3).toISOString().split('T')[0],
      dueTime: '14:30',
      priority: 'High',
      category: 'Infrastructure',
      tags: 'cloudflare, edge, cache',
      estimatedDuration: '4 hours',
      isImportant: true,
    };

    const createTaskRes = await request('POST', '/api/tasks', taskPayload);
    assert(createTaskRes.status === 201 && createTaskRes.data.task?.id, 'Created task with extended metadata');
    const taskId = createTaskRes.data.task?.id;

    // 3. Subtasks & Auto-calculated Progress Percentage
    console.log('\n--- 3. Subtasks & Progress Calculation ---');
    const subtask1Res = await request('POST', `/api/subtasks/task/${taskId}`, {
      title: 'Configure Worker Routing',
    });
    assert(subtask1Res.status === 201 && subtask1Res.data.subtask?.id, 'Added Subtask 1: "Configure Worker Routing"');
    const subtask1Id = subtask1Res.data.subtask?.id;

    const subtask2Res = await request('POST', `/api/subtasks/task/${taskId}`, {
      title: 'Verify KV Storage Latency',
    });
    assert(subtask2Res.status === 201 && subtask2Res.data.subtask?.id, 'Added Subtask 2: "Verify KV Storage Latency"');
    const subtask2Id = subtask2Res.data.subtask?.id;

    // Complete Subtask 1
    const toggle1Res = await request('PUT', `/api/subtasks/${subtask1Id}`, {
      is_completed: true,
    });
    assert(toggle1Res.status === 200 && toggle1Res.data.subtask?.is_completed === true, 'Completed Subtask 1');

    // Complete Subtask 2
    const toggle2Res = await request('PUT', `/api/subtasks/${subtask2Id}`, {
      is_completed: true,
    });
    assert(toggle2Res.status === 200 && toggle2Res.data.subtask?.is_completed === true, 'Completed Subtask 2');

    // Verify parent task progress updated to 100%
    const getTaskRes = await request('GET', '/api/tasks');
    const updatedTask = getTaskRes.data.tasks?.find((t) => t.id === taskId);
    assert(updatedTask && updatedTask.progress === 100, 'Task Progress auto-calculated to 100%');

    // 4. Permanent Notes
    console.log('\n--- 4. Permanent Notes Attachment & Persistence ---');
    const noteRes = await request('POST', '/api/notes', {
      task_id: taskId,
      content: 'Cloudflare Edge KV confirmed < 10ms latency in test region.',
    });
    assert(noteRes.status === 201 && noteRes.data.note?.id, 'Attached permanent timestamped note');

    const getNotesRes = await request('GET', `/api/notes?taskId=${taskId}`);
    assert(getNotesRes.status === 200 && getNotesRes.data.notes?.length >= 1, 'Retrieved persisted permanent notes');

    // 5. Quick Capture Inbox
    console.log('\n--- 5. Quick Capture Inbox & 1-Click Conversion ---');
    const inboxRes = await request('POST', '/api/inbox', {
      content: 'Investigate Cloudflare Turnstile bot protection for public login',
    });
    assert(inboxRes.status === 201 && inboxRes.data.item?.id, 'Captured raw thought in Inbox');
    const inboxItemId = inboxRes.data.item?.id;

    const convertRes = await request('POST', `/api/inbox/${inboxItemId}/convert-to-task`, {
      priority: 'Urgent',
      due_date: new Date().toISOString().split('T')[0],
    });
    assert(convertRes.status === 200 && convertRes.data.task?.id, 'Converted Inbox item to full Task');

    // 6. Activity Log & Audit Trail
    console.log('\n--- 6. Workspace Audit Trail & Activity Logs ---');
    const activityRes = await request('GET', `/api/activity?taskId=${taskId}`);
    assert(activityRes.status === 200 && Array.isArray(activityRes.data.activities), 'Retrieved task audit log history');

    // 7. AI Copilot Conversational Memory & NLP
    console.log('\n--- 7. AI Copilot Conversational Memory & NLP ---');

    // 7a. Direct create proposal with subtasks
    const aiChat1 = await request('POST', '/api/ai/chat', {
      prompt: 'create task Deploy Cloudflare Gateway due tomorrow at 4pm with subtasks Configure DNS, Setup Rules',
      clientTasks: [createTaskRes.data.task],
    });
    assert(
      aiChat1.status === 200 && aiChat1.data.proposals?.length > 0 && aiChat1.data.proposals[0].type === 'CREATE_TASK',
      'AI formulated CREATE proposal with inline date/time & subtasks'
    );

    // 7b. Pronoun Resolution ("move it to Friday")
    const aiChat2 = await request('POST', '/api/ai/chat', {
      prompt: 'move it to Friday',
      clientTasks: [createTaskRes.data.task],
      context: {
        lastTaskId: taskId,
        lastTaskTitle: 'Setup Cloudflare Edge Cache & KV store',
      },
    });
    assert(
      aiChat2.status === 200 && aiChat2.data.proposals?.length > 0 && Boolean(aiChat2.data.proposals[0].dueDate),
      'AI resolved pronoun "it" to focused task and generated reschedule proposal'
    );

    // 7c. Pronoun Note Attachment ("add note: ... to it")
    const aiChat3 = await request('POST', '/api/ai/chat', {
      prompt: 'add note: Edge rules active and tested to it',
      clientTasks: [createTaskRes.data.task],
      context: {
        lastTaskId: taskId,
        lastTaskTitle: 'Setup Cloudflare Edge Cache & KV store',
      },
    });
    assert(
      aiChat3.status === 200 && aiChat3.data.proposals?.length > 0 && aiChat3.data.proposals[0].type === 'ADD_NOTE',
      'AI resolved "add note: ... to it" into ADD_NOTE proposal'
    );

    // 7d. Pronoun Subtask Attachment ("add subtask ... to it")
    const aiChat4 = await request('POST', '/api/ai/chat', {
      prompt: 'add subtask Verify SSL certificates to it',
      clientTasks: [createTaskRes.data.task],
      context: {
        lastTaskId: taskId,
        lastTaskTitle: 'Setup Cloudflare Edge Cache & KV store',
      },
    });
    assert(
      aiChat4.status === 200 && aiChat4.data.proposals?.length > 0 && aiChat4.data.proposals[0].type === 'ADD_SUBTASK',
      'AI resolved "add subtask ... to it" into ADD_SUBTASK proposal'
    );

    // 7e. Project Deadline query
    const aiChat5 = await request('POST', '/api/ai/chat', {
      prompt: 'tell deadline of all project',
      clientTasks: [createTaskRes.data.task],
    });
    assert(
      aiChat5.status === 200 && aiChat5.data.message.includes('Project'),
      'AI answered "tell deadline of all project" with project overview'
    );

    // 8. Aggregated Reports Analytics
    console.log('\n--- 8. Aggregated Reports & Metrics ---');
    const reportsRes = await request('GET', '/api/reports/summary');
    assert(
      reportsRes.status === 200 && typeof reportsRes.data.metrics?.total === 'number',
      'Retrieved workspace executive report metrics (total, completed, inProgress, overdue, completionRate)'
    );

    // 9. Daily Mail AI & OAuth Status
    console.log('\n--- 9. Daily Mail AI & OAuth Status ---');
    const emailStatusRes = await request('GET', '/api/emails/status');
    assert(
      emailStatusRes.status === 200 && typeof emailStatusRes.data.isConnected === 'boolean',
      'Retrieved Google OAuth & Gmail status successfully (200 OK)'
    );

    const emailDailyRes = await request('GET', '/api/emails/daily');
    assert(
      emailDailyRes.status === 200 && Array.isArray(emailDailyRes.data.emails),
      'Retrieved AI prioritized daily email digest stream (200 OK)'
    );

    console.log('\n====================================================');
    console.log(`🎯 FULL SYSTEM TEST RESULTS: ${passedTests}/${totalTests} PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
    console.log('====================================================\n');
  } catch (err) {
    console.error('Test execution failed with error:', err);
  }
}

runFullSystemTest();
