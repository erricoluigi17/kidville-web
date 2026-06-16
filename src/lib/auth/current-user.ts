'use client';

// Identità lato client (modello app-level, niente Supabase Auth).
// L'id arriva dalla URL (?userId= / ?id=) e viene persistito in localStorage
// così le varie pagine genitore condividono lo stesso utente/alunno durante la
// navigazione (la home usa ?id=, i pagamenti ?userId=, ecc.).

export const DEV_PARENT_ID = '33333333-3333-3333-3333-333333333333';
export const DEFAULT_STUDENT_ID = 'dc617529-e80d-4084-9041-fb28e864089f';

const PARENT_KEY = 'kv_parent_id';
const STUDENT_KEY = 'kv_student_id';

function readStore(key: string): string | null {
    if (typeof window === 'undefined') return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStore(key: string, value: string) {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

// Restituisce l'id genitore corrente: URL → localStorage → fallback demo.
// Se presente in URL lo persiste per le pagine successive.
export function getCurrentParentId(params?: URLSearchParams | null): string {
    const fromUrl = params?.get('userId');
    if (fromUrl) { writeStore(PARENT_KEY, fromUrl); return fromUrl; }
    return readStore(PARENT_KEY) || DEV_PARENT_ID;
}

// Restituisce l'id alunno corrente: URL → localStorage → fallback demo.
export function getCurrentStudentId(params?: URLSearchParams | null): string {
    const fromUrl = params?.get('id');
    if (fromUrl) { writeStore(STUDENT_KEY, fromUrl); return fromUrl; }
    return readStore(STUDENT_KEY) || DEFAULT_STUDENT_ID;
}

// Propaga gli id correnti su un href interno (per i link/tile della home).
export function withIdentity(href: string, parentId: string, studentId?: string): string {
    const sep = href.includes('?') ? '&' : '?';
    const sp = new URLSearchParams();
    if (studentId) sp.set('id', studentId);
    sp.set('userId', parentId);
    return `${href}${sep}${sp.toString()}`;
}
