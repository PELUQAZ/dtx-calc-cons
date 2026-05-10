-- ============================================================
--  Migración 002: Actualizar áreas con TRD real de SULICOR
--  Ejecutar en: Supabase SQL Editor
-- ============================================================

-- 1. Agregar columna tipo_contrato a areas
ALTER TABLE areas
  ADD COLUMN IF NOT EXISTS tipo_contrato TEXT NOT NULL DEFAULT 'OTRO';

-- 2. Limpiar datos semilla anteriores de SULICOR
DELETE FROM consecutives_log
  WHERE client_id = '00000000-0000-0000-0000-000000000001';

DELETE FROM areas
  WHERE client_id = '00000000-0000-0000-0000-000000000001';

-- 3. Insertar áreas correctas según TRD de SULICOR
--
--    Formato: [prefijo][4 dígitos]
--    Ejemplos:
--      01-0001  → Acuerdos de Confidencialidad
--      02-0001  → Contratos con Clientes
--      AL-0001  → Contratos de Alianzas
--      P 01-0001 → Proveedores Área Financiera
--
INSERT INTO areas (client_id, nombre, prefijo, tipo_contrato) VALUES

  -- Tipos simples (no requieren selección de área)
  ('00000000-0000-0000-0000-000000000001',
   'Acuerdos de Confidencialidad',   '01-',    'CONFIDENCIALIDAD'),

  ('00000000-0000-0000-0000-000000000001',
   'Contratos con Clientes',         '02-',    'CLIENTES'),

  ('00000000-0000-0000-0000-000000000001',
   'Contratos de Alianzas o Similares', 'AL-', 'ALIANZAS'),

  -- Contratos con Proveedores (requieren selección de área)
  ('00000000-0000-0000-0000-000000000001',
   'Área Financiera',                'P 01-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Área Logística',                 'P 02-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Área Talento Humano',            'P 03-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Área Sistemas',                  'P 04-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Área Trade Marketing',           'P 05-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Área Comercial',                 'P 06-',  'PROVEEDORES'),

  ('00000000-0000-0000-0000-000000000001',
   'Otros',                          'P 60-',  'PROVEEDORES');

-- ============================================================
