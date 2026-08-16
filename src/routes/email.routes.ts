import { Hono } from 'hono';
import jwt from 'jsonwebtoken';
import { db, UserRecord, TaskRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';
import {
  getGoogleOAuthUrl,
  getGoogleOAuthRedirectUri,
  exchangeCodeForTokens,
  getDailyEmailsWithImportance,
  refreshGoogleAccessToken,
} from '../services/email.service.js';

const emails = new Hono<HonoEnv>();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hono_neon_2026';

function generateToken(user: { id: string; email: string; name: string }) {
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// Public endpoint for OAuth callback from Google
emails.get('/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error || !code) {
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Authorization Failed</title></head>
        <body style="font-family: sans-serif; display: grid; place-content: center; height: 100vh; background: #0f172a; color: white;">
          <h2>Google Authorization Cancelled or Failed</h2>
          <p>You can close this window and try again.</p>
          <script>
            setTimeout(() => window.close(), 3000);
          </script>
        </body>
      </html>
    `);
  }

  try {
    const host = c.req.header('host') || 'taskm-r2m0.onrender.com';
    const protocol = c.req.header('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
    const redirectUri = getGoogleOAuthRedirectUri(host, protocol);

    const tokens = await exchangeCodeForTokens(code, redirectUri);
    const accessToken = tokens.access_token;
    const refreshToken = tokens.refresh_token;

    let googleUser: { email: string; name: string; id: string } | null = null;
    let jwtToken: string | null = null;
    let dbUser: UserRecord | null = null;

    if (accessToken && !accessToken.startsWith('mock_')) {
      try {
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (userRes.ok) {
          googleUser = await userRes.json();
        }
      } catch (err) {
        console.warn('Failed to fetch userinfo from Google:', err);
      }
    }

    if (googleUser) {
      const email = googleUser.email;
      const name = googleUser.name || email.split('@')[0];
      const googleId = googleUser.id;

      let result = await db.query<UserRecord>('SELECT * FROM users WHERE email = $1 OR google_id = $2', [
        email,
        googleId || email,
      ]);

      if (result.rows.length > 0) {
        dbUser = result.rows[0];
        await db.query(
          'UPDATE users SET google_access_token = $1, google_refresh_token = COALESCE($2, google_refresh_token), google_id = COALESCE(google_id, $3) WHERE id = $4',
          [accessToken, refreshToken || null, googleId, dbUser.id]
        );
      } else {
        const inserted = await db.query<UserRecord>(
          'INSERT INTO users (email, password_hash, name, google_id, google_access_token, google_refresh_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
          [email, 'oauth_google', name, googleId, accessToken, refreshToken || null]
        );
        dbUser = inserted.rows[0];
      }

      jwtToken = generateToken(dbUser);
    }

    // Render success HTML that signals opener window and closes pop-up
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Authorization Success</title></head>
        <body style="font-family: sans-serif; display: grid; place-content: center; height: 100vh; background: #0f172a; color: white; text-align: center;">
          <div style="background: #1e293b; padding: 32px; border-radius: 16px; border: 1px solid #334155;">
            <h2 style="color: #38bdf8; margin-top: 0;">✅ Google Authorization Success!</h2>
            <p style="color: #94a3b8;">Closing this window...</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'GOOGLE_OAUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
              ${
                jwtToken && dbUser
                  ? `window.opener.postMessage({
                      type: 'GOOGLE_LOGIN_SUCCESS',
                      token: ${JSON.stringify(jwtToken)},
                      user: ${JSON.stringify({ id: dbUser.id, email: dbUser.email, name: dbUser.name })}
                    }, '*');`
                  : ''
              }
            }
            setTimeout(() => window.close(), 1200);
          </script>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error('OAuth Callback error:', err);
    return c.html(`<h3>OAuth Token Exchange Failed</h3><p>${err.message}</p>`);
  }
});

// Public endpoint to get Google OAuth login URL
emails.get('/connect', async (c) => {
  const host = c.req.header('host') || 'taskm-r2m0.onrender.com';
  const protocol = c.req.header('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  const url = getGoogleOAuthUrl(host, protocol);
  return c.json({ url });
});

// Protect remaining private routes with authMiddleware
emails.use('*', authMiddleware);

// GET /api/emails/status
emails.get('/status', async (c) => {
  try {
    const userPayload = c.get('user') as JwtPayload;
    if (!userPayload?.userId) {
      return c.json({ isConnected: false });
    }

    const res = await db.query<UserRecord>(
      'SELECT email, google_id, google_access_token FROM users WHERE id = $1',
      [userPayload.userId]
    );

    const user = res.rows[0];
    const isConnected = Boolean(user && user.google_access_token);

    return c.json({
      isConnected,
      email: isConnected ? user?.email : undefined,
      googleId: user?.google_id,
    });
  } catch (err: any) {
    console.error('Email status error:', err);
    return c.json({ isConnected: false, error: err.message });
  }
});

// POST /api/emails/save-tokens
emails.post('/save-tokens', async (c) => {
  try {
    const userPayload = c.get('user') as JwtPayload;
    const { accessToken, refreshToken } = await c.req.json();

    await db.query('UPDATE users SET google_access_token = $1, google_refresh_token = $2 WHERE id = $3', [
      accessToken || 'mock_access_token',
      refreshToken || 'mock_refresh_token',
      userPayload.userId,
    ]);

    return c.json({ message: 'Google OAuth tokens updated successfully' });
  } catch (err: any) {
    console.error('Save tokens error:', err);
    return c.json({ error: 'Failed to save tokens' }, 500);
  }
});

// POST /api/emails/disconnect
emails.post('/disconnect', async (c) => {
  try {
    const userPayload = c.get('user') as JwtPayload;
    await db.query('UPDATE users SET google_access_token = NULL, google_refresh_token = NULL WHERE id = $1', [
      userPayload.userId,
    ]);
    return c.json({ message: 'Disconnected Google account successfully' });
  } catch (err: any) {
    console.error('Disconnect error:', err);
    return c.json({ error: 'Failed to disconnect account' }, 500);
  }
});

// GET /api/emails/daily
emails.get('/daily', async (c) => {
  try {
    const userPayload = c.get('user') as JwtPayload;
    const result = await db.query<UserRecord>('SELECT google_access_token, google_refresh_token FROM users WHERE id = $1', [
      userPayload.userId,
    ]);

    let accessToken = result.rows[0]?.google_access_token || null;
    const refreshToken = result.rows[0]?.google_refresh_token || null;

    let digestData = await getDailyEmailsWithImportance(accessToken);

    // If fetch failed due to expired token and we have a refresh token, auto-refresh and retry
    if (digestData.summary.totalEmails === 0 && digestData.summary.overview.includes('re-authorize') && refreshToken) {
      const newAccessToken = await refreshGoogleAccessToken(refreshToken);
      if (newAccessToken) {
        await db.query('UPDATE users SET google_access_token = $1 WHERE id = $2', [newAccessToken, userPayload.userId]);
        digestData = await getDailyEmailsWithImportance(newAccessToken);
      }
    }

    return c.json(digestData);
  } catch (err: any) {
    console.error('Daily emails fetch error:', err);
    return c.json({ error: 'Failed to fetch daily emails' }, 500);
  }
});

// POST /api/emails/convert-task
emails.post('/convert-task', async (c) => {
  try {
    const userPayload = c.get('user') as JwtPayload;
    const { title, priority, dueDate, projectId } = await c.req.json();

    if (!title) {
      return c.json({ error: 'Task title is required' }, 400);
    }

    const taskPriority = priority || 'High';
    const taskDueDate = dueDate || new Date().toISOString().split('T')[0];

    const newTaskId = crypto.randomUUID();
    const result = await db.query<TaskRecord>(
      `INSERT INTO tasks (id, user_id, project_id, title, priority, due_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [newTaskId, userPayload.userId, projectId || null, title, taskPriority, taskDueDate, 'Todo']
    );

    return c.json({
      message: 'Email converted to task successfully!',
      task: result.rows[0] || { id: newTaskId, user_id: userPayload.userId, project_id: projectId || null, title, priority: taskPriority, due_date: taskDueDate, status: 'Todo' },
    });
  } catch (err: any) {
    console.error('Convert email to task error:', err);
    return c.json({ error: 'Failed to convert email to task' }, 500);
  }
});

export default emails;
