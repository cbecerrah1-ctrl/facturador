/* POST /api/wompi — Wompi avisa aquí cada cambio de una transacción (configúralo en el panel de Wompi → Eventos).
   Se verifica la firma con el secreto de eventos; si el pago está aprobado, la licencia se renueva sola. */
const L = require('../shared/lib');

module.exports = async function (context, req) {
  const body = L.cuerpoJSON(req);
  const W = L.wompi();
  const h = req.headers || {};
  if (!L.eventoValido(body, W.eventos, h['x-event-checksum'] || h['X-Event-Checksum'])) {
    context.log.warn('Evento de Wompi con firma inválida');
    context.res = { status: 200, body: '' }; return;   /* 200 para que no reintente un evento falso */
  }
  if (body.event !== 'transaction.updated' || !body.data || !body.data.transaction) { context.res = { status: 200, body: '' }; return; }
  try {
    const t = L.tablas(); await L.asegurarTablas(t);
    await L.aplicarPago(t, body.data.transaction, 'evento');
    context.res = { status: 200, body: '' };
  } catch (e) {
    context.log.error(e);
    context.res = { status: 500, body: '' };   /* Wompi reintenta más tarde */
  }
};
