import { getStore } from '@netlify/blobs';

// Catálogo de premios canjeables por puntos — Grupo Rolmar
// Cada premio se guarda como su propio blob: reward:<id>
// Un índice guarda la lista de ids: rewards:index
// quantity puede ser un número (stock limitado) o null (stock ilimitado)

const store = () => getStore({ name: 'rolmar-rewards', consistency: 'strong' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

async function getIndex(s) {
  const index = await s.get('rewards:index', { type: 'json' });
  return index || [];
}

async function saveIndex(s, index) {
  await s.setJSON('rewards:index', index);
}

export default async (req) => {
  const s = store();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  try {
    // ---------- GET: listar todos los premios ----------
    if (req.method === 'GET') {
      const index = await getIndex(s);
      const rewards = [];
      for (const rewardId of index) {
        const reward = await s.get(`reward:${rewardId}`, { type: 'json' });
        if (reward) rewards.push(reward);
      }
      rewards.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(200, rewards);
    }

    // ---------- POST: crear premio ----------
    if (req.method === 'POST') {
      const body = await req.json();

      if (!body.name || body.pointsCost === undefined) {
        return jsonResponse(400, { error: 'Falta el nombre o el costo en puntos' });
      }

      const pointsCost = Number(body.pointsCost);
      if (!Number.isFinite(pointsCost) || pointsCost <= 0) {
        return jsonResponse(400, { error: 'El costo en puntos debe ser un número mayor a 0' });
      }

      // quantity: si viene vacío/undefined/null, el premio queda con stock ilimitado
      let quantity = null;
      if (body.quantity !== undefined && body.quantity !== null && body.quantity !== '') {
        quantity = Number(body.quantity);
        if (!Number.isFinite(quantity) || quantity < 0) {
          return jsonResponse(400, { error: 'La cantidad disponible no es válida' });
        }
      }

      const newId = crypto.randomUUID();
      const reward = {
        id: newId,
        name: String(body.name).trim(),
        description: body.description ? String(body.description).trim() : '',
        photo: body.photo || '',
        pointsCost,
        quantity,
        active: body.active !== undefined ? Boolean(body.active) : true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await s.setJSON(`reward:${newId}`, reward);

      const index = await getIndex(s);
      index.push(newId);
      await saveIndex(s, index);

      return jsonResponse(201, reward);
    }

    // ---------- PUT: editar premio ----------
    if (req.method === 'PUT') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del premio' });

      const existing = await s.get(`reward:${id}`, { type: 'json' });
      if (!existing) return jsonResponse(404, { error: 'Premio no encontrado' });

      const body = await req.json();

      let quantity = existing.quantity;
      if (body.quantity !== undefined) {
        if (body.quantity === null || body.quantity === '') {
          quantity = null; // ilimitado
        } else {
          const q = Number(body.quantity);
          if (!Number.isFinite(q) || q < 0) {
            return jsonResponse(400, { error: 'La cantidad disponible no es válida' });
          }
          quantity = q;
        }
      }

      let pointsCost = existing.pointsCost;
      if (body.pointsCost !== undefined) {
        const p = Number(body.pointsCost);
        if (!Number.isFinite(p) || p <= 0) {
          return jsonResponse(400, { error: 'El costo en puntos debe ser un número mayor a 0' });
        }
        pointsCost = p;
      }

      const updated = {
        ...existing,
        name: body.name !== undefined ? String(body.name).trim() : existing.name,
        description: body.description !== undefined ? String(body.description).trim() : existing.description,
        photo: body.photo !== undefined ? body.photo : existing.photo,
        pointsCost,
        quantity,
        active: body.active !== undefined ? Boolean(body.active) : existing.active,
        updatedAt: Date.now()
      };

      await s.setJSON(`reward:${id}`, updated);
      return jsonResponse(200, updated);
    }

    // ---------- DELETE: eliminar premio ----------
    if (req.method === 'DELETE') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del premio' });

      await s.delete(`reward:${id}`);

      const index = await getIndex(s);
      await saveIndex(s, index.filter((rewardId) => rewardId !== id));

      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en rewards function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/rewards'
};
