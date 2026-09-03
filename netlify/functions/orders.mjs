import { getStore } from '@netlify/blobs';
import webpush from 'web-push';

// Pedidos de Grupo Rolmar
// order:<id> -> { id, email, customerName, items, total, pointsEarned, address, status, trackingNumber, createdAt }
// orders:index -> [ids]

const ordersStore = () => getStore({ name: 'rolmar-orders', consistency: 'strong' });
const catalogStore = () => getStore({ name: 'rolmar-catalog', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'rolmar-accounts', consistency: 'strong' });
const pushSubsStore = () => getStore({ name: 'rolmar-push-subs', consistency: 'strong' });

// Llave pública VAPID (no es secreta, puede ir en el código)
const VAPID_PUBLIC_KEY = 'BPh1GRkaGLyrsTJAOnj5QlVjfJ3y_BvbT-i59MBW4z0DRqxT0acQ6JElzo24EJkyxO72792TM632OM5qhcSZDUY';
// Llave privada: viene de la variable de entorno configurada en Netlify
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:contacto@gruporolmar.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const STATUS_LABELS = {
  pendiente: 'Pendiente',
  preparando: 'Preparando',
  enviado: 'Enviado',
  completado: 'Completado',
  cancelado: 'Cancelado'
};

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

// ---------- Mandar push al cliente dueño del pedido ----------
async function notifyCustomer(email, payload) {
  if (!VAPID_PRIVATE_KEY) return; // si no está configurada la llave, no truena, solo no manda nada

  const ps = pushSubsStore();
  const record = await ps.get(`push_sub:${email}`, { type: 'json' });
  if (!record || !record.subscription) return;

  try {
    await webpush.sendNotification(record.subscription, JSON.stringify(payload));
  } catch (err) {
    // Si la suscripción ya no es válida (410/404), la borramos para no seguir intentando
    if (err.statusCode === 410 || err.statusCode === 404) {
      await ps.delete(`push_sub:${email}`);
    } else {
      console.error('Error enviando push:', err.message);
    }
  }
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
      const address = body.address; // { fullName, phone, line1, city, reference }

      if (!token) return jsonResponse(401, { error: 'Falta iniciar sesión' });
      if (!Array.isArray(items) || items.length === 0) {
        return jsonResponse(400, { error: 'El carrito está vacío' });
      }
      if (!address || !address.line1 || !address.phone || !address.fullName) {
        return jsonResponse(400, { error: 'Falta completar la dirección de envío' });
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
        address: {
          fullName: String(address.fullName).trim(),
          phone: String(address.phone).trim(),
          line1: String(address.line1).trim(),
          city: address.city ? String(address.city).trim() : '',
          reference: address.reference ? String(address.reference).trim() : ''
        },
        status: 'pendiente',
        trackingNumber: '',
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

    // ---------- PUT: cambiar estado o número de guía del pedido (admin) ----------
    if (req.method === 'PUT') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del pedido' });
      const existing = await os.get(`order:${id}`, { type: 'json' });
      if (!existing) return jsonResponse(404, { error: 'Pedido no encontrado' });

      const body = await req.json();
      const newStatus = body.status || existing.status;
      const newTracking = body.trackingNumber !== undefined ? body.trackingNumber : existing.trackingNumber;

      const updated = { ...existing, status: newStatus, trackingNumber: newTracking };
      await os.setJSON(`order:${id}`, updated);

      // Si cambió el estado o se agregó número de guía, avisamos al cliente
      const statusChanged = newStatus !== existing.status;
      const trackingAdded = newTracking && newTracking !== existing.trackingNumber;

      if (statusChanged || trackingAdded) {
        const statusLabel = STATUS_LABELS[newStatus] || newStatus;
        let body_text = `Tu pedido está: ${statusLabel}`;
        if (newTracking) body_text += ` · Guía: ${newTracking}`;

        await notifyCustomer(updated.email, {
          title: 'Grupo Rolmar',
          body: body_text,
          url: '/cliente/'
        });
      }

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
