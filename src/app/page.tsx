import { createServerClient } from '@/lib/supabase';
import MainForm from '@/components/MainForm';
import type { Area, LogEntry } from '@/types';

/** Recarga la página fresca en cada visita (sin cache estático). */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const supabase  = createServerClient();
  const clientId  = process.env.CLIENT_ID;

  if (!clientId) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-8 py-6 max-w-md text-center">
          <p className="font-semibold mb-1">Configuración incompleta</p>
          <p className="text-sm">
            La variable de entorno <code className="font-mono bg-red-100 px-1 rounded">CLIENT_ID</code> no está definida.
            Crea el archivo <code className="font-mono bg-red-100 px-1 rounded">.env.local</code> a partir de{' '}
            <code className="font-mono bg-red-100 px-1 rounded">.env.example</code>.
          </p>
        </div>
      </div>
    );
  }

  const [{ data: areasRaw }, { data: logsRaw }] = await Promise.all([
    supabase
      .from('areas')
      .select('id, client_id, nombre, prefijo, tipo_contrato, activo, created_at')
      .eq('client_id', clientId)
      .eq('activo', true)
      .order('nombre'),

    supabase
      .from('consecutives_log')
      .select('id, codigo_generado, nombre_usuario, fecha_hora_creacion, areas(nombre, tipo_contrato)')
      .eq('client_id', clientId)
      .order('fecha_hora_creacion', { ascending: false })
      .limit(50),
  ]);

  const areas: Area[] = (areasRaw ?? []) as Area[];

  type AreaJoin = { nombre: string; tipo_contrato: string } | null;

  const initialLogs: LogEntry[] = (logsRaw ?? []).map((row) => {
    const area = row.areas as AreaJoin;
    return {
      id:                  row.id as string,
      codigo_generado:     row.codigo_generado as string,
      tipo_contrato:       area?.tipo_contrato ?? '',
      area_nombre:         area?.nombre ?? '—',
      nombre_usuario:      row.nombre_usuario as string | null,
      fecha_hora_creacion: row.fecha_hora_creacion as string,
    };
  });

  return <MainForm areas={areas} initialLogs={initialLogs} />;
}
