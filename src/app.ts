import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.routes.js';
import tasksRoutes from './routes/tasks.routes.js';
import projectsRoutes from './routes/projects.routes.js';
import aiRoutes from './routes/ai.routes.js';
import emailRoutes from './routes/email.routes.js';
import { db } from './db/index.js';

dotenv.config();

const app = new Hono();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const PORT = parseInt(process.env.PORT || '3000', 10);

// CORS configuration
app.use(
  '*',
  cors({
    origin: [FRONTEND_URL, 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Health Check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    databaseMode: db.isInMemory() ? 'In-Memory (Fallback Zero-Config)' : 'Neon Serverless Postgres',
    timestamp: new Date().toISOString(),
  });
});

// Mount API Routes
app.route('/api/auth', authRoutes);
app.route('/api/tasks', tasksRoutes);
app.route('/api/projects', projectsRoutes);
app.route('/api/ai', aiRoutes);
app.route('/api/emails', emailRoutes);

console.log(`🚀 Starting Hono Server on port ${PORT}...`);
console.log(`🗄️ Database mode: ${db.isInMemory() ? 'In-Memory Fallback (Zero-Config Active)' : 'Neon Postgres Connected'}`);

if (process.env.NODE_ENV !== 'production' || process.env.RUN_NODE) {
  serve({
    fetch: app.fetch,
    port: PORT,
  });
}

export default app;
