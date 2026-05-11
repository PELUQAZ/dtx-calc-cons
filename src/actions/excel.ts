'use server';

import { revalidatePath } from 'next/cache';
import { createServerClient } from '@/lib/supabase';

// ── Token cache (se renueva automáticamente antes de expirar) ──
let _cachedToken: { token: string; expiresAt: number } | null = null;

async function getGraphToken(): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt - 60_000) {
    return _cachedToken.token;
  }

  const tenantId     = process.env.MICROSOFT_TENANT_ID!;
  const clientId     = process.env.MICROSOFT_CLIENT_ID!;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET!;

  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     clientId,
        client_secret: clientSecret,
        scope:         'https://graph.microsoft.com/.default',
      }),
      cache: 'no-store',
    }
  );

  if (!res.ok) throw new Error(`Token error: ${await res.text()}`);

  const data = await res.json() as { access_token: string; expires_in: number };
  _cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

// ── Codifica sharing URL para Graph API ──────────────────────
function encodeSharingUrl(url: string): string {
  return 'u!' + Buffer.from(url).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── driveId / itemId cache ────────────────────────────────────
let _cachedRef: { driveId: string; itemId: string } | null = null;

async function getDriveItem(token: string, shareUrl: string) {
  if (_cachedRef) return _cachedRef;

  // Atajo: si el usuario configuró EXCEL_DRIVE_ID + EXCEL_ITEM_ID se salta
  // toda la resolución de URL (más estable en producción).
  const envDriveId = process.env.EXCEL_DRIVE_ID;
  const envItemId  = process.env.EXCEL_ITEM_ID;
  if (envDriveId && envItemId) {
    _cachedRef = { driveId: envDriveId, itemId: envItemId };
    return _cachedRef!;
  }

  // Intento 1: endpoint /shares/ de Graph
  const sharesRes = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${encodeSharingUrl(shareUrl)}/driveItem?$select=id,parentReference`,
    { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
  );
  if (sharesRes.ok) {
    const item = await sharesRes.json();
    _cachedRef = { driveId: item.parentReference.driveId as string, itemId: item.id as string };
    return _cachedRef!;
  }
  const errBody = await sharesRes.text().catch(() => '');

  // Intento 2: URL personal de OneDrive for Business
  // https://{tenant}-my.sharepoint.com/:x:/g/personal/{userFolder}/{resid}[?e=...]
  const m = shareUrl.match(
    /https:\/\/([^/]+-my\.sharepoint\.com)\/:x:\/g\/personal\/([^/]+)\/([^?/]+)/
  );
  if (m) {
    const [, hostname, userFolder, resid] = m;

    // 2a: vía /sites/{hostname}:/personal/{userFolder} (requiere Sites.ReadWrite.All)
    const siteRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}:/personal/${userFolder}?$select=id`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
    );
    if (siteRes.ok) {
      const siteId = (await siteRes.json()).id as string;
      const driveRes = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${siteId}/drive?$select=id`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
      );
      if (driveRes.ok) {
        const driveId = (await driveRes.json()).id as string;
        const itemRes = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${resid}?$select=id`,
          { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
        );
        if (itemRes.ok) {
          _cachedRef = { driveId, itemId: (await itemRes.json()).id as string };
          return _cachedRef!;
        }
      }
    }

    // 2b: vía /users/{upn}/drive (requiere Files.ReadWrite.All + admin consent)
    const parts  = userFolder.split('_');
    const tld    = parts.pop()!;
    const domain = parts.pop()!;
    const upn    = `${parts.join('_')}@${domain}.${tld}`;
    const userDriveRes = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(upn)}/drive?$select=id`,
      { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
    );
    if (userDriveRes.ok) {
      const driveId = (await userDriveRes.json()).id as string;
      const itemRes = await fetch(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${resid}?$select=id`,
        { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }
      );
      if (itemRes.ok) {
        _cachedRef = { driveId, itemId: (await itemRes.json()).id as string };
        return _cachedRef!;
      }
    }
  }

  throw new Error(
    `Sin acceso al archivo Excel. Revisa: ` +
    `(1) permiso "Files.ReadWrite.All" (Application) con consentimiento de administrador concedido en Azure AD, ` +
    `(2) permiso "Sites.ReadWrite.All" (Application) también con consent, ` +
    `o (3) configura EXCEL_DRIVE_ID + EXCEL_ITEM_ID directamente (ver .env.example). ` +
    `API: ${errBody}`
  );
}

// ── Helper fetch con cabeceras de Graph + sesión ──────────────
async function gfetch(
  token: string, method: string, url: string,
  sessionId?: string, body?: object
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization:   `Bearer ${token}`,
    'Content-Type':  'application/json',
  };
  if (sessionId) headers['workbook-session-id'] = sessionId;
  return fetch(url, {
    method,
    headers,
    body:  body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
}

// ── Helper: obtiene el workbook base URL ──────────────────────
function hasExcelConfig() {
  return !!(
    (process.env.EXCEL_SHAREPOINT_URL || (process.env.EXCEL_DRIVE_ID && process.env.EXCEL_ITEM_ID)) &&
    process.env.MICROSOFT_TENANT_ID
  );
}

// ── Acción: agregar consecutivo al Excel ──────────────────────
export async function appendConsecutiveToExcel(
  consecutive: string
): Promise<{ success: boolean; error?: string }> {
  const shareUrl     = process.env.EXCEL_SHAREPOINT_URL ?? '';
  const hasDirectIds = !!(process.env.EXCEL_DRIVE_ID && process.env.EXCEL_ITEM_ID);
  if (!shareUrl && !hasDirectIds) return { success: false, error: 'EXCEL_SHAREPOINT_URL no configurado.' };
  if (!process.env.MICROSOFT_TENANT_ID) return { success: false, error: 'Credenciales de Microsoft no configuradas.' };

  try {
    const token = await getGraphToken();
    const { driveId, itemId } = await getDriveItem(token, shareUrl);

    const base = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook`;

    // 1. Crear sesión (persistChanges = true guarda en el archivo)
    const sessRes = await gfetch(token, 'POST', `${base}/createSession`, undefined, { persistChanges: true });
    if (!sessRes.ok) throw new Error(`Sesión: ${await sessRes.text()}`);
    const { id: sessionId } = await sessRes.json() as { id: string };

    // 2. Nombre de la primera hoja si no está configurado
    let wsName = process.env.EXCEL_WORKSHEET_NAME ?? '';
    if (!wsName) {
      const sheetsRes = await gfetch(token, 'GET', `${base}/worksheets`, sessionId);
      if (!sheetsRes.ok) throw new Error(`Hojas: ${await sheetsRes.text()}`);
      const sheets = await sheetsRes.json() as { value: { name: string }[] };
      wsName = sheets.value[0]?.name ?? 'Sheet1';
    }

    const column = process.env.EXCEL_COLUMN ?? 'A';
    const wsEnc  = encodeURIComponent(wsName);

    // 3. Fila libre siguiente
    const usedRes = await gfetch(token, 'GET', `${base}/worksheets/${wsEnc}/usedRange`, sessionId);
    let nextRow = 2;
    if (usedRes.ok) {
      const used = await usedRes.json() as { rowCount: number };
      nextRow = (used.rowCount ?? 1) + 1;
    }

    const cell = `${column}${nextRow}`;

    // 4. Escribir valor
    const valRes = await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')`,
      sessionId,
      { values: [[consecutive]] }
    );
    if (!valRes.ok) throw new Error(`Valor: ${await valRes.text()}`);

    // 5. Color de fondo (#8EA9DB — azul claro igual al resto de la columna)
    await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')/format/fill`,
      sessionId,
      { color: '#8EA9DB' }
    );

    // 6. Fuente negra, sin negrita
    await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')/format/font`,
      sessionId,
      { color: '#000000', bold: false }
    );

    // 7. Alineación centrada
    await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')/format`,
      sessionId,
      { horizontalAlignment: 'Center' }
    );

    // 8. Cerrar sesión
    await gfetch(token, 'POST', `${base}/closeSession`, sessionId);

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[appendConsecutiveToExcel]', msg);
    return { success: false, error: msg };
  }
}

// ── Acción: sincronizar BD desde Excel ───────────────────────
// Lee la columna configurada, detecta el máximo numero_secuencial por
// prefijo, e inserta una entrada semilla en consecutives_log para que
// generate_consecutive continúe desde el número correcto.
export async function syncFromExcel(): Promise<{
  success: boolean;
  updated: number;
  skipped: number;
  error?: string;
}> {
  if (!hasExcelConfig()) {
    return { success: false, updated: 0, skipped: 0, error: 'Excel no configurado.' };
  }

  try {
    const shareUrl = process.env.EXCEL_SHAREPOINT_URL ?? '';
    const token    = await getGraphToken();
    const { driveId, itemId } = await getDriveItem(token, shareUrl);
    const base     = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook`;

    // Sesión de solo lectura
    const sessRes = await gfetch(token, 'POST', `${base}/createSession`, undefined, { persistChanges: false });
    if (!sessRes.ok) throw new Error(`Sesión: ${await sessRes.text()}`);
    const { id: sessionId } = await sessRes.json() as { id: string };

    // Nombre de la hoja
    let wsName = process.env.EXCEL_WORKSHEET_NAME ?? '';
    if (!wsName) {
      const sheetsRes = await gfetch(token, 'GET', `${base}/worksheets`, sessionId);
      if (!sheetsRes.ok) throw new Error(`Hojas: ${await sheetsRes.text()}`);
      const sheets = await sheetsRes.json() as { value: { name: string }[] };
      wsName = sheets.value[0]?.name ?? 'Sheet1';
    }
    const wsEnc  = encodeURIComponent(wsName);
    const colIdx = (process.env.EXCEL_COLUMN ?? 'A').toUpperCase().charCodeAt(0) - 65; // A=0

    // Leer todos los valores del rango utilizado
    const rangeRes = await gfetch(token, 'GET',
      `${base}/worksheets/${wsEnc}/usedRange?$select=values`, sessionId);
    if (!rangeRes.ok) throw new Error(`Lectura: ${await rangeRes.text()}`);
    const { values } = await rangeRes.json() as { values: (string | number | null)[][] };

    await gfetch(token, 'POST', `${base}/closeSession`, sessionId);

    // Parsear: máximo numero_secuencial por prefijo
    // Formato esperado: {prefijo}{4+ dígitos}  Ej: "P 05-0229", "AL-0003"
    // Entradas malformadas (espacios extra, sufijos, sin guión) se ignoran.
    const maxByPrefix = new Map<string, number>();
    for (const row of values) {
      const raw = String(row[colIdx] ?? '').trim();
      if (!raw) continue;
      const match = raw.match(/^(.+?-)(\d{4,})$/);
      if (!match) continue;
      const prefix = match[1];
      const num    = parseInt(match[2], 10);
      if (num > (maxByPrefix.get(prefix) ?? -1)) maxByPrefix.set(prefix, num);
    }

    if (maxByPrefix.size === 0) {
      return { success: true, updated: 0, skipped: 0 };
    }

    // Obtener áreas de la BD
    const supabase = createServerClient();
    const clientId = process.env.CLIENT_ID!;
    const { data: areas } = await supabase
      .from('areas')
      .select('id, prefijo')
      .eq('client_id', clientId)
      .eq('activo', true);

    if (!areas?.length) throw new Error('Sin áreas en la base de datos.');

    let updated = 0;
    let skipped = 0;

    for (const area of areas) {
      const excelMax = maxByPrefix.get(area.prefijo);
      if (excelMax === undefined) { skipped++; continue; }

      // Máximo actual en BD para este área
      const { data: topRow } = await supabase
        .from('consecutives_log')
        .select('numero_secuencial')
        .eq('client_id', clientId)
        .eq('area_id', area.id)
        .order('numero_secuencial', { ascending: false })
        .limit(1)
        .maybeSingle();

      const dbMax = (topRow as { numero_secuencial: number } | null)?.numero_secuencial ?? -1;

      if (excelMax <= dbMax) { skipped++; continue; }

      // Insertar entrada semilla: generate_consecutive continuará desde excelMax + 1
      const codigo = area.prefijo + String(excelMax).padStart(4, '0');
      await supabase.from('consecutives_log').insert({
        client_id:         clientId,
        area_id:           area.id,
        codigo_generado:   codigo,
        numero_secuencial: excelMax,
        nombre_usuario:    'Sync Excel',
      });
      updated++;
    }

    revalidatePath('/');
    return { success: true, updated, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[syncFromExcel]', msg);
    return { success: false, updated: 0, skipped: 0, error: msg };
  }
}
