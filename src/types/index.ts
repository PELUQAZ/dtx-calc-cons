export interface Area {
  id: string;
  client_id: string;
  nombre: string;
  prefijo: string;
  tipo_contrato: string;
  activo: boolean;
  created_at: string;
}

/** Estructura normalizada para mostrar en la tabla de historial */
export interface LogEntry {
  id: string;
  codigo_generado: string;
  tipo_contrato: string;   // 'CONFIDENCIALIDAD' | 'CLIENTES' | 'ALIANZAS' | 'PROVEEDORES'
  area_nombre: string;     // nombre del área (solo relevante para PROVEEDORES)
  nombre_usuario: string | null;
  fecha_hora_creacion: string;
}

export interface GenerateResult {
  success: boolean;
  codigo?: string;
  logEntry?: LogEntry;
  error?: string;
}
