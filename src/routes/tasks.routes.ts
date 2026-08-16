import { Hono } from 'hono';
import { db, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

const tasks = new Hono<HonoEnv>();

tasks.use('*', authMiddleware);

export function normalizeDateStr(val: string | Date | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).split('T')[0];
}

const formatTaskRecord = (t: TaskRecord): TaskRecord => ({
  ...t,
  due_date: normalizeDateStr(t.due_date),
});

// GET /api/tasks
tasks.get('/', async (c) => {
  const user = c.get('user') as JwtPayload;
  const result = await db.query<TaskRecord>(
    'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
    [user.userId]
  );

  return c.json({ tasks: result.rows.map(formatTaskRecord) });
});

// GET /api/tasks/today
tasks.get('/today', async (c) => {
  const user = c.get('user') as JwtPayload;
  const result = await db.query<TaskRecord>(
    'SELECT * FROM tasks WHERE user_id = $1 ORDER BY due_date ASC NULLS LAST, created_at DESC',
    [user.userId]
  );

  const allTasks = result.rows.map(formatTaskRecord);
  const todayStr = normalizeDateStr(new Date()) || new Date().toISOString().split('T')[0];

  const overdue: TaskRecord[] = [];
  const today: TaskRecord[] = [];
  const upcoming: TaskRecord[] = [];

  for (const t of allTasks) {
    if (!t.due_date) {
      upcoming.push(t);
    } else if (t.status !== 'Completed' && t.due_date < todayStr) {
      overdue.push(t);
    } else if (t.due_date === todayStr) {
      today.push(t);
    } else {
      upcoming.push(t);
    }
  }

  return c.json({
    overdue,
    today,
    upcoming,
    stats: {
      total: allTasks.length,
      overdueCount: overdue.length,
      todayCount: today.length,
      completedCount: allTasks.filter((t) => t.status === 'Completed').length,
    },
  });
});

// POST /api/tasks
tasks.post('/', async (c) => {
  const user = c.get('user') as JwtPayload;
  const { title, priority, due_date, project_id, status } = await c.req.json();

  if (!title) {
    return c.json({ error: 'Title is required' }, 400);
  }

  const result = await db.query<TaskRecord>(
    `INSERT INTO tasks (user_id, project_id, title, priority, due_date, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      user.userId,
      project_id || null,
      title,
      priority || 'Medium',
      due_date || null,
      status || 'Todo',
    ]
  );

  return c.json({ task: formatTaskRecord(result.rows[0]) }, 201);
});

// PATCH /api/tasks/:id
tasks.patch('/:id', async (c) => {
  const user = c.get('user') as JwtPayload;
  const taskId = c.req.param('id');
  const { title, priority, due_date, project_id, status } = await c.req.json();

  const existing = await db.query<TaskRecord>(
    'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
    [taskId, user.userId]
  );

  if (existing.rows.length === 0) {
    return c.json({ error: 'Task not found' }, 404);
  }

  const current = existing.rows[0];
  const newTitle = title !== undefined ? title : current.title;
  const newPriority = priority !== undefined ? priority : current.priority;
  const newDueDate = due_date !== undefined ? due_date : current.due_date;
  const newProjectId = project_id !== undefined ? project_id : current.project_id;
  const newStatus = status !== undefined ? status : current.status;

  const result = await db.query<TaskRecord>(
    `UPDATE tasks SET title = $1, priority = $2, due_date = $3, project_id = $4, status = $5
     WHERE id = $6 RETURNING *`,
    [newTitle, newPriority, newDueDate, newProjectId, newStatus, taskId]
  );

  return c.json({ task: formatTaskRecord(result.rows[0]) });
});

// DELETE /api/tasks/:id
tasks.delete('/:id', async (c) => {
  const user = c.get('user') as JwtPayload;
  const taskId = c.req.param('id');

  const existing = await db.query<TaskRecord>(
    'SELECT * FROM tasks WHERE id = $1 AND user_id = $2',
    [taskId, user.userId]
  );

  if (existing.rows.length === 0) {
    return c.json({ error: 'Task not found' }, 404);
  }

  await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
  return c.json({ message: 'Task deleted successfully' });
});

export default tasks;
