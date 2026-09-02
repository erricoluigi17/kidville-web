import { isoToIt, itToIso } from '@/lib/format/data';
import { testoCorrisponde } from '@/lib/ui/testo-ricerca';
import type {
  CampoFiltro,
  FiltroAttivo,
  LettoreParametri,
  OpzioneFiltro,
  Periodo,
  StatoElencoTipo,
  ValoreFiltro,
  ValoriFiltri,
} from './tipi';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * ─── IL MOTORE DEI FILTRI — puro, senza React, senza DOM ─────────────────────
 *
 * Tutto ciò che una barra filtri può sbagliare in silenzio sta qui dentro, e qui
 * si può provare senza montare niente: l'AND fra campi diversi e l'OR dentro un
 * campo, gli estremi di un periodo, che cosa parte verso l'API e che cosa resta
 * a schermo, quanti filtri sono «attivi» davvero.
 *
 * ── LA SEMANTICA, in una riga ───────────────────────────────────────────────
 * **AND fra campi diversi, OR dentro un `multi`.** «Stato = in attesa» E «Sede =
 * Cesa OPPURE Giugliano». È la lettura che ci si aspetta da una barra filtri, ed
 * è l'unica in cui aggiungere una spunta non fa mai *sparire* righe dentro lo
 * stesso campo né *comparire* righe fuori dagli altri.
 *
 * ── IL PERIODO È INCLUSIVO A TUTTI E DUE GLI ESTREMI ────────────────────────
 * «Dal 1° al 31» comprende il 31. Il difetto opposto — l'ultimo giorno che
 * sparisce — è il più comune di tutti e si nota solo quando manca la
 * registrazione di fine mese. Un `da` posteriore ad `a` NON si corregge da sé e
 * non si ignora: l'elenco esce vuoto, perché quello è ciò che è stato chiesto.
 *
 * ── LA STABILITÀ DELLA QUERY NON È UN DETTAGLIO ─────────────────────────────
 * `queryServer` scorre i CAMPI, non le chiavi dei valori: a parità di scelte la
 * stringa che ne esce è sempre la stessa, in qualunque ordine siano stati
 * scritti i valori. È il contratto su cui si regge `chiaveServer` dell'hook — e
 * una chiave che cambia identità a parità di scelte è un ciclo di fetch infinito
 * (la stessa ragione per cui `sede-context` espone `reFetchKey` come STRINGA).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Valori neutri
// ─────────────────────────────────────────────────────────────────────────────

const PERIODO_VUOTO: Periodo = { da: '', a: '' };

/** Il valore «a riposo» di un campo: quello a cui «Pulisci filtri» lo riporta. */
export function valoreNeutro<R>(campo: CampoFiltro<R>): ValoreFiltro {
  switch (campo.tipo) {
    case 'ricerca':
      return '';
    case 'scelta':
    case 'chip':
      return campo.predefinito ?? '';
    case 'multi':
      return [...(campo.predefinito ?? [])];
    case 'periodo':
      return { ...PERIODO_VUOTO };
    case 'interruttore':
      return campo.predefinito ?? false;
  }
}

const comeTesto = (v: ValoreFiltro | undefined): string => (typeof v === 'string' ? v : '');
const comeElenco = (v: ValoreFiltro | undefined): string[] => (Array.isArray(v) ? v : []);
const comeBooleano = (v: ValoreFiltro | undefined): boolean => v === true;
const comePeriodo = (v: ValoreFiltro | undefined): Periodo =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v : PERIODO_VUOTO;

/**
 * Una data `YYYY-MM-DD` che esiste davvero sul calendario.
 *
 * Il controllo passa dal giro completo di `@/lib/format/data`, che quella regola
 * ce l'ha già e la prova già (`31/02` non torna indietro). Riscriverla qui
 * significherebbe avere due calendari nel repo, e correggerne uno solo.
 */
function dataIsoValida(s: string): boolean {
  return s !== '' && itToIso(isoToIt(s)) === s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Lettura dall'indirizzo
// ─────────────────────────────────────────────────────────────────────────────

/** I nomi dei parametri che un campo occupa nell'indirizzo. */
export function parametriDi<R>(campo: CampoFiltro<R>): string[] {
  return campo.tipo === 'periodo' ? [`${campo.chiave}Da`, `${campo.chiave}A`] : [campo.chiave];
}

/** Tutti i parametri d'URL governati da questa barra (e nessun altro). */
export function parametriGovernati<R>(campi: readonly CampoFiltro<R>[]): string[] {
  return campi.flatMap(parametriDi);
}

const VERO = new Set(['1', 'true', 'si', 'sì']);
const FALSO = new Set(['0', 'false', 'no']);

/**
 * Lo stato di partenza: i valori neutri, sovrascritti da ciò che l'indirizzo
 * porta con sé.
 *
 * ⚠️ Un parametro d'URL lo scrive chiunque, e non si fida mai: un valore che non
 * è fra le opzioni viene SCARTATO, non accettato. Se passasse, il filtro
 * mostrerebbe zero righe e nessuno saprebbe perché — un elenco vuoto per colpa
 * di un refuso in un indirizzo si legge esattamente come un archivio vuoto.
 */
export function valoriIniziali<R>(
  campi: readonly CampoFiltro<R>[],
  daUrl?: LettoreParametri | null,
): ValoriFiltri {
  const valori: ValoriFiltri = {};
  for (const campo of campi) {
    const neutro = valoreNeutro(campo);
    if (!daUrl) {
      valori[campo.chiave] = neutro;
      continue;
    }
    switch (campo.tipo) {
      case 'ricerca': {
        valori[campo.chiave] = daUrl.get(campo.chiave) ?? '';
        break;
      }
      case 'scelta':
      case 'chip': {
        const grezzo = daUrl.get(campo.chiave);
        const ammesso =
          grezzo !== null && (grezzo === campo.predefinito || campo.opzioni.some((o) => o.valore === grezzo));
        valori[campo.chiave] = ammesso ? grezzo : neutro;
        break;
      }
      case 'multi': {
        const grezzo = daUrl.get(campo.chiave);
        if (grezzo === null) {
          valori[campo.chiave] = neutro;
          break;
        }
        const ammessi = new Set(campo.opzioni.map((o) => o.valore));
        valori[campo.chiave] = grezzo
          .split(',')
          .map((v) => v.trim())
          .filter((v) => v !== '' && ammessi.has(v));
        break;
      }
      case 'periodo': {
        const da = daUrl.get(`${campo.chiave}Da`) ?? '';
        const a = daUrl.get(`${campo.chiave}A`) ?? '';
        valori[campo.chiave] = {
          da: dataIsoValida(da) ? da : '',
          a: dataIsoValida(a) ? a : '',
        };
        break;
      }
      case 'interruttore': {
        const grezzo = (daUrl.get(campo.chiave) ?? '').toLowerCase();
        valori[campo.chiave] = VERO.has(grezzo) ? true : FALSO.has(grezzo) ? false : neutro;
        break;
      }
    }
  }
  return valori;
}

// ─────────────────────────────────────────────────────────────────────────────
// «È attivo?» — la domanda da cui dipendono pastiglia, chip e URL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Il campo si discosta dal proprio riposo.
 *
 * Nota su `obbligatorio`: qui NON è considerato. Questa funzione risponde «il
 * valore è diverso dal predefinito», che serve anche all'URL (dove l'anno scelto
 * a mano deve comparire). Chi conta i filtri o disegna i chip esclude gli
 * obbligatori a parte — vedi `contaAttivi` e `descriviAttivi`.
 */
export function campoAttivo<R>(campo: CampoFiltro<R>, valori: ValoriFiltri): boolean {
  const v = valori[campo.chiave];
  switch (campo.tipo) {
    case 'ricerca':
      return comeTesto(v).trim() !== '';
    case 'scelta':
    case 'chip':
      return comeTesto(v) !== (campo.predefinito ?? '');
    case 'multi': {
      const scelti = comeElenco(v);
      const base = campo.predefinito ?? [];
      if (scelti.length !== base.length) return true;
      const insieme = new Set(base);
      return scelti.some((s) => !insieme.has(s));
    }
    case 'periodo': {
      const p = comePeriodo(v);
      return p.da !== '' || p.a !== '';
    }
    case 'interruttore':
      return comeBooleano(v) !== (campo.predefinito ?? false);
  }
}

/** Quanti filtri l'utente ha aggiunto: è il numero sulla pastiglia «Filtri». */
export function contaAttivi<R>(campi: readonly CampoFiltro<R>[], valori: ValoriFiltri): number {
  // Si contano i CAMPI, non i valori: «Sede: Cesa, Aversa, Giugliano» è UN
  // filtro con tre scelte, e dire «3» sulla pastiglia farebbe credere che ce ne
  // siano tre da togliere. I chip, invece, sono uno per valore: quelli si
  // tolgono davvero uno alla volta.
  return campi.filter((c) => !c.obbligatorio && campoAttivo(c, valori)).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verso l'indirizzo e verso l'API
// ─────────────────────────────────────────────────────────────────────────────

function scriviParametro<R>(p: URLSearchParams, campo: CampoFiltro<R>, valori: ValoriFiltri): void {
  const v = valori[campo.chiave];
  switch (campo.tipo) {
    case 'ricerca': {
      const testo = comeTesto(v).trim();
      if (testo !== '') p.set(campo.chiave, testo);
      break;
    }
    case 'scelta':
    case 'chip': {
      const testo = comeTesto(v);
      if (testo !== '') p.set(campo.chiave, testo);
      break;
    }
    case 'multi': {
      const scelti = comeElenco(v);
      if (scelti.length > 0) p.set(campo.chiave, scelti.join(','));
      break;
    }
    case 'periodo': {
      const periodo = comePeriodo(v);
      if (periodo.da !== '') p.set(`${campo.chiave}Da`, periodo.da);
      if (periodo.a !== '') p.set(`${campo.chiave}A`, periodo.a);
      break;
    }
    case 'interruttore': {
      if (comeBooleano(v)) p.set(campo.chiave, '1');
      break;
    }
  }
}

/**
 * L'indirizzo da cui la stessa schermata si rialza identica.
 *
 * Esce solo ciò che è stato scelto davvero: un indirizzo pieno di parametri al
 * valore predefinito non si legge, non si incolla e nasconde le due o tre cose
 * che contano. Gli obbligatori compaiono solo quando sono stati CAMBIATI —
 * l'anno corrente nell'URL è rumore, l'anno scorso è un'informazione.
 */
export function versoUrl<R>(campi: readonly CampoFiltro<R>[], valori: ValoriFiltri): URLSearchParams {
  const p = new URLSearchParams();
  for (const campo of campi) {
    if (!campoAttivo(campo, valori)) continue;
    scriviParametro(p, campo, valori);
  }
  return p;
}

/**
 * I parametri che partono verso l'API: **solo** i campi `dove: 'server'`.
 *
 * Gli obbligatori ci sono sempre, anche al valore predefinito: sono la cornice
 * della richiesta (l'anno, la sede), e una richiesta senza cornice non è la
 * stessa richiesta con un parametro in meno — è una richiesta diversa.
 */
export function queryServer<R>(campi: readonly CampoFiltro<R>[], valori: ValoriFiltri): URLSearchParams {
  const p = new URLSearchParams();
  for (const campo of campi) {
    if (campo.dove !== 'server') continue;
    if (!campo.obbligatorio && !campoAttivo(campo, valori)) continue;
    scriviParametro(p, campo, valori);
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Il filtro vero e proprio
// ─────────────────────────────────────────────────────────────────────────────

/** `true` se la riga passa QUESTO campo (i campi server non filtrano a schermo). */
function rigaPassa<R>(campo: CampoFiltro<R>, valori: ValoriFiltri, riga: R): boolean {
  if (campo.dove !== 'client') return true;
  const v = valori[campo.chiave];
  switch (campo.tipo) {
    case 'ricerca':
      return testoCorrisponde(campo.testiDi(riga), comeTesto(v));
    case 'scelta':
    case 'chip': {
      const scelto = comeTesto(v);
      if (scelto === '') return true;
      return campo.valoreDi(riga) === scelto;
    }
    case 'multi': {
      const scelti = comeElenco(v);
      if (scelti.length === 0) return true;
      const insieme = new Set(scelti);
      // OR dentro il campo: basta che UNO dei valori della riga sia fra i scelti.
      return campo.valoriDi(riga).some((x) => typeof x === 'string' && insieme.has(x));
    }
    case 'periodo': {
      const { da, a } = comePeriodo(v);
      if (da === '' && a === '') return true;
      if (campo.intervalloDi) {
        const r = campo.intervalloDi(riga);
        if (!r) return false;
        const inizio = r.da ?? '';
        const fine = r.a ?? '';
        // Sovrapposizione fra due intervalli, estremi compresi. Un estremo
        // assente sulla riga vale «aperto da quel lato».
        if (a !== '' && inizio !== '' && inizio > a) return false;
        if (da !== '' && fine !== '' && fine < da) return false;
        return true;
      }
      const data = campo.dataDi(riga);
      if (!data) return false;
      // Confronto lessicografico: su `YYYY-MM-DD` coincide con quello di
      // calendario, ed è il motivo per cui il formato è quello e non un altro.
      if (da !== '' && data < da) return false;
      if (a !== '' && data > a) return false;
      return true;
    }
    case 'interruttore':
      return comeBooleano(v) ? campo.predicato(riga) : true;
  }
}

/**
 * Le righe che superano TUTTI i filtri client (AND), con l'OR dentro i `multi`.
 * L'ordine di partenza non si tocca: ordinare è mestiere di chi disegna la
 * tabella, non del filtro.
 */
export function filtraRighe<R>(
  campi: readonly CampoFiltro<R>[],
  valori: ValoriFiltri,
  righe: readonly R[],
): R[] {
  // Un intervallo rovesciato non si raddrizza di nascosto: chi ha scritto «dal
  // 31 marzo al 1° gennaio» ha chiesto l'insieme vuoto, e vederlo vuoto è
  // l'unico modo di accorgersi dello scambio. Correggerlo in silenzio mostra
  // righe che non sono state chieste.
  for (const campo of campi) {
    if (campo.tipo !== 'periodo' || campo.dove !== 'client') continue;
    const { da, a } = comePeriodo(valori[campo.chiave]);
    if (da !== '' && a !== '' && da > a) return [];
  }
  const attivi = campi.filter((c) => c.dove === 'client');
  if (attivi.length === 0) return [...righe];
  return righe.filter((riga) => attivi.every((campo) => rigaPassa(campo, valori, riga)));
}

// ─────────────────────────────────────────────────────────────────────────────
// I chip removibili
// ─────────────────────────────────────────────────────────────────────────────

const descriviPeriodo = (p: Periodo): string => `${p.da} → ${p.a}`.trim();

/**
 * I filtri attivi in forma leggibile, uno per chip.
 *
 * Il `tono` viene dall'OPZIONE, che a sua volta lo prende dai toni del badge di
 * quello stato nell'elenco: così «In attesa» filtro e «In attesa» riga sono la
 * stessa cosa arancione. Riscegliere il colore qui vorrebbe dire avere due
 * arancioni diversi per la stessa parola nella stessa schermata.
 *
 * Un `multi` produce un chip PER VALORE: quelli si tolgono davvero uno alla
 * volta, ed è la differenza con la pastiglia «Filtri», che conta i campi.
 */
export function descriviAttivi<R>(
  campi: readonly CampoFiltro<R>[],
  valori: ValoriFiltri,
): FiltroAttivo[] {
  const fuori: FiltroAttivo[] = [];
  for (const campo of campi) {
    if (campo.obbligatorio || !campoAttivo(campo, valori)) continue;
    const v = valori[campo.chiave];
    switch (campo.tipo) {
      case 'ricerca':
        fuori.push({ chiave: campo.chiave, etichetta: campo.etichetta, testo: comeTesto(v).trim() });
        break;
      case 'scelta':
      case 'chip': {
        const scelto = comeTesto(v);
        const opzione = campo.opzioni.find((o) => o.valore === scelto);
        fuori.push({
          chiave: campo.chiave,
          valore: scelto,
          etichetta: campo.etichetta,
          testo: opzione?.etichetta ?? scelto,
          ...(opzione?.tono ? { tono: opzione.tono } : null),
        });
        break;
      }
      case 'multi': {
        for (const scelto of comeElenco(v)) {
          const opzione = campo.opzioni.find((o) => o.valore === scelto);
          fuori.push({
            chiave: campo.chiave,
            valore: scelto,
            etichetta: campo.etichetta,
            testo: opzione?.etichetta ?? scelto,
            ...(opzione?.tono ? { tono: opzione.tono } : null),
          });
        }
        break;
      }
      case 'periodo': {
        const periodo = comePeriodo(v);
        fuori.push({
          chiave: campo.chiave,
          etichetta: campo.etichetta,
          testo: (campo.descrivi ?? descriviPeriodo)(periodo),
        });
        break;
      }
      case 'interruttore':
        // Non c'è un valore da mostrare: il filtro È la sua etichetta.
        fuori.push({ chiave: campo.chiave, etichetta: campo.etichetta, testo: campo.etichetta });
        break;
    }
  }
  return fuori;
}

// ─────────────────────────────────────────────────────────────────────────────
// Togliere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toglie un filtro. Con `valore` toglie SOLO quel valore da un `multi` (è il ✕
 * di un chip); senza, riporta il campo al proprio riposo.
 */
export function azzeraFiltro<R>(
  campi: readonly CampoFiltro<R>[],
  valori: ValoriFiltri,
  chiave: string,
  valore?: string,
): ValoriFiltri {
  const campo = campi.find((c) => c.chiave === chiave);
  if (!campo) return valori;
  if (campo.tipo === 'multi' && valore !== undefined) {
    return { ...valori, [chiave]: comeElenco(valori[chiave]).filter((v) => v !== valore) };
  }
  return { ...valori, [chiave]: valoreNeutro(campo) };
}

/**
 * «Pulisci filtri»: tutto a riposo, TRANNE gli obbligatori — che restano dove
 * sono. L'anno scelto dalla segreteria non è un filtro da togliere: è la
 * cornice dell'elenco, e riportarlo all'anno corrente le farebbe perdere il
 * posto in cui stava lavorando.
 */
export function pulisciFiltri<R>(
  campi: readonly CampoFiltro<R>[],
  valori: ValoriFiltri,
): ValoriFiltri {
  const puliti: ValoriFiltri = {};
  for (const campo of campi) {
    puliti[campo.chiave] = campo.obbligatorio ? valori[campo.chiave] : valoreNeutro(campo);
  }
  return puliti;
}

// ─────────────────────────────────────────────────────────────────────────────
// Opzioni derivate dai dati
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le voci di un filtro costruite sui DATI che ci sono, con quante righe porta
 * ciascuna. È il modo giusto per sedi, classi, categorie: un elenco fisso
 * mostrerebbe scelte che non danno nessuna riga, e nasconderebbe quelle nate
 * dopo.
 *
 * L'etichetta e il tono si decidono fuori: qui dentro non c'è lingua, e il
 * colore deve restare quello del badge dell'elenco.
 */
export function opzioniDerivate<R>(
  righe: readonly R[],
  estrai: (riga: R) => string | readonly string[] | null | undefined,
  opzioni?: {
    etichettaDi?: (valore: string) => string;
    tonoDi?: (valore: string) => BadgeTone | undefined;
    ordina?: 'etichetta' | 'conteggio';
  },
): OpzioneFiltro[] {
  const conteggi = new Map<string, number>();
  for (const riga of righe) {
    const grezzo = estrai(riga);
    if (grezzo === null || grezzo === undefined) continue;
    const valori = typeof grezzo === 'string' ? [grezzo] : grezzo;
    for (const v of valori) {
      if (typeof v !== 'string' || v === '') continue;
      conteggi.set(v, (conteggi.get(v) ?? 0) + 1);
    }
  }
  const fuori: OpzioneFiltro[] = [...conteggi.entries()].map(([valore, conteggio]) => {
    const tono = opzioni?.tonoDi?.(valore);
    return {
      valore,
      etichetta: opzioni?.etichettaDi?.(valore) ?? valore,
      conteggio,
      ...(tono ? { tono } : null),
    };
  });
  if (opzioni?.ordina === 'conteggio') {
    fuori.sort((a, b) => (b.conteggio ?? 0) - (a.conteggio ?? 0) || a.etichetta.localeCompare(b.etichetta, 'it'));
  } else {
    fuori.sort((a, b) => a.etichetta.localeCompare(b.etichetta, 'it'));
  }
  return fuori;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quale schermata rendere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quale dei quattro stati dell'elenco mostrare — e la distinzione conta.
 *
 * ⚠️ `totale` è quante righe esistono in questa linguetta **senza** filtri. È il
 * cardine di tutto: dire «nessun risultato con questi filtri» su una tabella che
 * non ha mai avuto una riga accusa i filtri di una colpa che non hanno, e manda
 * la segreteria a cercare un filtro che non esiste. In questo progetto 5
 * linguette su 13 hanno zero righe in produzione: è il caso normale, non il caso
 * limite. Se non si può sapere il totale senza filtri, si passa il conteggio
 * della linguetta — mai `mostrati`.
 *
 * ⚠️ Una lettura FALLITA non è mai «nessun risultato», nemmeno con i filtri
 * attivi: manderebbe a togliere filtri per un guasto che non è dell'utente.
 * Perciò `errore` viene prima di tutto.
 *
 * ⚠️ Se ci sono già righe a schermo, un ricaricamento NON riporta allo spinner:
 * le righe restano (attenuate, `aria-busy`), e questo è il motivo per cui
 * `caricamento` viene dopo `mostrati > 0`. Sostituire la tabella con uno
 * spinner a ogni battuta di tasto è il difetto peggiore di una barra filtri.
 */
export function decidiStatoElenco(stato: {
  caricamento: boolean;
  errore: boolean;
  totale: number;
  mostrati: number;
}): StatoElencoTipo {
  if (stato.errore) return 'errore';
  if (stato.mostrati > 0) return 'pronto';
  if (stato.caricamento) return 'caricamento';
  if (stato.totale <= 0) return 'vuoto';
  return 'senzaRisultati';
}
