'use server';

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

// ── Acción principal ──────────────────────────────────────────
export async function appendConsecutiveToExcel(
  consecutive: string
): Promise<{ success: boolean; error?: string }> {
  const shareUrl = process.env.EXCEL_SHAREPOINT_URL;
  if (!shareUrl)                          return { success: false, error: 'EXCEL_SHAREPOINT_URL no configurado.' };
  if (!process.env.MICROSOFT_TENANT_ID)  return { success: false, error: 'Credenciales de Microsoft no configuradas.' };

  try {
    const token = await getGraphToken();
    const { driveId, itemId } = await getDriveItem(token, shareUrl);

    const base = `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${itemId}/workbook`;

    // 1. Crear sesión (persistChanges = true guarda en el archivo)
    const sessRes = await gfetch(token, 'POST', `${base}/createSession`, undefined, { persistChanges: true });
    if (!sessRes.ok) throw new Error(`Sesión: ${await sessRes.text()}`);
    const { id: sessionId } = await sessRes.json() as { id: string };

    // 2. Obtener nombre de la primera hoja si no está configurado
    let wsName = process.env.EXCEL_WORKSHEET_NAME ?? '';
    if (!wsName) {
      const sheetsRes = await gfetch(token, 'GET', `${base}/worksheets`, sessionId);
      if (!sheetsRes.ok) throw new Error(`Hojas: ${await sheetsRes.text()}`);
      const sheets = await sheetsRes.json() as { value: { name: string }[] };
      wsName = sheets.value[0]?.name ?? 'Sheet1';
    }

    const column = process.env.EXCEL_COLUMN ?? 'A';
    const wsEnc  = encodeURIComponent(wsName);

    // 3. Obtener rango utilizado para calcular la siguiente fila libre
    const usedRes = await gfetch(token, 'GET', `${base}/worksheets/${wsEnc}/usedRange`, sessionId);
    let nextRow = 2;
    if (usedRes.ok) {
      const used = await usedRes.json() as { rowCount: number };
      nextRow = (used.rowCount ?? 1) + 1;
    }

    const cell = `${column}${nextRow}`;

    // 4. Escribir el valor
    const valRes = await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')`,
      sessionId,
      { values: [[consecutive]] }
    );
    if (!valRes.ok) throw new Error(`Valor: ${await valRes.text()}`);

    // 5. Fondo azul (#4472C4 — azul estándar de Excel)
    await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')/format/fill`,
      sessionId,
      { color: '#4472C4' }
    );

    // 6. Fuente blanca y negrita para legibilidad
    await gfetch(
      token, 'PATCH',
      `${base}/worksheets/${wsEnc}/range(address='${cell}')/format/font`,
      sessionId,
      { color: '#FFFFFF', bold: true }
    );

    // 7. Cerrar sesión
    await gfetch(token, 'POST', `${base}/closeSession`, sessionId);

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[appendConsecutiveToExcel]', msg);
    return { success: false, error: msg };
  }
}
