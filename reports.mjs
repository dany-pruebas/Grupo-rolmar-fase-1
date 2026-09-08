import { getStore } from '@netlify/blobs';

// Reportes de ventas de Grupo Rolmar
// Junta pedidos (rolmar-orders) y cuentas (rolmar-accounts) para armar
// las métricas que se muestran en reportes.html.
//
// GET /.netlify/functions/reports?range=7|30|90|all   (por defecto: 30)

const ordersStore = () => getStore({ name: 'rolmar-orders', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });

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

function dayKey(ts) {
  const d = new Date(ts);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

export default async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse(200, {});
  if (req.method !== 'GET') return jsonResponse(405, { error: 'Método no permitido' });

  try {
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get('range') || '30';
    const days = rangeParam === 'all' ? null : parseInt(rangeParam, 10) || 30;
    const since = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

    const os = ordersStore();
    const as = accountsStore();

    // ---------- Traer todos los pedidos ----------
    const orderIndex = (await os.get('orders:index', { type: 'json' })) || [];
    const allOrders = [];
    for (const orderId of orderIndex) {
      const order = await os.get(`order:${orderId}`, { type: 'json' });
      if (order) allOrders.push(order);
    }

    const orders = allOrders.filter(o => (o.createdAt || 0) >= since);
    const validOrders = orders.filter(o => o.status !== 'cancelado');

    // ---------- Métricas generales ----------
    const totalRevenue = validOrders.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
    const totalOrders = orders.length;
    const avgOrderValue = validOrders.length > 0 ? totalRevenue / validOrders.length : 0;
    const pointsIssued = validOrders.reduce((sum, o) => sum + (Number(o.pointsEarned) || 0), 0);

    // ---------- Pedidos por estado ----------
    const ordersByStatus = { pendiente: 0, preparando: 0, enviado: 0, completado: 0, cancelado: 0 };
    for (const o of orders) {
      if (ordersByStatus[o.status] !== undefined) ordersByStatus[o.status]++;
    }

    // ---------- Ventas por día ----------
    const salesByDay = {};
    for (const o of validOrders) {
      const key = dayKey(o.createdAt);
      if (!salesByDay[key]) salesByDay[key] = { date: key, total: 0, count: 0 };
      salesByDay[key].total += Number(o.total) || 0;
      salesByDay[key].count += 1;
    }
    const dailySales = Object.values(salesByDay).sort((a, b) => a.date.localeCompare(b.date));

    // ---------- Productos más vendidos ----------
    const productStats = {};
    for (const o of validOrders) {
      for (const item of (o.items || [])) {
        const key = item.productId || item.name;
        if (!productStats[key]) {
          productStats[key] = { productId: item.productId, name: item.name, quantitySold: 0, revenue: 0 };
        }
        productStats[key].quantitySold += Number(item.quantity) || 0;
        productStats[key].revenue += (Number(item.price) || 0) * (Number(item.quantity) || 0);
      }
    }
    const topProducts = Object.values(productStats)
      .sort((a, b) => b.quantitySold - a.quantitySold)
      .slice(0, 8);

    // ---------- Clientes nuevos en el rango ----------
    const { blobs: userBlobs } = await as.list({ prefix: 'user:' });
    let newClients = 0;
    for (const blob of userBlobs) {
      const user = await as.get(blob.key, { type: 'json' });
      if (user && (user.createdAt || 0) >= since) newClients++;
    }

    return jsonResponse(200, {
      range: rangeParam,
      totalRevenue,
      totalOrders,
      avgOrderValue,
      pointsIssued,
      ordersByStatus,
      dailySales,
      topProducts,
      newClients
    });
  } catch (err) {
    console.error('Error en reports function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/reports'
};
