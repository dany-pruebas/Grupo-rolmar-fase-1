// Pasarela de pago SIMULADA — Grupo Rolmar
//
// Este módulo existe para poder construir y probar todo el flujo de cobro
// (pedidos, saldo de puntos aplicado como descuento, etc.) mientras se decide
// y conecta una pasarela real (Stripe, Recurrente, PayPal, etc.).
//
// Cuando se conecte la pasarela real, solo hay que reemplazar el CONTENIDO
// de chargeCard(), manteniendo los mismos parámetros de entrada y la misma
// forma de respuesta. orders.mjs no necesita cambiar nada.
//
// Entrada:
//   { amount, email, orderId, card }
//     amount  -> monto en Quetzales a cobrar (ya con el saldo de puntos descontado)
//     email   -> email del cliente
//     orderId -> id del pedido que se está pagando
//     card    -> datos de la tarjeta (con la pasarela real vendrá un token/paymentMethodId,
//                nunca el número de tarjeta en texto plano)
//
// Salida:
//   éxito  -> { success: true,  transactionId, amount, gateway }
//   fallo  -> { success: false, error: 'mensaje para mostrar al cliente' }

export async function chargeCard({ amount, email, orderId, card }) {
  // ---------- SIMULACIÓN ----------
  // No se conecta a ningún banco. Simula una pequeña espera de red
  // y siempre aprueba el cobro, para poder probar el flujo completo.

  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!Number.isFinite(amount) || amount < 0) {
    return { success: false, error: 'Monto inválido para procesar el pago' };
  }

  return {
    success: true,
    transactionId: `SIM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    amount,
    gateway: 'simulado'
  };

  // ---------- CUANDO SE CONECTE LA PASARELA REAL ----------
  // Ejemplo de referencia con Stripe (no activo todavía):
  //
  // import Stripe from 'stripe';
  // const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  //
  // try {
  //   const paymentIntent = await stripe.paymentIntents.create({
  //     amount: Math.round(amount * 100), // Stripe trabaja en centavos
  //     currency: 'gtq',
  //     payment_method: card.paymentMethodId,
  //     confirm: true,
  //     metadata: { email, orderId }
  //   });
  //   if (paymentIntent.status === 'succeeded') {
  //     return { success: true, transactionId: paymentIntent.id, amount, gateway: 'stripe' };
  //   }
  //   return { success: false, error: 'El pago no pudo procesarse' };
  // } catch (err) {
  //   return { success: false, error: err.message || 'Error al procesar el pago' };
  // }
}
