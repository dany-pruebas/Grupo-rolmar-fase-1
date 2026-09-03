import { getStore } from '@netlify/blobs';

// Pedidos de Grupo Rolmar
// order:<id> -> { id, email, customerName, items, total, pointsEarned, status, createdAt }
// orders:index -> [ids]

const ordersStore = () => getStore({ name: 'rolmar-orders', consistency: 'strong' });
const catalogStore = () => getStore({ name: 'rolmar-catalog', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });

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

async function getIndex(s, key) {
  const index = await s.get(key, { type: 'json' });
  return index || [];
}
async function saveIndex(s, key, index) {
  await s.setJSON(key, index);
}

export default async (req) => {
  const os = ordersStore();
  const cs = catalogStore();
  const as = accountsStore();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'OPTIONS') return jsonResponse(200, {});

  try {
    // ---------- GET: listar pedidos ----------
    // Sin token = todos (admin). Con ?token= = solo los de ese cliente.
    if (req.method === 'GET') {
      const token = url.searchParams.get('token');
      let email = null;

      if (token) {
        const session = await as.get(`session:${token}`, { type: 'json' });
        if (!session) return jsonResponse(401, { error: 'Sesión inválida' });
        email = session.email;
      }

      const index = await getIndex(os, 'orders:index');
      const orders = [];
      for (const orderId of index) {
        const order = await os.get(`order:${orderId}`, { type: 'json' });
        if (order && (!email || order.email === email)) orders.push(order);
      }
      orders.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(200, orders);
    }

    // ---------- POST: crear pedido ----------
    if (req.method === 'POST') {
      const body = await req.json();
      const token = body.token;
      const items = body.items; // [{ productId, quantity }]

      if (!token) return jsonResponse(401, { error: 'Falta iniciar sesión' });
      if (!Array.isArray(items) || items.length === 0) {
        return jsonResponse(400, { error: 'El carrito está vacío' });
      }

      const session = await as.get(`session:${token}`, { type: 'json' });
      if (!session) return jsonResponse(401, { error: 'Sesión inválida o expirada' });

      const user = await as.get(`user:${session.email}`, { type: 'json' });
      if (!user) return jsonResponse(401, { error: 'Sesión inválida' });

      // Validar productos y stock
      const resolvedItems = [];
      for (const item of items) {
        const qty = Number(item.quantity);
        if (!item.productId || !qty || qty <= 0) {
          return jsonResponse(400, { error: 'Cantidad inválida en el carrito' });
        }
        const product = await cs.get(`product:${item.productId}`, { type: 'json' });
        if (!product) return jsonResponse(404, { error: 'Un producto del carrito ya no existe' });
        if (Number(product.quantity) < qty) {
          return jsonResponse(400, { error: `No hay suficiente stock de "${product.name}"` });
        }
        resolvedItems.push({ product, qty });
      }

      // Descontar stock
      for (const { product, qty } of resolvedItems) {
        const updated = { ...product, quantity: Number(product.quantity) - qty, updatedAt: Date.now() };
        await cs.setJSON(`product:${product.id}`, updated);
      }

      // Calcular total y puntos (1Q = 1 punto)
      const total = resolvedItems.reduce((sum, { product, qty }) => sum + Number(product.price) * qty, 0);
      const pointsEarned = Math.floor(total);

      // Crear pedido
      const orderId = crypto.randomUUID();
      const order = {
        id: orderId,
        email: user.email,
        customerName: user.name,
        items: resolvedItems.map(({ product, qty }) => ({
          productId: product.id,
          name: product.name,
          price: Number(product.price),
          quantity: qty
        })),
        total,
        pointsEarned,
        status: 'pendiente',
        createdAt: Date.now()
      };
      await os.setJSON(`order:${orderId}`, order);
      const index = await getIndex(os, 'orders:index');
      index.push(orderId);
      await saveIndex(os, 'orders:index', index);

      // Sumar puntos al cliente
      const updatedUser = { ...user, points: (user.points || 0) + pointsEarned };
      await as.setJSON(`user:${user.email}`, updatedUser);

      return jsonResponse(201, { order, points: updatedUser.points });
    }

    // ---------- PUT: cambiar estado del pedido (admin) ----------
    if (req.method === 'PUT') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del pedido' });
      const existing = await os.get(`order:${id}`, { type: 'json' });
      if (!existing) return jsonResponse(404, { error: 'Pedido no encontrado' });

      const body = await req.json();
      const updated = { ...existing, status: body.status || existing.status };
      await os.setJSON(`order:${id}`, updated);
      return jsonResponse(200, updated);
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en orders function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/orders'
};
