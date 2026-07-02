// Identità docente lato client. Coerente col modello app-level del progetto
// (userId da query param); in assenza vale l'identità di sessione persistita
// da useSessionIdentity (kv_user_id). Nessun fallback demo (M4): null =
// identità non risolta. Vedi current-user.ts per i genitori.

export function getCurrentTeacherId(params?: URLSearchParams | null): string | null {
  const fromUrl = params?.get('userId');
  if (fromUrl) return fromUrl;
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('kv_teacher_id')
      || window.localStorage.getItem('kv_user_id');
    if (stored) return stored;
  }
  return null;
}
