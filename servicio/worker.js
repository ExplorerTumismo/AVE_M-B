// Andén · servicio recolector (Cloudflare Worker + D1)
//
// Cada minuto (Cron Trigger):
//   1. Lee el horario Madrid–Barcelona de Renfe (horario.json, publicado con la app).
//   2. Lee el feed de retrasos en tiempo real de Renfe (GTFS-RT, alta velocidad y larga distancia).
//   3. Lee los paneles de llegadas y salidas de Madrid-Atocha, Madrid-Chamartín y Barcelona-Sants
//      (vía RadarDeTrenes, que publica los paneles oficiales a partir de datos de Renfe y Adif).
//   4. Guarda en la base de datos el estado de cada tren del día: Renfe, Iryo y Ouigo.
//
// API para la app (todas con CORS abierto):
//   GET /api/dia?fecha=AAAAMMDD     trenes de un día (por defecto, hoy)
//   GET /api/resumen?dias=14        puntualidad diaria por operador
//   GET /api/tren/03061?dias=30     historial de un tren
//   GET /api/estado                 última ejecución del recolector
//   GET /debug/tablero/71801        panel de una estación tal cual llega (para revisar el formato)
//   GET /debug/recolectar           ejecuta el recolector una vez a mano
//   GET /rt                         feed de Renfe con CORS (compatibilidad)
//
// Variables del Worker:
//   DB            base de datos D1 (binding)
//   HORARIO_URL   dirección de horario.json, p. ej. https://tu-usuario.github.io/AVE_M-B/horario.json

const FEED_RENFE = "https://gtfsrt.renfe.com/trip_updates_LD.json";
const TABLEROS = "https://radardetrenes.com/api/v1/stations/{codigo}/board-renfe";
const ESTACIONES = {
  "60000": { ciudad: "MAD", nombre: "Madrid-Puerta de Atocha" },
  "17000": { ciudad: "MAD", nombre: "Madrid-Chamartín" },
  "71801": { ciudad: "BCN", nombre: "Barcelona-Sants" },
};
const ES_MADRID = /madrid|atocha|chamart/i;
const ES_BARCELONA = /barcelona|sants/i;
const UA = { "User-Agent": "anden-trenes (uso personal; datos de Renfe y Adif)" };

// ─────────────────────────── utilidades de hora ───────────────────────────
const pad = (n) => String(n).padStart(2, "0");
const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
const fmt = (m) => { m = ((Math.round(m) % 1440) + 1440) % 1440; return pad(Math.floor(m / 60)) + ":" + pad(m % 60); };

export function madrid(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(d).map((x) => [x.type, x.value]));
  const ymd = p.year + p.month + p.day;
  const ay = new Date(Date.UTC(+p.year, +p.month - 1, +p.day - 1));
  const ayer = ay.getUTCFullYear() + pad(ay.getUTCMonth() + 1) + pad(ay.getUTCDate());
  return { ymd, ayer, min: +p.hour * 60 + +p.minute, iso: d.toISOString() };
}

// Convierte "07:30", "07:30:00", ISO o marca de tiempo a "HH:MM" en hora de Madrid
function aHHMM(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string" && /^\d{1,2}:\d{2}/.test(v.trim())) { const [h, m] = v.trim().split(":"); return pad(+h) + ":" + m.slice(0, 2); }
  let d = null;
  if (typeof v === "number") d = new Date(v < 1e12 ? v * 1000 : v);
  else if (typeof v === "string" && /^\d{10,13}$/.test(v)) d = new Date(v.length === 10 ? +v * 1000 : +v);
  else if (typeof v === "string") d = new Date(v);
  if (!d || isNaN(d)) return null;
  return fmt(madrid(d).min);
}

// "ld-05173" → "05173" · "IRYO 6123" → "06123" · "0306120261105" → "03061"
const numTren = (v) => {
  const s = String(v ?? "");
  const m = s.match(/(?:^|\D)(\d{4,5})(?:\D|$)/) || s.match(/(\d{5})/);
  return m ? m[1].padStart(5, "0") : null;
};

// ─────────────────────────── horario (Renfe GTFS) ───────────────────────────
let horarioCache = null;
async function cargarHorario(env) {
  if (horarioCache && Date.now() - horarioCache.t < 3600e3) return horarioCache.h;
  if (!env.HORARIO_URL) throw new Error("Falta la variable HORARIO_URL");
  const r = await fetch(env.HORARIO_URL, { headers: UA, cf: { cacheTtl: 3600 } });
  if (!r.ok) throw new Error("horario.json respondió " + r.status);
  const h = await r.json();
  horarioCache = { t: Date.now(), h };
  return h;
}

function programados(h, fechas) {
  const out = {};
  for (const ymd of fechas) for (const i of h.dias[ymd] || []) {
    const [numero, producto, sentido, salida, llegada] = h.trenes[i];
    out[numero + "_" + ymd] = { fecha: ymd, numero, operador: "Renfe", producto, sentido, salida_prog: salida, llegada_prog: llegada };
  }
  return out;
}

// ─────────────────────────── feed GTFS-RT de Renfe ───────────────────────────
export function parseRT(j) {
  const out = [];
  for (const e of (j && (j.entity || j.entities)) || []) {
    const tu = e.tripUpdate || e.trip_update; if (!tu) continue;
    const tr = tu.trip || {};
    const tid = String(tr.tripId || tr.trip_id || e.id || "");
    const m = tid.match(/^(\d{5})/); if (!m) continue;
    const fecha = String(tr.startDate || tr.start_date || (tid.slice(5).match(/(20\d{6})/) || [])[1] || "");
    const rel = String(tr.scheduleRelationship || tr.schedule_relationship || "").toUpperCase();
    let d = tu.delay;
    const stu = tu.stopTimeUpdate || tu.stop_time_update || [];
    if (d == null && stu.length) { const a = stu[stu.length - 1], b = stu[0]; d = (a.arrival && a.arrival.delay) ?? (b.departure && b.departure.delay) ?? (b.arrival && b.arrival.delay); }
    out.push({ numero: m[1], fecha, retraso: d == null ? null : Math.round(Number(d) / 60), cancelado: rel === "CANCELED" || rel === "CANCELLED" || rel === "3" });
  }
  return out;
}

// ─────────────────────────── paneles de estación ───────────────────────────
// Formato del panel (RadarDeTrenes /stations/{codigo}/board-renfe, fuente "renfe_official"):
//   { departures: [...], arrivals: [...], updatedAt, source }
//   cada entrada: trainCode, launchingDate (ms, salida del origen = fecha del tren),
//   originCode/originName, destinationCode/destinationName, routePreview,
//   trafficType (AVLDMD | CERCANIAS), operator ("RF"), product, plannedTime (ms),
//   delayMinutes, timeType (ESTIMATED = dato en vivo | SCHEDULED = solo horario),
//   circulationState ("" | "cancelled")
// Los trenes salen del panel cuando ya han pasado: no hay estado "llegado".
const pick = (o, ks) => { for (const k of ks) { const v = o == null ? null : o[k]; if (v != null && v !== "") return v; } return null; };

export function leerTablero(j) {
  const filas = [];
  const raiz = (j && (j.data || j.board)) || j || {};
  for (const [lista, tipo] of [[raiz.arrivals, "llegada"], [raiz.departures, "salida"]])
    if (Array.isArray(lista)) for (const e of lista) filas.push([e, tipo]);
  return filas.map(([e, tipo]) => {
    if (/cercan/i.test(String(e.trafficType || ""))) return null;
    const producto = String(pick(e, ["product", "productName", "commercialProduct"]) || "");
    const op = String(pick(e, ["operator", "operatorName", "company"]) || "");
    const pista = (op + " " + producto).toLowerCase();
    const operador = /iryo/.test(pista) ? "Iryo" : /ouigo/.test(pista) ? "Ouigo" : /^rf$|renfe/.test(op.toLowerCase()) || /ave|avlo|alvia|avant|euromed|intercity/.test(pista) ? "Renfe" : op;
    const planned = pick(e, ["plannedTime", "scheduledTime"]);
    const prog = aHHMM(planned);
    const enVivo = String(e.timeType || "ESTIMATED").toUpperCase() !== "SCHEDULED";
    const d = pick(e, ["delayMinutes", "delay"]);
    const retraso = enVivo && d != null && !isNaN(+d) ? Math.round(+d) : null;
    const lanz = pick(e, ["launchingDate"]);
    return {
      tipo,
      numero: numTren(pick(e, ["trainCode", "trainNumber", "number"])),
      fecha: lanz ? madrid(new Date(+lanz)).ymd : null,
      operador, producto: producto || operador,
      origen: String(pick(e, ["originName", "origin"]) || ""),
      destino: String(pick(e, ["destinationName", "destination"]) || ""),
      ruta: String(e.routePreview || ""),
      prog, retraso, enVivo,
      cancelado: /cancel|supri|anul/i.test(String(pick(e, ["circulationState", "status"]) || "")),
    };
  }).filter((x) => x && x.numero && x.prog);
}

async function leerPanel(codigo) {
  const r = await fetch(TABLEROS.replace("{codigo}", codigo), { headers: { ...UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`panel ${codigo}: HTTP ${r.status}`);
  return leerTablero(await r.json());
}

// ─────────────────────────── recolector ───────────────────────────
// Prioridad del retraso: panel de llegadas de la estación de destino > feed de Renfe > panel de salidas.
// Un tren se da por llegado cuando su hora de llegada (prevista + retraso) ya ha pasado
// y ha desaparecido del panel de llegadas de su estación de destino.
export async function recolectar(env, ahora = new Date(), fuentes = {}) {
  const now = madrid(ahora);
  const log = { inicio: now.iso, renfe: null, paneles: {}, cambios: 0, errores: [] };
  const h = fuentes.horario || (await cargarHorario(env));
  const prog = programados(h, [now.ayer, now.ymd]);

  const filas = (await env.DB.prepare("SELECT * FROM viajes WHERE fecha IN (?, ?)").bind(now.ayer, now.ymd).all()).results || [];
  const actual = Object.fromEntries(filas.map((f) => [f.numero + "_" + f.fecha, f]));
  const nuevos = {};
  const fila = (k, base) => nuevos[k] || (nuevos[k] = { ...(actual[k] || base) });
  const off = (f) => (f.fecha === now.ayer ? -1440 : 0);

  // 0. Alta de los trenes programados de hoy
  for (const [k, p] of Object.entries(prog)) if (!actual[k] && p.fecha === now.ymd)
    fila(k, { ...p, retraso: null, retraso_max: null, salida_real: null, llegada_real: null, llegada_tipo: null, estado: "prog", fuente: "horario" });

  const datoFeed = {}, datoLlegada = {}, datoSalida = {};

  // 1. Feed de Renfe
  let enFeed = null;
  try {
    const j = fuentes.renfe || (await (await fetch(FEED_RENFE, { headers: UA })).json());
    const lista = parseRT(j);
    enFeed = new Set();
    for (const t of lista) {
      const k = t.numero + "_" + (t.fecha || now.ymd);
      if (!prog[k] && !actual[k]) continue;
      enFeed.add(k);
      datoFeed[k] = t;
    }
    log.renfe = lista.length;
  } catch (err) { log.errores.push("feed Renfe: " + err.message); }

  // 2. Paneles de estación
  const panelOk = {}, enPanelLlegada = new Set();
  for (const [codigo, est] of Object.entries(ESTACIONES)) {
    let entradas;
    try { entradas = fuentes.paneles ? fuentes.paneles[codigo] : await leerPanel(codigo); }
    catch (err) { log.errores.push(err.message); continue; }
    if (!entradas) continue;
    panelOk[est.ciudad] = true;
    let usadas = 0;
    const otraRe = est.ciudad === "BCN" ? ES_MADRID : ES_BARCELONA;
    for (const e of entradas) {
      let fecha = e.fecha;
      if (!fecha) fecha = prog[e.numero + "_" + now.ymd] || !prog[e.numero + "_" + now.ayer] ? now.ymd : now.ayer;
      const k = e.numero + "_" + fecha;
      // ¿Es un Madrid–Barcelona en el sentido que corresponde a este panel?
      const sentidoPanel = e.tipo === "llegada" ? est.ciudad : est.ciudad === "BCN" ? "MAD" : "BCN";
      let sentido = null;
      if (prog[k] || actual[k]) sentido = (prog[k] || actual[k]).sentido;
      else if (otraRe.test(e.tipo === "llegada" ? e.origen : e.destino) || otraRe.test(e.ruta)) sentido = sentidoPanel;
      if (sentido !== sentidoPanel) continue;
      const f = fila(k, {
        fecha, numero: e.numero, operador: e.operador, producto: e.producto, sentido,
        salida_prog: null, llegada_prog: null, salida_real: null, llegada_real: null, llegada_tipo: null,
        retraso: null, retraso_max: null, estado: "prog", fuente: "estacion",
      });
      if (!f.operador) f.operador = e.operador;
      if (e.cancelado) { f.estado = "anulado"; usadas++; continue; }
      if (e.tipo === "llegada") {
        enPanelLlegada.add(k);
        f.llegada_prog = f.llegada_prog || e.prog;
        if (e.retraso != null) datoLlegada[k] = e.retraso;
      } else {
        f.salida_prog = f.salida_prog || e.prog;
        if (e.retraso != null) { datoSalida[k] = e.retraso; f.salida_real = fmt(toMin(f.salida_prog) + e.retraso); }
      }
      usadas++;
    }
    log.paneles[codigo] = { leidas: entradas.length, madridBarcelona: usadas };
  }

  // 3. Retraso de cada tren según la prioridad de fuentes
  const claves = new Set([...Object.keys(datoFeed), ...Object.keys(datoLlegada), ...Object.keys(datoSalida)]);
  for (const k of claves) {
    const f = fila(k, actual[k] || { ...prog[k], estado: "prog", fuente: "horario" });
    if (f.estado === "anulado" || f.estado === "llegado") continue;
    const t = datoFeed[k];
    if (t && t.cancelado) { f.estado = "anulado"; continue; }
    let r = null, fuente = null;
    if (datoLlegada[k] != null) { r = datoLlegada[k]; fuente = "estacion"; }
    else if (t && t.retraso != null) { r = t.retraso; fuente = "renfe"; }
    else if (datoSalida[k] != null) { r = datoSalida[k]; fuente = "estacion"; }
    if (r == null) continue;
    f.retraso = r; f.fuente = fuente;
    f.retraso_max = Math.max(f.retraso_max ?? r, r);
    const dep = toMin(f.salida_prog);
    if (dep != null && now.min >= dep + off(f) + Math.max(0, datoSalida[k] ?? 0)) f.estado = "ruta";
    else if (t && dep == null) f.estado = "ruta";
  }

  // 4. Llegadas: hora pasada y fuera del panel de llegadas de destino
  for (const k of new Set([...Object.keys(actual), ...Object.keys(nuevos)])) {
    const f = nuevos[k] || actual[k];
    if (f.estado === "anulado" || f.estado === "llegado" || f.retraso == null) continue;
    const arr = toMin(f.llegada_prog);
    if (arr == null) continue;
    const llegaEst = arr + off(f) + f.retraso;
    if (now.min < llegaEst - 1) continue;
    const fueraDePanel = panelOk[f.sentido] ? !enPanelLlegada.has(k) : enFeed ? !enFeed.has(k) : false;
    if (!fueraDePanel && now.min < llegaEst + 30) continue;
    const g = fila(k, f);
    g.estado = "llegado";
    g.llegada_real = fmt(arr + f.retraso);
    g.llegada_tipo = f.fuente === "estacion" ? "estacion" : "estimada";
  }

  // 5. Guardar solo lo que ha cambiado (y anotar cada cambio de retraso)
  const campos = ["operador", "producto", "sentido", "salida_prog", "llegada_prog", "salida_real", "llegada_real", "llegada_tipo", "retraso", "retraso_max", "estado", "fuente"];
  const stmts = [];
  for (const [k, f] of Object.entries(nuevos)) {
    const a = actual[k];
    if (a && campos.every((c) => (a[c] ?? null) === (f[c] ?? null))) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO viajes (fecha, numero, ${campos.join(", ")}, actualizado) VALUES (?, ?, ${campos.map(() => "?").join(", ")}, ?)
       ON CONFLICT (fecha, numero) DO UPDATE SET ${campos.map((c) => `${c} = excluded.${c}`).join(", ")}, actualizado = excluded.actualizado`
    ).bind(f.fecha, f.numero, ...campos.map((c) => f[c] ?? null), now.iso));
    if (f.retraso != null && f.retraso !== (a ? a.retraso : null))
      stmts.push(env.DB.prepare("INSERT INTO observaciones (fecha, numero, ts, retraso, fuente) VALUES (?, ?, ?, ?, ?)").bind(f.fecha, f.numero, now.iso, f.retraso, f.fuente));
  }
  log.cambios = stmts.length;
  stmts.push(env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('ultima', ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor").bind(JSON.stringify(log)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return log;
}

// ─────────────────────────── diagnóstico: otras vías de RadarDeTrenes ───────────────────────────
// Prueba el panel para insertar (HTML) y la herramienta MCP ver_tablero, para ver
// si incluyen Iryo y Ouigo y en qué formato. Solo se usa a mano desde /debug/radar/{codigo}.
const RADAR = "https://radardetrenes.com";
const recorta = (t, n = 6000) => (t.length > n ? t.slice(0, n) + "\n…[recortado]" : t);

async function diagnosticoRadar(codigo) {
  const out = { codigo };
  // 1. Ficha de la estación (para saber su nombre corto o "slug")
  let slug = null;
  try {
    const r = await fetch(`${RADAR}/api/v1/stations/${codigo}`, { headers: { ...UA, Accept: "application/json" } });
    const j = await r.json();
    out.estacion = j;
    const e = j.data || j.station || j;
    slug = e.slug || e.urlSlug || null;
  } catch (err) { out.estacion = { error: err.message }; }
  const candidatos = [...new Set([slug, { "71801": "barcelona-sants", "60000": "madrid-puerta-de-atocha", "17000": "madrid-chamartin" }[codigo]].filter(Boolean))];
  // 2. Panel para insertar: llegadas y salidas
  out.embed = {};
  for (const s of candidatos) {
    for (const tipo of ["llegadas", "salidas"]) {
      try {
        const r = await fetch(`${RADAR}/embed/estacion/${s}?n=15${tipo === "llegadas" ? "&tipo=llegadas" : ""}`, { headers: UA });
        const html = await r.text();
        const textoPlano = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        out.embed[`${s}/${tipo}`] = { http: r.status, menciona: { iryo: /iryo/i.test(html), ouigo: /ouigo/i.test(html) }, texto: recorta(textoPlano, 2500), html: recorta(html, 5000) };
      } catch (err) { out.embed[`${s}/${tipo}`] = { error: err.message }; }
    }
    if (Object.values(out.embed).some((x) => x.http === 200)) break;
  }
  // 3. Herramienta MCP ver_tablero
  out.mcp = {};
  try {
    const cab = { ...UA, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const leer = async (r) => {
      const t = await r.text();
      const datos = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
      try { return JSON.parse(datos.length ? datos[datos.length - 1] : t); } catch { return { crudo: recorta(t, 3000) }; }
    };
    const ini = await fetch(`${RADAR}/mcp`, { method: "POST", headers: cab, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "anden", version: "1" } } }) });
    const sid = ini.headers.get("mcp-session-id");
    out.mcp.initialize = { http: ini.status, sesion: !!sid, resp: await leer(ini) };
    if (sid) cab["Mcp-Session-Id"] = sid;
    await fetch(`${RADAR}/mcp`, { method: "POST", headers: cab, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    const lista = await leer(await fetch(`${RADAR}/mcp`, { method: "POST", headers: cab, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }));
    const tools = (lista.result && lista.result.tools) || [];
    const vt = tools.find((t) => t.name === "ver_tablero");
    out.mcp.ver_tablero_esquema = vt ? vt.inputSchema : { aviso: "no aparece ver_tablero", herramientas: tools.map((t) => t.name), resp: lista };
    if (vt) {
      const props = Object.keys((vt.inputSchema && vt.inputSchema.properties) || {});
      const args = {};
      for (const p of props) {
        if (/cod|station|estac|id|nombre|name|query/i.test(p)) args[p] = codigo;
        else if (/tipo|type|mode/i.test(p)) args[p] = "llegadas";
      }
      const res = await leer(await fetch(`${RADAR}/mcp`, { method: "POST", headers: cab, body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ver_tablero", arguments: args } }) }));
      const txt = JSON.stringify(res);
      out.mcp.llamada = { argumentos: args, menciona: { iryo: /iryo/i.test(txt), ouigo: /ouigo/i.test(txt) }, resp: JSON.parse(recorta(txt, 6000).endsWith("…[recortado]") ? JSON.stringify({ recortado: recorta(txt, 6000) }) : txt) };
    }
  } catch (err) { out.mcp.error = err.message; }
  return out;
}

// ─────────────────────────── exportar histórico ───────────────────────────
// GET /api/exportar?desde=AAAAMMDD&hasta=AAAAMMDD&formato=csv|json&datos=viajes|observaciones
// CSV con separador «;» y BOM UTF-8 para que Excel en español lo abra con columnas y acentos bien.
async function apiExportar(env, url, now) {
  const ok = (v) => /^\d{8}$/.test(v || "");
  const hasta = ok(url.searchParams.get("hasta")) ? url.searchParams.get("hasta") : now.ymd;
  const desde = ok(url.searchParams.get("desde")) ? url.searchParams.get("desde") : restarDias(hasta, 29);
  if (desde > hasta) return json({ error: "La fecha de inicio es posterior a la de fin" }, 400);
  if (desde < restarDias(hasta, 730)) return json({ error: "El periodo máximo es de dos años" }, 400);
  const formato = url.searchParams.get("formato") === "json" ? "json" : "csv";
  const obs = url.searchParams.get("datos") === "observaciones";
  const q = obs
    ? "SELECT fecha, numero, ts, retraso, fuente FROM observaciones WHERE fecha >= ? AND fecha <= ? ORDER BY fecha, numero, ts"
    : "SELECT fecha, numero, operador, producto, sentido, salida_prog, llegada_prog, salida_real, llegada_real, llegada_tipo, retraso, retraso_max, estado, fuente FROM viajes WHERE fecha >= ? AND fecha <= ? ORDER BY fecha, sentido, salida_prog";
  const filas = (await env.DB.prepare(q).bind(desde, hasta).all()).results || [];
  const isoFecha = (f) => f.slice(0, 4) + "-" + f.slice(4, 6) + "-" + f.slice(6, 8);
  const sentidoTxt = { BCN: "Madrid → Barcelona", MAD: "Barcelona → Madrid" };
  const estadoTxt = { llegado: "llegado", anulado: "anulado", ruta: "en ruta", prog: "programado" };
  const limpias = filas.map((f) => obs
    ? { fecha: isoFecha(f.fecha), tren: f.numero, momento_utc: f.ts, retraso_min: f.retraso, fuente: f.fuente }
    : {
        fecha: isoFecha(f.fecha), tren: f.numero, operador: f.operador, producto: f.producto,
        sentido: sentidoTxt[f.sentido] || f.sentido,
        salida_prevista: fmtHora(f.salida_prog), llegada_prevista: fmtHora(f.llegada_prog),
        salida_real: f.salida_real, llegada_real: f.llegada_real,
        tipo_llegada: f.llegada_tipo === "estacion" ? "panel de estación" : f.llegada_tipo === "estimada" ? "estimada" : "",
        retraso_min: f.retraso, retraso_max_min: f.retraso_max,
        estado: f.fecha < now.ymd && !["llegado", "anulado"].includes(f.estado) ? "sin datos" : estadoTxt[f.estado] || f.estado,
        fuente: f.fuente,
      });
  const nombre = `anden-${obs ? "observaciones" : "viajes"}-${desde}-${hasta}.${formato}`;
  const cab = { ...cors, "Content-Disposition": `attachment; filename="${nombre}"`, "Cache-Control": "no-store" };
  if (formato === "json")
    return new Response(JSON.stringify({ desde, hasta, generado: now.iso, fuentes: "Renfe y Adif, vía RadarDeTrenes", filas: limpias }, null, 1),
      { headers: { ...cab, "Content-Type": "application/json; charset=utf-8" } });
  const cols = limpias.length ? Object.keys(limpias[0]) : (obs ? ["fecha", "tren", "momento_utc", "retraso_min", "fuente"] : ["fecha", "tren", "operador", "producto", "sentido", "salida_prevista", "llegada_prevista", "salida_real", "llegada_real", "tipo_llegada", "retraso_min", "retraso_max_min", "estado", "fuente"]);
  const celda = (v) => { if (v == null) return ""; const t = String(v); return /[";\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = "﻿" + [cols.join(";"), ...limpias.map((r) => cols.map((c) => celda(r[c])).join(";"))].join("\r\n") + "\r\n";
  return new Response(csv, { headers: { ...cab, "Content-Type": "text/csv; charset=utf-8" } });
}
// "24:15" → "00:15" (los trenes que pasan de medianoche)
const fmtHora = (t) => (t ? fmt(toMin(t)) : null);

// ─────────────────────────── API ───────────────────────────
function estadoVisible(f, now) {
  if (f.estado === "anulado" || f.estado === "llegado") return f.estado;
  const pasado = f.fecha < now.ymd && !(f.fecha === now.ayer && toMin(f.llegada_prog) >= 1440 && now.min < toMin(f.llegada_prog) - 1440 + 120);
  if (pasado) return "sindatos";
  const off = f.fecha === now.ayer ? -1440 : 0;
  const dep = toMin(f.salida_prog), arr = toMin(f.llegada_prog);
  if (f.estado === "ruta") return "ruta";
  if (dep != null && now.min < dep + off) return "prog";
  if (arr != null && now.min < arr + off + Math.max(0, f.retraso || 0)) return "ruta";
  if (arr == null && dep != null && now.min < dep + off + 200) return "ruta";
  return "sindatos";
}

async function apiDia(env, url, now) {
  const fecha = /^\d{8}$/.test(url.searchParams.get("fecha") || "") ? url.searchParams.get("fecha") : now.ymd;
  const esHoy = fecha === now.ymd;
  const fechas = esHoy ? [now.ayer, now.ymd] : [fecha];
  const filas = (await env.DB.prepare(`SELECT * FROM viajes WHERE fecha IN (${fechas.map(() => "?").join(",")})`).bind(...fechas).all()).results || [];
  const porClave = Object.fromEntries(filas.map((f) => [f.numero + "_" + f.fecha, f]));
  // Hoy: añade los programados que el recolector aún no haya dado de alta
  if (esHoy) {
    try {
      const prog = programados(await cargarHorario(env), [now.ymd]);
      for (const [k, p] of Object.entries(prog)) if (!porClave[k]) porClave[k] = { ...p, estado: "prog", fuente: "horario" };
    } catch (e) { /* sin horario: solo lo que haya en la base de datos */ }
  }
  const trenes = Object.values(porClave)
    .map((f) => ({ ...f, estado: estadoVisible(f, now) }))
    .filter((f) => f.fecha === fecha || f.estado === "ruta")
    .map((f) => ({
      fecha: f.fecha, numero: f.numero, operador: f.operador || "", producto: f.producto || "", sentido: f.sentido,
      salida: f.salida_prog, llegada: f.llegada_prog, salida_real: f.salida_real, llegada_real: f.llegada_real,
      llegada_tipo: f.llegada_tipo, retraso: f.retraso, retraso_max: f.retraso_max, estado: f.estado, fuente: f.fuente,
    }));
  const ultima = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'ultima'").first();
  return { fecha, hoy: now.ymd, ahora: fmt(now.min), recolector: ultima ? JSON.parse(ultima.valor) : null, trenes };
}

async function apiResumen(env, url, now) {
  const dias = Math.min(90, Math.max(1, +(url.searchParams.get("dias") || 14)));
  const r = await env.DB.prepare(`
    SELECT fecha, operador,
           COUNT(*) AS trenes,
           SUM(estado = 'anulado') AS anulados,
           SUM(estado = 'llegado') AS llegados,
           ROUND(AVG(CASE WHEN estado = 'llegado' THEN MAX(retraso, 0) END), 1) AS retraso_medio,
           SUM(estado = 'llegado' AND COALESCE(retraso, 0) <= 5) AS puntuales,
           MAX(retraso_max) AS peor
    FROM viajes
    WHERE fecha >= ? AND fecha <= ?
    GROUP BY fecha, operador
    ORDER BY fecha DESC, operador`).bind(restarDias(now.ymd, dias - 1), now.ymd).all();
  return { dias, filas: r.results || [] };
}

async function apiTren(env, numero, url, now) {
  const dias = Math.min(365, Math.max(1, +(url.searchParams.get("dias") || 30)));
  const r = await env.DB.prepare("SELECT * FROM viajes WHERE numero = ? AND fecha >= ? ORDER BY fecha DESC")
    .bind(numero.padStart(5, "0"), restarDias(now.ymd, dias - 1)).all();
  return { numero, dias: r.results || [] };
}

function restarDias(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) - n));
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
}

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (b, status = 200, extra = {}) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra } });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(recolectar(env).catch((e) => console.error("recolector:", e)));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const now = madrid();
    try {
      if (url.pathname === "/api/dia") return json(await apiDia(env, url, now), 200, { "Cache-Control": "max-age=20" });
      if (url.pathname === "/api/resumen") return json(await apiResumen(env, url, now), 200, { "Cache-Control": "max-age=300" });
      const t = url.pathname.match(/^\/api\/tren\/(\d{3,5})$/);
      if (t) return json(await apiTren(env, t[1], url, now));
      if (url.pathname === "/api/exportar") return await apiExportar(env, url, now);
      if (url.pathname === "/api/estado") {
        const u = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'ultima'").first();
        return json(u ? JSON.parse(u.valor) : { aviso: "El recolector aún no se ha ejecutado" });
      }
      const rd = url.pathname.match(/^\/debug\/radar\/(\d{5})$/);
      if (rd) return json(await diagnosticoRadar(rd[1]));
      const d = url.pathname.match(/^\/debug\/tablero\/(\d{5})$/);
      if (d) {
        const r = await fetch(TABLEROS.replace("{codigo}", d[1]), { headers: { ...UA, Accept: "application/json" } });
        const crudo = await r.json().catch(() => null);
        return json({ http: r.status, interpretado: crudo ? leerTablero(crudo).slice(0, 40) : [], crudo });
      }
      if (url.pathname === "/debug/recolectar") return json(await recolectar(env));
      if (url.pathname === "/rt") {
        const r = await fetch(FEED_RENFE, { headers: UA, cf: { cacheTtl: 30 } });
        return new Response(r.body, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "max-age=30", ...cors } });
      }
      return json({ servicio: "Andén", rutas: ["/api/dia", "/api/resumen", "/api/exportar", "/api/tren/{numero}", "/api/estado", "/debug/tablero/{codigo}", "/debug/recolectar"] });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
