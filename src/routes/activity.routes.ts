import { Hono } from 'hono';
import { db, ActivityLogRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

export const activityRouter = new Hono<HonoEnv>();

activityRouter.use('/*', authMiddleware);

// Get activity history for workspace or a specific task/project
activityRouter.get('/', async (c) => {
  const user = c.get('user');
  const taskId = c.req.query('taskId');
  const projectId = c.req.query('projectId');

  let sql = 'SELECT * FROM activity_logs WHERE user_id = $1';
  const params: any[] = [user.userId];

  if (taskId) {
    sql += ' AND task_id = $2 ORDER BY created_at DESC LIMIT 50';
    params.push(taskId);
  } else if (projectId) {
    sql += ' AND project_id = $2 ORDER BY created_at DESC LIMIT 50';
    params.push(projectId);
  } else {
    sql += ' ORDER BY created_at DESC LIMIT 100';
  }

  const res = await db.query<ActivityLogRecord>(sql, params);
  return c.json({ activities: res.rows });
});
