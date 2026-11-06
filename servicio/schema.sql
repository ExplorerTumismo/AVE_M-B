-- Andén · base de datos (Cloudflare D1)
-- Un registro por tren y día. Se actualiza cada minuto mientras el tren circula.
CREATE TABLE IF NOT EXISTS viajes (
  fecha          TEXT NOT NULL,   -- AAAAMMDD (día de salida)
  numero         TEXT NOT NULL,   -- número de tren, 5 cifras
  operador       TEXT,            -- Renfe · Iryo · Ouigo
  producto       TEXT,            -- AVE · AVLO · Iryo · Ouigo…
  sentido        TEXT,            -- BCN (hacia Barcelona) · MAD (hacia Madrid)
  salida_prog    TEXT,            -- HH:MM
  llegada_prog   TEXT,            -- HH:MM (puede ser 24:15 si pasa de medianoche)
  salida_real    TEXT,            -- HH:MM según el panel de la estación
  llegada_real   TEXT,            -- HH:MM
  llegada_tipo   TEXT,            -- 'estacion' (panel) · 'estimada' (último retraso del feed)
  retraso        INTEGER,         -- último retraso conocido, minutos
  retraso_max    INTEGER,
  estado         TEXT,            -- prog · ruta · llegado · anulado
  fuente         TEXT,            -- horario · renfe · estacion
  actualizado    TEXT,            -- ISO UTC
  PRIMARY KEY (fecha, numero)
);
CREATE INDEX IF NOT EXISTS viajes_numero ON viajes (numero, fecha);

-- Cada cambio de retraso queda anotado (para ver cómo evolucionó un tren)
CREATE TABLE IF NOT EXISTS observaciones (
  fecha    TEXT NOT NULL,
  numero   TEXT NOT NULL,
  ts       TEXT NOT NULL,         -- ISO UTC
  retraso  INTEGER,
  fuente   TEXT
);
CREATE INDEX IF NOT EXISTS obs_tren ON observaciones (fecha, numero);

-- Estado del recolector
CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT
);
