import { Hono } from 'hono';
import { db, ProjectRecord, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';
import {
  generateSQLForUserQuery,
  synthesizeAgenticResponse,
  generateAIChatResponse,
  ProposalItem,
} from '../services/mistral.service.js';

const ai = new Hono<HonoEnv>();

ai.use('*', authMiddleware);

// POST /api/ai/chat (Text-to-SQL + Agentic AI Execution)
ai.post('/chat', async (c) => {
  try {
    const user = c.get('user') as JwtPayload;
    const { prompt, clientTasks } = await c.req.json();

    if (!prompt) {
      return c.json({ error: 'Prompt is required' }, 400);
    }

    const todayDate = new Date().toISOString().split('T')[0];

    // 1. Text-to-SQL Generation
    const sqlGen = generateSQLForUserQuery(prompt, todayDate);

    // 2. Direct PostgreSQL Execution
    const queryParams = [user.userId, ...sqlGen.params];
    const tasksRes = await db.query<TaskRecord>(sqlGen.sql, queryParams);

    console.log('\n==============================================');
    console.log('🤖 JARVIS AI /api/ai/chat REQUEST RECEIVED');
    console.log('👤 User:', user.email, `(${user.userId})`);
    console.log('💬 Prompt:', prompt);
    console.log('⚡ Generated SQL:', sqlGen.sql);
    console.log('🔧 Parameters:', queryParams);
    console.log(`📊 Tasks retrieved from PostgreSQL: ${tasksRes.rows.length}`);
    if (tasksRes.rows.length > 0) {
      console.log('📋 Tasks:', tasksRes.rows.map((t) => `${t.title} [${t.priority}] (Status: ${t.status})`).join(', '));
    }

    const normalizeDateStr = (d: any): string | null => {
      if (!d) return null;
      if (d instanceof Date) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      }
      return String(d).split('T')[0];
    };

    let matchedRows = tasksRes.rows;
    // Client fallback if DB was empty but client had cached state
    if (matchedRows.length === 0 && Array.isArray(clientTasks) && clientTasks.length > 0 && !sqlGen.isAction) {
      matchedRows = clientTasks;
    }

    const formattedTasks = matchedRows.map((t) => ({
      ...t,
      due_date: normalizeDateStr(t.due_date),
    }));

    let proposals = sqlGen.proposals || [];
    if (sqlGen.isAction && proposals.length > 0 && matchedRows.length > 0) {
      proposals = proposals.map((p) => {
        if (!p.targetTaskId && matchedRows[0]) {
          return {
            ...p,
            targetTaskId: matchedRows[0].id,
            targetTaskTitle: matchedRows[0].title,
          };
        }
        return p;
      });
    }

    // 3. Agentic Synthesis of DB Results
    const aiResponse = synthesizeAgenticResponse(
      prompt,
      formattedTasks,
      sqlGen.sql,
      todayDate,
      proposals
    );

    console.log('🤖 JARVIS Final Output:\n', aiResponse.message);
    if (aiResponse.proposals && aiResponse.proposals.length > 0) {
      console.log('✨ Proposals Prepared:', aiResponse.proposals);
    }
    console.log('==============================================\n');

    return c.json(aiResponse);
  } catch (err: any) {
    console.error('AI Text-to-SQL Chat Error:', err);
    return c.json({ error: 'Failed to process AI chat request' }, 500);
  }
});

// POST /api/ai/approve
ai.post('/approve', async (c) => {
  try {
    const user = c.get('user') as JwtPayload;
    const { proposals } = await c.req.json();

    if (!Array.isArray(proposals) || proposals.length === 0) {
      return c.json({ error: 'Proposals array is required' }, 400);
    }

    const executedResults = [];

    for (const prop of proposals as ProposalItem[]) {
      if (prop.type === 'CREATE_TASK') {
        const res = await db.query<TaskRecord>(
          `INSERT INTO tasks (user_id, project_id, title, priority, due_date, status)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
          [
            user.userId,
            prop.projectId || null,
            prop.title || 'Untitled Task',
            prop.priority || 'Medium',
            prop.dueDate || new Date().toISOString().split('T')[0],
            prop.status || 'Todo',
          ]
        );
        executedResults.push({ type: prop.type, item: res.rows[0] });
      } else if (prop.type === 'COMPLETE_TASK') {
        if (prop.targetTaskId) {
          const res = await db.query<TaskRecord>(
            `UPDATE tasks SET status = 'Completed' WHERE id = $1 AND user_id = $2 RETURNING *`,
            [prop.targetTaskId, user.userId]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
        } else if (prop.targetTaskTitle || prop.title) {
          const cleanT = (prop.targetTaskTitle || prop.title || '')
            .replace(/^mark\s+task\s+/i, '')
            .replace(/\s+as\s+completed$/i, '')
            .replace(/["']/g, '')
            .trim();
          const res = await db.query<TaskRecord>(
            `UPDATE tasks SET status = 'Completed' WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) RETURNING *`,
            [user.userId, `%${cleanT}%`]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
        }
      } else if (prop.type === 'UPDATE_TASK') {
        if (prop.targetTaskId) {
          const res = await db.query<TaskRecord>(
            `UPDATE tasks 
             SET status = COALESCE($1, status),
                 priority = COALESCE($2, priority),
                 due_date = COALESCE($3, due_date)
             WHERE id = $4 AND user_id = $5 RETURNING *`,
            [prop.status || null, prop.priority || null, prop.dueDate || null, prop.targetTaskId, user.userId]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
        } else if (prop.targetTaskTitle || prop.title) {
          const cleanT = (prop.targetTaskTitle || prop.title || '')
            .replace(/^update\s+task\s+/i, '')
            .replace(/["']/g, '')
            .trim();
          const res = await db.query<TaskRecord>(
            `UPDATE tasks 
             SET status = COALESCE($1, status),
                 priority = COALESCE($2, priority),
                 due_date = COALESCE($3, due_date)
             WHERE user_id = $4 AND LOWER(title) LIKE LOWER($5) RETURNING *`,
            [prop.status || null, prop.priority || null, prop.dueDate || null, user.userId, `%${cleanT}%`]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
        }
      } else if (prop.type === 'DELETE_TASK') {
        if (prop.targetTaskId) {
          await db.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [prop.targetTaskId, user.userId]);
          executedResults.push({ type: prop.type, targetTaskId: prop.targetTaskId });
        } else if (prop.targetTaskTitle || prop.title) {
          const cleanT = (prop.targetTaskTitle || prop.title || '')
            .replace(/^delete\s+task\s+/i, '')
            .replace(/["']/g, '')
            .trim();
          await db.query('DELETE FROM tasks WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2)', [user.userId, `%${cleanT}%`]);
          executedResults.push({ type: prop.type, targetTitle: cleanT });
        }
      } else if (prop.type === 'CREATE_PROJECT') {
        const res = await db.query<ProjectRecord>(
          `INSERT INTO projects (user_id, name, client, deadline, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [
            user.userId,
            prop.name || prop.title || 'New Project',
            prop.client || 'Client',
            prop.dueDate || null,
            prop.status || 'Active',
          ]
        );
        executedResults.push({ type: prop.type, item: res.rows[0] });
      }
    }

    return c.json({
      message: 'Proposals executed successfully',
      executed: executedResults,
    });
  } catch (err: any) {
    console.error('Approve Proposal Error:', err);
    return c.json({ error: 'Failed to approve proposal' }, 500);
  }
});

export default ai;
