import { getStore } from '@netlify/blobs';

// Suscripciones push de clientes de Grupo Rolmar
// push_sub:<email> -> { subscription, updatedAt }
// Se valida con el mismo token de sesión que usa auth.mjs

const subsStore = () => getStore({ name: 'rolmar-push-subs', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default async (req) => {
  const ss = subsStore();
  const as = accountsStore();

  if (req.method === 'OPTIONS') return jsonResponse(200, {});

  try {
    // ---------- POST: guardar/actualizar suscripción ----------
    if (req.method === 'POST') {
      const body = await req.json();
      const { token, subscription } = body;

      if (!token) return jsonResponse(401, { error: 'Falta iniciar sesión' });
      if (!subscription || !subscription.endpoint) {
        return jsonResponse(400, { error: 'Suscripción inválida' });
      }

      const session = await as.get(`session:${token}`, { type: 'json' });
      if (!session) return jsonResponse(401, { error: 'Sesión inválida o expirada' });

      await ss.setJSON(`push_sub:${session.email}`, {
        subscription,
        updatedAt: Date.now()
      });

      return jsonResponse(200, { ok: true });
    }

    // ---------- DELETE: quitar suscripción (el cliente desactivó notificaciones) ----------
    if (req.method === 'DELETE') {
      const body = await req.json();
      const { token } = body;
      if (!token) return jsonResponse(401, { error: 'Falta iniciar sesión' });

      const session = await as.get(`session:${token}`, { type: 'json' });
      if (!session) return jsonResponse(401, { error: 'Sesión inválida' });

      await ss.delete(`push_sub:${session.email}`);
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en push-subscribe function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/push-subscribe'
};
