/* POST /api/licencia — lo llama VETEX para activar o revisar su licencia.
   Cuerpo: { clave, equipo, version }
   Respuesta: { ok:true, token } (permiso firmado) o { ok:false, motivo, mensaje } */
const L = require('../shared/lib');

const DIAS_GRACIA = 15;      /* días que VETEX sigue funcionando sin poder conectarse */

module.exports = async function (context, req) {
  if (req.method === 'OPTIONS') { context.res = L.resp(204, {}); return; }
  const b = L.cuerpoJSON(req);
  const clave = L.normClave(b.clave);
  const equipo = String(b.equipo || '').toLowerCase();
  const version = String(b.version || '').slice(0, 40);
  if (!/^VTX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(clave)) { context.res = L.resp(200, { ok: false, motivo: 'clave_invalida', mensaje: 'La clave de licencia no es válida. Revisa que esté bien escrita.' }); return; }
  if (!/^[a-f0-9]{64}$/.test(equipo)) { context.res = L.resp(200, { ok: false, motivo: 'equipo_invalido', mensaje: 'No se pudo identificar este computador. Abre VETEX con "Iniciar VETEX.bat".' }); return; }

  let t;
  try { t = L.tablas(); await L.asegurarTablas(t); } catch (e) { context.log.error(e); context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'El servidor de licencias no está configurado.' }); return; }

  let lic;
  try { lic = await t.lic.getEntity('lic', clave); }
  catch (e) {
    if (e.statusCode === 404) { await L.evento(t, 'desconocidas', 'clave_inexistente', clave + ' equipo ' + equipo.slice(0, 12)); context.res = L.resp(200, { ok: false, motivo: 'no_existe', mensaje: 'Esa clave de licencia no existe.' }); return; }
    context.log.error(e); context.res = L.resp(500, { ok: false, motivo: 'servidor', mensaje: 'Error del servidor de licencias. Intenta más tarde.' }); return;
  }

  const ahora = new Date().toISOString();
  const equipos = L.parseEquipos(lic);
  const max = Math.max(1, Number(lic.maxEquipos) || 1);
  let idx = equipos.findIndex(x => x.id === equipo);

  if (lic.estado === 'bloqueada') {
    await L.evento(t, clave, 'rechazo_bloqueada', 'equipo ' + equipo.slice(0, 12));
    context.res = L.resp(200, { ok: false, motivo: 'bloqueada', mensaje: lic.mensaje || 'Esta licencia está suspendida. Comunícate con tu proveedor de VETEX.' }); return;
  }
  if (idx < 0) {
    if (equipos.length >= max) {
      await L.evento(t, clave, 'rechazo_otro_equipo', 'equipo nuevo ' + equipo.slice(0, 12));
      context.res = L.resp(200, { ok: false, motivo: 'otro_equipo', mensaje: b.tipo === 'tablet' ? `Esta licencia ya tiene ocupados sus ${max} equipo${max > 1 ? 's' : ''}. Para usar esta tablet, pide a tu proveedor de VETEX que agregue un equipo más a la licencia.` : 'Esta licencia ya está activada en otro computador. Para pasarla a este, comunícate con tu proveedor de VETEX.' }); return;
    }
    equipos.push({ id: equipo, desde: ahora, ultimo: ahora, ...(b.tipo === 'tablet' ? { tipo: 'tablet' } : {}) });
    idx = equipos.length - 1;
    await L.evento(t, clave, 'activacion', (b.tipo === 'tablet' ? 'tablet ' : 'equipo ') + equipo.slice(0, 12) + ' · versión ' + version);
  } else equipos[idx].ultimo = ahora;

  if (!lic.totp) lic.totp = L.nuevoSecreto();
  try { await t.lic.updateEntity({ partitionKey: 'lic', rowKey: clave, equipos: JSON.stringify(equipos), ultimoContacto: ahora, ultimaVersion: version, totp: lic.totp }, 'Merge'); }
  catch (e) { context.log.warn('No se pudo guardar el contacto', e.message); }

  if (!L.esFecha(lic.vence) || lic.vence < L.hoy()) {
    context.res = L.resp(200, { ok: false, motivo: 'vencida', vence: lic.vence || '', prueba: !!lic.prueba, negocio: lic.negocio || '', mensaje: lic.prueba ? 'Tu prueba gratis de VETEX Pro terminó el ' + (lic.vence || '—') + '. Elige un plan para seguir vendiendo; tus datos están guardados.' : 'La licencia venció el ' + (lic.vence || '—') + '. Renuévala con tu proveedor de VETEX.' }); return;
  }

  const token = L.firmar({ app: 'VETEX', c: clave, n: lic.negocio || '', nit: lic.nit || '', e: equipo, v: lic.vence, g: DIAS_GRACIA, t: Date.now(), k: lic.totp, ia: !!lic.ia, ...(lic.prueba ? { pr: 1, pd: Number(lic.pruebaDias) || 15 } : {}) });
  context.res = L.resp(200, { ok: true, token, vence: lic.vence, negocio: lic.negocio || '', mensaje: lic.mensaje || '' });
};
