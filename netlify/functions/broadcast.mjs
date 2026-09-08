import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

// Notificaciones masivas de Grupo Rolmar
// Envía un mensaje escrito por el staff a TODOS los clientes con notificaciones activadas.
// Reutiliza las mismas suscripciones que guarda push-subscribe.mjs (rolmar-push-subs).

const pushSubsStore = () => getStore({ name: 'rolmar-push-subs', consistency: 'strong' });

// Misma llave pública que usan orders.mjs y cliente/index.html (no es secreta)
const VAPID_PUBLIC_KEY = 'BPh1GRkaGLyrsTJAOnj5QlVjfJ3y_BvbT-i59MBW4z0DRqxT0acQ6JElzo24EJkyxO72792TM632OM5qhcSZDUY';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:contacto@gruporolmar.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse(200, {});
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Método no permitido' });

  if (!VAPID_PRIVATE_KEY) {
    return jsonResponse(500, { error: 'Falta configurar VAPID_PRIVATE_KEY en Netlify para poder enviar notificaciones' });
  }

  try {
    const body = await req.json();
    const title = (body.title || 'Grupo Rolmar').toString().trim().slice(0, 80);
    const message = (body.message || '').toString().trim().slice(0, 500);

    if (!message) {
      return jsonResponse(400, { error: 'Escribe un mensaje para enviar' });
    }

    const ps = pushSubsStore();
    const { blobs } = await ps.list({ prefix: 'push_sub:' });

    let sent = 0;
    let failed = 0;

    for (const blob of blobs) {
      const record = await ps.get(blob.key, { type: 'json' });
      if (!record || !record.subscription) continue;

      try {
        await webpush.sendNotification(record.subscription, JSON.stringify({
          title,
          body: message,
          url: '/cliente/'
        }));
        sent++;
      } catch (err) {
        failed++;
        // Suscripción vencida o inválida: la limpiamos para no seguir intentando
        if (err.statusCode === 410 || err.statusCode === 404) {
          await ps.delete(blob.key);
        } else {
          console.error('Error enviando push a', blob.key, err.message);
        }
      }
    }

    return jsonResponse(200, { sent, failed, total: blobs.length });
  } catch (err) {
    console.error('Error en broadcast function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/broadcast'
};
