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

// POST /api/ai/chat (Text-to-SQL + Agentic AI Execution with Contextual Memory)
ai.post('/chat', async (c) => {
  try {
    const user = c.get('user') as JwtPayload;
    const { prompt, clientTasks, context } = await c.req.json();

    if (!prompt) {
      return c.json({ error: 'Prompt is required' }, 400);
    }

    const todayDate = new Date().toISOString().split('T')[0];

    // 1. Text-to-SQL Generation with Contextual Pronoun Resolution
    const sqlGen = generateSQLForUserQuery(prompt, todayDate, context);

    // 2. Direct PostgreSQL Execution
    const queryParams = [user.userId, ...sqlGen.params];
    const tasksRes = await db.query<TaskRecord>(sqlGen.sql, queryParams);

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

    // 3. Check for Ambiguity / Disambiguation (if query matches multiple tasks)
    let actionType: 'PROPOSAL' | 'READ_ONLY' | 'DISAMBIGUATE' | 'CONFIRM_DELETION' =
      sqlGen.actionType || (proposals.length > 0 ? 'PROPOSAL' : 'READ_ONLY');

    let candidates: any[] | undefined = undefined;
    if (sqlGen.isAction && formattedTasks.length > 1 && !sqlGen.focusedTaskId) {
      actionType = 'DISAMBIGUATE';
      candidates = formattedTasks.slice(0, 4);
    }

    // 4. Agentic Synthesis of DB Results
    const aiResponse = synthesizeAgenticResponse(
      prompt,
      formattedTasks,
      sqlGen.sql,
      todayDate,
      proposals
    );

    return c.json({
      ...aiResponse,
      actionType,
      candidates,
      focusedTaskId: sqlGen.focusedTaskId || (formattedTasks.length === 1 ? formattedTasks[0].id : undefined),
      focusedTaskTitle: sqlGen.focusedTaskTitle || (formattedTasks.length === 1 ? formattedTasks[0].title : undefined),
    });
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
        const newTaskId = crypto.randomUUID();
        const res = await db.query<TaskRecord>(
          `INSERT INTO tasks (id, user_id, project_id, title, priority, due_date, due_time, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            newTaskId,
            user.userId,
            prop.projectId || null,
            prop.title || 'Untitled Task',
            prop.priority || 'Medium',
            prop.dueDate || new Date().toISOString().split('T')[0],
            prop.dueTime || null,
            prop.status || 'Todo',
          ]
        );
        const createdTask = res.rows[0] || { id: newTaskId, user_id: user.userId, title: prop.title, priority: prop.priority, status: 'Todo' };
        executedResults.push({ type: prop.type, item: createdTask });

        // Log Activity
        const actId = crypto.randomUUID();
        await db.query(
          `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
           VALUES ($1, $2, $3, 'CREATED_BY_AI', $4)`,
          [actId, createdTask.id, user.userId, JSON.stringify({ title: createdTask.title })]
        );
      } else if (prop.type === 'COMPLETE_TASK') {
        if (prop.targetTaskId) {
          const res = await db.query<TaskRecord>(
            `UPDATE tasks SET status = 'Completed', progress = 100 WHERE id = $1 AND user_id = $2 RETURNING *`,
            [prop.targetTaskId, user.userId]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
          const actId = crypto.randomUUID();
          await db.query(
            `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
             VALUES ($1, $2, $3, 'COMPLETED_BY_AI', $4)`,
            [actId, prop.targetTaskId, user.userId, JSON.stringify({ status: 'Completed' })]
          );
        } else if (prop.targetTaskTitle || prop.title) {
          const cleanT = (prop.targetTaskTitle || prop.title || '')
            .replace(/^mark\s+task\s+/i, '')
            .replace(/\s+as\s+completed$/i, '')
            .replace(/["']/g, '')
            .trim();
          const res = await db.query<TaskRecord>(
            `UPDATE tasks SET status = 'Completed', progress = 100 WHERE user_id = $1 AND LOWER(title) LIKE LOWER($2) RETURNING *`,
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
                 due_date = COALESCE($3, due_date),
                 due_time = COALESCE($4, due_time)
             WHERE id = $5 AND user_id = $6 RETURNING *`,
            [prop.status || null, prop.priority || null, prop.dueDate || null, prop.dueTime || null, prop.targetTaskId, user.userId]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
          const actId = crypto.randomUUID();
          await db.query(
            `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
             VALUES ($1, $2, $3, 'UPDATED_BY_AI', $4)`,
            [actId, prop.targetTaskId, user.userId, JSON.stringify(prop)]
          );
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
      } else if (prop.type === 'ADD_SUBTASK') {
        if (prop.targetTaskId && prop.subtaskTitle) {
          const subId = crypto.randomUUID();
          const sRes = await db.query(
            `INSERT INTO subtasks (id, task_id, user_id, title, is_completed, position)
             VALUES ($1, $2, $3, $4, false, 0) RETURNING *`,
            [subId, prop.targetTaskId, user.userId, prop.subtaskTitle]
          );
          executedResults.push({ type: prop.type, item: sRes.rows[0] || { id: subId, task_id: prop.targetTaskId, user_id: user.userId, title: prop.subtaskTitle } });
        }
      } else if (prop.type === 'ADD_NOTE') {
        if (prop.targetTaskId && prop.noteContent) {
          const noteId = crypto.randomUUID();
          const nRes = await db.query(
            `INSERT INTO task_notes (id, task_id, user_id, content)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [noteId, prop.targetTaskId, user.userId, prop.noteContent]
          );
          executedResults.push({ type: prop.type, item: nRes.rows[0] || { id: noteId, task_id: prop.targetTaskId, user_id: user.userId, content: prop.noteContent } });
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
        const projId = crypto.randomUUID();
        const res = await db.query<ProjectRecord>(
          `INSERT INTO projects (id, user_id, name, client, deadline, status)
           VALUES ($1, $2, $3, $4, $5, 'Active') RETURNING *`,
          [projId, user.userId, prop.name || 'New Project', prop.client || null, prop.dueDate || null]
        );
        executedResults.push({ type: prop.type, item: res.rows[0] || { id: projId, user_id: user.userId, name: prop.name, client: prop.client, deadline: prop.dueDate } });
      }
    }

    return c.json({ success: true, count: executedResults.length, results: executedResults });
  } catch (err: any) {
    console.error('Approval Execution Error:', err);
    return c.json({ error: 'Failed to execute approved proposals' }, 500);
  }
});

export default ai;
