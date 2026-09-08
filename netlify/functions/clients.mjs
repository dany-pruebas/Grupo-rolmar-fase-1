import { getStore } from '@netlify/blobs';

// Listado de clientes de Grupo Rolmar
// Junta las cuentas (rolmar-accounts) con sus pedidos (rolmar-orders)
// para mostrarle al staff nombre, correo, puntos, cantidad de pedidos y total gastado.

const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });
const ordersStore = () => getStore({ name: 'rolmar-orders', consistency: 'strong' });

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse(200, {});
  if (req.method !== 'GET') return jsonResponse(405, { error: 'Método no permitido' });

  try {
    const as = accountsStore();
    const os = ordersStore();

    // ---------- Traer todas las cuentas de cliente ----------
    const { blobs: userBlobs } = await as.list({ prefix: 'user:' });
    const users = [];
    for (const blob of userBlobs) {
      const user = await as.get(blob.key, { type: 'json' });
      if (user) users.push(user);
    }

    // ---------- Agregar estadísticas de pedidos por correo ----------
    const orderIndex = (await os.get('orders:index', { type: 'json' })) || [];
    const statsByEmail = {};

    for (const orderId of orderIndex) {
      const order = await os.get(`order:${orderId}`, { type: 'json' });
      if (!order) continue;

      const s = statsByEmail[order.email] || { ordersCount: 0, totalSpent: 0, lastOrderAt: 0 };
      s.ordersCount += 1;
      if (order.status !== 'cancelado') {
        s.totalSpent += Number(order.total) || 0;
      }
      if (order.createdAt > s.lastOrderAt) s.lastOrderAt = order.createdAt;
      statsByEmail[order.email] = s;
    }

    // ---------- Combinar ----------
    const clients = users.map((u) => {
      const s = statsByEmail[u.email] || { ordersCount: 0, totalSpent: 0, lastOrderAt: 0 };
      return {
        name: u.name,
        email: u.email,
        points: u.points || 0,
        createdAt: u.createdAt || 0,
        ordersCount: s.ordersCount,
        totalSpent: s.totalSpent,
        lastOrderAt: s.lastOrderAt || null
      };
    });

    // Clientes con compra más reciente primero
    clients.sort((a, b) => (b.lastOrderAt || 0) - (a.lastOrderAt || 0));

    return jsonResponse(200, clients);
  } catch (err) {
    console.error('Error en clients function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/clients'
};
