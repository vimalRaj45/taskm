import { Hono } from 'hono';
import { db, ProjectRecord, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';
import { generateAIChatResponse, ProposalItem } from '../services/mistral.service.js';

const ai = new Hono<HonoEnv>();

ai.use('*', authMiddleware);

// POST /api/ai/chat
ai.post('/chat', async (c) => {
  try {
    const user = c.get('user') as JwtPayload;
    const { prompt } = await c.req.json();

    if (!prompt) {
      return c.json({ error: 'Prompt is required' }, 400);
    }

    const tasksRes = await db.query<TaskRecord>('SELECT * FROM tasks WHERE user_id = $1', [user.userId]);
    const projectsRes = await db.query<ProjectRecord>('SELECT * FROM projects WHERE user_id = $1', [user.userId]);

    const aiResponse = await generateAIChatResponse(prompt, tasksRes.rows, projectsRes.rows);

    return c.json(aiResponse);
  } catch (err: any) {
    console.error('AI Chat Error:', err);
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
      } else if (prop.type === 'COMPLETE_TASK' || prop.type === 'UPDATE_TASK') {
        if (prop.targetTaskId) {
          const newStatus = prop.type === 'COMPLETE_TASK' ? 'Completed' : (prop.status || 'In Progress');
          const res = await db.query<TaskRecord>(
            `UPDATE tasks SET status = $1 WHERE id = $2 AND user_id = $3 RETURNING *`,
            [newStatus, prop.targetTaskId, user.userId]
          );
          executedResults.push({ type: prop.type, item: res.rows[0] });
        }
      } else if (prop.type === 'DELETE_TASK') {
        if (prop.targetTaskId) {
          await db.query('DELETE FROM tasks WHERE id = $1 AND user_id = $2', [prop.targetTaskId, user.userId]);
          executedResults.push({ type: prop.type, targetTaskId: prop.targetTaskId });
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
