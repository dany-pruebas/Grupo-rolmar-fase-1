import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

// Cuentas de cliente para Grupo Rolmar
// Usuarios:  user:<email>        -> { name, email, passwordHash, salt, points, createdAt }
// Sesiones:  session:<token>     -> { email, createdAt }
// consistency: 'strong' para que login/registro se reflejen de inmediato

const store = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function publicUser(user) {
  return { name: user.name, email: user.email, points: user.points || 0, createdAt: user.createdAt };
}

export default async (req) => {
  const s = store();
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  try {
    // ---------- GET: validar sesión (?token=...) ----------
    if (req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!token) return jsonResponse(400, { error: 'Falta el token' });

      const session = await s.get(`session:${token}`, { type: 'json' });
      if (!session) return jsonResponse(401, { error: 'Sesión inválida o expirada' });

      const user = await s.get(`user:${session.email}`, { type: 'json' });
      if (!user) return jsonResponse(401, { error: 'Sesión inválida' });

      return jsonResponse(200, { user: publicUser(user) });
    }

    if (req.method === 'POST') {
      const body = await req.json();
      const action = body.action;

      // ---------- Registro ----------
      if (action === 'register') {
        const name = (body.name || '').trim();
        const email = (body.email || '').trim().toLowerCase();
        const password = body.password || '';

        if (!name || !email || !password) {
          return jsonResponse(400, { error: 'Completa nombre, correo y contraseña' });
        }
        if (password.length < 6) {
          return jsonResponse(400, { error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        const existing = await s.get(`user:${email}`, { type: 'json' });
        if (existing) {
          return jsonResponse(409, { error: 'Ya existe una cuenta con ese correo' });
        }

        const salt = randomBytes(16).toString('hex');
        const passwordHash = hashPassword(password, salt);

        const user = {
          name,
          email,
          passwordHash,
          salt,
          points: 0,
          createdAt: Date.now()
        };
        await s.setJSON(`user:${email}`, user);

        const token = randomUUID();
        await s.setJSON(`session:${token}`, { email, createdAt: Date.now() });

        return jsonResponse(201, { token, user: publicUser(user) });
      }

      // ---------- Login ----------
      if (action === 'login') {
        const email = (body.email || '').trim().toLowerCase();
        const password = body.password || '';

        const user = await s.get(`user:${email}`, { type: 'json' });
        if (!user) return jsonResponse(401, { error: 'Correo o contraseña incorrectos' });

        const attemptHash = hashPassword(password, user.salt);
        const a = Buffer.from(attemptHash, 'hex');
        const b = Buffer.from(user.passwordHash, 'hex');
        const valid = a.length === b.length && timingSafeEqual(a, b);

        if (!valid) return jsonResponse(401, { error: 'Correo o contraseña incorrectos' });

        const token = randomUUID();
        await s.setJSON(`session:${token}`, { email, createdAt: Date.now() });

        return jsonResponse(200, { token, user: publicUser(user) });
      }

      // ---------- Logout ----------
      if (action === 'logout') {
        const token = body.token;
        if (token) await s.delete(`session:${token}`);
        return jsonResponse(200, { ok: true });
      }

      return jsonResponse(400, { error: 'Acción no reconocida' });
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en auth function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/auth'
};
