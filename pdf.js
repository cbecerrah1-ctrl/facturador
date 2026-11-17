/*
  Genera los PDF dentro del navegador (sin servidor), con el mismo diseño
  de las plantillas de Word: encabezado con logo, caja morada con número y fecha,
  datos del cliente, detalle, total en letras, notas y firma.
*/
const PDF = (() => {
  const MORADO = [58, 22, 122], SUAVE = [241, 237, 248], LINEA = [207, 198, 227];
  const GRIS = [107, 107, 107], ROJO = [192, 38, 45], TINTA = [34, 34, 34], BLANCO = [255, 255, 255];
  const TITULOS = { COTIZACION: "COTIZACIÓN", FACTURA: "FACTURA DE VENTA", CUENTA_COBRO: "CUENTA DE COBRO" };
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
                 "septiembre", "octubre", "noviembre", "diciembre"];
  let logoCache = null;

  const pesos = v => "$" + Math.round(v || 0).toLocaleString("es-CO");
  const cant = q => String(Math.round(q * 100) / 100).replace(".", ",");
  const corta = iso => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; };
  const larga = iso => { const d = new Date(iso); return `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`; };

  async function logo() {
    if (logoCache) return logoCache;
    const blob = await (await fetch("logo.png")).blob();
    logoCache = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    return logoCache;
  }

  /* La fuente del PDF solo dibuja letras latinas: los emojis y símbolos raros se quitan
     y las comillas tipográficas se cambian por normales para que no salga basura. */
  const limpiar = t => String(t ?? "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2022\u20AC]/gu, "").replace(/\s{2,}/g, " ").trim();
  const limpiarObj = o => Array.isArray(o) ? o.map(limpiarObj)
    : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, limpiarObj(v)]))
    : typeof o === "string" ? limpiar(o) : o;

  async function crear(docOriginal, cfgOriginal) {
    const doc = limpiarObj(docOriginal), cfg = limpiarObj(cfgOriginal);
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "pt", format: "letter" });
    const W = 612, H = 792, M = 46, AN = W - 2 * M;
    const c = doc.cliente || {};
    pdf.setProperties({ title: `${TITULOS[doc.tipo]} ${doc.numero}`, author: cfg.nombre });

    // ---------- encabezado ----------
    let y = 38;
    try { pdf.addImage(await logo(), "PNG", M, y, 82, 82); } catch (e) { /* sin logo */ }
    const x = M + 94;
    pdf.setFont("helvetica", "bold").setFontSize(16).setTextColor(...MORADO).text(cfg.nombre || "", x, y + 16);
    pdf.setFontSize(8.5).setTextColor(...ROJO).text(cfg.eslogan || "", x, y + 29);
    pdf.setFontSize(9).setTextColor(...TINTA).text(cfg.responsable || "", x, y + 45);
    pdf.setFont("helvetica", "normal").setFontSize(8.2).setTextColor(...GRIS);
    let yy = y + 57;
    const lineas = [cfg.identificacion, ...pdf.splitTextToSize(cfg.direccion || "", 190), cfg.telefono && "Cel. " + cfg.telefono];
    lineas.filter(Boolean).forEach(l => { pdf.text(l, x, yy); yy += 10.5; });

    const bw = 196, bx = W - M - bw, bh = 86;
    pdf.setFillColor(...MORADO).rect(bx, y, bw, bh, "F");
    pdf.setFont("helvetica", "bold").setFontSize(14).setTextColor(...BLANCO).text(TITULOS[doc.tipo], bx + bw - 14, y + 26, { align: "right" });
    const filas = [["No.", doc.numero], ["Fecha", corta(doc.fecha)]];
    if (doc.vence) filas.push(["Válida hasta", corta(doc.vence)]);
    if (doc.origen) filas.push(["", "Según cotización " + doc.origen]);
    let fy = y + 44;
    filas.forEach(([e, v]) => {
      pdf.setFont("helvetica", "bold").setFontSize(9).setTextColor(...BLANCO);
      const wv = pdf.getTextWidth(v);
      pdf.text(v, bx + bw - 14, fy, { align: "right" });
      if (e) pdf.setFont("helvetica", "normal").setFontSize(8).setTextColor(220, 211, 240).text(e, bx + bw - 20 - wv, fy, { align: "right" });
      fy += 12.5;
    });

    y = Math.max(y + bh, yy) + 18;
    pdf.setFont("helvetica", "normal").setFontSize(9).setTextColor(...GRIS).text(`${cfg.ciudad || "Bogotá D.C."}, ${larga(doc.fecha)}`, M, y);
    y += 18;

    const seccion = t => {
      pdf.setFont("helvetica", "bold").setFontSize(8.5).setTextColor(...MORADO).text(t, M, y);
      pdf.setDrawColor(...MORADO).setLineWidth(0.8).line(M, y + 4, W - M, y + 4);
      y += 10;
    };
    const titulosCliente = { COTIZACION: "COTIZADO A", FACTURA: "FACTURAR A", CUENTA_COBRO: "DEUDOR" };

    // ---------- cliente ----------
    seccion(titulosCliente[doc.tipo]);
    const v = x => (x && String(x).trim()) || "—";
    const etq = t => ({ content: t, styles: { fillColor: SUAVE, textColor: MORADO, fontStyle: "bold", fontSize: 7.3 } });
    pdf.autoTable({
      startY: y, margin: { left: M, right: M }, theme: "grid",
      styles: { font: "helvetica", fontSize: 8.8, textColor: TINTA, lineColor: LINEA, lineWidth: 0.5, cellPadding: 5, valign: "middle" },
      columnStyles: { 0: { cellWidth: 72 }, 1: { cellWidth: AN / 2 - 72 }, 2: { cellWidth: 72 }, 3: { cellWidth: AN / 2 - 72 } },
      body: [
        [etq("NOMBRE"), v(c.nombre), etq("C.C. / NIT"), v(c.documento)],
        [etq("TELÉFONO"), v(c.telefono), etq("DIRECCIÓN"), v(c.direccion)],
        [etq("CORREO"), v(c.correo), etq("CIUDAD"), v(c.ciudad || cfg.ciudad)],
        [etq("VEHÍCULO"), v(c.vehiculo), etq("PLACA"), v(c.placa).toUpperCase()],
      ],
    });
    y = pdf.lastAutoTable.finalY + 18;

    // ---------- cuenta de cobro: texto formal ----------
    if (doc.tipo === "CUENTA_COBRO") {
      seccion("DEBE A");
      y += 4;
      const texto = `${cfg.responsable || cfg.nombre}${cfg.identificacion ? ", identificado(a) con " + cfg.identificacion + "," : ","} la suma de ` +
        `${pesos(doc.total)} (${Letras.pesos(doc.total)}), por concepto de: ${doc.concepto || "productos y servicios según detalle"}.`;
      pdf.setFont("helvetica", "normal").setFontSize(9.5).setTextColor(...TINTA);
      const partes = pdf.splitTextToSize(texto, AN);
      pdf.text(partes, M, y + 6, { lineHeightFactor: 1.45 });
      y += partes.length * 13.8 + 14;
    }

    // ---------- detalle ----------
    seccion("DETALLE");
    const items = doc.items && doc.items.length ? doc.items
      : [{ ref: "SERVICIO", descripcion: doc.concepto || "", cantidad: 1, precio: doc.total, total: doc.total }];
    pdf.autoTable({
      startY: y, margin: { left: M, right: M, bottom: 70 }, theme: "grid",
      styles: { font: "helvetica", fontSize: 8.8, textColor: TINTA, lineColor: LINEA, lineWidth: 0.5, cellPadding: 5.5, valign: "middle" },
      headStyles: { fillColor: MORADO, textColor: BLANCO, fontStyle: "bold", fontSize: 8 },
      columnStyles: {
        0: { cellWidth: 70, textColor: GRIS, fontSize: 8 }, 1: { cellWidth: "auto" },
        2: { cellWidth: 44, halign: "center" }, 3: { cellWidth: 82, halign: "right" }, 4: { cellWidth: 82, halign: "right", fontStyle: "bold" },
      },
      head: [["REF", "DESCRIPCIÓN", "CANT.", "VR. UNITARIO", "VR. TOTAL"]],
      body: items.map(it => [it.ref || "SERVICIO", it.descripcion, cant(it.cantidad), pesos(it.precio), pesos(it.total)]),
    });
    y = pdf.lastAutoTable.finalY;

    const nuevaPaginaSi = alto => { if (y + alto > H - 70) { pdf.addPage(); y = 50; } };

    // ---------- total ----------
    nuevaPaginaSi(30);
    const tw = 82;
    pdf.setFillColor(...MORADO).rect(W - M - 2 * tw, y, tw, 24, "F");
    pdf.setFillColor(...SUAVE).rect(W - M - tw, y, tw, 24, "F");
    pdf.setFont("helvetica", "bold").setFontSize(10.5).setTextColor(...BLANCO).text("TOTAL", W - M - tw - 8, y + 16, { align: "right" });
    pdf.setTextColor(...MORADO).text(pesos(doc.total), W - M - 6, y + 16, { align: "right" });
    pdf.setFont("helvetica", "italic").setFontSize(7.8).setTextColor(...GRIS);
    pdf.text(pdf.splitTextToSize("Son: " + Letras.pesos(doc.total), AN - 2 * tw - 14), M + 2, y + 14);
    y += 40;

    // ---------- notas ----------
    const notas = [];
    if (cfg.notaImpuestos) notas.push(["Nota: ", cfg.notaImpuestos]);
    if (cfg.datosPago) notas.push(["Forma de pago: ", cfg.datosPago]);
    if (doc.tipo === "COTIZACION") {
      notas.push(["Validez: ", `Esta cotización es válida hasta el ${corta(doc.vence)}.`]);
      notas.push(["Para aprobarla: ", `responda por WhatsApp${cfg.telefono ? " al " + cfg.telefono : ""} indicando el número ${doc.numero}.`]);
    }
    if (notas.length) {
      pdf.setFontSize(8.8);
      const renglones = notas.map(([e, t]) => {
        pdf.setFont("helvetica", "bold"); const we = pdf.getTextWidth(e);
        pdf.setFont("helvetica", "normal"); return { e, we, partes: pdf.splitTextToSize(t, AN - 24 - we) };
      });
      const alto = renglones.reduce((s, r) => s + r.partes.length * 12, 0) + 16;
      nuevaPaginaSi(alto);
      pdf.setFillColor(...SUAVE).rect(M, y, AN, alto, "F");
      let ny = y + 15;
      renglones.forEach(r => {
        pdf.setFont("helvetica", "bold").setTextColor(...MORADO).text(r.e, M + 12, ny);
        pdf.setFont("helvetica", "normal").setTextColor(...TINTA).text(r.partes, M + 12 + r.we, ny, { lineHeightFactor: 1.35 });
        ny += r.partes.length * 12;
      });
      y += alto;
    }

    // ---------- firma ----------
    nuevaPaginaSi(80);
    y += 52;
    if (cfgOriginal.firma) {
      // la firma se ajusta a un recuadro de 190 × 58 puntos y se apoya sobre la línea
      try {
        const p = pdf.getImageProperties(cfgOriginal.firma);
        const esc = Math.min(190 / p.width, 58 / p.height);
        const w = p.width * esc, h = p.height * esc;
        pdf.addImage(cfgOriginal.firma, "PNG", M + 4, y - h + 4, w, h);
      } catch (e) { /* firma dañada: el documento sale sin ella */ }
    }
    pdf.setDrawColor(...TINTA).setLineWidth(0.7).line(M, y, M + 200, y);
    pdf.setFont("helvetica", "bold").setFontSize(9.5).setTextColor(...TINTA).text(cfg.responsable || cfg.nombre || "", M, y + 14);
    pdf.setFont("helvetica", "normal").setFontSize(8.2).setTextColor(...GRIS).text(cfg.identificacion || "", M, y + 26);

    // ---------- pie en todas las páginas ----------
    const total = pdf.getNumberOfPages();
    for (let i = 1; i <= total; i++) {
      pdf.setPage(i);
      pdf.setDrawColor(...LINEA).setLineWidth(0.5).line(M, H - 44, W - M, H - 44);
      pdf.setFont("helvetica", "normal").setFontSize(7.2).setTextColor(...GRIS);
      pdf.text([cfg.nombre, cfg.direccion, cfg.telefono && "Cel. " + cfg.telefono].filter(Boolean).join("  |  "), W / 2, H - 32, { align: "center" });
      if (cfg.notaPie) pdf.setFont("helvetica", "italic").setFontSize(6.8).text(cfg.notaPie, W / 2, H - 22, { align: "center" });
      if (total > 1) pdf.text(`Página ${i} de ${total}`, W - M, H - 22, { align: "right" });
    }
    return pdf.output("blob");
  }

  return { crear, pesos };
})();

/* Número a letras para pesos colombianos */
const Letras = (() => {
  const U = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ", "ONCE", "DOCE", "TRECE",
    "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIÚN", "VEINTIDÓS", "VEINTITRÉS",
    "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
  const D = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const C = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];
  const m1 = x => { if (!x) return ""; if (x === 100) return "CIEN"; const c = Math.floor(x / 100), r = x % 100, p = c ? [C[c]] : [];
    if (r && r < 30) p.push(U[r]); else if (r) p.push(D[Math.floor(r / 10)] + (r % 10 ? " Y " + U[r % 10] : "")); return p.join(" "); };
  const m2 = x => { const k = Math.floor(x / 1000), r = x % 1000, p = []; if (k === 1) p.push("MIL"); else if (k) p.push(m1(k) + " MIL"); if (r) p.push(m1(r)); return p.join(" "); };
  function pesos(n) {
    n = Math.round(n || 0); if (!n) return "CERO PESOS M/CTE";
    const mi = Math.floor(n / 1e6), r = n % 1e6, p = [];
    if (mi === 1) p.push("UN MILLÓN"); else if (mi) p.push(m2(mi) + " MILLONES"); if (r) p.push(m2(r));
    return p.join(" ") + (n >= 1e6 && !r ? " DE" : "") + (n === 1 ? " PESO" : " PESOS") + " M/CTE";
  }
  return { pesos };
})();
