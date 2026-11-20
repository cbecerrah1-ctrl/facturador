/* POST /api/sedes/{accion} — varias sedes del mismo dueño (plan Pro).
   Las sedes de un grupo son las licencias con el mismo "grupo" (lo pones en tu panel) o, si no tiene, el mismo NIT.
   lista            → las otras sedes del grupo (id opaco + nombre)
   enviar           → { destino, items:[{nombre, sku, cant, unidad, costo}], nota, ref } crea un traslado pendiente
   pendientes       → traslados que llegan a esta sede (pendientes y los últimos recibidos)
   enviados         → traslados que salieron de esta sede y en qué van
   recibir/rechazar → { id } la sede destino confirma o devuelve
   Todas las llamadas vienen de un computador activado con la licencia (clave + equipo). */
const crypto = require('crypto');
const L = require('../shared/lib');
const idSede = clave => crypto.createHash('sha256').update('sede:' + clave).digest('hex').slice(0, 16);
const grupoDe = lic => String(lic.grupo || '').trim().toLowerCase() || (L.normNit(lic.nit) ? 'nit:' + L.normNit(lic.nit) : '');
const limpia = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').slice(0, n);

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const b = L.cuerpoJSON(req), accion = String((req.params || {}).accion || (context.bindingData || {}).accion || ''), clave = L.normClave(b.clave);
  const no = (motivo, mensaje) => { context.res = L.resp(200, { ok: false, motivo, mensaje }); };
  try {
    const t = L.tablas(); await L.asegurarTablas(t);
    let lic; try { lic = await t.lic.getEntity('lic', clave); } catch (e) { if (e.statusCode === 404) return no('no_existe', 'Licencia no encontrada.'); throw e; }
    const equipo = String(b.equipo || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(equipo) || !L.parseEquipos(lic).some(x => x.id === equipo)) return no('equipo_no_registrado', 'Este computador no está activado con esa licencia.');
    if (!lic.ia) return no('pro', 'Varias sedes es una función del plan Pro.');
    const g = grupoDe(lic);
    const sedes = async () => {
      if (!g) return [];
      const out = [];
      for await (const e of t.lic.listEntities({ queryOptions: { filter: "PartitionKey eq 'lic'" } }))
        if (e.rowKey !== clave && grupoDe(e) === g && e.estado !== 'bloqueada') out.push({ id: idSede(e.rowKey), clave: e.rowKey, negocio: e.negocio || e.rowKey, pro: !!e.ia });
      return out;
    };
    const vista = e => ({ id: e.rowKey, origen: e.origenNombre, destino: e.destinoNombre, fecha: e.fecha, estado: e.estado, items: JSON.parse(e.items || '[]'), nota: e.nota || '', ref: e.ref || '', recibido: e.recibido || '', recibidoPor: e.recibidoPor || '' });

    if (accion === 'lista') { const s = await sedes(); context.res = L.resp(200, { ok: true, grupo: !!g, propia: lic.negocio || '', sedes: s.map(x => ({ id: x.id, negocio: x.negocio })) }); return; }
    if (accion === 'enviar') {
      const dest = (await sedes()).find(x => x.id === String(b.destino || ''));
      if (!dest) return no('destino', 'Esa sede no está en tu grupo.');
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, 300).map(i => ({ nombre: limpia(i.nombre, 120), sku: limpia(i.sku, 40), cant: Math.max(0, Number(i.cant) || 0), unidad: limpia(i.unidad, 10), costo: Math.max(0, Number(i.costo) || 0) })).filter(i => i.nombre && i.cant > 0);
      if (!items.length) return no('vacio', 'El traslado no tiene productos.');
      const id = Date.now().toString(36) + crypto.randomBytes(4).toString('hex'), fecha = new Date().toISOString();
      const ent = { origen: clave, origenNombre: lic.negocio || clave, destino: dest.clave, destinoNombre: dest.negocio, fecha, estado: 'pendiente', items: JSON.stringify(items), nota: limpia(b.nota, 300), ref: limpia(b.ref, 40) };
      await t.tr.createEntity({ partitionKey: 'd|' + dest.clave, rowKey: id, ...ent });
      await t.tr.createEntity({ partitionKey: 'o|' + clave, rowKey: id, ...ent });
      await L.evento(t, clave, 'traslado', `${items.length} productos → ${dest.negocio}`);
      context.res = L.resp(200, { ok: true, id, fecha, destino: dest.negocio }); return;
    }
    if (accion === 'pendientes' || accion === 'enviados') {
      const pk = (accion === 'pendientes' ? 'd|' : 'o|') + clave, out = [];
      for await (const e of t.tr.listEntities({ queryOptions: { filter: `PartitionKey eq '${pk.replace(/'/g, "''")}'` } })) if (e.partitionKey === pk) out.push(vista(e));
      out.sort((a, b) => b.fecha.localeCompare(a.fecha));
      context.res = L.resp(200, { ok: true, traslados: out.filter(x => x.estado === 'pendiente').concat(out.filter(x => x.estado !== 'pendiente').slice(0, 30)) }); return;
    }
    if (accion === 'recibir' || accion === 'rechazar') {
      const id = String(b.id || '');let e;
      try { e = await t.tr.getEntity('d|' + clave, id); } catch (x) { if (x.statusCode === 404) return no('no_existe', 'Ese traslado no existe.'); throw x; }
      if (e.estado !== 'pendiente') return no('hecho', 'Ese traslado ya se había ' + (e.estado === 'recibido' ? 'recibido' : 'devuelto') + '.');
      const c = { estado: accion === 'recibir' ? 'recibido' : 'rechazado', recibido: new Date().toISOString(), recibidoPor: limpia(b.usuario, 60) };
      await t.tr.updateEntity({ partitionKey: 'd|' + clave, rowKey: id, ...c }, 'Merge', { etag: e.etag });
      await t.tr.updateEntity({ partitionKey: 'o|' + e.origen, rowKey: id, ...c }, 'Merge').catch(() => {});
      context.res = L.resp(200, { ok: true, estado: c.estado }); return;
    }
    no('accion', 'Acción no válida.');
  } catch (e) {
    context.log.error(e);
    context.res = L.resp(e.statusCode === 412 ? 409 : 500, { ok: false, mensaje: e.statusCode === 412 ? 'Otro equipo acaba de procesar ese traslado.' : 'Error del servidor. Intenta de nuevo.' });
  }
};
