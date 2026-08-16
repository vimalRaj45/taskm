import { Hono } from 'hono';
import { db, TaskNoteRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

export const notesRouter = new Hono<HonoEnv>();

notesRouter.use('/*', authMiddleware);

// 1. Get notes by task or project
notesRouter.get('/', async (c) => {
  const user = c.get('user');
  const taskId = c.req.query('taskId');
  const projectId = c.req.query('projectId');

  let sql = 'SELECT * FROM task_notes WHERE user_id = $1';
  const params: any[] = [user.userId];

  if (taskId) {
    sql += ' AND task_id = $2 ORDER BY created_at DESC';
    params.push(taskId);
  } else if (projectId) {
    sql += ' AND project_id = $2 ORDER BY created_at DESC';
    params.push(projectId);
  } else {
    sql += ' ORDER BY created_at DESC';
  }

  const res = await db.query<TaskNoteRecord>(sql, params);
  return c.json({ notes: res.rows });
});

// 2. Create permanent note
notesRouter.post('/', async (c) => {
  const user = c.get('user');
  const { task_id, project_id, content } = await c.req.json();

  if (!content || !content.trim()) {
    return c.json({ error: 'Note content is required' }, 400);
  }

  const noteId = crypto.randomUUID();
  const res = await db.query<TaskNoteRecord>(
    `INSERT INTO task_notes (id, task_id, project_id, user_id, content)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [noteId, task_id || null, project_id || null, user.userId, content.trim()]
  );

  // Log activity
  const actId = crypto.randomUUID();
  await db.query(
    `INSERT INTO activity_logs (id, task_id, project_id, user_id, action_type, details)
     VALUES ($1, $2, $3, $4, 'NOTE_ADDED', $5)`,
    [actId, task_id || null, project_id || null, user.userId, JSON.stringify({ noteSnippet: content.slice(0, 60) })]
  );

  return c.json({ note: res.rows[0] || { id: noteId, task_id: task_id || null, project_id: project_id || null, user_id: user.userId, content: content.trim(), created_at: new Date().toISOString() } }, 201);
});

// 3. Delete note
notesRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const noteId = c.req.param('id');

  await db.query('DELETE FROM task_notes WHERE id = $1 AND user_id = $2', [noteId, user.userId]);
  return c.json({ success: true, deletedId: noteId });
});
