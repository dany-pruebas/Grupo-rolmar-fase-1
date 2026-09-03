import { getStore } from '@netlify/blobs';

// Catálogo de Grupo Rolmar
// Cada producto se guarda como su propio blob: product:<id>
// Un índice guarda la lista de ids: products:index
// consistency: 'strong' para que una escritura se refleje de inmediato en la siguiente lectura

const store = () => getStore({ name: 'rolmar-catalog', consistency: 'strong' });

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
  const index = await s.get('products:index', { type: 'json' });
  return index || [];
}

async function saveIndex(s, index) {
  await s.setJSON('products:index', index);
}

export default async (req) => {
  const s = store();
  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (req.method === 'OPTIONS') {
    return jsonResponse(200, {});
  }

  try {
    // ---------- GET: listar todos los productos ----------
    if (req.method === 'GET') {
      const index = await getIndex(s);
      const products = [];
      for (const productId of index) {
        const product = await s.get(`product:${productId}`, { type: 'json' });
        if (product) products.push(product);
      }
      // más nuevos primero
      products.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(200, products);
    }

    // ---------- POST: crear producto ----------
    if (req.method === 'POST') {
      const body = await req.json();

      if (!body.name || body.price === undefined || body.quantity === undefined) {
        return jsonResponse(400, { error: 'Falta nombre, precio o cantidad' });
      }

      const newId = crypto.randomUUID();
      const product = {
        id: newId,
        name: String(body.name).trim(),
        price: Number(body.price),
        quantity: Number(body.quantity),
        description: body.description ? String(body.description).trim() : '',
        photo: body.photo || '',
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await s.setJSON(`product:${newId}`, product);

      const index = await getIndex(s);
      index.push(newId);
      await saveIndex(s, index);

      return jsonResponse(201, product);
    }

    // ---------- PUT: editar producto ----------
    if (req.method === 'PUT') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del producto' });

      const existing = await s.get(`product:${id}`, { type: 'json' });
      if (!existing) return jsonResponse(404, { error: 'Producto no encontrado' });

      const body = await req.json();

      const updated = {
        ...existing,
        name: body.name !== undefined ? String(body.name).trim() : existing.name,
        price: body.price !== undefined ? Number(body.price) : existing.price,
        quantity: body.quantity !== undefined ? Number(body.quantity) : existing.quantity,
        description: body.description !== undefined ? String(body.description).trim() : existing.description,
        photo: body.photo !== undefined ? body.photo : existing.photo,
        updatedAt: Date.now()
      };

      await s.setJSON(`product:${id}`, updated);
      return jsonResponse(200, updated);
    }

    // ---------- DELETE: eliminar producto ----------
    if (req.method === 'DELETE') {
      if (!id) return jsonResponse(400, { error: 'Falta el id del producto' });

      await s.delete(`product:${id}`);

      const index = await getIndex(s);
      await saveIndex(s, index.filter((productId) => productId !== id));

      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(405, { error: 'Método no permitido' });
  } catch (err) {
    console.error('Error en catalog function:', err);
    return jsonResponse(500, { error: 'Error interno del servidor' });
  }
};

export const config = {
  path: '/.netlify/functions/catalog'
};
