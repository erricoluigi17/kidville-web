// Identità docente lato client. Coerente col modello app-level del progetto
// (userId da query param), con fallback dev. Vedi current-user.ts per i genitori.

export const DEV_TEACHER_ID = '22222222-2222-2222-2222-222222222222';

export function getCurrentTeacherId(params?: URLSearchParams | null): string {
  const fromUrl = params?.get('userId');
  if (fromUrl) return fromUrl;
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem('kv_teacher_id');
    if (stored) return stored;
  }
  return DEV_TEACHER_ID;
}
