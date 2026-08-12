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

// CORS configuration supporting Production, Localhost, Vercel & Render origins
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (
        !origin ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1') ||
        origin === FRONTEND_URL ||
        origin.endsWith('.vercel.app') ||
        origin.endsWith('.onrender.com')
      ) {
        return origin || FRONTEND_URL;
      }
      return FRONTEND_URL;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Root Endpoint for Render / Deployment Health Check
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    message: 'Task Manager API Server Running',
    health: '/health',
  });
});

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

// Always start HTTP server on 0.0.0.0 for Render / Node.js runtime
serve(
  {
    fetch: app.fetch,
    port: PORT,
    hostname: '0.0.0.0',
  },
  (info) => {
    console.log(`🚀 Hono Server listening on http://0.0.0.0:${info.port}`);
    console.log(
      `🗄️ Database mode: ${
        db.isInMemory() ? 'In-Memory Fallback (Zero-Config Active)' : 'Neon Postgres Connected'
      }`
    );
  }
);

export default app;
