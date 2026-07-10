// Helper puri per il formato data italiano (gg/mm/aaaa) ↔ ISO (yyyy-mm-dd).
// Deterministici (niente dipendenza dal locale del browser/OS), testabili.

/** ISO 'yyyy-mm-dd' → 'gg/mm/aaaa' (stringa vuota se non valida). */
export function isoToIt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** 'gg/mm/aaaa' → ISO 'yyyy-mm-dd', oppure null se incompleta/non valida (con check di calendario). */
export function itToIso(it: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((it ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const giorno = Number(dd), mese = Number(mm);
  if (mese < 1 || mese > 12 || giorno < 1 || giorno > 31) return null;
  const iso = `${yyyy}-${mm}-${dd}`;
  const dt = new Date(`${iso}T12:00:00`);
  // Rifiuta date impossibili (es. 31/02): il rollover cambierebbe mese/giorno.
  if (Number.isNaN(dt.getTime()) || dt.getMonth() + 1 !== mese || dt.getDate() !== giorno) return null;
  return iso;
}

/** Applica la maschera gg/mm/aaaa mentre si digita (solo cifre, con gli slash). */
export function maskItDate(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('/');
}
