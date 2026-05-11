-- ============================================================
--  Migración 003: Función latest-per-area + activar Realtime
--  Ejecutar en: Supabase SQL Editor
-- ============================================================

-- 1. Función: último consecutivo por área (LEFT JOIN LATERAL)
--    Devuelve TODAS las áreas activas del cliente;
--    si un área no tiene registros, codigo_generado = NULL.
CREATE OR REPLACE FUNCTION get_latest_per_area(p_client_id UUID)
RETURNS TABLE (
  area_id             UUID,
  tipo_contrato       TEXT,
  area_nombre         TEXT,
  codigo_generado     TEXT,
  fecha_hora_creacion TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
STABLE
AS $$
  SELECT
    a.id              AS area_id,
    a.tipo_contrato,
    a.nombre          AS area_nombre,
    last_log.codigo_generado,
    last_log.fecha_hora_creacion
  FROM areas a
  LEFT JOIN LATERAL (
    SELECT codigo_generado, fecha_hora_creacion
    FROM   consecutives_log
    WHERE  area_id   = a.id
      AND  client_id = p_client_id
    ORDER  BY fecha_hora_creacion DESC
    LIMIT  1
  ) last_log ON TRUE
  WHERE  a.client_id = p_client_id
    AND  a.activo    = TRUE
  ORDER BY a.tipo_contrato, a.nombre;
$$;

-- 2. Activar Realtime para consecutives_log
--    (permite suscripciones en tiempo real desde el browser)
ALTER PUBLICATION supabase_realtime ADD TABLE consecutives_log;

-- ============================================================
--  NOTA: después de ejecutar este SQL, ve a Supabase Dashboard →
--  Database → Replication → Tables y verifica que
--  consecutives_log aparece como "Realtime enabled".
-- ============================================================
