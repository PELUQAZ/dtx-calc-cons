'use server';

import { revalidatePath } from 'next/cache';
import { createServerClient } from '@/lib/supabase';
import type { GenerateResult, LogEntry } from '@/types';

type AreaRow = { nombre: string; tipo_contrato: string } | null;

function getClientId(): string {
  const id = process.env.CLIENT_ID;
  if (!id) throw new Error('CLIENT_ID env var no configurada');
  return id;
}

/**
 * Genera el siguiente consecutivo para el área indicada.
 * La atomicidad y el control de concurrencia están garantizados
 * por la función SQL `generate_consecutive` mediante SELECT … FOR UPDATE.
 */
export async function generateConsecutive(
  areaId: string,
  nombreUsuario: string,
): Promise<GenerateResult> {
  if (!areaId) return { success: false, error: 'Debes seleccionar un área.' };

  const supabase  = createServerClient();
  const clientId  = getClientId();

  // Llamada atómica al motor de consecutivos
  const { data, error } = await supabase.rpc('generate_consecutive', {
    p_client_id:      clientId,
    p_area_id:        areaId,
    p_nombre_usuario: nombreUsuario.trim() || null,
  });

  if (error) {
    console.error('[generateConsecutive]', error.message);
    return { success: false, error: 'No se pudo generar el consecutivo. Intenta de nuevo.' };
  }

  // Obtener tipo_contrato del área para enriquecer el log de la UI
  const { data: areaData } = await supabase
    .from('areas')
    .select('tipo_contrato')
    .eq('id', areaId)
    .single();

  revalidatePath('/');

  const logEntry: LogEntry = {
    id:                  data.id,
    codigo_generado:     data.codigo,
    tipo_contrato:       (areaData as { tipo_contrato: string } | null)?.tipo_contrato ?? '',
    area_nombre:         data.area_nombre,
    nombre_usuario:      nombreUsuario.trim() || null,
    fecha_hora_creacion: new Date().toISOString(),
  };

  return { success: true, codigo: data.codigo as string, logEntry };
}

/** Elimina un registro de la bitácora por id (solo del cliente configurado). */
export async function deleteConsecutive(id: string): Promise<{ success: boolean; error?: string }> {
  const supabase = createServerClient();
  const clientId = getClientId();

  const { error } = await supabase
    .from('consecutives_log')
    .delete()
    .eq('id', id)
    .eq('client_id', clientId);

  if (error) {
    console.error('[deleteConsecutive]', error.message);
    return { success: false, error: 'No se pudo eliminar el registro.' };
  }

  revalidatePath('/');
  return { success: true };
}

/** Devuelve los últimos N registros de la bitácora para el cliente actual. */
export async function getRecentLogs(limit = 50): Promise<LogEntry[]> {
  const supabase = createServerClient();
  const clientId = getClientId();

  const { data, error } = await supabase
    .from('consecutives_log')
    .select('id, codigo_generado, nombre_usuario, fecha_hora_creacion, areas(nombre, tipo_contrato)')
    .eq('client_id', clientId)
    .order('fecha_hora_creacion', { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  return data.map((row) => {
    const area = row.areas as AreaRow;
    return {
      id:                  row.id as string,
      codigo_generado:     row.codigo_generado as string,
      tipo_contrato:       area?.tipo_contrato ?? '',
      area_nombre:         area?.nombre ?? '—',
      nombre_usuario:      row.nombre_usuario as string | null,
      fecha_hora_creacion: row.fecha_hora_creacion as string,
    };
  });
}
