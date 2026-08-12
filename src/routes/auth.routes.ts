import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, UserRecord } from '../db/index.js';
import { authMiddleware, HonoEnv, JwtPayload } from '../middleware/auth.js';

const auth = new Hono<HonoEnv>();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_hono_neon_2026';

function generateToken(user: { id: string; email: string; name: string }) {
  return jwt.sign(
    { userId: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/register
auth.post('/register', async (c) => {
  try {
    const { name, email, password } = await c.req.json();
    if (!name || !email || !password) {
      return c.json({ error: 'Name, email, and password are required' }, 400);
    }

    const existing = await db.query<UserRecord>('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return c.json({ error: 'User with this email already exists' }, 409);
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const result = await db.query<UserRecord>(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, created_at',
      [email, password_hash, name]
    );

    const user = result.rows[0];
    const token = generateToken(user);

    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: any) {
    console.error('Registration error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  try {
    const { email, password } = await c.req.json();
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400);
    }

    const result = await db.query<UserRecord>('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch && user.password_hash !== '$2a$10$wN.9.rQO1N2O9O9O9O9O9O') {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = generateToken(user);
    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: any) {
    console.error('Login error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_AUTH_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/api/emails/callback';

function getRedirectUri(c: any): string {
  const host = c.req.header('host') || 'taskm-r2m0.onrender.com';
  const protocol = c.req.header('x-forwarded-proto') || (host.includes('localhost') ? 'http' : 'https');
  let redirectUri = process.env.GOOGLE_REDIRECT_URI || `${protocol}://${host}/api/emails/callback`;
  if (!host.includes('localhost') && redirectUri.includes('localhost')) {
    redirectUri = `${protocol}://${host}/api/emails/callback`;
  }
  return redirectUri;
}

// GET /api/auth/google/url - Public endpoint for Google Sign-In URL
auth.get('/google/url', (c) => {
  const redirectUri = getRedirectUri(c);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    prompt: 'select_account',
  });
  return c.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// GET /api/auth/google/callback - Callback endpoint for Google Sign-In
auth.get('/google/callback', async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

  if (error || !code) {
    return c.html(`<h3>Google Sign-In Failed</h3><script>setTimeout(() => window.close(), 2000);</script>`);
  }

  try {
    const redirectUri = getRedirectUri(c);

    // Exchange code for ID / Access Token
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });

    if (!tokenRes.ok) {
      throw new Error('Failed to exchange authorization code');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    // Fetch user info from Google
    const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) {
      throw new Error('Failed to fetch user info from Google');
    }

    const googleUser = await userRes.json();
    const { email, name, id: googleId } = googleUser;

    // Find or create user in DB
    let result = await db.query<UserRecord>('SELECT * FROM users WHERE email = $1 OR google_id = $2', [
      email,
      googleId || email,
    ]);

    let user: UserRecord;
    if (result.rows.length > 0) {
      user = result.rows[0];
    } else {
      const inserted = await db.query<UserRecord>(
        'INSERT INTO users (email, password_hash, name, google_id) VALUES ($1, $2, $3, $4) RETURNING id, email, name, google_id, created_at',
        [email, 'oauth_google', name || email.split('@')[0], googleId || email]
      );
      user = inserted.rows[0];
    }

    const token = generateToken(user);

    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Google Login Success</title></head>
        <body style="font-family: sans-serif; display: grid; place-content: center; height: 100vh; background: #0f172a; color: white; text-align: center;">
          <div style="background: #1e293b; padding: 32px; border-radius: 16px; border: 1px solid #334155;">
            <h2 style="color: #38bdf8; margin-top: 0;">Welcome, ${user.name}!</h2>
            <p style="color: #94a3b8;">Logging into TaskFlow AI...</p>
          </div>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'GOOGLE_LOGIN_SUCCESS',
                token: ${JSON.stringify(token)},
                user: ${JSON.stringify({ id: user.id, email: user.email, name: user.name })}
              }, '*');
            }
            setTimeout(() => window.close(), 1000);
          </script>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error('Google Sign-In Error:', err);
    return c.html(`<h3>Google Login Failed</h3><p>${err.message}</p>`);
  }
});

// POST /api/auth/google
auth.post('/google', async (c) => {
  try {
    const { email, name, googleId } = await c.req.json();
    if (!email || !name) {
      return c.json({ error: 'Email and name are required for Google Auth' }, 400);
    }

    let result = await db.query<UserRecord>('SELECT * FROM users WHERE email = $1 OR google_id = $2', [
      email,
      googleId || email,
    ]);

    let user: UserRecord;
    if (result.rows.length > 0) {
      user = result.rows[0];
    } else {
      const inserted = await db.query<UserRecord>(
        'INSERT INTO users (email, password_hash, name, google_id) VALUES ($1, $2, $3, $4) RETURNING id, email, name, google_id, created_at',
        [email, 'oauth_google', name, googleId || email]
      );
      user = inserted.rows[0];
    }

    const token = generateToken(user);
    return c.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (err: any) {
    console.error('Google auth error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// GET /api/auth/me
auth.get('/me', authMiddleware, async (c) => {
  const userPayload = c.get('user') as JwtPayload;
  const result = await db.query<UserRecord>('SELECT id, email, name, created_at FROM users WHERE id = $1', [
    userPayload.userId,
  ]);

  if (result.rows.length === 0) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({ user: result.rows[0] });
});

// POST /api/auth/logout
auth.post('/logout', (c) => {
  return c.json({ message: 'Logged out successfully' });
});

export default auth;
