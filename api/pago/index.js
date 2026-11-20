/* /api/pago/{accion} — pago de la licencia en línea (Wompi)
   POST precios   { clave }          → planes y montos para esa licencia
   POST iniciar   { clave, plan }    → { url } de la página de pago de Wompi (firmada)
   GET  confirmar ?id=<transacción>  → la consulta a Wompi y, si está aprobada, renueva (respaldo del evento) */
const L = require('../shared/lib');

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const accion = String((context.bindingData && context.bindingData.accion) || '').toLowerCase();
  const W = L.wompi();
  let t;
  try { t = L.tablas(); await L.asegurarTablas(t); } catch (e) { context.log.error(e); context.res = L.resp(500, { ok: false, mensaje: 'El servidor no está configurado.' }); return; }

  try {
    if (accion === 'confirmar') {
      const id = String((req.query && req.query.id) || L.cuerpoJSON(req).id || '').trim();
      if (!/^[A-Za-z0-9-]{6,80}$/.test(id)) { context.res = L.resp(200, { ok: false, estado: 'desconocido', mensaje: 'Falta el número de la transacción.' }); return; }
      let tx = null;
      try { const r = await fetch(W.api + '/transactions/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } }); const j = await r.json(); tx = j && j.data; } catch (e) { context.log.warn('Wompi no respondió', e.message); }
      if (!tx) { context.res = L.resp(200, { ok: false, estado: 'pendiente', mensaje: 'Aún no tenemos la respuesta del pago. Revisa en unos minutos.' }); return; }
      const r = await L.aplicarPago(t, tx, 'confirmacion');
      context.res = L.resp(200, { ...r, monto: tx.amount_in_cents ? tx.amount_in_cents / 100 : 0, metodo: tx.payment_method_type || '' }); return;
    }

    const b = L.cuerpoJSON(req);
    const clave = L.normClave(b.clave);
    if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clave)) { context.res = L.resp(200, { ok: false, mensaje: 'Clave de licencia no válida.' }); return; }
    let lic;
    try { lic = await t.lic.getEntity('lic', clave); } catch (e) { if (e.statusCode === 404) { context.res = L.resp(200, { ok: false, mensaje: 'Esa clave de licencia no existe.' }); return; } throw e; }
    const planes = L.planes(lic.maxEquipos);

    if (accion === 'precios') {
      context.res = L.resp(200, { ok: true, activo: W.listo, pruebas: !W.prod, negocio: lic.negocio || '', vence: lic.vence || '', equipos: Math.max(1, Number(lic.maxEquipos) || 1), pro: !!lic.ia, prueba: !!lic.prueba, planes }); return;
    }

    if (accion === 'iniciar') {
      if (!W.listo) { context.res = L.resp(200, { ok: false, mensaje: 'El pago en línea aún no está disponible. Comunícate con tu proveedor de VETEX.' }); return; }
      const plan = planes.find(x => x.k === b.plan);
      if (!plan) { context.res = L.resp(200, { ok: false, mensaje: 'Elige un plan.' }); return; }
      const centavos = plan.monto * 100;
      const ref = `${clave}-${plan.meses === 12 ? 'A' : 'M'}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 36 ** 2).toString(36).toUpperCase()}`;
      await t.pg.createEntity({ partitionKey: clave, rowKey: ref, plan: plan.k, meses: plan.meses, pro: !!plan.pro, monto: centavos, estado: 'pendiente', equipos: Math.max(1, Number(lic.maxEquipos) || 1), creado: new Date().toISOString() });
      const base = (process.env.VETEX_SITIO || 'https://wonderful-desert-0d7a5580f.3.azurestaticapps.net').replace(/\/+$/, '');
      const q = new URLSearchParams({ 'public-key': W.pub, currency: 'COP', 'amount-in-cents': String(centavos), reference: ref, 'signature:integrity': L.firmaIntegridad(ref, centavos, 'COP', W.integridad), 'redirect-url': base + '/pago/' });
      if (lic.negocio) q.set('customer-data:full-name', String(lic.negocio).slice(0, 60));
      await L.evento(t, clave, 'pago_iniciado', `${L.pesos(centavos)} · ${plan.n}`);
      context.res = L.resp(200, { ok: true, url: W.checkout + '?' + q.toString(), referencia: ref, monto: plan.monto, pruebas: !W.prod }); return;
    }

    context.res = L.resp(404, { ok: false, mensaje: 'Acción no válida' });
  } catch (e) {
    context.log.error(e);
    context.res = L.resp(500, { ok: false, mensaje: 'Error del servidor. Intenta más tarde.' });
  }
};
