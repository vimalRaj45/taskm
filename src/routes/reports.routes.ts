import { Hono } from 'hono';
import { db, TaskRecord, ProjectRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

export const reportsRouter = new Hono<HonoEnv>();

reportsRouter.use('/*', authMiddleware);

// Generate aggregated analytics & productivity report summary
reportsRouter.get('/summary', async (c) => {
  const user = c.get('user');
  const todayStr = new Date().toISOString().split('T')[0];

  const [tasksRes, projectsRes] = await Promise.all([
    db.query<TaskRecord>('SELECT * FROM tasks WHERE user_id = $1', [user.userId]),
    db.query<ProjectRecord>('SELECT * FROM projects WHERE user_id = $1', [user.userId]),
  ]);

  const tasks = tasksRes.rows;
  const projects = projectsRes.rows;

  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === 'Completed').length;
  const inProgress = tasks.filter((t) => t.status === 'In Progress').length;
  const todo = tasks.filter((t) => t.status === 'Todo' || t.status === 'Not Started').length;
  const blocked = tasks.filter((t) => t.status === 'Blocked' || t.status === 'On Hold').length;

  const formatDateStr = (d: any): string => {
    if (!d) return '';
    if (d instanceof Date) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    return String(d).split('T')[0];
  };

  const overdue = tasks.filter((t) => {
    const d = formatDateStr(t.due_date);
    return d && d < todayStr && t.status !== 'Completed';
  }).length;

  const dueToday = tasks.filter((t) => {
    const d = formatDateStr(t.due_date);
    return d && d === todayStr && t.status !== 'Completed';
  }).length;
  const critical = tasks.filter((t) => (t.priority === 'Urgent' || t.priority === 'Critical') && t.status !== 'Completed').length;
  const important = tasks.filter((t) => t.is_important && t.status !== 'Completed').length;

  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  return c.json({
    metrics: {
      total,
      completed,
      inProgress,
      todo,
      blocked,
      overdue,
      dueToday,
      critical,
      important,
      completionRate,
    },
    projects: projects.map((p) => {
      const pTasks = tasks.filter((t) => t.project_id === p.id);
      const pDone = pTasks.filter((t) => t.status === 'Completed').length;
      return {
        id: p.id,
        name: p.name,
        client: p.client,
        deadline: p.deadline,
        totalTasks: pTasks.length,
        completedTasks: pDone,
        progress: pTasks.length > 0 ? Math.round((pDone / pTasks.length) * 100) : 0,
      };
    }),
  });
});
