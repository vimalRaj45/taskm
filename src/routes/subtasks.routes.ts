import { Hono } from 'hono';
import { db, SubtaskRecord, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

export const subtasksRouter = new Hono<HonoEnv>();

subtasksRouter.use('/*', authMiddleware);

// Recalculate and update task progress %
async function updateTaskProgress(taskId: string, userId: string) {
  try {
    const subRes = await db.query<SubtaskRecord>(
      'SELECT * FROM subtasks WHERE task_id = $1 AND user_id = $2',
      [taskId, userId]
    );
    const subtasks = subRes.rows;
    if (subtasks.length === 0) return;

    const completedCount = subtasks.filter((s) => s.is_completed).length;
    const progress = Math.round((completedCount / subtasks.length) * 100);

    // If all subtasks completed, we can also auto-complete the task if user wishes
    await db.query(
      'UPDATE tasks SET progress = $1 WHERE id = $2 AND user_id = $3',
      [progress, taskId, userId]
    );
  } catch (err) {
    console.error('Error updating task progress:', err);
  }
}

// 1. Get all subtasks for a task
subtasksRouter.get('/task/:taskId', async (c) => {
  const user = c.get('user');
  const taskId = c.req.param('taskId');

  const res = await db.query<SubtaskRecord>(
    'SELECT * FROM subtasks WHERE task_id = $1 AND user_id = $2 ORDER BY position ASC, created_at ASC',
    [taskId, user.userId]
  );
  return c.json({ subtasks: res.rows });
});

// 2. Create a new subtask
subtasksRouter.post('/task/:taskId', async (c) => {
  const user = c.get('user');
  const taskId = c.req.param('taskId');
  const { title, position = 0 } = await c.req.json();

  if (!title || !title.trim()) {
    return c.json({ error: 'Subtask title is required' }, 400);
  }

  const subtaskId = crypto.randomUUID();
  const res = await db.query<SubtaskRecord>(
    `INSERT INTO subtasks (id, task_id, user_id, title, is_completed, position)
     VALUES ($1, $2, $3, $4, false, $5) RETURNING *`,
    [subtaskId, taskId, user.userId, title.trim(), position]
  );

  await updateTaskProgress(taskId, user.userId);

  // Log activity
  const activityId = crypto.randomUUID();
  await db.query(
    `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
     VALUES ($1, $2, $3, 'SUBTASK_ADDED', $4)`,
    [activityId, taskId, user.userId, JSON.stringify({ subtaskTitle: title.trim(), subtaskId: res.rows[0]?.id || subtaskId })]
  );

  return c.json({ subtask: res.rows[0] || { id: subtaskId, task_id: taskId, user_id: user.userId, title: title.trim(), is_completed: false, position } }, 201);
});

// 3. Toggle / Update subtask
subtasksRouter.put('/:id', async (c) => {
  const user = c.get('user');
  const subtaskId = c.req.param('id');
  const { is_completed, title } = await c.req.json();

  let subtask: SubtaskRecord | null = null;

  if (typeof is_completed === 'boolean') {
    const res = await db.query<SubtaskRecord>(
      'UPDATE subtasks SET is_completed = $1 WHERE id = $2 RETURNING *',
      [is_completed, subtaskId]
    );
    subtask = res.rows[0] || null;
  } else if (title) {
    const res = await db.query<SubtaskRecord>(
      'UPDATE subtasks SET title = $1 WHERE id = $2 RETURNING *',
      [title.trim(), subtaskId]
    );
    subtask = res.rows[0] || null;
  }

  if (!subtask) {
    return c.json({ error: 'Subtask not found' }, 404);
  }

  if (subtask.task_id) {
    await updateTaskProgress(subtask.task_id, user.userId);
  }

  // Log activity
  if (typeof is_completed === 'boolean' && subtask.task_id) {
    const actId = crypto.randomUUID();
    await db.query(
      `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        actId,
        subtask.task_id,
        user.userId,
        is_completed ? 'SUBTASK_COMPLETED' : 'SUBTASK_REOPENED',
        JSON.stringify({ subtaskTitle: subtask.title, is_completed }),
      ]
    );
  }

  return c.json({ subtask });
});

// 4. Delete subtask
subtasksRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const subtaskId = c.req.param('id');

  const getRes = await db.query<SubtaskRecord>(
    'SELECT * FROM subtasks WHERE id = $1',
    [subtaskId]
  );
  const subtask = getRes.rows[0];

  if (!subtask) {
    return c.json({ error: 'Subtask not found' }, 404);
  }

  await db.query('DELETE FROM subtasks WHERE id = $1', [subtaskId]);
  if (subtask.task_id) {
    await updateTaskProgress(subtask.task_id, user.userId);
  }

  return c.json({ success: true, deletedId: subtaskId });
});
