import pg from 'pg';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const dbUrl = process.env.DATABASE_URL || '';
const isPlaceholderUrl = !dbUrl || dbUrl.includes('username:password') || dbUrl.includes('ep-cool-name-123456');

let pool: pg.Pool | null = null;
let useInMemory = isPlaceholderUrl;

if (!isPlaceholderUrl) {
  try {
    pool = new pg.Pool({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
    });

    // Auto-create tables on Neon Postgres if they don't exist
    initNeonSchema(pool).catch((err) => {
      console.warn('Neon Postgres schema initialization warning:', err);
    });
  } catch (err) {
    console.warn('Postgres connection setup failed, falling back to in-memory store:', err);
    useInMemory = true;
  }
}

async function initNeonSchema(p: pg.Pool) {
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        google_id VARCHAR(255) UNIQUE,
        google_access_token TEXT,
        google_refresh_token TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        client VARCHAR(255),
        deadline DATE,
        status VARCHAR(50) DEFAULT 'Active',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        title VARCHAR(255) NOT NULL,
        priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
        due_date DATE,
        status VARCHAR(20) NOT NULL DEFAULT 'Todo',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
    `);
    console.log('✅ Neon Postgres database schema verified & initialized successfully!');
  } catch (e) {
    console.error('Error creating Neon Postgres tables:', e);
  }
}

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  google_id?: string;
  google_access_token?: string | null;
  google_refresh_token?: string | null;
  created_at: string;
}

export interface ProjectRecord {
  id: string;
  user_id: string;
  name: string;
  client: string | null;
  deadline: string | null;
  status: string;
  created_at: string;
  total_tasks?: string | number;
  completed_tasks?: string | number;
}

export interface TaskRecord {
  id: string;
  user_id: string;
  project_id: string | null;
  title: string;
  priority: string;
  due_date: string | null;
  status: string;
  created_at: string;
}

const memoryDb = {
  users: [] as UserRecord[],
  projects: [] as ProjectRecord[],
  tasks: [] as TaskRecord[],
};

// Seed sample data for in-memory fallback
const defaultUserId = '11111111-1111-1111-1111-111111111111';
const defaultProjId1 = '22222222-2222-2222-2222-222222222222';
const defaultProjId2 = '33333333-3333-3333-3333-333333333333';

const todayStr = new Date().toISOString().split('T')[0];
const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
const nextWeekStr = new Date(Date.now() + 5 * 86400000).toISOString().split('T')[0];

memoryDb.users.push({
  id: defaultUserId,
  email: 'demo@taskmanager.com',
  password_hash: '$2a$10$wN.9.rQO1N2O9O9O9O9O9O',
  name: 'Demo User',
  created_at: new Date().toISOString(),
});

memoryDb.projects.push(
  {
    id: defaultProjId1,
    user_id: defaultUserId,
    name: 'Website Redesign',
    client: 'Acme Corp',
    deadline: nextWeekStr,
    status: 'Active',
    created_at: new Date().toISOString(),
  },
  {
    id: defaultProjId2,
    user_id: defaultUserId,
    name: 'Mobile App V2',
    client: 'TechStart Inc',
    deadline: nextWeekStr,
    status: 'Active',
    created_at: new Date().toISOString(),
  }
);

memoryDb.tasks.push(
  {
    id: 't1',
    user_id: defaultUserId,
    project_id: defaultProjId1,
    title: 'Submit landing page responsive design mockups',
    priority: 'Urgent',
    due_date: yesterdayStr,
    status: 'Todo',
    created_at: new Date().toISOString(),
  },
  {
    id: 't2',
    user_id: defaultUserId,
    project_id: defaultProjId1,
    title: 'Review user authentication security endpoints',
    priority: 'High',
    due_date: todayStr,
    status: 'In Progress',
    created_at: new Date().toISOString(),
  },
  {
    id: 't3',
    user_id: defaultUserId,
    project_id: defaultProjId2,
    title: 'Set up Neon Serverless Postgres schema',
    priority: 'Medium',
    due_date: todayStr,
    status: 'Completed',
    created_at: new Date().toISOString(),
  },
  {
    id: 't4',
    user_id: defaultUserId,
    project_id: defaultProjId2,
    title: 'Configure Mistral AI prompt interpretation pipeline',
    priority: 'High',
    due_date: nextWeekStr,
    status: 'Todo',
    created_at: new Date().toISOString(),
  }
);

export const db = {
  isInMemory: () => useInMemory,

  async query<T = any>(text: string, params: any[] = []): Promise<{ rows: T[] }> {
    if (!useInMemory && pool) {
      try {
        const res = await pool.query(text, params);
        return { rows: res.rows as T[] };
      } catch (err) {
        console.warn('Neon Postgres query failed, using in-memory store fallback:', err);
        useInMemory = true;
      }
    }

    return memoryQuery<T>(text, params);
  },
};

function memoryQuery<T>(text: string, params: any[]): { rows: T[] } {
  const queryLower = text.toLowerCase();

  if (queryLower.includes('from users') && queryLower.includes('email =')) {
    const email = params[0];
    const user = memoryDb.users.find((u) => u.email === email);
    return { rows: (user ? [user] : []) as T[] };
  }
  if (queryLower.includes('from users') && queryLower.includes('id =')) {
    const id = params[0];
    const user = memoryDb.users.find((u) => u.id === id);
    return { rows: (user ? [user] : []) as T[] };
  }
  if (queryLower.includes('from users') && queryLower.includes('google_id =')) {
    const googleId = params[0];
    const user = memoryDb.users.find((u) => u.google_id === googleId);
    return { rows: (user ? [user] : []) as T[] };
  }
  if (queryLower.includes('insert into users')) {
    const [email, password_hash, name, google_id] = params;
    const newUser: UserRecord = {
      id: crypto.randomUUID(),
      email,
      password_hash: password_hash || 'oauth_google',
      name,
      google_id: google_id || undefined,
      created_at: new Date().toISOString(),
    };
    memoryDb.users.push(newUser);
    return { rows: [newUser] as T[] };
  }
  if (queryLower.includes('update users')) {
    const userId = params[params.length - 1];
    const userIndex = memoryDb.users.findIndex((u) => u.id === userId);
    if (userIndex !== -1) {
      if (text.includes('google_access_token =')) {
        memoryDb.users[userIndex].google_access_token = params[0];
      }
      if (text.includes('google_refresh_token =')) {
        memoryDb.users[userIndex].google_refresh_token = params[1] || memoryDb.users[userIndex].google_refresh_token;
      }
      return { rows: [memoryDb.users[userIndex]] as T[] };
    }
  }

  if (queryLower.includes('from projects') && queryLower.includes('user_id =')) {
    const userId = params[0];
    const userProjects = memoryDb.projects.filter((p) => p.user_id === userId);
    const enriched = userProjects.map((p) => {
      const pTasks = memoryDb.tasks.filter((t) => t.project_id === p.id);
      const total_tasks = pTasks.length;
      const completed_tasks = pTasks.filter((t) => t.status === 'Completed').length;
      return {
        ...p,
        total_tasks: total_tasks.toString(),
        completed_tasks: completed_tasks.toString(),
      };
    });
    return { rows: enriched as T[] };
  }
  if (queryLower.includes('insert into projects')) {
    const [user_id, name, client, deadline, status] = params;
    const newProject: ProjectRecord = {
      id: crypto.randomUUID(),
      user_id,
      name,
      client: client || null,
      deadline: deadline || null,
      status: status || 'Active',
      created_at: new Date().toISOString(),
    };
    memoryDb.projects.push(newProject);
    return { rows: [newProject] as T[] };
  }
  if (queryLower.includes('update projects')) {
    const id = params[params.length - 1];
    const projIndex = memoryDb.projects.findIndex((p) => p.id === id);
    if (projIndex !== -1) {
      if (text.includes('name =')) memoryDb.projects[projIndex].name = params[0];
      if (text.includes('client =')) memoryDb.projects[projIndex].client = params[1];
      if (text.includes('deadline =')) memoryDb.projects[projIndex].deadline = params[2];
      if (text.includes('status =')) memoryDb.projects[projIndex].status = params[3];
      return { rows: [memoryDb.projects[projIndex]] as T[] };
    }
  }
  if (queryLower.includes('delete from projects')) {
    const id = params[0];
    const proj = memoryDb.projects.find((p) => p.id === id);
    memoryDb.projects = memoryDb.projects.filter((p) => p.id !== id);
    memoryDb.tasks = memoryDb.tasks.map((t) => (t.project_id === id ? { ...t, project_id: null } : t));
    return { rows: (proj ? [proj] : []) as T[] };
  }

  if (queryLower.includes('from tasks') && queryLower.includes('user_id =')) {
    const userId = params[0];
    const userTasks = memoryDb.tasks
      .filter((t) => t.user_id === userId)
      .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'));
    return { rows: userTasks as T[] };
  }
  if (queryLower.includes('insert into tasks')) {
    const [user_id, project_id, title, priority, due_date, status] = params;
    const newTask: TaskRecord = {
      id: crypto.randomUUID(),
      user_id,
      project_id: project_id || null,
      title,
      priority: priority || 'Medium',
      due_date: due_date || null,
      status: status || 'Todo',
      created_at: new Date().toISOString(),
    };
    memoryDb.tasks.push(newTask);
    return { rows: [newTask] as T[] };
  }
  if (queryLower.includes('update tasks')) {
    const id = params[params.length - 1];
    const taskIndex = memoryDb.tasks.findIndex((t) => t.id === id);
    if (taskIndex !== -1) {
      if (text.includes('title =')) memoryDb.tasks[taskIndex].title = params[0];
      if (text.includes('priority =')) memoryDb.tasks[taskIndex].priority = params[1];
      if (text.includes('due_date =')) memoryDb.tasks[taskIndex].due_date = params[2];
      if (text.includes('project_id =')) memoryDb.tasks[taskIndex].project_id = params[3];
      if (text.includes('status =')) memoryDb.tasks[taskIndex].status = params[4];
      return { rows: [memoryDb.tasks[taskIndex]] as T[] };
    }
  }
  if (queryLower.includes('delete from tasks')) {
    const id = params[0];
    const task = memoryDb.tasks.find((t) => t.id === id);
    memoryDb.tasks = memoryDb.tasks.filter((t) => t.id !== id);
    return { rows: (task ? [task] : []) as T[] };
  }

  return { rows: [] };
}
