'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { generateConsecutive, deleteConsecutive, getLatestPerArea } from '@/actions/consecutives';
import { appendConsecutiveToExcel, syncFromExcel } from '@/actions/excel';
import { getBrowserClient } from '@/lib/supabase';
import type { Area, LatestByArea, LogEntry } from '@/types';

// ── Tipos de contrato ─────────────────────────────────────

const TIPO_LABELS: Record<string, string> = {
  CONFIDENCIALIDAD: 'Acuerdos de Confidencialidad',
  CLIENTES:         'Contratos con Clientes',
  ALIANZAS:         'Contratos de Alianzas o Similares',
  PROVEEDORES:      'Contratos con Proveedores',
};
const TIPO_ORDER = ['CONFIDENCIALIDAD', 'CLIENTES', 'ALIANZAS', 'PROVEEDORES'];

type SortCol = 'codigo_generado' | 'tipo_contrato' | 'area_nombre' | 'nombre_usuario' | 'fecha_hora_creacion';

// ── Helpers ───────────────────────────────────────────────

function fmt(iso: string) {
  const d = new Date(iso);
  return {
    fecha: d.toLocaleDateString('es-CO', { year: 'numeric', month: '2-digit', day: '2-digit' }),
    hora:  d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  };
}

// ── Iconos ────────────────────────────────────────────────

function IconSort({ col, active, dir }: { col: string; active: boolean; dir: 'asc' | 'desc' }) {
  return (
    <span className={`ml-1 inline-flex flex-col leading-none ${active ? 'text-indigo-400' : 'text-slate-300'}`}>
      <svg className={`w-2.5 h-2.5 -mb-0.5 ${active && dir === 'asc' ? 'text-indigo-600' : ''}`}
           viewBox="0 0 10 6" fill="currentColor">
        <path d="M5 0L10 6H0L5 0z" />
      </svg>
      <svg className={`w-2.5 h-2.5 ${active && dir === 'desc' ? 'text-indigo-600' : ''}`}
           viewBox="0 0 10 6" fill="currentColor">
        <path d="M5 6L0 0H10L5 6z" />
      </svg>
    </span>
  );
}

function IconSpinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ── Helpers extra ─────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60)   return 'hace ' + diff + 's';
  if (diff < 3600) return 'hace ' + Math.floor(diff / 60) + 'min';
  if (diff < 86400) return 'hace ' + Math.floor(diff / 3600) + 'h';
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' });
}

// ── Props ─────────────────────────────────────────────────

interface Props {
  areas: Area[];
  initialLogs: LogEntry[];
  initialLatest: LatestByArea[];
  excelUrl?: string;
  excelConfigured?: boolean;
}

// ── Componente ────────────────────────────────────────────

export default function MainForm({ areas, initialLogs, initialLatest, excelUrl, excelConfigured }: Props) {

  // --- Formulario ---
  const [tipoContrato, setTipoContrato]   = useState('');
  const [areaId, setAreaId]               = useState('');
  const [nombreUsuario, setNombreUsuario] = useState('');
  const [generatedCode, setGeneratedCode]         = useState<string | null>(null);
  const [lastGeneratedAreaId, setLastGeneratedAreaId] = useState<string | null>(null);
  const [copiedAreaId, setCopiedAreaId]           = useState<string | null>(null);
  const [errorMsg, setErrorMsg]                   = useState<string | null>(null);
  const [isPending, startTransition]      = useTransition();

  // --- Excel: append ---
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [excelStatus, setExcelStatus]           = useState<'idle' | 'pending' | 'ok' | 'error'>('idle');
  const [excelError, setExcelError]             = useState<string | null>(null);

  // --- Excel: sync ---
  const [syncPending, setSyncPending] = useState(false);
  const [syncMsg, setSyncMsg]         = useState<string | null>(null);
  const [syncIsError, setSyncIsError] = useState(false);

  // --- Grid ---
  const [logs, setLogs]             = useState<LogEntry[]>(initialLogs);
  const [search, setSearch]         = useState('');
  const [sortCol, setSortCol]       = useState<SortCol>('fecha_hora_creacion');
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // --- Resumen últimos por área ---
  const [latestPerArea, setLatestPerArea]   = useState<LatestByArea[]>(initialLatest);
  const [recentlyUpdated, setRecentlyUpdated] = useState<Set<string>>(new Set());
  const fetchingRef = useRef(false);

  // ── Suscripción Realtime ─────────────────────────────────
  useEffect(() => {
    const supabase = getBrowserClient();

    const channel = supabase
      .channel('consecutivos-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'consecutives_log' },
        async (payload) => {
          // Actualizar resumen por área
          if (!fetchingRef.current) {
            fetchingRef.current = true;
            const latest = await getLatestPerArea();
            setLatestPerArea(latest);
            fetchingRef.current = false;
          }

          // Actualizar log principal
          if (payload.eventType === 'INSERT') {
            const rec = payload.new as {
              id: string; area_id: string; codigo_generado: string;
              nombre_usuario: string | null; fecha_hora_creacion: string;
            };
            const area = areas.find(a => a.id === rec.area_id);
            if (area) {
              const entry: LogEntry = {
                id: rec.id,
                codigo_generado: rec.codigo_generado,
                tipo_contrato: area.tipo_contrato,
                area_nombre: area.nombre,
                nombre_usuario: rec.nombre_usuario,
                fecha_hora_creacion: rec.fecha_hora_creacion,
              };
              setLogs(prev => prev.some(l => l.id === rec.id) ? prev : [entry, ...prev]);
              // Marcar área como "recién actualizada" por 3s
              setRecentlyUpdated(s => new Set(s).add(rec.area_id));
              setTimeout(() => {
                setRecentlyUpdated(s => { const n = new Set(s); n.delete(rec.area_id); return n; });
              }, 3000);
            }
          }

          if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id: string }).id;
            setLogs(prev => prev.filter(l => l.id !== oldId));
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Derivados ────────────────────────────────────────────
  const tiposDisponibles   = TIPO_ORDER.filter(t => areas.some(a => a.tipo_contrato === t));
  const areasProveedores   = areas.filter(a => a.tipo_contrato === 'PROVEEDORES');
  const areaActiva         = areas.find(a => a.id === areaId);
  const prefijoPreview     = areaActiva
    ? `${areaActiva.prefijo}XXXX`
    : tipoContrato && tipoContrato !== 'PROVEEDORES'
      ? `${areas.find(a => a.tipo_contrato === tipoContrato)?.prefijo ?? ''}XXXX`
      : null;
  const canGenerate = tipoContrato !== '' && (tipoContrato !== 'PROVEEDORES' || areaId !== '');

  // ── Resumen: ordenado por más reciente primero ───────────
  const sortedLatest = useMemo(() => {
    return [...latestPerArea].sort((a, b) => {
      if (!a.fecha_hora_creacion && !b.fecha_hora_creacion) return 0;
      if (!a.fecha_hora_creacion) return 1;
      if (!b.fecha_hora_creacion) return -1;
      return b.fecha_hora_creacion.localeCompare(a.fecha_hora_creacion);
    });
  }, [latestPerArea]);

  // ── Grid: filtrado y ordenación ──────────────────────────
  const displayedLogs = useMemo(() => {
    let result = [...logs];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter(log => {
        const { fecha, hora } = fmt(log.fecha_hora_creacion);
        const tipoLabel = (TIPO_LABELS[log.tipo_contrato] ?? log.tipo_contrato).toLowerCase();
        return (
          log.codigo_generado.toLowerCase().includes(q) ||
          tipoLabel.includes(q) ||
          log.area_nombre.toLowerCase().includes(q) ||
          (log.nombre_usuario ?? '').toLowerCase().includes(q) ||
          fecha.includes(q) ||
          hora.includes(q)
        );
      });
    }

    result.sort((a, b) => {
      const aVal = String(a[sortCol] ?? '');
      const bVal = String(b[sortCol] ?? '');
      const cmp  = aVal.localeCompare(bVal, 'es', { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [logs, search, sortCol, sortDir]);

  // ── Handlers ─────────────────────────────────────────────

  function handleTipoChange(tipo: string) {
    setTipoContrato(tipo);
    setErrorMsg(null);
    setGeneratedCode(null);
    if (tipo && tipo !== 'PROVEEDORES') {
      setAreaId(areas.find(a => a.tipo_contrato === tipo)?.id ?? '');
    } else {
      setAreaId('');
    }
  }

  function handleSort(col: SortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }

  function handleGenerate() {
    if (!canGenerate) {
      setErrorMsg(tipoContrato === 'PROVEEDORES' ? 'Selecciona el área.' : 'Selecciona el tipo de contrato.');
      return;
    }
    setErrorMsg(null);
    if (excelUrl) {
      setShowConfirmModal(true);
    } else {
      executeGenerate();
    }
  }

  function executeGenerate() {
    setShowConfirmModal(false);
    setExcelStatus('idle');
    setExcelError(null);
    startTransition(async () => {
      const result = await generateConsecutive(areaId, nombreUsuario);
      if (result.success && result.codigo && result.logEntry) {
        setGeneratedCode(result.codigo);
        setLastGeneratedAreaId(areaId);
        setLogs(prev =>
          prev.some(l => l.id === result.logEntry!.id) ? prev : [result.logEntry!, ...prev]
        );
        getLatestPerArea().then(setLatestPerArea);
        setRecentlyUpdated(s => new Set(s).add(areaId));
        setTimeout(() => {
          setRecentlyUpdated(s => { const n = new Set(s); n.delete(areaId); return n; });
        }, 3000);

        // Registrar en Excel y abrir pestaña
        if (excelUrl) {
          setExcelStatus('pending');
          const exRes = await appendConsecutiveToExcel(result.codigo);
          if (exRes.success) {
            setExcelStatus('ok');
            window.open(excelUrl, '_blank', 'noopener,noreferrer');
          } else {
            setExcelStatus('error');
            setExcelError(exRes.error ?? 'No se pudo registrar en Excel.');
          }
        }
      } else {
        setErrorMsg(result.error ?? 'Error al generar el consecutivo.');
      }
    });
  }

  async function handleCopyArea(areaId: string, code: string) {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = code;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedAreaId(areaId);
    setTimeout(() => setCopiedAreaId(id => id === areaId ? null : id), 2500);
  }

  function formatNombreResumen(tipo: string, areaNombre: string): string {
    const tipoLabel = TIPO_LABELS[tipo] ?? tipo;
    if (tipo !== 'PROVEEDORES') return tipoLabel;
    const areaCorta = areaNombre.replace(/^Área\s+/i, '');
    return `${tipoLabel} / A. ${areaCorta}`;
  }

  async function handleSync() {
    if (syncPending) return;
    setSyncPending(true);
    setSyncMsg(null);
    setSyncIsError(false);
    const result = await syncFromExcel();
    setSyncPending(false);
    if (result.success) {
      const msg = result.updated > 0
        ? `${result.updated} área${result.updated !== 1 ? 's' : ''} actualizada${result.updated !== 1 ? 's' : ''} desde Excel.`
        : 'BD ya sincronizada con Excel.';
      setSyncMsg(msg);
      setSyncIsError(false);
      const latest = await getLatestPerArea();
      setLatestPerArea(latest);
    } else {
      setSyncMsg(result.error ?? 'Error al sincronizar.');
      setSyncIsError(true);
    }
    setTimeout(() => setSyncMsg(null), 5000);
  }

  async function handleDelete(log: LogEntry) {
    const ok = window.confirm(
      `¿Eliminar el consecutivo "${log.codigo_generado}"?\n\nEsta acción no se puede deshacer.`
    );
    if (!ok) return;

    setDeletingId(log.id);
    const result = await deleteConsecutive(log.id);
    setDeletingId(null);

    if (result.success) {
      setLogs(prev => prev.filter(l => l.id !== log.id));
      if (generatedCode === log.codigo_generado) setGeneratedCode(null);
    } else {
      alert(`Error al eliminar: ${result.error}`);
    }
  }

  // ── Render ───────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col">

      {/* Header */}
      <header className="bg-indigo-700 shadow-md">
        <div className="max-w-screen-xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="bg-indigo-600 rounded-lg p-2">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-bold text-white leading-tight">Calculadora de Consecutivos</h1>
            <p className="text-indigo-300 text-xs">SULICOR · Doctux SAS</p>
          </div>
        </div>
      </header>

      {/* Barra URL Excel — ancho completo */}
      {excelUrl && (
        <div className="bg-emerald-50 border-b border-emerald-200">
          <div className="max-w-screen-xl mx-auto px-6 py-2.5 flex items-center gap-3">
            <svg className="w-4 h-4 text-emerald-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 0v10m0-10a2 2 0 012 2h2a2 2 0 012-2" />
            </svg>
            <span className="text-xs font-medium text-emerald-700 flex-shrink-0">Archivo Excel:</span>
            <span className="text-xs font-mono text-emerald-800 break-all flex-1 select-all">{excelUrl}</span>
            <a
              href={excelUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-shrink-0 text-xs text-emerald-700 hover:text-emerald-900 underline whitespace-nowrap"
            >
              Abrir ↗
            </a>
          </div>
        </div>
      )}

      {/* Body — dos columnas */}
      <div className="flex-1 max-w-screen-xl mx-auto w-full px-6 py-6
                      grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">

        {/* ══ COLUMNA IZQUIERDA (4/12 ≈ 33%) ══════════════════ */}
        <div className="lg:col-span-4 space-y-4">

          {/* Tarjeta: Formulario */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-5">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-4">
              Nuevo Consecutivo
            </h2>

            <div className="space-y-4">

              {/* Tipo de contrato */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Tipo de contrato <span className="text-red-500">*</span>
                </label>
                <select
                  value={tipoContrato}
                  onChange={e => handleTipoChange(e.target.value)}
                  disabled={isPending}
                  className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900
                             focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                             disabled:bg-slate-100 disabled:cursor-not-allowed"
                >
                  <option value="">— Selecciona el tipo —</option>
                  {tiposDisponibles.map(t => (
                    <option key={t} value={t}>{TIPO_LABELS[t] ?? t}</option>
                  ))}
                </select>
              </div>

              {/* Área (solo Proveedores) */}
              {tipoContrato === 'PROVEEDORES' && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Área <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={areaId}
                    onChange={e => { setAreaId(e.target.value); setErrorMsg(null); }}
                    disabled={isPending}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900
                               focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                               disabled:bg-slate-100 disabled:cursor-not-allowed"
                  >
                    <option value="">— Selecciona el área —</option>
                    {areasProveedores.map(a => (
                      <option key={a.id} value={a.id}>{a.nombre}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Preview prefijo */}
              {prefijoPreview && (
                <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200
                                rounded-lg px-3 py-2 flex gap-2">
                  <span>Formato:</span>
                  <span className="font-mono font-semibold text-indigo-600">{prefijoPreview}</span>
                </div>
              )}

              {/* Nombre */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Tu nombre <span className="text-slate-400 font-normal">(opcional)</span>
                </label>
                <input
                  type="text"
                  value={nombreUsuario}
                  onChange={e => setNombreUsuario(e.target.value)}
                  placeholder="Ej. María García"
                  maxLength={120}
                  disabled={isPending}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900
                             placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500
                             focus:border-transparent disabled:bg-slate-100 disabled:cursor-not-allowed"
                />
              </div>
            </div>

            {/* Error */}
            {errorMsg && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-red-50 border border-red-200
                              px-3 py-2.5 text-red-700 text-xs">
                <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd" />
                </svg>
                {errorMsg}
              </div>
            )}

            {/* Botón */}
            <button
              onClick={handleGenerate}
              disabled={isPending || !canGenerate}
              className="mt-4 w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl
                         text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800
                         disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed
                         text-white transition-colors focus:outline-none focus:ring-2
                         focus:ring-indigo-500 focus:ring-offset-2"
            >
              {isPending ? (
                <><IconSpinner /> Generando…</>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Generar Consecutivo
                </>
              )}
            </button>

            {/* Estado Excel */}
            {excelStatus === 'pending' && (
              <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                <IconSpinner /> Registrando en Excel…
              </div>
            )}
            {excelStatus === 'ok' && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                Consecutivo registrado en Excel.
              </div>
            )}
            {excelStatus === 'error' && excelError && (
              <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50
                              border border-amber-200 rounded-lg px-3 py-2">
                <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd" />
                </svg>
                <span><span className="font-medium">Excel:</span> {excelError}</span>
              </div>
            )}
          </div>

          {/* ── Panel: Últimos por área ── */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="border-b border-slate-100">
              <div className="px-4 py-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
                  Últimos Consecutivos
                </h3>
                <div className="flex items-center gap-2">
                  {excelConfigured && (
                    <button
                      onClick={handleSync}
                      disabled={syncPending}
                      title="Sincronizar consecutivos desde Excel"
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-indigo-600
                                 disabled:text-slate-300 transition-colors focus:outline-none"
                    >
                      <svg className={`w-3.5 h-3.5 ${syncPending ? 'animate-spin' : ''}`}
                           fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      <span className="hidden sm:inline">Sync Excel</span>
                    </button>
                  )}
                  <span className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    En vivo
                  </span>
                </div>
              </div>
              {syncMsg && (
                <div className={`px-4 py-2 text-xs border-t ${
                  syncIsError
                    ? 'bg-amber-50 text-amber-700 border-amber-200'
                    : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                }`}>
                  {syncMsg}
                </div>
              )}
            </div>

            <ul className="divide-y divide-slate-100">
              {sortedLatest.length === 0 ? (
                <li className="px-4 py-4 text-xs text-slate-400 text-center">Sin registros aún.</li>
              ) : (
                sortedLatest.map((item) => {
                  const isLast   = item.area_id === lastGeneratedAreaId;
                  const isNew    = recentlyUpdated.has(item.area_id);
                  const isCopied = copiedAreaId === item.area_id;

                  return (
                    <li
                      key={item.area_id}
                      className={`px-4 py-2.5 flex items-center gap-2 transition-colors duration-500
                                  ${isNew ? 'bg-indigo-50' : isLast ? 'bg-indigo-50/40' : 'hover:bg-slate-50'}`}
                    >
                      {/* Nombre completo */}
                      <div className="flex-1 min-w-0">
                        <p className={`text-xs leading-snug truncate
                                       ${isLast ? 'font-semibold text-slate-800' : 'font-medium text-slate-600'}`}>
                          {formatNombreResumen(item.tipo_contrato, item.area_nombre)}
                        </p>
                        {item.fecha_hora_creacion && (
                          <p className="text-xs text-slate-400 mt-0.5">
                            {timeAgo(item.fecha_hora_creacion)}
                          </p>
                        )}
                      </div>

                      {/* Código + botón copiar */}
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {item.codigo_generado ? (
                          <>
                            <span className={`font-mono font-bold transition-colors
                                             ${isLast ? 'text-base text-indigo-700' : 'text-xs text-slate-700'}`}>
                              {item.codigo_generado}
                            </span>
                            <button
                              onClick={() => handleCopyArea(item.area_id, item.codigo_generado!)}
                              title="Copiar"
                              className={`inline-flex items-center justify-center w-6 h-6 rounded
                                          transition-colors focus:outline-none
                                          ${isCopied
                                            ? 'text-emerald-600 bg-emerald-50'
                                            : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'
                                          }`}
                            >
                              {isCopied ? (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          </>
                        ) : (
                          <span className="text-xs italic text-slate-300">Sin generar</span>
                        )}
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>

        {/* ══ COLUMNA DERECHA (8/12 ≈ 67%) ════════════════════ */}
        <div className="lg:col-span-8 min-w-0 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">

          {/* Header del grid */}
          <div className="px-5 py-4 border-b border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                Historial de Consecutivos
              </h2>
              <span className="text-xs text-slate-400 bg-slate-100 rounded-full px-2 py-0.5">
                {displayedLogs.length} / {logs.length}
              </span>
            </div>

            {/* Búsqueda */}
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400"
                   fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0" />
              </svg>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar por código, área, usuario o fecha…"
                className="w-full pl-9 pr-8 py-2 text-sm rounded-lg border border-slate-300 bg-slate-50
                           focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent
                           placeholder-slate-400"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>

          {/* Tabla */}
          <div className="overflow-y-auto overflow-x-hidden flex-1">
            {displayedLogs.length === 0 ? (
              <div className="px-5 py-12 text-center text-slate-400 text-sm">
                {search ? (
                  <>Sin resultados para <strong>"{search}"</strong></>
                ) : (
                  'No hay consecutivos generados aún.'
                )}
              </div>
            ) : (
              <table className="w-full text-sm table-fixed">
                <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                  <tr>
                    {(
                      [
                        { col: 'codigo_generado',    label: 'Código',          w: 'w-[10%]' },
                        { col: 'tipo_contrato',      label: 'Tipo',            w: 'w-[28%]' },
                        { col: 'area_nombre',         label: 'Área',           w: 'w-[16%]' },
                        { col: 'nombre_usuario',      label: 'Usuario',        w: 'w-[16%]' },
                        { col: 'fecha_hora_creacion', label: 'Fecha y Hora',   w: 'w-[22%]' },
                      ] as { col: SortCol; label: string; w: string }[]
                    ).map(({ col, label, w }) => (
                      <th
                        key={col + label}
                        onClick={() => handleSort(col)}
                        className={`${w} px-3 py-2.5 text-left text-xs font-semibold text-slate-500
                                   uppercase tracking-wide cursor-pointer hover:text-indigo-600 select-none`}
                      >
                        {label}
                        <IconSort col={col} active={sortCol === col} dir={sortDir} />
                      </th>
                    ))}
                    <th className="px-4 py-2.5 text-center text-xs font-semibold text-slate-500
                                   uppercase tracking-wide w-12">
                      Acc.
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayedLogs.map((log, i) => {
                    const { fecha, hora } = fmt(log.fecha_hora_creacion);
                    const isNew      = i === 0 && log.codigo_generado === generatedCode;
                    const isDeleting = deletingId === log.id;
                    const esProveedor = log.tipo_contrato === 'PROVEEDORES';

                    return (
                      <tr
                        key={log.id}
                        className={`transition-colors ${
                          isNew ? 'bg-indigo-50 hover:bg-indigo-50/80' : 'hover:bg-slate-50'
                        } ${isDeleting ? 'opacity-40' : ''}`}
                      >
                        {/* Código */}
                        <td className="px-3 py-2.5 font-mono font-bold text-indigo-700 truncate">
                          {log.codigo_generado}
                        </td>

                        {/* Tipo de Contrato */}
                        <td className="px-3 py-2.5 text-slate-700 text-xs truncate"
                            title={TIPO_LABELS[log.tipo_contrato] ?? log.tipo_contrato}>
                          {TIPO_LABELS[log.tipo_contrato] ?? log.tipo_contrato}
                        </td>

                        {/* Área (N/A si no es Proveedores) */}
                        <td className="px-3 py-2.5 text-xs truncate">
                          {esProveedor ? (
                            <span className="text-slate-700">{log.area_nombre}</span>
                          ) : (
                            <span className="text-slate-300 italic">N/A</span>
                          )}
                        </td>

                        {/* Usuario */}
                        <td className="px-3 py-2.5 text-slate-500 text-xs truncate">
                          {log.nombre_usuario ?? (
                            <span className="italic text-slate-300">Anónimo</span>
                          )}
                        </td>

                        {/* Fecha y Hora */}
                        <td className="px-3 py-2.5 text-xs">
                          <span className="text-slate-600">{fecha}</span>
                          <span className="text-slate-400 ml-1">{hora}</span>
                        </td>

                        {/* Acción eliminar */}
                        <td className="px-3 py-2.5 text-center w-[8%]">
                          <button
                            onClick={() => handleDelete(log)}
                            disabled={isDeleting}
                            title="Eliminar consecutivo"
                            className="inline-flex items-center justify-center w-7 h-7 rounded-lg
                                       text-slate-400 hover:text-red-600 hover:bg-red-50
                                       disabled:cursor-not-allowed transition-colors"
                          >
                            {isDeleting ? (
                              <IconSpinner />
                            ) : (
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <footer className="text-center py-4 text-slate-400 text-xs border-t border-slate-200">
        Doctux SAS · Sistema de Consecutivos Contractuales · {new Date().getFullYear()}
      </footer>

      {/* ── Modal de confirmación Excel ─────────────────────── */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
             style={{ backgroundColor: 'rgba(15,23,42,0.55)' }}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md border border-slate-200 overflow-hidden">

            {/* Header */}
            <div className="bg-amber-50 border-b border-amber-200 px-6 py-4 flex items-start gap-3">
              <div className="mt-0.5 flex-shrink-0 bg-amber-100 rounded-full p-1.5">
                <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <h3 className="text-sm font-bold text-amber-800">Confirmar generación de consecutivo</h3>
                <p className="text-xs text-amber-700 mt-0.5">Esta acción modificará el archivo Excel de SharePoint.</p>
              </div>
            </div>

            {/* Cuerpo */}
            <div className="px-6 py-5 space-y-3">
              <p className="text-sm text-slate-700">
                Al continuar, el nuevo consecutivo se <span className="font-semibold">registrará automáticamente</span> en
                una nueva fila del siguiente archivo y la celda se pintará de azul:
              </p>

              {/* URL de solo lectura */}
              <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2.5">
                <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                <span className="text-xs font-mono text-slate-600 truncate select-all" title={excelUrl}>
                  {excelUrl}
                </span>
              </div>

              <p className="text-xs text-slate-500">
                Una vez generado, <span className="font-medium">el archivo se abrirá en una nueva pestaña</span> para
                que puedas verificar el registro.
              </p>
            </div>

            {/* Acciones */}
            <div className="px-6 pb-5 flex gap-3 justify-end">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600
                           border border-slate-300 hover:bg-slate-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={executeGenerate}
                className="px-5 py-2 rounded-lg text-sm font-semibold text-white
                           bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800
                           transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
              >
                Confirmar y Generar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
