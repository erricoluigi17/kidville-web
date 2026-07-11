// Data e anno a valenza FISCALE nel fuso Europe/Rome. Il runtime (Vercel) gira
// in UTC: senza questo, vicino alla mezzanotte — e soprattutto a cavallo del
// 31/12–01/01 — la data documento e l'ANNO di numerazione slitterebbero di 1–2
// ore rispetto all'ora italiana (una fattura emessa in Italia il 1° gennaio
// 00:30 prenderebbe numero e data dell'anno precedente).

/** Oggi come 'YYYY-MM-DD' nel fuso Europe/Rome. */
export function oggiFiscaleISO(): string {
  // en-CA formatta come YYYY-MM-DD; il timeZone forza il fuso italiano.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
}

/** Anno solare corrente (a fini fiscali) nel fuso Europe/Rome. */
export function annoFiscale(): number {
  return Number(oggiFiscaleISO().slice(0, 4));
}
