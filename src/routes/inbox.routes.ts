import { Hono } from 'hono';
import { db, InboxItemRecord, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

export const inboxRouter = new Hono<HonoEnv>();

inboxRouter.use('/*', authMiddleware);

// 1. Get all inbox items for user
inboxRouter.get('/', async (c) => {
  const user = c.get('user');
  const res = await db.query<InboxItemRecord>(
    'SELECT * FROM inbox_items WHERE user_id = $1 AND is_converted = false ORDER BY created_at DESC',
    [user.userId]
  );
  return c.json({ items: res.rows });
});

// 2. Quick capture item
inboxRouter.post('/', async (c) => {
  const user = c.get('user');
  const { content, type = 'raw' } = await c.req.json();

  if (!content || !content.trim()) {
    return c.json({ error: 'Content is required' }, 400);
  }

  const newInboxId = crypto.randomUUID();
  const res = await db.query<InboxItemRecord>(
    `INSERT INTO inbox_items (id, user_id, content, type, is_converted)
     VALUES ($1, $2, $3, $4, false) RETURNING *`,
    [newInboxId, user.userId, content.trim(), type]
  );

  return c.json({ item: res.rows[0] || { id: newInboxId, user_id: user.userId, content: content.trim(), type, is_converted: false } }, 201);
});

// 3. Convert inbox item into Task
inboxRouter.post('/:id/convert-to-task', async (c) => {
  const user = c.get('user');
  const itemId = c.req.param('id');
  const { priority = 'Medium', due_date = null, project_id = null } = await c.req.json().catch(() => ({}));

  const itemRes = await db.query<InboxItemRecord>(
    'SELECT * FROM inbox_items WHERE id = $1 AND user_id = $2',
    [itemId, user.userId]
  );
  const item = itemRes.rows[0];

  if (!item) {
    return c.json({ error: 'Inbox item not found' }, 404);
  }

  // Create task
  const newTaskId = crypto.randomUUID();
  const taskRes = await db.query<TaskRecord>(
    `INSERT INTO tasks (id, user_id, project_id, title, priority, due_date, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'Todo') RETURNING *`,
    [newTaskId, user.userId, project_id, item.content, priority, due_date]
  );

  // Mark inbox item converted
  await db.query(
    'UPDATE inbox_items SET is_converted = true WHERE id = $1 AND user_id = $2',
    [itemId, user.userId]
  );

  // Log activity
  const actId = crypto.randomUUID();
  await db.query(
    `INSERT INTO activity_logs (id, task_id, user_id, action_type, details)
     VALUES ($1, $2, $3, 'CONVERTED_FROM_INBOX', $4)`,
    [actId, taskRes.rows[0]?.id || newTaskId, user.userId, JSON.stringify({ originalContent: item.content })]
  );

  return c.json({ task: taskRes.rows[0] || { id: newTaskId, user_id: user.userId, project_id, title: item.content, priority, due_date, status: 'Todo' } });
});

// 4. Delete inbox item
inboxRouter.delete('/:id', async (c) => {
  const user = c.get('user');
  const itemId = c.req.param('id');

  await db.query('DELETE FROM inbox_items WHERE id = $1 AND user_id = $2', [itemId, user.userId]);
  return c.json({ success: true, deletedId: itemId });
});
