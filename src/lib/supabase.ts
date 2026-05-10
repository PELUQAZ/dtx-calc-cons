import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;

/**
 * Cliente de servidor usando la service_role key.
 * Solo usar en Server Components y Server Actions — nunca en el cliente.
 * Bypasea RLS de forma segura para las operaciones internas.
 */
export function createServerClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  return createClient(supabaseUrl, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
