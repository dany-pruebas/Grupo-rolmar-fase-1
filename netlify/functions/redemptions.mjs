import { getStore } from '@netlify/blobs';

// Canjes de puntos de Grupo Rolmar
// Cubre dos tipos de canje:
//   - "discount": el cliente convierte puntos en un vale de descuento con código,
//     usando la tasa configurada en Configuración (pointsToQuetzalRate).
//   - "reward": el cliente canjea puntos por un premio del catálogo (rewards.mjs).
//
// redemption:<id> -> {
//   id, email, customerName, type, pointsUsed, status, createdAt,
//   // solo si type === 'discount':
//   voucherCode, discountValue,
//   // solo si type === 'reward':
//   rewardId, rewardName, rewardPhoto
// }
// redemptions:index -> [ids]
//
// Estados:
//   discount -> disponible | usado | cancelado
//   reward   -> pendiente | entregado | cancelado

const redemptionsStore = () => getStore({ name: 'rolmar-redemptions', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });
const rewardsStore = () => getStore({ name: 'rolmar-rewards', consistency: 'strong' });
const settingsStore = () => getStore({ name: 'rolmar-settings', consistency: 'strong' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

async function getIndex(s) {
  const index = await s.get('redemptions:index', { type: 'json' });
  return index || [];
}
async function saveIndex(s, index) {
  await s.setJSON('redemptions:index', index);
}

// ---------- Tasa de canje: cuántos puntos equivalen a Q1 de descuento ----------
async function getPointsToQuetzalRate() {
  try {
    const settings = await settingsStore().get('store:config', { type: 'json' });
    const rate = settings ? Number(settings.pointsToQuetzalRate) : NaN;
    return Number.isFinite(rate) && rate > 0 ? rate : 10; // por defecto: 10 puntos = Q1
  } catch (err) {
    return 10;
  }
}

function generateVoucherCode() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

export default async (req) => {
  const rs = redemptionsStore();
  const as = accountsStore();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'OPTIONS') return jsonResponse(200, {});

  try {
    // ---------- GET: listar canjes ----------
    // Sin token = todos (admin). Con ?token= = solo los del cliente dueño de la sesión.
    if (req.method === 'GET') {
      const token = url.searchParams.get('token');
      let email = null;

      if (token) {
        const session = await as.get(`session:${token}`, { type: 'json' });
        if (!session) return jsonResponse(401, { error: 'Sesión inválida' });
        email = session.email;
      }

      const index = await getIndex(rs);
      const redemptions = [];
      for (const redemptionId of index) {
        const redemption = await rs.get(`redemption:${redemptionId}`, { type: 'json' });
        if (redemption && (!email || redemption.email === email)) redemptions.push(redemption);
      }
      redemptions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(200, redemptions);
    }

    // ---------- POST: crear canje ----------
    if (req.method === 'POST') {
      const body = await req.json();
      const token = body.token;
      const type = body.type;

      if (!token) return jsonResponse(401, { error: 'Falta iniciar sesión' });
      if (type !== 'discount' && type !== 'reward') {
        return jsonResponse(400, { error: 'Tipo de canje no válido' });
      }

      const session = await as.get(`session:${token}`, { type: 'json' });
      if (!session) return jsonResponse(401, { error: 'Sesión inválida o expirada' });

      const user = await as.get(`user:${session.email}`, { type: 'json' });
      if (!user) return jsonResponse(401, { error: 'Sesión inválida' });

      const currentPoints = user.points || 0;

      // ---------- Canje por descuento ----------
      if (type === 'discount') {
        const points = Number(body.points);
        if (!Number.isFinite(points) || points <= 0 || !Number.isInteger(points)) {
          return jsonResponse(400, { error: 'Ingresa una cantidad válida de puntos' });
        }
        if (points > currentPoints) {
          return jsonResponse(400, { error: 'No tienes suficientes puntos' });
        }

        const rate = await getPointsToQuetzalRate();
        const discountValue = Math.round((points / rate) * 100) / 100;

        if (discountValue <= 0) {
          return jsonResponse(400, { error: 'Esa cantidad de puntos no alcanza para un descuento' });
        }

        const updatedUser = { ...user, points: currentPoints - points };
        await as.setJSON(`user:${user.email}`, updatedUser);

        const redemptionId = crypto.randomUUID();
        const redemption = {
          id: redemptionId,
          email: user.email,
          customerName: user.name,
          type: 'discount',
          pointsUsed: points,
          voucherCode: generateVoucherCode(),
          discountValue,
          status: 'disponible',
          createdAt: Date.now()
        };
        await rs.setJSON(`redemption:${redemptionId}`, redemption);
        const index = await getIndex(rs);
        index.push(redemptionId);
        await saveIndex(rs, index);

        return jsonResponse(201, { redemption, points: updatedUser.points });
      }

      // ---------- Canje por premio ----------
      if (type === 'reward') {
        const rewardId = body.rewardId;
        if (!rewardId) return jsonResponse(400, { error: 'Falta el premio a canjear' });

        const rw = rewardsStore();
        const reward = await rw.get(`reward:${rewardId}`, { type: 'json' });
        if (!reward) return jsonResponse(404, { error: 'Ese premio ya no existe' });
        if (reward.active === false) return jsonResponse(400, { error: 'Ese premio ya no está disponible' });
        if (reward.quantity !== null && reward.quantity !== undefined && Number(reward.quantity) <= 0) {
          return jsonResponse(400, { error: 'Ese premio ya no tiene existencias' });
        }
        if (currentPoints < reward.pointsCost) {
          return jsonResponse(400, { error: 'No tienes suficientes puntos para este premio' });
        }

        const updatedUser = { ...user, points: currentPoints - reward.pointsCost };
        await as.setJSON(`user:${user.email}`, updatedUser);

        if (reward.quantity !== null && reward.quantity !== undefined) {
          const updatedReward = { ...reward, quantity: Number(reward.quantity) - 1, updatedAt: Date.now() };
          await rw.setJSON(`reward:${reward.id}`, updatedReward);
        }

        const redemptionId = crypto.randomUUID();
        const redemption = {
          id: redemptionId,
          email: user.email,
          customerName: user.name,
          type: 'reward',
          pointsUsed: reward.pointsCost,
          rewardId: reward.id,
          rewardName: reward.name,
          rewardPhoto: reward.photo || '',
          status: 'pendiente',
          createdAt: Date.now()
        };
        await rs.setJSON(`redemption:${redemptionId}`, redemption);
        const index = await getIndex(rs);
        index.push(redemptionId);
        await saveIndex(rs, index);

        return jsonResponse(201, { redemption, points: updatedUser.points });
      }
    }

    // ---------- PUT: admin cambia el estado de un canje ----------
    if (req.method === 'PUT') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del canje' });
      const existing = await rs.get(`redemption:${id}`, { type: 'json' });
      if (!existing) return jsonResponse(404, { error: 'Canje no encontrado' });

      const body = await req.json();
      const newStatus = body.status;
      const validStatuses = existing.type === 'discount'
        ? ['disponible', 'usado', 'cancelado']
        : ['pendiente', 'entregado', 'cancelado'];

      if (!validStatuses.includes(newStatus)) {
        return jsonResponse(400, { error: 'Estado no válido para este tipo de canje' });
      }

      // Si se cancela (y no estaba ya cancelado), se le devuelven los puntos al cliente
      // y, si era un premio con stock limitado, se repone la existencia.
      if (newStatus === 'cancelado' && existing.status !== 'cancelado') {
        const user = await as.get(`user:${existing.email}`, { type: 'json' });
        if (user) {
          const updatedUser = { ...user, points: (user.points || 0) + existing.pointsUsed };
          await as.setJSON(`user:${existing.email}`, updatedUser);
        }

        if (existing.type === 'reward' && existing.rewardId) {
          const rw = rewardsStore();
          const reward = await rw.get(`reward:${existing.rewardId}`, { type: 'json' });
          if (reward && reward.quantity !== null && reward.quantity !== undefined) {
            const updatedReward = { ...reward, quantity: Number(reward.quantity) + 1, updatedAt: Date.now() };
            await rw.setJSON(`reward:${existing.rewardId}`, updatedReward);
          }
        }
      }

      const updated = { ...existing, status: newStatus, updatedAt: Date.now() };
      await rs.setJSON(`redemption:${id}`, updated);
      return jsonResponse(200, updated);
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en redemptions function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/redemptions'
};
