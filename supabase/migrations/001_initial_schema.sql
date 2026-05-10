-- ============================================================
--  Calculadora de Consecutivos Contractuales — Esquema inicial
--  Cliente: Doctux SAS  |  Inquilino seed: SULICOR
--  Ejecutar en: Supabase SQL Editor
-- ============================================================

-- ── 1. TABLAS ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS clients (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre     TEXT        NOT NULL,
  activo     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS areas (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  nombre     TEXT        NOT NULL,
  prefijo    TEXT        NOT NULL,       -- Ej. "P 05-"  (prefijo TRD, puede incluir espacios)
  activo     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consecutives_log (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  area_id             UUID        NOT NULL REFERENCES areas(id)   ON DELETE CASCADE,
  codigo_generado     TEXT        NOT NULL,
  numero_secuencial   INTEGER     NOT NULL,    -- almacenamos el número para hacer MAX() eficiente
  nombre_usuario      TEXT,
  fecha_hora_creacion TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 2. ÍNDICES ─────────────────────────────────────────────

-- Búsqueda del último número por área (usada en el motor de consecutivos)
CREATE INDEX IF NOT EXISTS idx_consec_log_area_num
  ON consecutives_log (client_id, area_id, numero_secuencial DESC);

-- Consulta del historial ordenado por fecha
CREATE INDEX IF NOT EXISTS idx_consec_log_fecha
  ON consecutives_log (client_id, fecha_hora_creacion DESC);

-- ── 3. FUNCIÓN: MOTOR DE CONSECUTIVOS ─────────────────────
--
--  Garantiza atomicidad y control de concurrencia mediante
--  SELECT … FOR UPDATE sobre la fila del área.
--  Dos llamadas simultáneas para la MISMA área se serializan;
--  áreas distintas no se bloquean entre sí.
--
CREATE OR REPLACE FUNCTION generate_consecutive(
  p_client_id    UUID,
  p_area_id      UUID,
  p_nombre_usuario TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER   -- ejecuta con privilegios del propietario (postgres), bypass RLS
AS $$
DECLARE
  v_prefijo       TEXT;
  v_area_nombre   TEXT;
  v_ultimo_numero INTEGER;
  v_nuevo_numero  INTEGER;
  v_codigo        TEXT;
  v_log_id        UUID;
BEGIN
  -- Bloquea la fila del área para serializar accesos concurrentes a ese área
  SELECT prefijo, nombre
    INTO v_prefijo, v_area_nombre
    FROM areas
   WHERE id        = p_area_id
     AND client_id = p_client_id
     AND activo    = TRUE
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Área no encontrada o inactiva (area_id: %)', p_area_id;
  END IF;

  -- Obtiene el último número secuencial registrado para este área
  SELECT COALESCE(MAX(numero_secuencial), 0)
    INTO v_ultimo_numero
    FROM consecutives_log
   WHERE client_id = p_client_id
     AND area_id   = p_area_id;

  v_nuevo_numero := v_ultimo_numero + 1;

  -- Formato: [Prefijo][número con mínimo 4 dígitos, se expande si supera 9999]
  v_codigo := v_prefijo || LPAD(v_nuevo_numero::TEXT, 4, '0');

  -- Inserta en la bitácora
  INSERT INTO consecutives_log (
    client_id, area_id, codigo_generado, numero_secuencial, nombre_usuario
  )
  VALUES (
    p_client_id, p_area_id, v_codigo, v_nuevo_numero, p_nombre_usuario
  )
  RETURNING id INTO v_log_id;

  RETURN json_build_object(
    'id',          v_log_id::TEXT,
    'codigo',      v_codigo,
    'numero',      v_nuevo_numero,
    'area_nombre', v_area_nombre
  );
END;
$$;

-- ── 4. DATOS SEMILLA ───────────────────────────────────────

-- Cliente SULICOR con UUID fijo para facilitar la variable de entorno CLIENT_ID
INSERT INTO clients (id, nombre)
VALUES ('00000000-0000-0000-0000-000000000001', 'SULICOR')
ON CONFLICT (id) DO NOTHING;

-- Áreas de SULICOR con prefijos TRD representativos
INSERT INTO areas (client_id, nombre, prefijo) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Gerencia General',  'GG-01-'),
  ('00000000-0000-0000-0000-000000000001', 'Talento Humano',    'TH-02-'),
  ('00000000-0000-0000-0000-000000000001', 'Logística',         'P 05-'),
  ('00000000-0000-0000-0000-000000000001', 'Contabilidad',      'CONT-04-'),
  ('00000000-0000-0000-0000-000000000001', 'Operaciones',       'OPS-06-')
ON CONFLICT DO NOTHING;

-- ── 5. NOTA SOBRE RLS ──────────────────────────────────────
--
--  Para este MVP, RLS está deshabilitado (comportamiento por
--  defecto en Supabase). El acceso a datos se controla
--  exclusivamente desde el servidor usando SUPABASE_SERVICE_ROLE_KEY.
--
--  Para producción con multi-tenant real, habilitar RLS y agregar:
--
--    ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
--    ALTER TABLE areas             ENABLE ROW LEVEL SECURITY;
--    ALTER TABLE consecutives_log  ENABLE ROW LEVEL SECURITY;
--
--  y definir políticas por rol/claim de JWT.
-- ============================================================
