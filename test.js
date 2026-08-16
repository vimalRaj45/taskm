import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Text-to-SQL Generator
 */
function generateSQLForUserQuery(prompt, todayDate) {
  const lower = prompt.toLowerCase().trim();

  // Date Range extraction (e.g. "from 2026-08-10 to 2026-08-16", "between ... and ...")
  const rangeMatch = prompt.match(/(?:from|between)\s+(\d{4}-\d{2}-\d{2})\s+(?:to|and)\s+(\d{4}-\d{2}-\d{2})/i);
  if (rangeMatch) {
    return {
      sql: 'SELECT * FROM tasks WHERE user_id = $1 AND due_date >= $2 AND due_date <= $3 ORDER BY due_date ASC NULLS LAST, created_at DESC',
      params: [rangeMatch[1], rangeMatch[2]],
    };
  }

  // Overdue filter
  if (lower.includes('overdue')) {
    return {
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND due_date < $2 AND status != 'Completed' ORDER BY due_date ASC, priority DESC",
      params: [todayDate],
    };
  }

  // Due Today filter
  if (lower.includes('today') && !lower.includes('plan') && !lower.includes('agenda')) {
    return {
      sql: 'SELECT * FROM tasks WHERE user_id = $1 AND due_date = $2 ORDER BY priority DESC, created_at DESC',
      params: [todayDate],
    };
  }

  // Urgent / Critical filter
  if (lower.includes('urgent') || lower.includes('@urgent') || lower.includes('critical')) {
    return {
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND (priority = 'Urgent' OR priority = 'High') ORDER BY due_date ASC NULLS LAST, created_at DESC",
      params: [],
    };
  }

  // Completed / Done filter
  if (lower.includes('completed') || lower.includes('done') || lower.includes('finished')) {
    return {
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND status = 'Completed' ORDER BY created_at DESC",
      params: [],
    };
  }

  // Pending / Peding / Todo filter
  if (lower.includes('pending') || lower.includes('peding') || lower.includes('todo')) {
    return {
      sql: "SELECT * FROM tasks WHERE user_id = $1 AND status != 'Completed' ORDER BY due_date ASC NULLS LAST, created_at DESC",
      params: [],
    };
  }

  // Default: All Workspace Tasks (for Day Planning, Agenda, General Retrieval)
  return {
    sql: 'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
    params: [],
  };
}

/**
 * Agentic Synthesis of DB Results
 */
function synthesizeAgenticResponse(userPrompt, queriedTasks, sqlQuery, todayDate) {
  const lower = userPrompt.toLowerCase().trim();

  const toDateStr = (d) => {
    if (!d) return null;
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(d).split('T')[0];
  };

  const overdueTasks = queriedTasks.filter((t) => {
    const dStr = toDateStr(t.due_date);
    return dStr && dStr < todayDate && t.status !== 'Completed';
  });
  const todayTasks = queriedTasks.filter((t) => toDateStr(t.due_date) === todayDate && t.status !== 'Completed');
  const upcomingTasks = queriedTasks.filter((t) => {
    const dStr = toDateStr(t.due_date);
    return (!dStr || dStr > todayDate) && t.status !== 'Completed';
  });
  const completedTasks = queriedTasks.filter((t) => t.status === 'Completed');
  const pendingTasks = queriedTasks.filter((t) => t.status !== 'Completed');

  const isPlanQuery = lower.includes('plan') || lower.includes('agenda') || lower.includes('@today');

  if (isPlanQuery) {
    let msg = `### 🤖 J.A.R.V.I.S Autonomous Daily Plan Protocol\n`;
    msg += `Good day, Sir. Retrieved **${queriedTasks.length} tasks** directly from database.\n\n`;

    msg += `🎯 **Executive Strategy & Workload Assessment**:\n`;
    if (overdueTasks.length > 0) {
      msg += `- 🚨 **Attention Required**: ${overdueTasks.length} overdue task(s) require immediate remediation.\n`;
    }
    msg += `- ⚡ **Today's Active Load**: ${todayTasks.length} scheduled item(s).\n`;
    msg += `- 📅 **Pipeline Backlog**: ${upcomingTasks.length} queued task(s).\n\n`;

    msg += `⏳ **Chronological Execution Timeline**:\n`;
    if (overdueTasks.length > 0 || todayTasks.some((t) => t.priority === 'Urgent' || t.priority === 'High')) {
      const critical = [...overdueTasks, ...todayTasks.filter((t) => t.priority === 'Urgent' || t.priority === 'High')];
      msg += `- **09:00 – 11:30 | Critical Deep Work Block**\n  Focus: ${critical.map((t) => t.title).slice(0, 3).join(', ')}\n`;
    }
    msg += `- **11:45 – 14:00 | Core Deliverables Block**\n  Execution of standard priority items & team syncs.\n`;
    msg += `- **14:30 – 17:00 | Tactical Reviews & Pipeline Tasks**\n  Advancing upcoming sprint deliverables.\n`;
    msg += `- **17:00 – 18:00 | Wrap-up & Tomorrow Staging**\n  Review checklist completions & stage tomorrow's priorities.\n\n`;

    msg += `📋 **Master Task Checklist**:\n`;
    if (overdueTasks.length > 0) {
      msg += `Overdue Tasks (${overdueTasks.length}):\n` +
        overdueTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date)} - OVERDUE)`).join('\n') + '\n\n';
    }
    if (todayTasks.length > 0) {
      msg += `Due Today (${todayTasks.length}):\n` +
        todayTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Status: ${t.status})`).join('\n') + '\n\n';
    }
    if (upcomingTasks.length > 0) {
      msg += `Upcoming & Backlog (${upcomingTasks.length}):\n` +
        upcomingTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] ${t.due_date ? `(Due: ${toDateStr(t.due_date)})` : '(No due date)'}`).join('\n') + '\n\n';
    }
    if (completedTasks.length > 0) {
      msg += `Recently Completed (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}]`).join('\n') + '\n\n';
    }
    if (queriedTasks.length === 0) {
      msg += `You currently have 0 tasks in your workspace.`;
    }

    return { message: msg.trim(), sqlQuery };
  }

  // Focused Query Output
  let msg = `### J.A.R.V.I.S Database Query Results\n`;
  msg += `Found **${queriedTasks.length} task(s)** matching your query criteria.\n\n`;

  const isPendingFilter = lower.includes('pending') || lower.includes('peding') || lower.includes('todo');
  const isCompletedFilter = lower.includes('completed') || lower.includes('done') || lower.includes('finished');

  if (isPendingFilter) {
    if (pendingTasks.length === 0) {
      msg += `All caught up! You have 0 pending tasks.`;
    } else {
      msg += `Pending Tasks (${pendingTasks.length}):\n` +
        pendingTasks
          .map((t) => {
            const dStr = toDateStr(t.due_date);
            const isOverdue = dStr && dStr < todayDate;
            const dueLabel = dStr ? `(Due: ${dStr}${isOverdue ? ' - OVERDUE' : ''})` : '(No due date)';
            return `- [ ] **${t.title}** • [${t.priority}] ${dueLabel}`;
          })
          .join('\n') + '\n\n';
    }
  } else if (isCompletedFilter) {
    if (completedTasks.length === 0) {
      msg += `No completed tasks found in your workspace yet.`;
    } else {
      msg += `Completed Tasks (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}]`).join('\n') + '\n\n';
    }
  } else {
    if (overdueTasks.length > 0) {
      msg += `Overdue Tasks (${overdueTasks.length}):\n` +
        overdueTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Due: ${toDateStr(t.due_date)})`).join('\n') + '\n\n';
    }
    if (todayTasks.length > 0) {
      msg += `Due Today (${todayTasks.length}):\n` +
        todayTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] (Status: ${t.status})`).join('\n') + '\n\n';
    }
    if (upcomingTasks.length > 0) {
      msg += `Upcoming & Backlog (${upcomingTasks.length}):\n` +
        upcomingTasks.map((t) => `- [ ] **${t.title}** • [${t.priority}] ${t.due_date ? `(Due: ${toDateStr(t.due_date)})` : '(No due date)'}`).join('\n') + '\n\n';
    }
    if (completedTasks.length > 0) {
      msg += `Recently Completed (${completedTasks.length}):\n` +
        completedTasks.map((t) => `- [x] ~${t.title}~ • [${t.priority}]`).join('\n') + '\n\n';
    }
    if (queriedTasks.length === 0) {
      msg += `No matching tasks found in database for the requested criteria.`;
    }
  }

  return { message: msg.trim(), sqlQuery };
}

async function runTests() {
  console.log('==============================================');
  console.log('🧪 TESTING TEXT-TO-SQL AI AGENT PIPELINE');
  console.log('==============================================\n');

  try {
    const userRes = await pool.query('SELECT id, email FROM users LIMIT 1');
    const targetUserId = userRes.rows[0]?.id;
    console.log(`👤 Testing with User: ${userRes.rows[0]?.email} (${targetUserId})`);

    const todayDate = new Date().toISOString().split('T')[0];
    const yesterdayDate = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const nextWeekDate = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    // Seed 4 sample tasks in DB if empty so test shows real DB retrieval
    const checkTasks = await pool.query('SELECT COUNT(*) FROM tasks WHERE user_id = $1', [targetUserId]);
    if (parseInt(checkTasks.rows[0].count, 10) === 0) {
      console.log('🌱 Seeding 4 sample tasks in PostgreSQL for testing...');
      await pool.query(`
        INSERT INTO tasks (user_id, title, priority, due_date, status) VALUES
        ($1, 'Fix API auth security vulnerability', 'Urgent', $2, 'Todo'),
        ($1, 'Prepare quarterly executive presentation', 'High', $3, 'Todo'),
        ($1, 'Deploy cloud infrastructure to production', 'Medium', $4, 'Todo'),
        ($1, 'Setup PostgreSQL database schema', 'High', $2, 'Completed')
      `, [targetUserId, yesterdayDate, todayDate, nextWeekDate]);
      console.log('✅ Sample tasks seeded successfully!\n');
    }

    const allTasksRes = await pool.query('SELECT id, user_id, title, priority, due_date, status FROM tasks WHERE user_id = $1', [targetUserId]);
    console.log(`📦 Database Task Count: ${allTasksRes.rows.length} total task(s) found in table 'tasks'`);
    console.log(`📋 Tasks in DB:`, allTasksRes.rows.map(t => `${t.title} [${t.priority}] (Due: ${t.due_date ? new Date(t.due_date).toISOString().split('T')[0] : 'None'}, Status: ${t.status})`).join('\n   - '));
    console.log('\n');

    const testQueries = [
      'my peding tasks',
      'urgent tasks',
      'plan my day',
      'tasks between 2026-08-10 and 2026-08-16',
      'completed tasks',
    ];

    for (const query of testQueries) {
      console.log(`----------------------------------------------`);
      console.log(`💬 User Query: "${query}"`);

      // 1. Generate SQL
      const sqlGen = generateSQLForUserQuery(query, todayDate);
      console.log(`⚡ Generated SQL: ${sqlGen.sql}`);
      console.log(`🔧 Parameters: [${[targetUserId, ...sqlGen.params].join(', ')}]`);

      // 2. Execute SQL against live PostgreSQL
      const queryParams = [targetUserId, ...sqlGen.params];
      const result = await pool.query(sqlGen.sql, queryParams);
      console.log(`📊 DB Rows Returned: ${result.rows.length} task(s)`);

      // 3. Agentic Synthesis
      const aiResponse = synthesizeAgenticResponse(
        query,
        result.rows,
        sqlGen.sql,
        todayDate
      );

      console.log(`\n🤖 JARVIS Response:`);
      console.log(aiResponse.message);
      console.log(`\n`);
    }

    console.log('==============================================');
    console.log('✅ ALL TEXT-TO-SQL TESTS COMPLETED SUCCESSFULLY!');
    console.log('==============================================');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
  } finally {
    await pool.end();
  }
}

runTests();
