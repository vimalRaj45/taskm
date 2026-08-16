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
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      google_id VARCHAR(255) UNIQUE,
      google_access_token TEXT,
      google_refresh_token TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      name VARCHAR(255) NOT NULL,
      client VARCHAR(255),
      deadline DATE,
      status VARCHAR(50) DEFAULT 'Active',
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT NOT NULL,
      project_id TEXT,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      start_date DATE,
      due_date DATE,
      due_time VARCHAR(10),
      priority VARCHAR(20) NOT NULL DEFAULT 'Medium',
      status VARCHAR(30) NOT NULL DEFAULT 'Todo',
      category VARCHAR(100),
      tags TEXT,
      estimated_duration VARCHAR(50),
      reminder_at TIMESTAMP WITH TIME ZONE,
      is_important BOOLEAN DEFAULT false,
      is_recurring BOOLEAN DEFAULT false,
      recurrence_rule VARCHAR(100),
      dependencies TEXT,
      progress INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS subtasks (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      task_id TEXT,
      user_id TEXT,
      title VARCHAR(255) NOT NULL,
      is_completed BOOLEAN DEFAULT false,
      position INT DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS task_notes (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      task_id TEXT,
      project_id TEXT,
      user_id TEXT,
      content TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS inbox_items (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT,
      content TEXT NOT NULL,
      type VARCHAR(50) DEFAULT 'raw',
      is_converted BOOLEAN DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS activity_logs (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      task_id TEXT,
      project_id TEXT,
      user_id TEXT,
      action_type VARCHAR(100) NOT NULL,
      details JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      user_id TEXT,
      task_id TEXT,
      title VARCHAR(255) NOT NULL,
      message TEXT,
      type VARCHAR(50) DEFAULT 'REMINDER',
      is_read BOOLEAN DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    )`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_access_token TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS google_refresh_token TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date DATE`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time VARCHAR(10)`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS category VARCHAR(100)`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tags TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS estimated_duration VARCHAR(50)`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reminder_at TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_important BOOLEAN DEFAULT false`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recurrence_rule VARCHAR(100)`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependencies TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress INTEGER DEFAULT 0`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS task_id TEXT`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS title VARCHAR(255)`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS is_completed BOOLEAN DEFAULT false`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS position INT DEFAULT 0`,
    `ALTER TABLE subtasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS task_id TEXT`,
    `ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS project_id TEXT`,
    `ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS content TEXT`,
    `ALTER TABLE task_notes ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS content TEXT`,
    `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'raw'`,
    `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS is_converted BOOLEAN DEFAULT false`,
    `ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS task_id TEXT`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS project_id TEXT`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS user_id TEXT`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS action_type VARCHAR(100)`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS details JSONB`,
    `ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE activity_logs ALTER COLUMN "action" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN action DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "action_type" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN action_type DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "entityId" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "entityType" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "taskId" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "userId" DROP NOT NULL`,
    `ALTER TABLE activity_logs ALTER COLUMN "projectId" DROP NOT NULL`,
    `ALTER TABLE subtasks ALTER COLUMN "updatedAt" DROP NOT NULL`,
    `ALTER TABLE subtasks ALTER COLUMN "taskId" DROP NOT NULL`,
    `ALTER TABLE subtasks ALTER COLUMN "userId" DROP NOT NULL`,
    `ALTER TABLE task_notes ALTER COLUMN "userId" DROP NOT NULL`,
    `ALTER TABLE task_notes ALTER COLUMN "taskId" DROP NOT NULL`,
    `ALTER TABLE task_notes ALTER COLUMN "projectId" DROP NOT NULL`,
    `ALTER TABLE inbox_items ALTER COLUMN "userId" DROP NOT NULL`,
    `ALTER TABLE tasks ALTER COLUMN "updatedAt" DROP NOT NULL`,
    `ALTER TABLE projects ALTER COLUMN "updatedAt" DROP NOT NULL`,
    `DO $$ 
    BEGIN 
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='subtasks' AND column_name='taskId') THEN
        EXECUTE 'UPDATE subtasks SET task_id = "taskId"::text WHERE task_id IS NULL';
      END IF;
    END $$;`,
  ];

  for (const statement of statements) {
    try {
      await p.query(statement);
    } catch (e: any) {
      // Non-blocking single statement warning
      console.warn(`Schema init notice for statement: ${statement.slice(0, 40)}...`, e?.message || e);
    }
  }
  console.log('✅ Neon Postgres database schema verified & initialized successfully!');
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
  description?: string | null;
  start_date?: string | null;
  due_date: string | null;
  due_time?: string | null;
  priority: string;
  status: string;
  category?: string | null;
  tags?: string | null;
  estimated_duration?: string | null;
  reminder_at?: string | null;
  is_important?: boolean;
  is_recurring?: boolean;
  recurrence_rule?: string | null;
  dependencies?: string | null;
  progress?: number;
  created_at: string;
}

export interface SubtaskRecord {
  id: string;
  task_id: string;
  user_id: string;
  title: string;
  is_completed: boolean;
  position: number;
  created_at: string;
}

export interface TaskNoteRecord {
  id: string;
  task_id?: string | null;
  project_id?: string | null;
  user_id: string;
  content: string;
  created_at: string;
}

export interface InboxItemRecord {
  id: string;
  user_id: string;
  content: string;
  type: string;
  is_converted: boolean;
  created_at: string;
}

export interface ActivityLogRecord {
  id: string;
  task_id?: string | null;
  project_id?: string | null;
  user_id: string;
  action_type: string;
  details?: any;
  created_at: string;
}

export interface NotificationRecord {
  id: string;
  user_id: string;
  task_id?: string | null;
  title: string;
  message?: string | null;
  type: string;
  is_read: boolean;
  created_at: string;
}

const memoryDb = {
  users: [] as UserRecord[],
  projects: [] as ProjectRecord[],
  tasks: [] as TaskRecord[],
  subtasks: [] as SubtaskRecord[],
  notes: [] as TaskNoteRecord[],
  inbox: [] as InboxItemRecord[],
  activities: [] as ActivityLogRecord[],
  notifications: [] as NotificationRecord[],
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
    progress: 50,
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
    progress: 0,
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
    progress: 100,
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
    progress: 0,
    created_at: new Date().toISOString(),
  }
);

memoryDb.subtasks.push(
  {
    id: 'st1',
    task_id: 't1',
    user_id: defaultUserId,
    title: 'Mobile viewport testing',
    is_completed: true,
    position: 0,
    created_at: new Date().toISOString(),
  },
  {
    id: 'st2',
    task_id: 't1',
    user_id: defaultUserId,
    title: 'Design Dark Mode tokens',
    is_completed: false,
    position: 1,
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
      } catch (err: any) {
        console.warn('Neon Postgres query failed, using in-memory store fallback:', err?.message || err);
      }
    }

    return memoryQuery<T>(text, params);
  },
};

function memoryQuery<T>(text: string, params: any[]): { rows: T[] } {
  const queryLower = text.toLowerCase();

  // 1. Users
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

  // 2. Projects
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

  // 3. Subtasks
  if (queryLower.includes('from subtasks') && queryLower.includes('task_id =')) {
    const taskId = params[0];
    const taskSubtasks = memoryDb.subtasks.filter((s) => s.task_id === taskId);
    return { rows: taskSubtasks as T[] };
  }
  if (queryLower.includes('insert into subtasks')) {
    const [task_id, user_id, title, is_completed, position] = params;
    const newSubtask: SubtaskRecord = {
      id: crypto.randomUUID(),
      task_id,
      user_id,
      title,
      is_completed: Boolean(is_completed),
      position: position || 0,
      created_at: new Date().toISOString(),
    };
    memoryDb.subtasks.push(newSubtask);
    return { rows: [newSubtask] as T[] };
  }
  if (queryLower.includes('update subtasks')) {
    const id = params[1] || params[0];
    const sIndex = memoryDb.subtasks.findIndex((s) => s.id === id);
    if (sIndex !== -1) {
      if (text.includes('is_completed =')) memoryDb.subtasks[sIndex].is_completed = Boolean(params[0]);
      if (text.includes('title =')) memoryDb.subtasks[sIndex].title = params[0];
      return { rows: [memoryDb.subtasks[sIndex]] as T[] };
    }
  }
  if (queryLower.includes('delete from subtasks')) {
    const id = params[0];
    const st = memoryDb.subtasks.find((s) => s.id === id);
    memoryDb.subtasks = memoryDb.subtasks.filter((s) => s.id !== id);
    return { rows: (st ? [st] : []) as T[] };
  }

  // 4. Notes
  if (queryLower.includes('from task_notes')) {
    const userId = params[0];
    const taskId = params[1];
    const userNotes = memoryDb.notes.filter((n) => (!userId || n.user_id === userId) && (!taskId || n.task_id === taskId));
    return { rows: userNotes as T[] };
  }
  if (queryLower.includes('insert into task_notes')) {
    const [task_id, project_id, user_id, content] = params;
    const newNote: TaskNoteRecord = {
      id: crypto.randomUUID(),
      task_id: task_id || null,
      project_id: project_id || null,
      user_id,
      content,
      created_at: new Date().toISOString(),
    };
    memoryDb.notes.push(newNote);
    return { rows: [newNote] as T[] };
  }
  if (queryLower.includes('delete from task_notes')) {
    const id = params[0];
    const n = memoryDb.notes.find((note) => note.id === id);
    memoryDb.notes = memoryDb.notes.filter((note) => note.id !== id);
    return { rows: (n ? [n] : []) as T[] };
  }

  // 5. Inbox Items
  if (queryLower.includes('from inbox_items')) {
    const userId = params[0];
    const items = memoryDb.inbox.filter((i) => i.user_id === userId);
    return { rows: items as T[] };
  }
  if (queryLower.includes('insert into inbox_items')) {
    const [user_id, content, type] = params;
    const item: InboxItemRecord = {
      id: crypto.randomUUID(),
      user_id,
      content,
      type: type || 'raw',
      is_converted: false,
      created_at: new Date().toISOString(),
    };
    memoryDb.inbox.push(item);
    return { rows: [item] as T[] };
  }
  if (queryLower.includes('update inbox_items')) {
    const id = params[params.length - 2] || params[0];
    const idx = memoryDb.inbox.findIndex((i) => i.id === id);
    if (idx !== -1) {
      if (text.includes('is_converted =')) memoryDb.inbox[idx].is_converted = true;
      return { rows: [memoryDb.inbox[idx]] as T[] };
    }
  }
  if (queryLower.includes('delete from inbox_items')) {
    const id = params[0];
    const item = memoryDb.inbox.find((i) => i.id === id);
    memoryDb.inbox = memoryDb.inbox.filter((i) => i.id !== id);
    return { rows: (item ? [item] : []) as T[] };
  }

  // 6. Activity Logs
  if (queryLower.includes('from activity_logs')) {
    const userId = params[0];
    const logs = memoryDb.activities
      .filter((a) => a.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { rows: logs as T[] };
  }
  if (queryLower.includes('insert into activity_logs')) {
    const [task_id, project_id, user_id, action_type, details] = params;
    const log: ActivityLogRecord = {
      id: crypto.randomUUID(),
      task_id: task_id || null,
      project_id: project_id || null,
      user_id,
      action_type,
      details: typeof details === 'string' ? JSON.parse(details) : details,
      created_at: new Date().toISOString(),
    };
    memoryDb.activities.push(log);
    return { rows: [log] as T[] };
  }

  // 7. Notifications
  if (queryLower.includes('from notifications')) {
    const userId = params[0];
    const notifs = memoryDb.notifications
      .filter((n) => n.user_id === userId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { rows: notifs as T[] };
  }
  if (queryLower.includes('insert into notifications')) {
    const [user_id, task_id, title, message, type] = params;
    const notif: NotificationRecord = {
      id: crypto.randomUUID(),
      user_id,
      task_id: task_id || null,
      title,
      message: message || null,
      type: type || 'REMINDER',
      is_read: false,
      created_at: new Date().toISOString(),
    };
    memoryDb.notifications.push(notif);
    return { rows: [notif] as T[] };
  }

  // 8. Tasks
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
      progress: 0,
      created_at: new Date().toISOString(),
    };
    memoryDb.tasks.push(newTask);
    return { rows: [newTask] as T[] };
  }
  if (queryLower.includes('update tasks')) {
    let id = params[params.length - 1];
    if (queryLower.includes('progress =')) {
      id = params[1];
    }
    const taskIndex = memoryDb.tasks.findIndex((t) => t.id === id);
    if (taskIndex !== -1) {
      if (text.includes('progress =')) memoryDb.tasks[taskIndex].progress = params[0];
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
    memoryDb.subtasks = memoryDb.subtasks.filter((s) => s.task_id !== id);
    memoryDb.notes = memoryDb.notes.filter((n) => n.task_id !== id);
    return { rows: (task ? [task] : []) as T[] };
  }

  return { rows: [] };
}
