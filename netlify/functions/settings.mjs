import { getStore } from '@netlify/blobs';

// Configuración general de Grupo Rolmar
// store:config -> { storeName, whatsapp, contactEmail, pointsPerQuetzal, updatedAt }

const settingsStore = () => getStore({ name: 'rolmar-settings', consistency: 'strong' });

const DEFAULT_SETTINGS = {
  storeName: 'Grupo Rolmar',
  whatsapp: '',
  contactEmail: 'contacto@gruporolmar.com',
  pointsPerQuetzal: 1,
  updatedAt: null
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default async (req) => {
  const s = settingsStore();

  if (req.method === 'OPTIONS') return jsonResponse(200, {});

  try {
    // ---------- GET: leer configuración actual ----------
    if (req.method === 'GET') {
      const saved = await s.get('store:config', { type: 'json' });
      return jsonResponse(200, { ...DEFAULT_SETTINGS, ...(saved || {}) });
    }

    // ---------- PUT/POST: actualizar configuración ----------
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = await req.json();
      const current = (await s.get('store:config', { type: 'json' })) || {};

      const storeName = body.storeName !== undefined
        ? String(body.storeName).trim().slice(0, 60)
        : current.storeName;

      const whatsapp = body.whatsapp !== undefined
        ? String(body.whatsapp).trim().slice(0, 30)
        : current.whatsapp;

      const contactEmail = body.contactEmail !== undefined
        ? String(body.contactEmail).trim().slice(0, 80)
        : current.contactEmail;

      let pointsPerQuetzal = body.pointsPerQuetzal !== undefined
        ? Number(body.pointsPerQuetzal)
        : current.pointsPerQuetzal;

      if (!Number.isFinite(pointsPerQuetzal) || pointsPerQuetzal < 0) {
        pointsPerQuetzal = DEFAULT_SETTINGS.pointsPerQuetzal;
      }

      const updated = {
        ...DEFAULT_SETTINGS,
        ...current,
        storeName: storeName || DEFAULT_SETTINGS.storeName,
        whatsapp: whatsapp || '',
        contactEmail: contactEmail || DEFAULT_SETTINGS.contactEmail,
        pointsPerQuetzal,
        updatedAt: Date.now()
      };

      await s.setJSON('store:config', updated);
      return jsonResponse(200, updated);
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en settings function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/settings'
};
