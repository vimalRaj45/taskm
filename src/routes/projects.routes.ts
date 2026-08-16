import { Hono } from 'hono';
import { db, ProjectRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

const projects = new Hono<HonoEnv>();

projects.use('*', authMiddleware);

// GET /api/projects
projects.get('/', async (c) => {
  const user = c.get('user') as JwtPayload;

  const result = await db.query(
    `SELECT p.*,
            COUNT(t.id) AS total_tasks,
            COUNT(CASE WHEN t.status = 'Completed' THEN 1 END) AS completed_tasks
     FROM projects p
     LEFT JOIN tasks t ON p.id = t.project_id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [user.userId]
  );

  return c.json({ projects: result.rows });
});

// POST /api/projects
projects.post('/', async (c) => {
  const user = c.get('user') as JwtPayload;
  const { name, client, deadline, status } = await c.req.json();

  if (!name) {
    return c.json({ error: 'Project name is required' }, 400);
  }

  const newProjectId = crypto.randomUUID();
  const result = await db.query<ProjectRecord>(
    `INSERT INTO projects (id, user_id, name, client, deadline, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [newProjectId, user.userId, name, client || null, deadline || null, status || 'Active']
  );

  return c.json(
    {
      project: {
        ...(result.rows[0] || { id: newProjectId, user_id: user.userId, name, client: client || null, deadline: deadline || null, status: status || 'Active' }),
        total_tasks: '0',
        completed_tasks: '0',
      },
    },
    201
  );
});

// PATCH /api/projects/:id
projects.patch('/:id', async (c) => {
  const user = c.get('user') as JwtPayload;
  const projId = c.req.param('id');
  const { name, client, deadline, status } = await c.req.json();

  const existing = await db.query<ProjectRecord>(
    'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
    [projId, user.userId]
  );

  if (existing.rows.length === 0) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const current = existing.rows[0];
  const newName = name !== undefined ? name : current.name;
  const newClient = client !== undefined ? client : current.client;
  const newDeadline = deadline !== undefined ? deadline : current.deadline;
  const newStatus = status !== undefined ? status : current.status;

  const result = await db.query<ProjectRecord>(
    `UPDATE projects SET name = $1, client = $2, deadline = $3, status = $4
     WHERE id = $5 RETURNING *`,
    [newName, newClient, newDeadline, newStatus, projId]
  );

  return c.json({ project: result.rows[0] });
});

// DELETE /api/projects/:id
projects.delete('/:id', async (c) => {
  const user = c.get('user') as JwtPayload;
  const projId = c.req.param('id');

  const existing = await db.query<ProjectRecord>(
    'SELECT * FROM projects WHERE id = $1 AND user_id = $2',
    [projId, user.userId]
  );

  if (existing.rows.length === 0) {
    return c.json({ error: 'Project not found' }, 404);
  }

  await db.query('DELETE FROM projects WHERE id = $1', [projId]);
  return c.json({ message: 'Project deleted successfully' });
});

export default projects;
