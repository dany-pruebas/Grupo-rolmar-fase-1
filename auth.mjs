import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';

// Cuentas de cliente para Grupo Rolmar
// Usuarios:  user:<llave>        -> { name, email, phone, passwordHash, salt, points, creditBalance, savedAddress, createdAt }
//            <llave> = el correo, o "tel:<numero>" si la cuenta se creó solo con teléfono
//            (el campo email guarda esa llave; al cliente se le devuelve vacío si es "tel:...")
//            savedAddress: { fullName, phone, line1, city, reference } | null
//            phone: teléfono normalizado (solo dígitos, 8 dígitos de Guatemala) o null en cuentas viejas
// Teléfonos: phone:<digitos>     -> { email }   (índice para poder ingresar con el número)
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
  return {
    name: user.name,
    email: String(user.email).startsWith('tel:') ? '' : user.email,
    phone: user.phone || '',
    points: user.points || 0,
    creditBalance: user.creditBalance || 0,
    savedAddress: user.savedAddress || null,
    createdAt: user.createdAt
  };
}

// ---------- Normalizar teléfono: solo dígitos, sin el 502 de Guatemala ----------
// Devuelve el número normalizado o null si no parece válido (mínimo 8 dígitos).
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('502')) digits = digits.slice(3);
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

// ---------- Validar y normalizar una dirección de entrega ----------
function resolveAddress(rawAddress) {
  if (!rawAddress || !rawAddress.fullName || !rawAddress.phone || !rawAddress.line1) {
    return { error: 'Falta completar nombre, teléfono y dirección' };
  }
  return {
    address: {
      fullName: String(rawAddress.fullName).trim(),
      phone: String(rawAddress.phone).trim(),
      line1: String(rawAddress.line1).trim(),
      city: rawAddress.city ? String(rawAddress.city).trim() : '',
      reference: rawAddress.reference ? String(rawAddress.reference).trim() : ''
    }
  };
}

// ---------- Sesión -> usuario ----------
async function getSessionUser(s, token) {
  if (!token) return { error: 'Falta iniciar sesión', status: 401 };
  const session = await s.get(`session:${token}`, { type: 'json' });
  if (!session) return { error: 'Sesión inválida o expirada', status: 401 };
  const user = await s.get(`user:${session.email}`, { type: 'json' });
  if (!user) return { error: 'Sesión inválida', status: 401 };
  return { user };
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
        const rawEmail = (body.email || '').trim().toLowerCase();
        const rawPhone = (body.phone || '').trim();
        const password = body.password || '';

        // Correo y teléfono son opcionales, pero hace falta al menos uno
        if (!name || !password) {
          return jsonResponse(400, { error: 'Completa nombre y contraseña' });
        }
        if (!rawEmail && !rawPhone) {
          return jsonResponse(400, { error: 'Ingresa un correo o un teléfono' });
        }
        if (rawEmail && !rawEmail.includes('@')) {
          return jsonResponse(400, { error: 'Revisa el correo' });
        }
        const phone = rawPhone ? normalizePhone(rawPhone) : '';
        if (rawPhone && !phone) {
          return jsonResponse(400, { error: 'Ingresa un teléfono válido (8 dígitos)' });
        }
        if (password.length < 6) {
          return jsonResponse(400, { error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        if (rawEmail) {
          const existing = await s.get(`user:${rawEmail}`, { type: 'json' });
          if (existing) {
            return jsonResponse(409, { error: 'Ya existe una cuenta con ese correo' });
          }
        }
        if (phone) {
          const phoneOwner = await s.get(`phone:${phone}`, { type: 'json' });
          if (phoneOwner) {
            return jsonResponse(409, { error: 'Ya existe una cuenta con ese teléfono' });
          }
        }

        // Llave interna de la cuenta: el correo, o "tel:<numero>" si se registró solo con teléfono.
        // (Todo el sistema — pedidos, canjes, notificaciones — identifica al cliente por esta llave.)
        const key = rawEmail || `tel:${phone}`;

        const salt = randomBytes(16).toString('hex');
        const passwordHash = hashPassword(password, salt);

        const user = {
          name,
          email: key,
          phone: phone || '',
          passwordHash,
          salt,
          points: 0,
          creditBalance: 0,
          savedAddress: null,
          createdAt: Date.now()
        };
        await s.setJSON(`user:${key}`, user);
        if (phone) await s.setJSON(`phone:${phone}`, { email: key });

        const token = randomUUID();
        await s.setJSON(`session:${token}`, { email: key, createdAt: Date.now() });

        return jsonResponse(201, { token, user: publicUser(user) });
      }

      // ---------- Login (correo o teléfono) ----------
      // "identifier" puede ser un correo o un número. También se acepta "email" por compatibilidad.
      if (action === 'login') {
        const identifier = String(body.identifier ?? body.email ?? '').trim();
        const password = body.password || '';
        const genericError = 'Usuario o contraseña incorrectos';

        let email = null;
        if (identifier.includes('@')) {
          email = identifier.toLowerCase();
        } else {
          const phone = normalizePhone(identifier);
          if (phone) {
            const idx = await s.get(`phone:${phone}`, { type: 'json' });
            if (idx && idx.email) email = idx.email;
          }
        }
        if (!email) return jsonResponse(401, { error: genericError });

        const user = await s.get(`user:${email}`, { type: 'json' });
        if (!user) return jsonResponse(401, { error: genericError });

        const attemptHash = hashPassword(password, user.salt);
        const a = Buffer.from(attemptHash, 'hex');
        const b = Buffer.from(user.passwordHash, 'hex');
        const valid = a.length === b.length && timingSafeEqual(a, b);

        if (!valid) return jsonResponse(401, { error: genericError });

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

      // ---------- Agregar teléfono a una cuenta que aún no tiene (cuentas creadas solo con correo) ----------
      if (action === 'updatePhone') {
        const { user, error, status } = await getSessionUser(s, body.token);
        if (error) return jsonResponse(status, { error });

        if (user.phone) {
          return jsonResponse(400, { error: 'Tu cuenta ya tiene un teléfono registrado' });
        }

        const phone = normalizePhone(body.phone);
        if (!phone) return jsonResponse(400, { error: 'Ingresa un teléfono válido (8 dígitos)' });

        const phoneOwner = await s.get(`phone:${phone}`, { type: 'json' });
        if (phoneOwner && phoneOwner.email !== user.email) {
          return jsonResponse(409, { error: 'Ese teléfono ya está en otra cuenta' });
        }

        const updatedUser = { ...user, phone };
        await s.setJSON(`user:${user.email}`, updatedUser);
        await s.setJSON(`phone:${phone}`, { email: user.email });

        return jsonResponse(200, { user: publicUser(updatedUser) });
      }

      // ---------- Guardar / actualizar la dirección de entrega guardada ----------
      // Se usa desde "Mi cuenta" para editar la dirección sin tener que comprar o canjear.
      if (action === 'updateAddress') {
        const { user, error, status } = await getSessionUser(s, body.token);
        if (error) return jsonResponse(status, { error });

        const { address, error: addrError } = resolveAddress(body.address);
        if (addrError) return jsonResponse(400, { error: addrError });

        const updatedUser = { ...user, savedAddress: address };
        await s.setJSON(`user:${user.email}`, updatedUser);

        return jsonResponse(200, { user: publicUser(updatedUser) });
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
