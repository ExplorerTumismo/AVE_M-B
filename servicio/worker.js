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
// El formato exacto de los paneles no está documentado campo a campo: este lector
// prueba los nombres habituales. Si algo no cuadra, mira /debug/tablero/71801.
const pick = (o, ks) => { for (const k of ks) { const v = k.split(".").reduce((a, b) => (a == null ? a : a[b]), o); if (v != null && v !== "") return v; } return null; };
const texto = (v) => (v == null ? "" : typeof v === "object" ? pick(v, ["name", "nombre", "shortName", "longName", "code"]) || "" : String(v));

export function leerTablero(j) {
  const filas = [];
  const add = (lista, tipo) => { if (Array.isArray(lista)) for (const e of lista) filas.push([e, tipo]); };
  const raiz = j && (j.data || j.board || j.result || j);
  add(pick(raiz, ["arrivals", "llegadas", "arrival"]), "llegada");
  add(pick(raiz, ["departures", "salidas", "departure"]), "salida");
  if (!filas.length) {
    const lista = Array.isArray(raiz) ? raiz : pick(raiz, ["items", "trains", "circulaciones", "entries", "rows"]);
    if (Array.isArray(lista)) for (const e of lista) {
      const t = String(pick(e, ["type", "tipo", "kind", "movement", "direction"]) || "").toLowerCase();
      filas.push([e, /arr|lleg/.test(t) ? "llegada" : /dep|sal/.test(t) ? "salida" : "?"]);
    }
  }
  return filas.map(([e, tipo]) => {
    const producto = texto(pick(e, ["productName", "product", "producto", "service", "serviceName", "commercialProduct", "brand"]));
    let operador = texto(pick(e, ["operatorName", "operator", "operador", "company", "empresa", "commercialCompany", "companyName", "agency"]));
    const pista = (operador + " " + producto).toLowerCase();
    operador = /iryo/.test(pista) ? "Iryo" : /ouigo/.test(pista) ? "Ouigo" : /renfe|ave|avlo|alvia|avant|euromed|intercity/.test(pista) ? "Renfe" : operador || "";
    const prog = aHHMM(pick(e, ["scheduledTime", "scheduled", "plannedTime", "planned", "scheduledArrival", "scheduledDeparture", "horaProgramada", "hora", "time"]));
    const real = aHHMM(pick(e, ["actualTime", "realTime", "actual", "horaReal", "estimatedTime", "estimated", "expectedTime", "expected", "horaEstimada"]));
    let retraso = pick(e, ["delayMinutes", "delay", "retraso", "delayMin"]);
    retraso = retraso == null || isNaN(+retraso) ? (prog && real ? toMin(real) - toMin(prog) : null) : Math.round(+retraso);
    if (retraso != null && retraso < -720) retraso += 1440;
    const estado = String(pick(e, ["status", "estado", "state", "situation"]) || "");
    return {
      tipo,
      numero: numTren(pick(e, ["trainCode", "trainNumber", "numero", "number", "train", "codigo", "code", "id"])),
      operador, producto: producto || operador,
      origen: texto(pick(e, ["originName", "origin", "origen", "from", "procedencia", "originStation"])),
      destino: texto(pick(e, ["destinationName", "destination", "destino", "to", "destinationStation"])),
      prog, real, retraso,
      hecho: /lleg|arriv|finaliz|ended|complet|sali|depart|parti/i.test(estado) && !/prev|expected|estim/i.test(estado),
      cancelado: /supri|cancel|anul/i.test(estado),
    };
  }).filter((x) => x.numero && x.prog);
}

async function leerPanel(codigo) {
  const r = await fetch(TABLEROS.replace("{codigo}", codigo), { headers: { ...UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`panel ${codigo}: HTTP ${r.status}`);
  return leerTablero(await r.json());
}

// ─────────────────────────── recolector ───────────────────────────
export async function recolectar(env, ahora = new Date(), fuentes = {}) {
  const now = madrid(ahora);
  const log = { inicio: now.iso, renfe: null, paneles: {}, cambios: 0, errores: [] };
  const h = fuentes.horario || (await cargarHorario(env));
  const prog = programados(h, [now.ayer, now.ymd]);

  const filas = (await env.DB.prepare("SELECT * FROM viajes WHERE fecha IN (?, ?)").bind(now.ayer, now.ymd).all()).results || [];
  const actual = Object.fromEntries(filas.map((f) => [f.numero + "_" + f.fecha, f]));
  const nuevos = {};      // clave → fila completa a guardar
  const obs = [];
  const fila = (k, base) => nuevos[k] || (nuevos[k] = { ...(actual[k] || base) });

  // 0. Alta de los trenes programados de hoy (para que el historial tenga el día completo)
  for (const [k, p] of Object.entries(prog)) if (!actual[k] && p.fecha === now.ymd)
    fila(k, { ...p, retraso: null, retraso_max: null, salida_real: null, llegada_real: null, llegada_tipo: null, estado: "prog", fuente: "horario" });

  // 1. Feed de Renfe
  let enFeed = null;
  try {
    const j = fuentes.renfe || (await (await fetch(FEED_RENFE, { headers: UA })).json());
    const lista = parseRT(j);
    enFeed = new Set();
    for (const t of lista) {
      const fecha = t.fecha || now.ymd;
      const k = t.numero + "_" + fecha;
      if (!prog[k] && !actual[k]) continue;   // no es un Madrid–Barcelona
      enFeed.add(k);
      const f = fila(k, { ...prog[k], retraso: null, retraso_max: null, estado: "prog", fuente: "renfe" });
      if (t.cancelado) { f.estado = "anulado"; continue; }
      if (f.llegada_tipo === "estacion") continue;   // ya confirmado por el panel
      if (t.retraso != null && t.retraso !== f.retraso) obs.push([fecha, t.numero, now.iso, t.retraso, "renfe"]);
      if (t.retraso != null) { f.retraso = t.retraso; f.retraso_max = Math.max(f.retraso_max ?? t.retraso, t.retraso); }
      const dep = toMin(f.salida_prog) ?? 0, off = fecha === now.ayer ? -1440 : 0;
      f.estado = now.min >= dep + off ? "ruta" : "prog";
      if (f.llegada_tipo === "estimada") { f.llegada_tipo = null; f.llegada_real = null; }  // reapareció
      f.fuente = f.fuente === "horario" ? "renfe" : f.fuente;
    }
    log.renfe = lista.length;
  } catch (err) { log.errores.push("feed Renfe: " + err.message); }

  // 2. Paneles de estación (todos los operadores)
  for (const [codigo, est] of Object.entries(ESTACIONES)) {
    let entradas;
    try { entradas = fuentes.paneles ? fuentes.paneles[codigo] || [] : await leerPanel(codigo); }
    catch (err) { log.errores.push(err.message); continue; }
    let usadas = 0;
    for (const e of entradas) {
      // Llegadas a una ciudad desde la otra, o salidas de una ciudad hacia la otra
      const otra = e.tipo === "llegada" ? e.origen : e.destino;
      const destinoCiudad = e.tipo === "llegada" ? est.ciudad : ES_BARCELONA.test(e.destino) ? "BCN" : ES_MADRID.test(e.destino) ? "MAD" : null;
      const deLaOtra = est.ciudad === "BCN" ? ES_MADRID.test(otra) : ES_BARCELONA.test(otra);
      if (!deLaOtra || e.tipo === "?") continue;
      const sentido = e.tipo === "llegada" ? est.ciudad : destinoCiudad;
      // Fecha del tren: si la hora del panel queda muy por delante de ahora, es de ayer
      let fecha = now.ymd;
      if (toMin(e.prog) - now.min > 720) fecha = now.ayer;
      if (e.tipo === "llegada" && fecha === now.ymd && prog[e.numero + "_" + now.ayer] && !prog[e.numero + "_" + now.ymd]) fecha = now.ayer;
      const k = e.numero + "_" + fecha;
      const f = fila(k, {
        fecha, numero: e.numero, operador: e.operador || "", producto: e.producto || e.operador || "", sentido,
        salida_prog: null, llegada_prog: null, retraso: null, retraso_max: null, estado: "prog", fuente: "estacion",
      });
      if (!f.operador && e.operador) f.operador = e.operador;
      if (e.cancelado) { f.estado = "anulado"; usadas++; continue; }
      const antes = f.retraso;
      if (e.tipo === "salida") {
        f.salida_prog = f.salida_prog || e.prog;
        if (e.hecho || (e.real && toMin(e.real) <= now.min && toMin(e.real) > now.min - 600)) { f.salida_real = e.real || e.prog; if (f.estado === "prog") f.estado = "ruta"; }
        if (e.retraso != null && f.fuente === "estacion") f.retraso = e.retraso;
      } else {
        f.llegada_prog = f.llegada_prog || e.prog;
        if (e.retraso != null && (f.fuente === "estacion" || f.retraso == null || e.hecho)) f.retraso = e.retraso;
        if (e.hecho) {
          f.estado = "llegado"; f.llegada_tipo = "estacion";
          f.llegada_real = e.real || fmt(toMin(f.llegada_prog || e.prog) + (e.retraso || 0));
        } else if (f.estado === "prog" && f.salida_prog && now.min >= toMin(f.salida_prog)) f.estado = "ruta";
      }
      if (f.retraso != null) f.retraso_max = Math.max(f.retraso_max ?? f.retraso, f.retraso);
      if (f.retraso != null && f.retraso !== antes) obs.push([fecha, e.numero, now.iso, f.retraso, "estacion"]);
      usadas++;
    }
    log.paneles[codigo] = { leidas: entradas.length, madridBarcelona: usadas };
  }

  // 3. Cierre: trenes de Renfe que ya no están en el feed y cuya llegada ya pasó
  if (enFeed) {
    for (const [k, f0] of Object.entries({ ...actual, ...nuevos })) {
      const f = nuevos[k] || f0;
      if (f.estado !== "ruta" || enFeed.has(k) || f.fuente === "estacion") continue;
      const off = f.fecha === now.ayer ? -1440 : 0;
      const llegadaEst = toMin(f.llegada_prog) + off + Math.max(0, f.retraso || 0);
      if (now.min >= llegadaEst - 10) {
        const g = fila(k, f);
        g.estado = "llegado"; g.llegada_tipo = "estimada";
        g.llegada_real = fmt(toMin(f.llegada_prog) + (f.retraso || 0));
      }
    }
  }

  // 4. Guardar solo lo que ha cambiado
  const campos = ["operador", "producto", "sentido", "salida_prog", "llegada_prog", "salida_real", "llegada_real", "llegada_tipo", "retraso", "retraso_max", "estado", "fuente"];
  const stmts = [];
  for (const [k, f] of Object.entries(nuevos)) {
    const a = actual[k];
    if (a && campos.every((c) => (a[c] ?? null) === (f[c] ?? null))) continue;
    stmts.push(env.DB.prepare(
      `INSERT INTO viajes (fecha, numero, ${campos.join(", ")}, actualizado) VALUES (?, ?, ${campos.map(() => "?").join(", ")}, ?)
       ON CONFLICT (fecha, numero) DO UPDATE SET ${campos.map((c) => `${c} = excluded.${c}`).join(", ")}, actualizado = excluded.actualizado`
    ).bind(f.fecha, f.numero, ...campos.map((c) => f[c] ?? null), now.iso));
  }
  for (const o of obs) stmts.push(env.DB.prepare("INSERT INTO observaciones (fecha, numero, ts, retraso, fuente) VALUES (?, ?, ?, ?, ?)").bind(...o));
  log.cambios = stmts.length;
  stmts.push(env.DB.prepare("INSERT INTO meta (clave, valor) VALUES ('ultima', ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor").bind(JSON.stringify(log)));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return log;
}

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
      if (url.pathname === "/api/estado") {
        const u = await env.DB.prepare("SELECT valor FROM meta WHERE clave = 'ultima'").first();
        return json(u ? JSON.parse(u.valor) : { aviso: "El recolector aún no se ha ejecutado" });
      }
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
      return json({ servicio: "Andén", rutas: ["/api/dia", "/api/resumen", "/api/tren/{numero}", "/api/estado", "/debug/tablero/{codigo}", "/debug/recolectar"] });
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
