// Andén — proxy del feed de Renfe (Cloudflare Worker)
//
// Solo hace falta si el navegador del móvil no puede leer el feed de Renfe
// directamente (bloqueo CORS). Reenvía el feed GTFS-Realtime de alta velocidad
// y larga distancia añadiendo la cabecera CORS, con 30 s de caché.
//
// Ruta: GET /rt  →  el JSON de https://gtfsrt.renfe.com/trip_updates_LD.json

const FEED = "https://gtfsrt.renfe.com/trip_updates_LD.json";
const CACHE_SEGUNDOS = 30;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors() });
    if (url.pathname !== "/rt") return new Response("Usa /rt", { status: 404, headers: cors() });

    const cache = caches.default;
    const clave = new Request(url.origin + "/rt");
    const hit = await cache.match(clave);
    if (hit) return hit;

    let origen;
    try {
      origen = await fetch(FEED, { headers: { "User-Agent": "anden-pwa" }, cf: { cacheTtl: CACHE_SEGUNDOS } });
    } catch (err) {
      return json({ error: "No se pudo contactar con Renfe" }, 502);
    }
    if (!origen.ok) return json({ error: "Renfe respondió " + origen.status }, 502);

    const res = new Response(origen.body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SEGUNDOS}`,
        ...cors(),
      },
    });
    ctx.waitUntil(cache.put(clave, res.clone()));
    return res;
  },
};

function cors() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" };
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors() } });
}
