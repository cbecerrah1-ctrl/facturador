/* /api/gestion/{accion} — solo para el panel (rol "admin").
   GET  listar            → todas las licencias
   GET  eventos?clave=…   → historial de una licencia (o de todas)
   POST crear             → { negocio, nit, telefono, notas, meses | vence, maxEquipos }
   POST actualizar        → { clave, vence?, sumarMeses?, estado?, mensaje?, notas?, negocio?, nit?, telefono?, maxEquipos?, liberarEquipos? } */
const L = require('../shared/lib');

const limpio = (s, n = 120) => String(s == null ? '' : s).trim().slice(0, n);
function vista(e) {
  return {
    clave: e.rowKey, negocio: e.negocio || '', nit: e.nit || '', grupo: e.grupo || '', telefono: e.telefono || '', notas: e.notas || '',
    vence: e.vence || '', estado: e.estado || 'activa', mensaje: e.mensaje || '', maxEquipos: Number(e.maxEquipos) || 1,
    equipos: L.parseEquipos(e), creada: e.creada || '', ultimoContacto: e.ultimoContacto || '', ultimaVersion: e.ultimaVersion || '',
    ultimoRespaldo: e.ultimoRespaldo || '', respaldoTam: Number(e.respaldoTam) || 0, respaldos: Number(e.respaldos) || 0,
    totp: e.totp || '', ia: !!e.ia, iaUso: e.iaUsoP === L.hoy().slice(0, 7) ? Number(e.iaUso) || 0 : 0, ultimoPago: e.ultimoPago || '', ultimoPagoMonto: Number(e.ultimoPagoMonto) || 0, ultimoPagoPlan: e.ultimoPagoPlan || '', prueba: !!e.prueba, pruebaDias: Number(e.pruebaDias) || 0, tuvoPrueba: !!e.tuvoPrueba, convertida: e.convertida || '', iaPru: e.iaPruP === 'prueba' ? Number(e.iaPru) || 0 : 0, celulares: (() => { try { return JSON.parse(e.duenoTokens || '[]').length; } catch { return 0; } })(), resumenFecha: e.resumenFecha || ''
  };
}

module.exports = async function (context, req) {
  const u = L.usuario(req);
  if (!L.esAdmin(u)) { context.res = L.resp(403, { ok: false, mensaje: 'Sin permiso' }); return; }
  const quien = (u.userDetails || 'admin') + '';
  const accion = String((context.bindingData && context.bindingData.accion) || '').toLowerCase();

  let t;
  try { t = L.tablas(); await L.asegurarTablas(t); } catch (e) { context.res = L.resp(500, { ok: false, mensaje: e.message }); return; }

  try {
    if (req.method === 'GET' && accion === 'listar') {
      const out = [];
      for await (const e of t.lic.listEntities({ queryOptions: { filter: "PartitionKey eq 'lic'" } })) out.push(vista(e));
      out.sort((a, b) => a.negocio.localeCompare(b.negocio, 'es'));
      context.res = L.resp(200, { ok: true, hoy: L.hoy(), usuario: quien, licencias: out }); return;
    }

    if (req.method === 'GET' && accion === 'eventos') {
      const clave = req.query.clave ? L.normClave(req.query.clave) : '';
      const out = [];
      const it = t.ev.listEntities(clave ? { queryOptions: { filter: `PartitionKey eq '${clave.replace(/'/g, "''")}'` } } : {});
      for await (const e of it) { out.push({ clave: e.partitionKey, tipo: e.tipo, detalle: e.detalle, fecha: e.fecha }); if (out.length >= 300) break; }
      out.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));
      context.res = L.resp(200, { ok: true, eventos: out.slice(0, 100) }); return;
    }

    const b = L.cuerpoJSON(req);

    if (req.method === 'POST' && accion === 'crear') {
      const negocio = limpio(b.negocio);
      if (!negocio) { context.res = L.resp(400, { ok: false, mensaje: 'Escribe el nombre del negocio.' }); return; }
      const prueba = !!b.prueba, dp = L.diasPrueba();
      /* Una sola prueba gratis por NIT o cédula (salvo que el administrador la fuerce) */
      if (prueba && L.normNit(b.nit) && !b.forzar) {
        for await (const e of t.lic.listEntities({ queryOptions: { filter: "PartitionKey eq 'lic'" } })) {
          if (e.tuvoPrueba && L.normNit(e.nit) === L.normNit(b.nit)) { context.res = L.resp(409, { ok: false, repetida: true, mensaje: `Ese NIT ya tuvo una prueba gratis (${e.negocio || e.rowKey}).` }); return; }
        }
      }
      const vence = prueba ? (() => { const d = new Date(L.hoy() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + dp); return d.toISOString().slice(0, 10); })()
        : L.esFecha(b.vence) ? b.vence : L.sumarMeses(L.hoy(), Math.max(1, Math.min(60, Number(b.meses) || 1)));
      let clave, intento = 0;
      for (;;) {
        clave = L.nuevaClave();
        try {
          await t.lic.createEntity({ partitionKey: 'lic', rowKey: clave, negocio, nit: limpio(b.nit, 40), grupo: limpio(b.grupo || '', 60), telefono: limpio(b.telefono, 40), notas: limpio(b.notas, 500), vence, estado: 'activa', mensaje: '', totp: L.nuevoSecreto(), maxEquipos: prueba ? 1 : Math.max(1, Math.min(10, Number(b.maxEquipos) || 1)), equipos: '[]', creada: new Date().toISOString(), ia: prueba || !!b.ia, ...(prueba ? { prueba: true, tuvoPrueba: true, pruebaDias: dp } : {}) });
          break;
        } catch (e) { if (e.statusCode === 409 && ++intento < 5) continue; throw e; }
      }
      await L.evento(t, clave, prueba ? 'prueba' : 'creada', `${negocio}${prueba ? ` · 🎁 prueba gratis de ${dp} días con Pro` : ''} · vence ${vence} · por ${quien}`);
      context.res = L.resp(200, { ok: true, licencia: vista(await t.lic.getEntity('lic', clave)) }); return;
    }

    if (req.method === 'POST' && accion === 'actualizar') {
      const clave = L.normClave(b.clave);
      let e;
      try { e = await t.lic.getEntity('lic', clave); } catch (x) { if (x.statusCode === 404) { context.res = L.resp(404, { ok: false, mensaje: 'No existe esa licencia.' }); return; } throw x; }
      const c = { partitionKey: 'lic', rowKey: clave }, log = [];
      /* Renovar a mano una prueba = el cliente pagó: deja de ser prueba y queda con el plan que pagó */
      if (e.prueba && (b.sumarMeses || (L.esFecha(b.vence) && b.vence > (e.vence || '')))) { c.prueba = false; c.convertida = new Date().toISOString(); log.push('🎉 prueba convertida en cliente'); }
      if (b.terminarPrueba && e.prueba) { const d = new Date(L.hoy() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); c.vence = d.toISOString().slice(0, 10); log.push('prueba terminada a mano'); }
      if (b.sumarMeses) { const base = L.esFecha(e.vence) && e.vence > L.hoy() ? e.vence : L.hoy(); c.vence = L.sumarMeses(base, Math.max(1, Math.min(60, Number(b.sumarMeses) || 1))); log.push('renovada hasta ' + c.vence); }
      else if (L.esFecha(b.vence)) { c.vence = b.vence; log.push('vence ' + b.vence); }
      if (b.estado === 'bloqueada' || b.estado === 'activa') { c.estado = b.estado; log.push(b.estado === 'bloqueada' ? 'bloqueada' : 'desbloqueada'); }
      ['mensaje', 'notas', 'negocio', 'nit', 'telefono', 'grupo'].forEach(k => { if (b[k] != null) { c[k] = limpio(b[k], k === 'notas' || k === 'mensaje' ? 500 : 120); log.push(k + ' editado'); } });
      if (b.maxEquipos != null) { c.maxEquipos = Math.max(1, Math.min(10, Number(b.maxEquipos) || 1)); log.push('equipos máx ' + c.maxEquipos); }
      if (typeof b.ia === 'boolean') { c.ia = b.ia; log.push(b.ia ? 'IA activada (Pro)' : 'IA desactivada'); }
      if (b.liberarEquipos) { c.equipos = '[]'; log.push('equipos liberados'); }
      if (b.nuevoTotp || (b.verTotp && !e.totp)) { c.totp = L.nuevoSecreto(); log.push(b.nuevoTotp ? 'código técnico renovado' : 'código técnico creado'); }
      if (c.negocio === '') { context.res = L.resp(400, { ok: false, mensaje: 'El negocio no puede quedar vacío.' }); return; }
      await t.lic.updateEntity(c, 'Merge');
      if (log.length) await L.evento(t, clave, 'cambio', log.join(' · ') + ' · por ' + quien);
      context.res = L.resp(200, { ok: true, licencia: vista(await t.lic.getEntity('lic', clave)) }); return;
    }

    context.res = L.resp(404, { ok: false, mensaje: 'Acción no válida' });
  } catch (e) {
    context.log.error(e);
    context.res = L.resp(500, { ok: false, mensaje: 'Error: ' + (e.message || e) });
  }
};
