#!/usr/bin/env node

/**
 * Script simple de diagnóstico (sin dependencias)
 * Ejecución: node test-supabase-simple.js
 */

const fs = require('fs');
const path = require('path');

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║       DIAGNÓSTICO DE CONEXIÓN A SUPABASE              ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// ── Leer .env.local ────────────────────────────────────────

console.log('📋 Leyendo .env.local...\n');

const envPath = path.join(__dirname, '.env.local');

if (!fs.existsSync(envPath)) {
  console.log('❌ Archivo .env.local NO ENCONTRADO en:', envPath);
  console.log('\n⚠️  Acciones:');
  console.log('   1. Copia .env.example → .env.local');
  console.log('   2. Llena los 4 valores desde Supabase Dashboard');
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};

envContent.split('\n').forEach((line) => {
  if (line.trim() && !line.startsWith('#')) {
    const [key, ...valueParts] = line.split('=');
    env[key.trim()] = valueParts.join('=').trim();
  }
});

// ── Validar variables ──────────────────────────────────────

const required = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CLIENT_ID',
];

let valid = true;

required.forEach((key) => {
  const value = env[key];
  const status = value ? '✅' : '❌';
  const display = value ? value.substring(0, 40) + (value.length > 40 ? '...' : '') : '(vacío)';

  console.log(`${status} ${key}`);
  console.log(`   ${display}\n`);

  if (!value) valid = false;
});

if (!valid) {
  console.log('❌ Faltan variables. Edita .env.local y completa todos los valores.\n');
  process.exit(1);
}

console.log('✅ Variables de entorno OK\n');

// ── Intenta cargar @supabase/supabase-js ──────────────────

console.log('🔌 Intentando importar @supabase/supabase-js...\n');

let supabase;

try {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  console.log('✅ Conexión creada\n');
} catch (err) {
  console.log('❌ No se puede cargar @supabase/supabase-js');
  console.log(`   Error: ${err.message}`);
  console.log('\n⚠️  Debes ejecutar primero: npm install\n');
  process.exit(1);
}

// ── Probar consultas ───────────────────────────────────────

async function test() {
  console.log('📊 Probando consultas...\n');

  try {
    const { data: clients, error: e1 } = await supabase.from('clients').select('*');

    if (e1) throw new Error(`clients: ${e1.message}`);
    console.log(`✅ Tabla 'clients': ${clients.length} registros\n`);

    const { data: areas, error: e2 } = await supabase
      .from('areas')
      .select('*')
      .eq('client_id', env.CLIENT_ID);

    if (e2) throw new Error(`areas: ${e2.message}`);
    console.log(`✅ Tabla 'areas': ${areas.length} áreas para SULICOR`);
    if (areas.length > 0) {
      areas.slice(0, 3).forEach((a) => console.log(`   • ${a.nombre} (${a.prefijo})`));
    }
    console.log('');

    const { data: logs, error: e3 } = await supabase
      .from('consecutives_log')
      .select('*')
      .eq('client_id', env.CLIENT_ID)
      .limit(5);

    if (e3) throw new Error(`consecutives_log: ${e3.message}`);
    console.log(`✅ Tabla 'consecutives_log': ${logs.length} registros\n`);

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║              ✅ TODO FUNCIONA CORRECTAMENTE             ║');
    console.log('╚════════════════════════════════════════════════════════╝\n');
    console.log('Ahora ejecuta: npm run dev\n');

  } catch (err) {
    console.log(`❌ ERROR: ${err.message}\n`);

    if (err.message.includes('JWT')) {
      console.log('⚠️  Parece un problema con las API keys de Supabase.');
      console.log('   Verifica que copiastes bien los valores desde:');
      console.log('   Supabase → Settings → API\n');
    }

    if (err.message.includes('function') || err.message.includes('does not exist')) {
      console.log('⚠️  La tabla o función no existe.');
      console.log('   Ejecuta el SQL en Supabase → SQL Editor:');
      console.log('   supabase/migrations/001_initial_schema.sql\n');
    }

    process.exit(1);
  }
}

test();
