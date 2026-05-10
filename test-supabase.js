#!/usr/bin/env node

/**
 * Script de diagnóstico para probar la conexión a Supabase
 * Ejecución: node test-supabase.js
 */

require('dotenv').config({ path: '.env.local' });

const { createClient } = require('@supabase/supabase-js');

console.log('\n╔════════════════════════════════════════════════════════╗');
console.log('║       DIAGNÓSTICO DE CONEXIÓN A SUPABASE              ║');
console.log('╚════════════════════════════════════════════════════════╝\n');

// ── 1. Verificar variables de entorno ──────────────────────

console.log('📋 PASO 1: Verificando variables de entorno...\n');

const ENV_VARS = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  CLIENT_ID: process.env.CLIENT_ID,
};

let allVarsPresent = true;

Object.entries(ENV_VARS).forEach(([key, value]) => {
  const status = value ? '✅' : '❌';
  const displayValue = value
    ? value.substring(0, 30) + (value.length > 30 ? '...' : '')
    : '(vacío)';
  console.log(`  ${status} ${key}`);
  console.log(`      ${displayValue}`);

  if (!value) {
    allVarsPresent = false;
  }
});

if (!allVarsPresent) {
  console.log('\n❌ Faltan variables de entorno. Asegúrate de que .env.local esté completo.\n');
  process.exit(1);
}

console.log('\n✅ Todas las variables están presentes.\n');

// ── 2. Conectar a Supabase ────────────────────────────────

console.log('🔌 PASO 2: Intentando conectar a Supabase...\n');

const supabase = createClient(
  ENV_VARS.NEXT_PUBLIC_SUPABASE_URL,
  ENV_VARS.SUPABASE_SERVICE_ROLE_KEY || ENV_VARS.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

console.log(`  URL: ${ENV_VARS.NEXT_PUBLIC_SUPABASE_URL}`);
console.log(`  Usando: ${ENV_VARS.SUPABASE_SERVICE_ROLE_KEY ? 'service_role_key' : 'anon_key'}`);
console.log('');

// ── 3. Probar conexión ────────────────────────────────────

async function test() {
  try {
    // Test 1: Verificar que la tabla `clients` existe
    console.log('📊 PASO 3: Verificando tablas y datos...\n');

    const { data: clients, error: clientsError } = await supabase
      .from('clients')
      .select('*');

    if (clientsError) {
      console.log(`  ❌ Error al consultar tabla 'clients':`);
      console.log(`     ${clientsError.message}`);
      console.log('');
      process.exit(1);
    }

    console.log(`  ✅ Tabla 'clients' accesible`);
    console.log(`     ${clients.length} registro(s) encontrado(s)`);

    // Buscar SULICOR
    const sulicor = clients.find((c) => c.nombre === 'SULICOR');
    if (sulicor) {
      console.log(`     → SULICOR encontrado (id: ${sulicor.id})`);
    } else {
      console.log(`     ⚠️  SULICOR NO encontrado`);
    }
    console.log('');

    // Test 2: Tabla areas
    const { data: areas, error: areasError } = await supabase
      .from('areas')
      .select('*')
      .eq('client_id', ENV_VARS.CLIENT_ID);

    if (areasError) {
      console.log(`  ❌ Error al consultar tabla 'areas':`);
      console.log(`     ${areasError.message}`);
      process.exit(1);
    }

    console.log(`  ✅ Tabla 'areas' accesible`);
    console.log(`     ${areas.length} área(s) activa(s) para SULICOR`);
    if (areas.length > 0) {
      areas.slice(0, 3).forEach((a) => {
        console.log(`     → ${a.nombre} (prefijo: "${a.prefijo}")`);
      });
      if (areas.length > 3) {
        console.log(`     ... y ${areas.length - 3} más`);
      }
    }
    console.log('');

    // Test 3: Tabla consecutives_log
    const { data: logs, error: logsError } = await supabase
      .from('consecutives_log')
      .select('*')
      .eq('client_id', ENV_VARS.CLIENT_ID)
      .limit(3);

    if (logsError) {
      console.log(`  ❌ Error al consultar tabla 'consecutives_log':`);
      console.log(`     ${logsError.message}`);
      process.exit(1);
    }

    console.log(`  ✅ Tabla 'consecutives_log' accesible`);
    console.log(`     ${logs.length} registro(s) de historial`);
    console.log('');

    // Test 4: Función RPC
    console.log('⚡ PASO 4: Verificando función RPC...\n');

    // Intenta llamar la función (sin parámetros para solo verificar que existe)
    const { data: rpcTest, error: rpcError } = await supabase.rpc(
      'generate_consecutive',
      {
        p_client_id: ENV_VARS.CLIENT_ID,
        p_area_id: areas.length > 0 ? areas[0].id : null,
        p_nombre_usuario: 'TEST_DIAGNOSTICO',
      }
    );

    if (rpcError) {
      // Si falla, podría ser porque ya existe o por otro motivo
      if (rpcError.message.includes('function') || rpcError.message.includes('does not exist')) {
        console.log(`  ❌ Función 'generate_consecutive' NO ENCONTRADA`);
        console.log(`     ${rpcError.message}`);
        console.log('');
        console.log('⚠️  ACCIÓN REQUERIDA:');
        console.log('   Ejecuta el SQL de migración en Supabase → SQL Editor:');
        console.log('   supabase/migrations/001_initial_schema.sql');
      } else {
        console.log(`  ✅ Función 'generate_consecutive' existe`);
        console.log(`     Resultado: ${JSON.stringify(rpcTest)}`);
      }
    } else {
      console.log(`  ✅ Función 'generate_consecutive' ejecutada correctamente`);
      console.log(`     Nuevo consecutivo generado: ${rpcTest.codigo}`);
    }
    console.log('');

    // ── Resumen final ──────────────────────────────────────

    console.log('╔════════════════════════════════════════════════════════╗');
    console.log('║                   ✅ DIAGNÓSTICO OK                    ║');
    console.log('╚════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('La conexión a Supabase funciona correctamente.');
    console.log('Puedes volver a ejecutar: npm run dev');
    console.log('');

  } catch (err) {
    console.log('\n❌ ERROR INESPERADO:\n');
    console.log(err.message);
    console.log('\nStack trace:');
    console.log(err.stack);
    process.exit(1);
  }
}

test();
