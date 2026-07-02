'use client';

// Identità lato client (modello app-level, niente Supabase Auth).
// L'id arriva dalla URL (?userId= / ?id=) e viene persistito in localStorage
// così le varie pagine genitore condividono lo stesso utente/alunno durante la
// navigazione (la home usa ?id=, i pagamenti ?userId=, ecc.). In assenza vale
// l'identità di sessione persistita da useSessionIdentity (kv_user_id).
// Nessun fallback demo (M4): null = identità non risolta.

const PARENT_KEY = 'kv_parent_id';
const STUDENT_KEY = 'kv_student_id';
const SESSION_USER_KEY = 'kv_user_id';

function readStore(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string) {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

// Restituisce l'id genitore corrente: URL → localStorage → sessione → null.
// Se presente in URL lo persiste per le pagine successive.
export function getCurrentParentId(params?: URLSearchParams | null): string | null {
    const fromUrl = params?.get('userId');
    if (fromUrl) { writeStore(PARENT_KEY, fromUrl); return fromUrl; }
    return readStore(PARENT_KEY) || readStore(SESSION_USER_KEY) || null;
}

// Restituisce l'id alunno corrente: URL → localStorage → null.
export function getCurrentStudentId(params?: URLSearchParams | null): string | null {
    const fromUrl = params?.get('id');
    if (fromUrl) { writeStore(STUDENT_KEY, fromUrl); return fromUrl; }
    return readStore(STUDENT_KEY) || null;
}

// Propaga gli id correnti su un href interno (per i link/tile della home).
// Gli id non ancora risolti (null) vengono semplicemente omessi.
export function withIdentity(href: string, parentId: string | null, studentId?: string | null): string {
    const sp = new URLSearchParams();
    if (studentId) sp.set('id', studentId);
    if (parentId) sp.set('userId', parentId);
    const qs = sp.toString();
    if (!qs) return href;
    const sep = href.includes('?') ? '&' : '?';
    return `${href}${sep}${qs}`;
}
