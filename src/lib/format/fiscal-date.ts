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

/**
 * L'istante UTC in cui è cominciato il giorno ITALIANO corrente.
 *
 * Serve a contare «quante email di credenziali sono già uscite oggi»: una domanda
 * che ha senso solo nel giorno di chi le riceve, non in quello di UTC.
 *
 * ⚠️ LA SCORCIATOIA CHE SEMBRA GIUSTA E NON LO È:
 *
 *     new Date(oggiFiscaleISO() + 'T00:00:00Z')
 *
 * `oggiFiscaleISO()` dà la data italiana giusta, ma la `Z` la interpreta come
 * mezzanotte UTC — che in Italia è l'una o le due di notte. Il conteggio
 * sbaglierebbe di un'ora esatta (due in estate), includendo o escludendo le email
 * di quella fascia. Questo repo ha già pagato quattro difetti caduti insieme per
 * «UTC contro Europe/Rome»: uno dei quali passava per coincidenza.
 *
 * Qui l'offset si CHIEDE al fuso invece di assumerlo, formattando l'istante come lo
 * vedrebbe Roma e ricavando da lì lo scarto reale — che l'ora legale la conosce.
 */
export function inizioGiornoRomaISO(adesso: Date = new Date()): string {
  // La stessa data che vede Roma, a mezzanotte, letta come se fosse UTC.
  const giornoRoma = adesso.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' });
  const mezzanotteComeUtc = Date.parse(`${giornoRoma}T00:00:00Z`);

  // Quanto Roma è avanti rispetto a UTC IN QUESTO ISTANTE. Non si assume (+01:00 o
  // +02:00 secondo il mese): si legge come Roma vede questo momento e si confronta,
  // così l'ora legale e i suoi due giorni di cambio non vanno indovinati. `en-CA` è
  // qui per il suo FORMATO (YYYY-MM-DD), non come lingua di prodotto: la regione
  // dell'inglese si decide in `LOCALE_BCP47`, e questo file non la decide.
  const parti = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(adesso);
  const p = (tipo: string): string => parti.find((x) => x.type === tipo)?.value ?? '00';
  // `hour` può uscire come '24' a mezzanotte in alcune implementazioni: si normalizza.
  const ora = p('hour') === '24' ? '00' : p('hour');
  const comeRoma = Date.parse(
    `${p('year')}-${p('month')}-${p('day')}T${ora}:${p('minute')}:${p('second')}Z`,
  );
  // Millisecondi scartati di proposito: l'offset di un fuso è sempre a minuti interi.
  const offsetMs = comeRoma - Math.floor(adesso.getTime() / 1000) * 1000;

  return new Date(mezzanotteComeUtc - offsetMs).toISOString();
}
