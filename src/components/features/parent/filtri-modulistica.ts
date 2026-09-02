import { dataCivile } from '@/i18n/config';
import { aggiungiGiorni } from '@/lib/anagrafica/scadenze';
import { opzioniDerivate } from '@/lib/ui/filtri/motore';
import type { CampoFiltro, OpzioneFiltro, Periodo, Traduttore } from '@/lib/ui/filtri/tipi';

/**
 * ─── I FILTRI DELLE QUATTRO SCHEDE DI «MODULISTICA» (GENITORE) ───────────────
 *
 * Qui non c'è React e non c'è DOM: solo la DICHIARAZIONE di che cosa si filtra e
 * come si legge una riga. Il disegno lo fa `BarraFiltri`, la semantica il motore
 * (`lib/ui/filtri/motore.ts`), e questo file si prova senza montare niente —
 * `__tests__/lib/filtri-modulistica-parent.test.ts`.
 *
 * ── OGNI CAMPO È `dove: 'client'`, ED È UNA DECISIONE ───────────────────────
 * Il carico di una famiglia è di poche righe per figlio, e le quattro rotte
 * `parent/*` lo consegnano già intero (`fetchData`). Mandare un filtro verso
 * l'API vorrebbe dire aggiungere un parametro che nessuno schema `zod` di quelle
 * rotte dichiara: o un 400 in faccia a un genitore, o — peggio — un parametro
 * ignorato che restituisce tutto mentre la schermata dice di aver filtrato.
 * Il banco di prova lo verifica campo per campo, e `queryServer` deve restare la
 * stringa vuota.
 *
 * ── PERCHÉ `multi` DOVE C'È UN VALORE DI PARTENZA ───────────────────────────
 * `chip` e `scelta` con un `predefinito` hanno un buco misurato: premendo la
 * pastiglia accesa il valore torna alla stringa vuota, che per il motore è
 * ATTIVA (diversa dal predefinito) ma non corrisponde a nessuna opzione — e il
 * chip removibile che ne nasce ha l'etichetta VUOTA. Con `multi` lo stesso gesto
 * produce l'insieme vuoto, che vuol dire «tutti» senza inventare un chip senza
 * nome, e ogni valore scelto resta removibile uno per uno. Perciò: pastiglia
 * singola dove il riposo è «nessun filtro», `multi` dove il riposo è un valore.
 *
 * ── PERCHÉ «FIGLIO» È UN `chip` E NON UNA TENDINA ──────────────────────────
 * Nella variante compatta `BarraFiltri` tiene in prima riga i soli campi di tipo
 * `chip`: `primario` lì non è consultato. Una tendina «Figlio», per quanto
 * dichiarata primaria, finirebbe dentro il foglio — cioè dietro due tocchi, sul
 * filtro che su un telefono conta più di tutti gli altri messi insieme.
 * `primario: true` resta dichiarato lo stesso: è vero, e vale se un giorno la
 * stessa barra verrà resa nella variante da cockpit.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Le righe, nella forma MINIMA che i filtri leggono
// ─────────────────────────────────────────────────────────────────────────────
//
// Sono i tipi strutturali che servono agli estrattori, non i tipi completi della
// pagina: i descrittori restano generici su `R`, così la pagina continua a
// lavorare con le proprie righe intere (`filtra()` le restituisce come sono).

export interface RigaModuloAssegnato {
  form_id: string;
  title: string;
  description?: string;
  form_type: string;
  expiration_date: string | null;
  status: string;
  student: { id: string; nome: string; cognome: string };
}

export interface RigaArchivio {
  id: string;
  created_at: string;
  /** `online` = firmato dalla famiglia · `cartaceo` = scansione acquisita dallo staff. */
  origine?: string | null;
  forms_templates?: { title?: string | null } | null;
  alunni?: { nome?: string | null; cognome?: string | null } | null;
}

export interface RigaCertificatoMedico {
  id: string;
  alunno_id?: string | null;
  fileName?: string | null;
  creato_il: string;
  stato?: string | null;
  data_inizio?: string | null;
  data_fine?: string | null;
  alunno?: { nome?: string | null; cognome?: string | null } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Costanti di comportamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il valore di riposo del filtro «Stato» della scheda «Da compilare».
 *
 * 🔴 Prima era un `if` cablato — `assignedForms.filter(f => f.status === 'pending')`,
 * scritto DUE volte nella stessa pagina (una per decidere se l'elenco è vuoto, una
 * per disegnarlo). Diventando un filtro non deve cambiare ciò che la famiglia vede
 * aprendo la scheda: il riposo resta «da compilare», e «Pulisci filtri» ci
 * riporta invece di azzerarlo. Un `predefinito` che «Pulisci» azzera è un filtro
 * che, pulito, mostra PIÙ righe di quante ne mostrasse all'apertura.
 */
export const STATO_MODULO_PREDEFINITO = 'pending';

/**
 * Quanti giorni prima un modulo si considera «in scadenza». Estremi compresi.
 *
 * ⚠️ NON si chiama `SCADENZA_…`, e non è pignoleria: `__tests__/lib/logging-tetto.test.ts`
 * inventaria per NOME ogni costante di modulo che contenga `TETTO`, `TIMEOUT`,
 * `SCADENZA` o `ATTESA`, perché quelle parole in questo repo annunciano un tetto di
 * RETE — millisecondi, con un meccanismo che interrompe una chiamata — e ognuno
 * deve stare in un file dichiarato con la sua ragione. Questo non è un tetto: è
 * una finestra di calendario, in GIORNI, che nessuna `fetch` guarda.
 *
 * La stessa trappola è già scritta accanto a `RINVIO_DOPO_SECONDI` in
 * `PrestampatiGenitore.tsx`. Rinominare costa una riga; allungare l'elenco delle
 * eccezioni costa la leggibilità di quell'elenco — che è l'unica cosa che lo
 * tiene vivo.
 */
export const GIORNI_DI_PREAVVISO = 7;

// ─────────────────────────────────────────────────────────────────────────────
// Attrezzi comuni
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un campo a scelta si disegna solo se ha almeno DUE opzioni.
 *
 * Con una sola voce il controllo occupa spazio e non può restringere niente: su
 * un telefono è una pastiglia che ruba la riga al filtro che serve. Vale per
 * tutte le scelte che nascono dai dati — il figlio unico, l'archivio con un solo
 * modulo, un catalogo in cui tutti i fogli parlano della stessa persona.
 */
function distingue(opzioni: readonly OpzioneFiltro[]): boolean {
  return opzioni.length > 1;
}

/** Il giorno CIVILE italiano di un istante ISO, o `null` se l'istante non è leggibile. */
function giornoCivile(istante: string | null | undefined): string | null {
  if (!istante) return null;
  const quando = new Date(istante);
  if (Number.isNaN(quando.getTime())) return null;
  return dataCivile(quando);
}

/**
 * `scaduto` · `in_scadenza` (entro sette giorni, oggi compreso) · `null`.
 *
 * `oggi` arriva da fuori e non si legge qui l'orologio: è la stessa disciplina di
 * `lib/anagrafica/scadenze.ts` e di `lib/pagamenti/aging.ts`, ed è ciò che rende
 * questa classificazione provabile senza congelare il tempo. Con `oggi` vuoto —
 * il render sul server, dove il giorno del browser non si conosce ancora — non si
 * classifica niente: meglio un filtro che non restringe di un filtro che
 * restringe sul giorno sbagliato.
 */
function classificaScadenza(scadenza: string | null | undefined, oggi: string): string | null {
  if (oggi === '') return null;
  const giorno = giornoCivile(scadenza);
  if (giorno === null) return null;
  if (giorno < oggi) return 'scaduto';
  const limite = aggiungiGiorni(oggi, GIORNI_DI_PREAVVISO);
  return limite !== '' && giorno <= limite ? 'in_scadenza' : null;
}

/** «Cognome Nome» ridotto a una chiave stabile; `''` quando non c'è nessun nome. */
function chiaveNome(persona: { nome?: string | null; cognome?: string | null } | null | undefined): string {
  return `${persona?.cognome ?? ''} ${persona?.nome ?? ''}`.trim();
}

/**
 * Come si legge un periodo nella lingua della pagina.
 *
 * Il motore, da solo, sa scrivere `2026-01-01 → 2026-03-31`: neutro di lingua ma
 * illeggibile per una famiglia. La pagina conosce il proprio formattatore di date
 * e passa questa funzione; senza, resta il testo del motore.
 */
export type DescriviPeriodo = (periodo: Periodo) => string;

/**
 * Il descrittore di periodo pronto per una pagina italiana.
 *
 * Le tre forme sono tre frasi diverse — «dal … al …», «dal …», «fino al …» — e
 * non una con dei pezzi mancanti: un periodo aperto da un lato letto come «dal
 * 01/09 al » è un intervallo che sembra rotto.
 */
export function descriviPeriodoIt(t: Traduttore, dataBreve: (iso: string) => string): DescriviPeriodo {
  return ({ da, a }) => {
    if (da !== '' && a !== '') return t('modulisticaPeriodoDalAl', { da: dataBreve(da), a: dataBreve(a) });
    if (da !== '') return t('modulisticaPeriodoDal', { da: dataBreve(da) });
    if (a !== '') return t('modulisticaPeriodoAl', { a: dataBreve(a) });
    return '';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 · «Da compilare»
// ─────────────────────────────────────────────────────────────────────────────

export function campiDaCompilare<R extends RigaModuloAssegnato>(
  righe: readonly R[],
  t: Traduttore,
  opzioni: { oggi: string },
): CampoFiltro<R>[] {
  const figli = opzioniDerivate(righe, (r) => r.student.id, {
    // Il NOME e basta: su una pastiglia da telefono il cognome non ci sta, e fra
    // fratelli non distingue niente. Una parola in meno dell'anagrafica di un
    // minore a schermo è comunque una parola in meno.
    etichettaDi: (id) => righe.find((r) => r.student.id === id)?.student.nome ?? id,
  });

  const campi: CampoFiltro<R>[] = [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('modulisticaFiltroCercaModulo'),
      segnaposto: t('modulisticaFiltroCercaModuloSegnaposto'),
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.title],
    },
  ];

  if (distingue(figli)) {
    campi.push({
      tipo: 'chip',
      chiave: 'figlio',
      etichetta: t('modulisticaFiltroFiglio'),
      dove: 'client',
      primario: true,
      opzioni: figli,
      valoreDi: (r) => r.student.id,
    });
  }

  campi.push(
    {
      tipo: 'multi',
      chiave: 'stato',
      etichetta: t('modulisticaFiltroStato'),
      dove: 'client',
      predefinito: [STATO_MODULO_PREDEFINITO],
      opzioni: [
        { valore: 'pending', etichetta: t('modulisticaStatoDaCompilare'), tono: 'warn' },
        { valore: 'signed', etichetta: t('modulisticaStatoFirmato'), tono: 'success' },
        { valore: 'expired', etichetta: t('modulisticaStatoScaduto'), tono: 'neutral' },
      ],
      valoriDi: (r) => [r.status],
    },
    {
      // Gli stessi toni dei badge della riga: «Autorizzazione» è verde là e verde
      // qui, «Sondaggio» e «Gradimento» gialli in tutte e due i posti. Rischeglierli
      // a occhio darebbe due colori alla stessa parola nella stessa schermata.
      tipo: 'chip',
      chiave: 'tipoModulo',
      etichetta: t('modulisticaFiltroTipoModulo'),
      dove: 'client',
      opzioni: [
        { valore: 'autorizzazione', etichetta: t('modulisticaBadgeAutorizzazione'), tono: 'info' },
        { valore: 'sondaggio', etichetta: t('modulisticaBadgeSondaggio'), tono: 'evidenza' },
        { valore: 'gradimento', etichetta: t('modulisticaBadgeGradimento'), tono: 'evidenza' },
      ],
      valoreDi: (r) => r.form_type,
    },
    {
      tipo: 'scelta',
      chiave: 'scadenza',
      etichetta: t('modulisticaFiltroScadenza'),
      dove: 'client',
      opzioni: [
        { valore: 'in_scadenza', etichetta: t('modulisticaScadenzaEntroSetteGiorni'), tono: 'warn' },
        { valore: 'scaduto', etichetta: t('modulisticaScadenzaScaduto'), tono: 'error' },
      ],
      valoreDi: (r) => classificaScadenza(r.expiration_date, opzioni.oggi),
    },
  );

  return campi;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · «Archivio firmati»
// ─────────────────────────────────────────────────────────────────────────────

export function campiArchivio<R extends RigaArchivio>(
  righe: readonly R[],
  t: Traduttore,
  opzioni?: { descriviPeriodo?: DescriviPeriodo },
): CampoFiltro<R>[] {
  const figli = opzioniDerivate(righe, (r) => chiaveNome(r.alunni), {
    etichettaDi: (chiave) => righe.find((r) => chiaveNome(r.alunni) === chiave)?.alunni?.nome ?? chiave,
  });
  const moduli = opzioniDerivate(righe, (r) => r.forms_templates?.title ?? '');
  const ORIGINI: Record<string, string> = {
    online: t('modulisticaOrigineOnline'),
    cartaceo: t('modulisticaOrigineCartaceo'),
  };
  const origini = opzioniDerivate(righe, (r) => r.origine ?? '', {
    etichettaDi: (valore) => ORIGINI[valore] ?? valore,
  });

  const campi: CampoFiltro<R>[] = [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('modulisticaFiltroCercaArchivio'),
      segnaposto: t('modulisticaFiltroCercaArchivioSegnaposto'),
      dove: 'client',
      primario: true,
      testiDi: (r) => [r.forms_templates?.title, r.alunni?.nome, r.alunni?.cognome],
    },
  ];

  if (distingue(figli)) {
    campi.push({
      tipo: 'chip',
      chiave: 'figlio',
      etichetta: t('modulisticaFiltroFiglio'),
      dove: 'client',
      primario: true,
      opzioni: figli,
      valoreDi: (r) => chiaveNome(r.alunni),
    });
  }

  if (distingue(origini)) {
    campi.push({
      tipo: 'chip',
      chiave: 'origine',
      etichetta: t('modulisticaFiltroOrigine'),
      dove: 'client',
      opzioni: origini,
      valoreDi: (r) => r.origine ?? null,
    });
  }

  if (distingue(moduli)) {
    campi.push({
      tipo: 'scelta',
      chiave: 'modulo',
      etichetta: t('modulisticaFiltroModulo'),
      dove: 'client',
      opzioni: moduli,
      valoreDi: (r) => r.forms_templates?.title ?? null,
    });
  }

  campi.push({
    tipo: 'periodo',
    chiave: 'periodo',
    etichetta: t('modulisticaFiltroPeriodoFirma'),
    dove: 'client',
    ...(opzioni?.descriviPeriodo ? { descrivi: opzioni.descriviPeriodo } : null),
    // Il GIORNO CIVILE italiano, non i primi dieci caratteri dell'istante: una
    // firma delle 00:30 del 31 luglio è registrata `2026-07-30T22:30:00Z`, e
    // tagliata a fette finirebbe sotto il 30 — cioè fuori dal mese in cui la
    // famiglia l'ha fatta.
    dataDi: (r) => giornoCivile(r.created_at),
  });

  return campi;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · «Certificati medici»
// ─────────────────────────────────────────────────────────────────────────────

export function campiCertificatiMedici<R extends RigaCertificatoMedico>(
  righe: readonly R[],
  t: Traduttore,
  opzioni?: { descriviPeriodo?: DescriviPeriodo },
): CampoFiltro<R>[] {
  const figli = opzioniDerivate(righe, (r) => r.alunno_id ?? '', {
    etichettaDi: (id) => righe.find((r) => r.alunno_id === id)?.alunno?.nome ?? id,
  });

  const campi: CampoFiltro<R>[] = [
    {
      tipo: 'ricerca',
      chiave: 'q',
      etichetta: t('modulisticaFiltroCercaCertificato'),
      segnaposto: t('modulisticaFiltroCercaCertificatoSegnaposto'),
      dove: 'client',
      primario: true,
      // Il nome del file e il nome del figlio. **Non le note**: sono testo libero
      // di contenuto sanitario, e un campo che ci pesca dentro invita a scriverci
      // per cercarci — cioè a farne un indice.
      testiDi: (r) => [r.fileName, r.alunno?.nome, r.alunno?.cognome],
    },
  ];

  if (distingue(figli)) {
    campi.push({
      tipo: 'chip',
      chiave: 'figlio',
      etichetta: t('modulisticaFiltroFiglio'),
      dove: 'client',
      primario: true,
      opzioni: figli,
      valoreDi: (r) => r.alunno_id ?? null,
    });
  }

  campi.push(
    {
      tipo: 'chip',
      chiave: 'stato',
      etichetta: t('modulisticaFiltroStato'),
      dove: 'client',
      opzioni: [
        { valore: 'in_validazione', etichetta: t('modulisticaCertStatoInValidazione'), tono: 'warn' },
        { valore: 'validato', etichetta: t('modulisticaCertStatoValidato'), tono: 'success' },
        { valore: 'rifiutato', etichetta: t('modulisticaCertStatoRifiutato'), tono: 'error' },
      ],
      valoreDi: (r) => r.stato ?? null,
    },
    {
      tipo: 'periodo',
      chiave: 'copertura',
      etichetta: t('modulisticaFiltroCopertura'),
      dove: 'client',
      ...(opzioni?.descriviPeriodo ? { descrivi: opzioni.descriviPeriodo } : null),
      // La riga OCCUPA un intervallo, non sta in un giorno: si tiene se le due
      // finestre SI SOVRAPPONGONO. «I certificati di settembre» deve trovare anche
      // la malattia cominciata il 30 agosto e finita il 3 settembre — che è
      // esattamente quella che serve quando si cerca un'assenza da giustificare.
      intervalloDi: (r) => ({ da: r.data_inizio, a: r.data_fine }),
    },
  );

  return campi;
}
