#!/usr/bin/env python3
"""Genera horario.json con los trenes de Renfe entre Madrid y Barcelona.

Descarga el GTFS oficial de Renfe (Alta Velocidad, Larga y Media Distancia),
se queda con los viajes que paran en una estación de Madrid y en otra de
Barcelona, y apunta para cada uno el número de tren, el producto (AVE, AVLO…),
el sentido, la hora de salida y la de llegada, y los días en que circula.

Uso:
    python3 scripts/generar_horario.py --salida dist/horario.json
    python3 scripts/generar_horario.py --gtfs google_transit.zip --salida dist/horario.json
"""
import argparse, csv, io, json, re, sys, urllib.request, zipfile
from datetime import date, datetime, timedelta

GTFS_URL = "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip"
DIAS_VISTA = 45  # cuántos días hacia delante se calculan

ES_MADRID = re.compile(r"^\s*madrid", re.I)
ES_BARCELONA = re.compile(r"^\s*barcelona", re.I)
SEMANA = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def leer(z, nombre):
    # Los ficheros de Renfe rellenan columnas con espacios, también en la cabecera:
    # se limpian nombres y valores para que "exception_type   " sea "exception_type".
    try:
        with z.open(nombre) as f:
            filas = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))
            return [{(k or "").strip().lower(): (v or "").strip() for k, v in fila.items()} for fila in filas]
    except KeyError:
        return []


def hhmm(t):
    """'07:30:00' -> '07:30'. Mantiene horas >= 24 (viajes que pasan de medianoche)."""
    h, m = t.strip().split(":")[:2]
    return f"{int(h):02d}:{m}"


def numero_tren(trip):
    corto = (trip.get("trip_short_name") or "").strip()
    if corto.isdigit():
        return corto.zfill(5)
    m = re.match(r"\d{5}", trip["trip_id"].strip())
    return m.group(0) if m else trip["trip_id"].strip()


def generar(zbytes, hoy):
    z = zipfile.ZipFile(io.BytesIO(zbytes))
    stops = {s["stop_id"].strip(): s["stop_name"].strip() for s in leer(z, "stops.txt")}
    ciudad = {}
    for sid, nombre in stops.items():
        if ES_MADRID.match(nombre):
            ciudad[sid] = "MAD"
        elif ES_BARCELONA.match(nombre):
            ciudad[sid] = "BCN"
    if not any(v == "MAD" for v in ciudad.values()) or not any(v == "BCN" for v in ciudad.values()):
        sys.exit("No encuentro estaciones de Madrid y Barcelona en stops.txt: revisa el GTFS.")

    # Paradas de cada viaje en Madrid o Barcelona
    paradas = {}
    for st in leer(z, "stop_times.txt"):
        sid = st["stop_id"].strip()
        if sid in ciudad:
            paradas.setdefault(st["trip_id"].strip(), []).append(
                (int(st["stop_sequence"]), ciudad[sid], st["arrival_time"], st["departure_time"]))

    rutas = {r["route_id"].strip(): r for r in leer(z, "routes.txt")}
    trips = {t["trip_id"].strip(): t for t in leer(z, "trips.txt")}

    trenes, servicio_de = [], []
    for tid, ps in paradas.items():
        ciudades = {p[1] for p in ps}
        if ciudades != {"MAD", "BCN"} or tid not in trips:
            continue
        ps.sort()
        origen = ps[0][1]
        destino = "BCN" if origen == "MAD" else "MAD"
        sale = [p for p in ps if p[1] == origen]
        llega = [p for p in ps if p[1] == destino]
        if sale[-1][0] > llega[0][0]:
            continue  # orden raro: pasa por destino antes que por origen
        trip = trips[tid]
        ruta = rutas.get(trip["route_id"].strip(), {})
        producto = (ruta.get("route_short_name") or ruta.get("route_long_name") or "").strip() or "Renfe"
        trenes.append([numero_tren(trip), producto, destino, hhmm(sale[-1][3]), hhmm(llega[0][2])])
        servicio_de.append(trip["service_id"].strip())

    # Días en que circula cada servicio
    cal = {c["service_id"].strip(): c for c in leer(z, "calendar.txt")}
    excep = {}
    for cd in leer(z, "calendar_dates.txt"):
        excep[(cd["service_id"].strip(), cd["date"].strip())] = cd["exception_type"].strip()

    def circula(sid, d):
        clave = d.strftime("%Y%m%d")
        e = excep.get((sid, clave))
        if e == "1":
            return True
        if e == "2":
            return False
        c = cal.get(sid)
        if not c:
            return False
        return (c["start_date"] <= clave <= c["end_date"]) and c.get(SEMANA[d.weekday()], "0").strip() == "1"

    dias = {}
    for i in range(-1, DIAS_VISTA):  # incluye ayer para los trenes que pasan de medianoche
        d = hoy + timedelta(days=i)
        idx = [n for n, sid in enumerate(servicio_de) if circula(sid, d)]
        if idx:
            dias[d.strftime("%Y%m%d")] = idx

    return {
        "generado": datetime.now().isoformat(timespec="minutes"),
        "fuente": GTFS_URL,
        "columnas": ["numero", "producto", "sentido", "salida", "llegada"],
        "trenes": trenes,
        "dias": dias,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gtfs", help="ruta a un google_transit.zip ya descargado")
    ap.add_argument("--salida", default="horario.json")
    ap.add_argument("--hoy", help="fecha base AAAA-MM-DD (para pruebas)")
    a = ap.parse_args()
    if a.gtfs:
        data = open(a.gtfs, "rb").read()
    else:
        req = urllib.request.Request(GTFS_URL, headers={"User-Agent": "anden-horario"})
        data = urllib.request.urlopen(req, timeout=120).read()
    hoy = date.fromisoformat(a.hoy) if a.hoy else date.today()
    out = generar(data, hoy)
    with open(a.salida, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{len(out['trenes'])} trenes Madrid–Barcelona, {len(out['dias'])} días → {a.salida}")


if __name__ == "__main__":
    main()
