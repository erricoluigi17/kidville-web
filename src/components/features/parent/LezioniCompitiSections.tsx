'use client';

import { useId, useState } from 'react';
import { BookOpen, ClipboardList, FileText, Image as ImageIcon, CalendarClock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { annoScolasticoCorrente } from '@/lib/anno-scolastico';
import { addGiorni } from '@/lib/format/data';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { decidiStatoElenco, opzioniDerivate } from '@/lib/ui/filtri/motore';
import type { FiltroAttivo, OpzioneFiltro } from '@/lib/ui/filtri/tipi';
import { cx } from '@/lib/ui/cx';
import { StatoElenco, testiStatoElenco, type TestiStatoElenco } from '@/components/ui/StatoElenco';

// `file_url` è NULLABILE, e il tipo lo dice.
//
// `GET /api/parent/primaria` non restituisce più il percorso dentro il
// contenitore privato — che il browser risolveva come indirizzo RELATIVO,
// rispondendo 404 senza un errore né una riga di log — ma un link FIRMATO a
// tempo. Quando la firma non riesce (Storage giù, file rimosso a mano) il
// contratto del progetto è `null`, mai il percorso grezzo: qui `null` significa
// «allegato non apribile adesso», e l'unica risposta onesta è non disegnare un
// link.
export interface Allegato { id: string; tipo: string; file_url: string | null; file_name: string | null }
export interface Individualizzata { argomento: string | null; compiti: string | null }
export interface Lezione {
  id: string; data: string; ora_lezione: number; materia: string | null;
  argomento: string | null; compiti: string | null; data_consegna_compiti?: string | null;
  allegati: Allegato[]; individualizzate: Individualizzata[];
}

function perGiorno(lezioni: Lezione[]): [string, Lezione[]][] {
  const m = new Map<string, Lezione[]>();
  for (const l of lezioni) {
    const arr = m.get(l.data) ?? [];
    arr.push(l);
    m.set(l.data, arr);
  }
  return [...m.entries()];
}

// ─── `new Date('YYYY-MM-DD')` È MEZZANOTTE **UTC**, e qui va bene ────────────
//
// La stringa arriva da una colonna `date` di Postgres e il costruttore la legge
// come mezzanotte UTC. Il giorno reso sarebbe quindi quello sbagliato in ogni
// fuso a occidente di Greenwich — se il formattatore usasse il fuso di CHI
// GUARDA. Non lo usa: `intlDateTime` dichiara `Europe/Rome` per costruzione
// (`@/i18n/config`), e il lock `__tests__/architecture/date-con-timezone.test.ts`
// vieta i formattatori che non lo fanno.
//
// Misurato, non dedotto (2026-09-09, `new Date('2026-09-10')`):
//
//   fuso del processo      Europe/Rome forzato    fuso d'ambiente
//   Europe/Rome            gio 10 set             gio 10 set
//   America/Los_Angeles    gio 10 set             mer 9 set   ← lo sfasamento
//   Pacific/Niue           gio 10 set             mer 9 set
//
// Mezzanotte UTC in Europe/Rome è l'01:00 o le 02:00 dello STESSO giorno, e il
// fuso italiano non è mai negativo: la data non può scivolare. L'assunzione da
// non infrangere è quindi una sola — il fuso è quello dell'ISTITUTO, non del
// dispositivo — e vale finché queste due chiamate non dichiarano un `timeZone`
// proprio. Non c'è niente da correggere; c'è da non toglierlo.
const fmtGiorno = (g: string, locale: string) =>
  intlDateTime(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(g));

/**
 * I chip degli allegati di una lezione — gli stessi in «Lezioni» e in «Compiti».
 *
 * Vive in una funzione sola perché le due sezioni sono nate con lo stesso blocco
 * scritto una volta: in «Compiti» semplicemente NON C'ERA, e il pulsante «Scatta
 * foto» del registro produceva un dato che la famiglia non vedeva mai. Due copie
 * dello stesso blocco sono due copie da tenere allineate, ed è esattamente il
 * modo in cui la seconda si dimentica.
 *
 * Un allegato senza indirizzo (`file_url: null`, firma non riuscita) non diventa
 * un'ancora: `href={null}` renderebbe un `<a>` che sembra un link, non lo è, e
 * non lo dice a nessuno.
 */
function AllegatiLezione({ allegati, etichettaVuota }: { allegati: Allegato[]; etichettaVuota: string }) {
  // Il predicato di tipo, e non un `!` più avanti: è la stessa condizione detta
  // una volta sola, e il compilatore la porta fino all'`href`.
  const apribili = allegati.filter((a): a is Allegato & { file_url: string } => !!a.file_url);
  if (apribili.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {apribili.map((a) => (
        <a key={a.id} href={a.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-pill bg-white px-2 py-0.5 text-[11px] text-kidville-muted">
          {a.tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />}
          {a.file_name || etichettaVuota}
        </a>
      ))}
    </div>
  );
}

// Sezione "Lezioni": materia + argomento + allegati (sola lettura).
export function LezioniList({ lezioni }: { lezioni: Lezione[] }) {
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const giorni = perGiorno(lezioni);
  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2 mb-3">
        <BookOpen size={18} className="text-kidville-green" /> {t('lezioniTitolo')}
      </h3>
      {giorni.length === 0 ? (
        <p className="font-maven text-sm text-kidville-muted">{t('lezioniVuoto')}</p>
      ) : (
        <div className="space-y-4">
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-kidville-muted mb-1">{fmtGiorno(giorno, f.locale)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-sm text-kidville-ink">
                      <span className="font-semibold text-kidville-green">{l.materia || t('lezioniLezione')}</span>
                      {l.argomento && <span className="text-kidville-muted"> — {l.argomento}</span>}
                    </div>
                    {l.individualizzate.filter((i) => i.argomento).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-kidville-info-soft px-2 py-1 font-maven text-xs text-kidville-info">{t('lezioniAttivitaIndividuale', { value: i.argomento ?? '' })}</p>
                    ))}
                    <AllegatiLezione allegati={l.allegati} etichettaVuota={t('lezioniAllegato')} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── IL PERIODO DELLA BACHECA «COMPITI» ──────────────────────────────────────
//
// La bacheca mostrava una finestra sola — gli ultimi 14 giorni — e non c'era
// modo di spostarla: dopo una pausa (una malattia, le vacanze di Natale) il
// genitore leggeva «Nessun compito assegnato di recente» con il registro pieno.
// Da qui questo selettore, che è l'unico posto in cui si decide che cosa
// significhi «14 giorni», «90 giorni» o «anno in corso».
export const PERIODI_COMPITI = [14, 30, 90, 'anno'] as const;
export type PeriodoCompiti = (typeof PERIODI_COMPITI)[number];

/**
 * Il preimpostato **resta 14 giorni**, e resta il comportamento di oggi: per
 * questo `dataDaDelPeriodo(14)` risponde `null` invece di calcolare una data.
 * La finestra preimpostata la decide la route (`GIORNI_REGISTRO_PREDEFINITI`),
 * e mandarle `dataDa` con lo stesso valore sarebbe una seconda copia della
 * stessa costante — cioè una cosa in più da tenere allineata.
 *
 * ⚠️ LIMITE DICHIARATO, NON RISOLTO. Il 14 qui e il 14 di
 * `GIORNI_REGISTRO_PREDEFINITI` (`src/app/api/parent/primaria/route.ts:53`)
 * sono due numeri scritti due volte, e **nessun lock li tiene legati**: se la
 * route passasse a 30, questa tendina continuerebbe a dire «Ultimi 14 giorni»
 * sopra trenta giorni di compiti, e il silenzio sarebbe totale — il
 * preimpostato è l'unico periodo che NON manda `dataDa`, quindi non c'è
 * nessuna data nell'indirizzo da confrontare. Legarli vuol dire esportare la
 * costante dalla route (o portarla in un modulo condiviso) e farci sopra un
 * lock: è un intervento sul modulo della route, fuori da questa corsia. Finché
 * non lo si fa, chi cambia `GIORNI_REGISTRO_PREDEFINITI` deve cambiare anche
 * questa riga — ed è esattamente il tipo di promessa che un giorno nessuno
 * mantiene.
 */
export const PERIODO_PREDEFINITO: PeriodoCompiti = 14;

/**
 * Il tetto che il client si dà, UN GIORNO PIÙ STRETTO di quello della route.
 *
 * `GET /api/parent/primaria` rifiuta con 400 un `dataDa` più vecchio di 365
 * giorni, e il confronto lo fa con il PROPRIO `oggiFiscaleISO()`. Fra il
 * momento in cui questa pagina calcola la data e quello in cui il server la
 * valuta può passare la mezzanotte italiana: con 365 esatti, un `dataDa`
 * calcolato alle 23:59:59 diventa «troppo lontano» un secondo dopo, e il
 * genitore vede un errore al posto del registro. Un giorno di margine costa un
 * giorno di registro e chiude la corsa.
 */
const GIORNI_INDIETRO_MASSIMI = 364;

/**
 * La data da cui chiedere il registro, o `null` per lasciare alla route la sua
 * finestra preimpostata.
 *
 * ⚠️ «Oggi» è `oggiFiscaleISO()` (Europe/Rome), MAI `new Date().toISOString()`:
 * il secondo è UTC, e fra mezzanotte e le due di notte italiane restituisce
 * IERI — un giorno di registro in meno, per chi guarda proprio a quell'ora.
 *
 * ⚠️ «Anno in corso» è l'ANNO SCOLASTICO, e lo decide `annoScolasticoCorrente()`
 * — l'unica definizione di anno scolastico che questo repo ha (soglia al 1°
 * agosto, giorno contato a Roma). NON `annoFiscale()`: quello è l'anno SOLARE a
 * fini di fatturazione, e farebbe partire la bacheca dal 1° gennaio — a ottobre
 * significherebbe «nessun compito», col registro pieno da un mese e mezzo.
 *
 * Si chiama da un gestore di evento o dentro l'effetto che carica, mai nel
 * corpo del render: `new Date()` nel render è un disallineamento di idratazione.
 */
export function dataDaDelPeriodo(periodo: PeriodoCompiti): string | null {
  if (periodo === PERIODO_PREDEFINITO) return null;
  const oggi = oggiFiscaleISO();
  const limite = addGiorni(oggi, -GIORNI_INDIETRO_MASSIMI);
  if (periodo === 'anno') {
    // `annoScolasticoCorrente()` → «2026/2027»: l'anno che apre è quello del 1° agosto.
    const inizio = `${annoScolasticoCorrente().slice(0, 4)}-08-01`;
    // Confronto lessicografico su `YYYY-MM-DD`: coincide con quello di calendario.
    return inizio < limite ? limite : inizio;
  }
  return addGiorni(oggi, -periodo);
}

/** Il valore di una tendina torna come stringa: qui si riporta nel vocabolario. */
function leggiPeriodo(grezzo: string): PeriodoCompiti {
  return PERIODI_COMPITI.find((p) => String(p) === grezzo) ?? PERIODO_PREDEFINITO;
}

/**
 * L'etichetta delle due tendine — e il token è `sub`, mai `muted`.
 *
 * `text-kidville-muted` (#7B8582) vale **3,80:1** su bianco e **3,43:1** sul
 * crema; `text-kidville-sub` (#55615C) vale **6,46:1** e **5,82:1** sugli stessi
 * due fondi. La soglia di WCAG 1.4.3 è 4,5:1, e a 11px non vale nemmeno la
 * deroga del «testo grande» (che parte da 18,66px in grassetto): `muted` resta
 * sotto, `sub` sopra. E queste due righe sono l'UNICA indicazione di che cosa
 * facciano i due controlli che questa corsia ha aggiunto: dipingerle col grigio
 * meno leggibile del tema significa aggiungere un comando e non dire a chi ha
 * una vista imperfetta che cosa comanda.
 *
 * ⚠️ I NUMERI SONO STATI RIFATTI, NON RICOPIATI (2026-09-19). Questo commento
 * ha detto «2,51:1 su bianco e 2,27:1 sul crema» per quindici giorni: erano i
 * valori del VECCHIO `muted` #9AA6A2, cambiato in #7B8582 il **2026-09-04** —
 * e `src/app/globals.css:86-106` lo spiega per esteso tre righe sopra il token.
 * La conclusione non cambia (3,80 < 4,5, e a 11px non c'è deroga), quindi il
 * rimedio resta `sub`: a essere sbagliata era la MISURA, ricopiata da una riga
 * più vecchia del token che descriveva — dentro il lavoro che punisce quella
 * stessa abitudine sull'allowlist. Chi rilegge queste cifre le ricalcoli con
 * l'aritmetica di `__tests__/a11y/contrasto-token.test.ts`, che il token lo
 * legge da `globals.css` invece di fidarsi di una riga di commento.
 *
 * ⚠️ Il lock `__tests__/a11y/testo-muted-allowlist.test.ts` era VERDE con
 * `muted` qui, e non perché andasse bene: nello stesso lavoro era sparita
 * un'altra occorrenza del token (il vecchio `<p>` dello stato vuoto, ora
 * `StatoElenco`), il conteggio per-file era rimasto 7, e la riga nuova aveva
 * occupato il posto liberato dalla riga morta. È il caso che il commento di quel
 * lock descrive: un elenco che non si abbassa quando una voce muore lascia un
 * posto libero a chi verrà dopo. Per questo l'allowlist scende a 6 nello stesso
 * commit.
 */
const ETICHETTA_FILTRO = 'font-maven text-[11px] font-semibold uppercase tracking-wide text-kidville-sub';
const CONTROLLO_FILTRO =
  'font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm text-kidville-ink';

/**
 * Quanta della finestra di registro è stata davvero letta, come la dichiara
 * `GET /api/parent/primaria` nel campo `data.finestraRegistro`.
 *
 * ⚠️ PARLA DELLA FINESTRA, NON DEI COMPITI. «Non ho letto tutto il periodo» non
 * è «mancano dei compiti»: una classe che segna le lezioni senza mai scrivere i
 * compiti può superare il tetto della route e restituire ZERO compiti con il
 * troncamento vero. Le due cose vanno dette separate, o la bacheca finisce per
 * dire insieme «il periodo non è stato letto tutto» e «nessun compito: prova ad
 * allargare il periodo», che è una contraddizione — ed è già stata misurata
 * sull'altro lato dell'app.
 *
 * `totale` è `null` quando il conteggio non è arrivato: si sa che si è tagliato,
 * non di quanto. La forma del tipo lo dice invece di lasciarlo scoprire a chi
 * stamperà «su null».
 */
export interface FinestraRegistro {
  troncata: boolean;
  lette: number;
  totale: number | null;
}

export interface CompitiListProps {
  lezioni: Lezione[];
  /** Il periodo chiesto al server. Chi non lo passa resta al preimpostato. */
  periodo?: PeriodoCompiti;
  /** Manca → la tendina del periodo non si disegna: non avrebbe nessun effetto. */
  onPeriodo?: (periodo: PeriodoCompiti) => void;
  /**
   * Manca → nessun avviso, che è il comportamento di ogni chiamante scritto
   * prima di questo campo (`/parent/lezioni` e le schermate in sola lettura).
   * Il preimpostato è «finestra letta per intero», mai «troncata»: un avviso che
   * compare per omissione è un avviso che si impara a ignorare.
   */
  finestra?: FinestraRegistro;
  caricamento?: boolean;
  errore?: boolean;
  onRiprova?: () => void;
}

// Sezione "Compiti": compiti + scadenza (mostra solo le lezioni con compiti).
export function CompitiList({
  lezioni,
  periodo = PERIODO_PREDEFINITO,
  onPeriodo,
  finestra,
  caricamento = false,
  errore = false,
  onRiprova,
}: CompitiListProps) {
  const t = useTranslations('parentPrimaria');
  const tp = useTranslations('parentServizi');
  const ts = useTranslations('shared');
  const f = useDateFormat();
  const idPeriodo = useId();
  const idMateria = useId();
  // Il filtro per materia è LATO CLIENT: i dati sono già in memoria, e mandarlo
  // al server vorrebbe dire una chiamata in più per togliere righe che ci sono.
  const [materia, setMateria] = useState('');

  // La semantica della bacheca non cambia: una lezione con il solo `argomento`
  // non è un compito.
  const conCompiti = lezioni.filter((l) => l.compiti || l.individualizzate.some((i) => i.compiti));

  // Le materie sono quelle che i compiti ce li hanno DAVVERO, non l'elenco
  // delle materie della classe: una voce che non porta nessuna riga è una voce
  // che promette un elenco e ne apre uno vuoto.
  //
  // ─── LIMITE DICHIARATO: LA MATERIA È UNA STRINGA, E IL CONFRONTO È ESATTO ───
  //
  // Il nome arriva da `materie.nome` e, quando la lezione non è agganciata a una
  // materia, dal `varchar(100)` libero `registro_orario.materia`
  // (`parent/primaria/route.ts:305`). Né l'uno né l'altro sono un vocabolario
  // chiuso: «arte», «Arte» e «Àrte» sarebbero tre voci distinte in questa
  // tendina, e `l.materia === materia` qui sotto ne mostrerebbe una sola per
  // volta.
  //
  // NON si normalizza, e la ragione è misurata sul database di produzione oggi
  // (2026-09-19, sole letture aggregate):
  //   · `materie`: 141 righe, 21 nomi distinti, 17 una volta normalizzati
  //     (minuscole + spazi tolti) → quattro grafie doppione ESISTONO;
  //   · ma raggruppate per sezione, le sezioni con due grafie della stessa
  //     materia sono **0**, e questa bacheca legge una sezione sola
  //     (`.eq('section_id', alunno.section_id)`): nessun genitore può oggi
  //     vedere due voci gemelle;
  //   · il ripiego a testo libero non è nemmeno in uso: `registro_orario` ha 97
  //     righe e **0** con `materia` valorizzata.
  // Normalizzare qui vorrebbe dire scegliere «la forma più frequente» da
  // mostrare e portarsi dietro chiave ed etichetta separate, per un caso che nel
  // perimetro visibile non si dà. La correzione che conta sta a monte — un
  // vincolo di unicità su `materie(section_id, lower(nome))` e la tendina del
  // registro docente al posto del campo libero — e sono file di altre corsie.
  const opzioniMaterie = opzioniDerivate(conCompiti, (l) => l.materia);
  // La scelta in corso resta visibile anche quando il periodo nuovo non porta
  // più quella materia: toglierla di nascosto farebbe leggere «Tutte le
  // materie» a una tendina che sta filtrando.
  //
  // E rientra IN ORDINE, non in fondo: `opzioniDerivate` ordina per etichetta
  // con `localeCompare(…, 'it')`, e appenderla con lo spread la lasciava sotto
  // la Z — cioè faceva saltare all'occhio proprio la voce che deve sembrare
  // normale. Stesso comparatore, perché due ordinamenti diversi sulla stessa
  // tendina sono un ordinamento sbagliato.
  const materieVisibili: OpzioneFiltro[] =
    materia !== '' && !opzioniMaterie.some((o) => o.valore === materia)
      ? [...opzioniMaterie, { valore: materia, etichetta: materia }].sort((a, b) =>
          a.etichetta.localeCompare(b.etichetta, 'it'),
        )
      : opzioniMaterie;

  const visibili = materia === '' ? conCompiti : conCompiti.filter((l) => l.materia === materia);
  const giorni = perGiorno(visibili);

  // ─── I DUE VUOTI SONO DUE FRASI DIVERSE, E L'ERRORE NON È UN VUOTO ──────────
  //
  // `totale` sono i compiti che il periodo caricato contiene PRIMA del filtro
  // per materia: è il cardine fra «in questo periodo non c'è niente» (e allora
  // si invita ad allargarlo) e «con questa materia non c'è niente» (e allora si
  // offre di azzerare il filtro). E una lettura FALLITA non è mai nessuno dei
  // due: manderebbe a togliere filtri per un guasto che non è della famiglia.
  //
  // ─── IL CASO SCOMODO, DICHIARATO: PERIODO VUOTO **E** MATERIA ANCORA SCELTA ─
  //
  // Se in tutto il periodo non c'è nessun compito (`totale === 0`) ma la tendina
  // è rimasta su «Italiano», lo stato è `vuoto`: si legge «Nessun compito
  // assegnato negli ultimi 14 giorni · prova ad allargare il periodo», e NON
  // compare «Azzera i filtri». È voluto, e non è una svista del motore:
  //  · la frase è VERA — con o senza materia, in quel periodo non c'è niente:
  //    `totale` è il conteggio PRE-filtro, ed è per questo che il motore lo
  //    pretende separato da `mostrati`;
  //  · «Azzera i filtri» lì sarebbe un pulsante che PROMETTE righe e non ne può
  //    restituire nessuna: togliere la materia lascia comunque zero compiti, e
  //    la schermata resterebbe identica. Un comando che non cambia niente è
  //    peggio del comando assente;
  //  · il filtro acceso non è comunque muto: la sua tendina resta a schermo —
  //    la voce «fantasma» qui sopra esiste apposta — con la sua etichetta
  //    VISIBILE «Materia» e il valore «Italiano» in chiaro, e si azzera da lì.
  //    Il test «il periodo vuoto non nasconde la materia ancora scelta» ne è la
  //    prova, perché senza quella voce fantasma la tendina sparirebbe e il
  //    filtro diventerebbe davvero inaccessibile.
  const stato = decidiStatoElenco({
    caricamento,
    errore,
    totale: conCompiti.length,
    mostrati: visibili.length,
  });

  // ─── IL PERIODO NON LETTO PER INTERO ────────────────────────────────────────
  //
  // `finestra.troncata` dice che `GET /api/parent/primaria` ha smesso di leggere
  // il registro prima della fine del periodo (il suo tetto è `RIGHE_REGISTRO_
  // MASSIME`, e l'ordine è `data DESC`: a restare fuori è la parte più VECCHIA).
  // Non dice niente sui compiti, e questa distinzione decide due frasi a schermo.
  const troncata = finestra?.troncata ?? false;

  // ─── LA CHIAVE MORTA CHE SE N'È ANDATA COL SUO CONSUMATORE ──────────────────
  //
  // `parentPrimaria.compitiVuoto` («Nessun compito assegnato di recente.») è
  // uscita da ENTRAMBI i cataloghi in questo stesso lavoro: il suo unico punto
  // di chiamata era il `<p>` che `StatoElenco` ha sostituito, e lo stato vuoto
  // adesso dice due frasi diverse — il periodo o i filtri — con chiavi che
  // vivono in `parentServizi`. Portare via il consumatore lasciando il consumato
  // è il difetto che `__tests__/architecture/messaggi-chiavi-orfane.test.ts`
  // esiste per prendere, e qui si sarebbe preso da solo.
  //
  // ⚠️ LA GARANZIA C'È, MA NON È QUELLA CHE VERREBBE DA SCRIVERE. La scansione
  // di quel lock su `parentPrimaria` dà zero orfane, ed è per questo che la
  // TESTATA del lock (`messaggi-chiavi-orfane.test.ts:41-45`) nomina il
  // namespace fra quelli «oggi a zero», che «entrano appena il ramo che li sta
  // riscrivendo è chiuso». Non c'è nessuna lista d'attesa e nessuna procedura
  // dietro quella frase: `SOTTO_TUTELA` è una `Map` con DUE voci
  // (`adminModulistica` e `password`), e l'ingresso di un terzo namespace è un
  // gesto che qualcuno deve fare a mano.
  //
  // La frase comoda, «nessuna chiave del namespace è costruita da un dato»,
  // sarebbe poi FALSA: di siti così ce ne sono **sei**, in quattro consumatori —
  //   · `parent/primaria/page.tsx:68-69`        `t(s.labelKey)`, `t(s.subKey)`
  //   · `parent/primaria/assenze/page.tsx:214`  `t(tile.labelKey)`
  //   · `parent/primaria/assenze/page.tsx:274`  `t(meta.labelKey)`
  //   · `parent/primaria/note/page.tsx:101`     `t(meta.labelKey)`
  //   · `PrimariaParentView.tsx:84`             `t(CAT_LABEL_KEY[n.categoria])`
  //   · `PrimariaParentView.tsx:358`            `t(STATO_ASSENZA_KEY[a.stato])`
  //
  // La scansione dà zero lo stesso perché tutte e sei risolvono da TABELLE DI
  // LETTERALI dichiarate dentro `src/` (`SEZIONI`, `RIEPILOGO_TILES`,
  // `CATEGORIE`, `STATO_LABEL`, `CAT_LABEL_KEY`, `STATO_ASSENZA_KEY`), e il lock
  // legge i sorgenti come TESTO: il nome della chiave scritto dentro la tabella
  // si fa trovare esattamente come se stesse al punto di chiamata.
  //
  // ⚠️ ED È IL MOTIVO PER CUI QUI NESSUNA DI QUELLE CHIAVI È NOMINATA PER
  // ESTESO. Il lock legge i sorgenti come testo e NON spoglia i commenti: una
  // chiave citata in questo paragrafo diventerebbe la sua seconda occorrenza in
  // `src/`, e il giorno in cui `parentPrimaria` entrasse in `SOTTO_TUTELA` —
  // cioè proprio ciò che qui sotto si invita a fare — cancellare la voce dalla
  // tabella lascerebbe il lock VERDE, tenuto in piedi da questa spiegazione.
  // Sarebbe l'auto-immunizzazione già vista altrove nel repo, creata dentro il
  // commento che la racconta. I nomi si leggono ai sei punti elencati qui sopra.
  //
  // È una garanzia PIÙ DEBOLE, e va detto invece che arrotondato: non regge
  // perché le chiavi sono nominate per esteso, regge finché quelle sei tabelle
  // restano di letterali e restano in `src/`. Il giorno in cui una finisse nel
  // database, in un JSON fuori da `src/`, o venisse composta (`'hub' + nome`),
  // la scansione diventerebbe cieca su quelle chiavi e il lock resterebbe VERDE
  // su un catalogo morto. Chi un domani metterà `parentPrimaria` in
  // `SOTTO_TUTELA` deve scrivere là dentro questa ragione, non l'altra: la
  // motivazione di un lock è la cosa che nessuno riverifica più.
  const testi: TestiStatoElenco = {
    ...testiStatoElenco(ts),
    // Lo stato «vuoto» NON nomina i filtri: nomina il periodo, che è la cornice
    // della richiesta, e indica il passo che serve — allargarlo.
    //
    // ⚠️ MA CON LA FINESTRA TRONCATA «Nessun compito negli ultimi 364 giorni» è
    // una frase FALSA: di quei 364 giorni ne è stata letta solo la coda più
    // recente, e sul resto non si sa niente. Il titolo dice allora ciò che si è
    // davvero verificato — nessun compito fra le lezioni LETTE — e il conto di
    // quante siano sta nell'avviso qui sotto, che è l'unico posto in cui vive.
    vuotoTitolo: troncata
      ? tp('compitiVuotoTroncato')
      : periodo === 'anno'
        ? tp('compitiVuotoAnno')
        : tp('compitiVuotoPeriodo', { giorni: periodo }),
    // «Prova ad allargare il periodo QUI SOPRA» indica un comando, e senza
    // `onPeriodo` quel comando non è disegnato: la frase manderebbe a cercare
    // una tendina che non c'è. La riga dell'«anno in corso» non indica niente da
    // toccare («più indietro di così il registro non si consulta»), quindi resta
    // sempre.
    //
    // ⚠️ E CON LA FINESTRA TRONCATA L'INVITO AD ALLARGARE SI SPEGNE, sempre,
    // anche quando la tendina c'è. Non è prudenza: allargare il periodo mentre
    // il taglio è attivo non porta indietro NEMMENO UNA riga. Le righe lette
    // sono le N più recenti della finestra, e le N più recenti di una finestra
    // più larga sono esattamente le stesse — cambierebbe solo il numero accanto
    // a «su», cioè la misura di quanto NON si sta vedendo. Mandare ad allargare
    // sarebbe indicare un comando che non può dare ciò che promette, e lo
    // sarebbe mentre l'avviso qui sopra dice che il periodo è già più lungo di
    // quanto si legga: le due frasi si contraddirebbero a un centimetro di
    // distanza.
    vuotoCorpo: troncata
      ? tp('compitiVuotoTroncatoInvito')
      : periodo === 'anno'
        ? tp('compitiVuotoAnnoInvito')
        : onPeriodo
          ? tp('compitiVuotoPeriodoInvito')
          : undefined,
    senzaRisultatiTitolo: tp('compitiSenzaRisultatiTitolo'),
    senzaRisultatiCorpo: tp('compitiSenzaRisultatiCorpo'),
    pulisciFiltri: tp('compitiAzzeraFiltri'),
  };

  // Il periodo NON compare fra i chip e «Azzera i filtri» non lo tocca: è la
  // CORNICE della richiesta, non una restrizione aggiunta — la stessa regola
  // che `pulisciFiltri` applica agli `obbligatorio` del motore. Riportarlo a 14
  // qui dentro toglierebbe righe invece di restituirle, proprio nel momento in
  // cui si è chiesto di rivedere tutto.
  const attivi: FiltroAttivo[] =
    materia === '' ? [] : [{ chiave: 'materia', etichetta: tp('compitiFiltriMateria'), testo: materia }];

  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2 mb-3">
        <ClipboardList size={18} className="text-kidville-yellow-strong" /> {t('compitiTitolo')}
      </h3>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        {onPeriodo && (
          <div className="flex flex-col gap-1">
            {/* L'etichetta è VISIBILE, non solo `aria-label`: su un telefono una
                tendina senza etichetta si legge solo dal valore che porta. */}
            <label htmlFor={idPeriodo} className={ETICHETTA_FILTRO}>
              {tp('compitiFiltriPeriodo')}
            </label>
            <select
              id={idPeriodo}
              value={String(periodo)}
              onChange={(e) => onPeriodo(leggiPeriodo(e.target.value))}
              className={CONTROLLO_FILTRO}
            >
              {PERIODI_COMPITI.map((p) => (
                <option key={p} value={String(p)}>
                  {p === 'anno' ? tp('compitiPeriodoAnno') : tp('compitiPeriodoGiorni', { giorni: p })}
                </option>
              ))}
            </select>
          </div>
        )}
        {materieVisibili.length > 0 && (
          <div className="flex flex-col gap-1">
            <label htmlFor={idMateria} className={ETICHETTA_FILTRO}>
              {tp('compitiFiltriMateria')}
            </label>
            <select
              id={idMateria}
              value={materia}
              onChange={(e) => setMateria(e.target.value)}
              className={CONTROLLO_FILTRO}
            >
              <option value="">{tp('compitiMateriaTutte')}</option>
              {materieVisibili.map((o) => (
                <option key={o.valore} value={o.valore}>
                  {o.etichetta}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {/* ─── L'AVVISO CHE IL PERIODO NON È STATO LETTO PER INTERO ─────────────
          Sta SOPRA l'elenco e sopra lo stato vuoto, perché vale in tutti e due i
          casi: qualunque cosa ci sia sotto, non è la risposta all'intero periodo
          chiesto. Senza, il taglio della route sarebbe silenzioso esattamente
          come lo era quello di PostgREST che ha sostituito.

          `text-kidville-info-strong` e non `info`: sulla propria fascia
          `info-soft` il token debole vale 4,20:1, sotto i 4,5:1 di WCAG 1.4.3, e
          il forte 6,74:1 — misurati in `__tests__/a11y/contrasto-token.test.ts`,
          che i token li legge da `globals.css`.

          Il testo senza il totale NON è un ripiego muto: `finestra.totale` è
          `null` quando il conteggio non è arrivato, e allora si sa che si è
          tagliato ma non di quanto. Stampare «su null» — o inventare un numero —
          sarebbe peggio del non dirlo.

          ⚠️ CIÒ CHE QUESTO AVVISO NON DÀ, scritto invece che lasciato scoprire:
          col taglio attivo il genitore non ha NESSUNA via d'uscita verso la
          parte più vecchia del periodo. Allargare non porta indietro niente (le
          righe lette sono sempre le N più recenti) e restringere nemmeno: si
          accorcia la finestra, non si scorre. Le due frasi qui fanno la cosa
          giusta non offrendo un comando che non potrebbero mantenere, ma non
          indicano nemmeno l'alternativa che esiste fuori dall'app — chiedere
          alla segreteria.

          NON SI AGGIUNGE ORA, e il motivo non è la dimenticanza:
           · è LATENTE. Perché il taglio morda servono ~500 lezioni nel periodo
             scelto; in tutta la produzione `registro_orario` ne ha meno di cento
             (misurato il 2026-09-19). Oggi questo avviso non lo vede nessuno;
           · costerebbe una chiave nuova in ENTRAMBI i cataloghi, cioè toccare i
             testi di una schermata che questo ramo non ha il mandato di
             riscrivere — e una frase che manda in segreteria è una decisione di
             prodotto, non un dettaglio di resa: la scrive chi risponde a quel
             telefono;
           · e soprattutto esiste già il momento in cui la domanda si porrà
             davvero: il `warn` `finestra-registro-troncata` di
             `api/parent/primaria`, che è l'unico canale da cui si saprà che il
             tetto ha iniziato a mordere ed è provato che parte
             (`__tests__/api/parent-primaria-finestra-registro.test.ts`). Chi
             vedrà comparire quella riga nei log: il rimando alla segreteria va
             aggiunto qui, in questo `<p>`, insieme alla decisione se alzare il
             tetto. */}
      {troncata && finestra && (
        <p
          role="status"
          className="mb-3 rounded-card bg-kidville-info-soft px-3 py-2 font-maven text-xs text-kidville-info-strong"
        >
          {finestra.totale === null
            ? tp('compitiRegistroTroncatoParziale', { lette: finestra.lette })
            : tp('compitiRegistroTroncato', { lette: finestra.lette, totale: finestra.totale })}
        </p>
      )}
      <StatoElenco
        stato={stato}
        testi={testi}
        attivi={attivi}
        onPulisci={() => setMateria('')}
        onRiprova={onRiprova}
        className="py-8"
      />
      {giorni.length > 0 && (
        // ─── IL SEGNALE DI RICARICA QUANDO LE RIGHE CI SONO GIÀ ───────────────
        //
        // Con righe a schermo `decidiStatoElenco` torna `pronto` PRIMA di
        // guardare `caricamento`, ed è la decisione giusta: sostituire l'elenco
        // con uno spinner a ogni cambio di periodo è il difetto peggiore di una
        // barra filtri. Ma `pronto` fa rendere `null` a `StatoElenco`, e senza
        // queste due righe il cambio di periodo non produceva NESSUN segnale:
        // misurato il 2026-09-19, `queryByRole('status')` era `null`, `aria-busy`
        // non esisteva nel DOM, e i compiti del periodo VECCHIO restavano
        // identici sotto un selettore già spostato sul nuovo. Il genitore non
        // poteva distinguere «sta caricando» da «con 90 giorni non c'è niente di
        // più» — la stessa ambiguità che questa bacheca esiste per chiudere.
        //
        // `aria-busy` lo dice a uno screen reader, l'attenuazione a chi guarda.
        // È il contratto che il commento di `decidiStatoElenco`
        // (`lib/ui/filtri/motore.ts`) promette ai propri chiamanti — «le righe
        // restano, attenuate, `aria-busy`» — e che va onorato QUI, perché è qui
        // che le righe si disegnano.
        //
        // ─── IL TERZO CASO: L'ERRORE CON LE RIGHE GIÀ A SCHERMO ───────────────
        //
        // `errore` e non solo `caricamento`, perché i casi sono TRE e non due.
        // `decidiStatoElenco` mette `errore` davanti a tutto
        // (`motore.ts:546-550`), quindi con una lettura fallita DOPO che
        // qualcosa c'era si vede il pannello d'errore con «Riprova» e, sotto,
        // le righe di prima. Misurato il 2026-09-19 (prima lettura riuscita,
        // poi «90 giorni» e risposta fallita): restavano la tendina già su 90,
        // il pannello d'errore, e le righe dei 14 giorni a PIENA opacità, con
        // `aria-busy="false"`. È la stessa ambiguità che queste righe esistono
        // per chiudere, nell'altro ramo: il genitore non distingue «queste sono
        // le righe dei 90» da «queste sono le vecchie dei 14, i 90 non sono mai
        // arrivati». Un elenco che non corrisponde più al comando che lo
        // sovrasta va detto, che la richiesta sia in volo o caduta.
        //
        // ─── PERCHÉ 75 E NON 60 ───────────────────────────────────────────────
        //
        // Misurato il 2026-09-19 con l'aritmetica di `contrasto-token.test.ts`,
        // sulle bande VERE di queste righe (la card è bianca, la riga è
        // `bg-kidville-cream/40` = #FFF9F4, e il testo del compito sta sul
        // riquadro `bg-kidville-yellow/20` = #FFEEC3 dentro la riga):
        //
        //   `text-kidville-ink` #1F3D38      piena   op-60   op-70   op-75
        //     sul riquadro del compito       10,25    3,30    4,32    4,91
        //     sulla riga                     11,28    3,48    4,62    5,31
        //     sul bianco della card          11,78    3,58    4,76    5,46
        //
        // `opacity-60` portava il CONTENUTO a 3,30:1, sotto i 4,5:1 di WCAG
        // 1.4.3 — e non è testo «inattivo» a cui la soglia non si applica:
        // niente `inert`, niente `aria-disabled`, si legge e si seleziona, e
        // dura quanto la rete. Nello stesso lavoro si porta un'etichetta da
        // 3,80 a 6,46 e si attenuava il contenuto a 3,30.
        //
        // `opacity-70` — il valore che il rilievo proponeva — NON basta: sulla
        // riga dà 4,62, ma sul riquadro giallo, che è dove il compito si legge
        // davvero, si ferma a **4,32:1**. È la banda che la misura del rilievo
        // non guardava. `opacity-75` sta sopra soglia su tutte e tre
        // (4,91 · 5,31 · 5,46) e un quarto di attenuazione resta percepibile.
        //
        // ⚠️ RESTA SOTTO, ed è debito dichiarato altrove, non introdotto qui:
        // le intestazioni di giorno e la materia sono `text-kidville-muted`, che
        // sulla riga vale **3,64:1 già a riposo** (il token non è un inchiostro,
        // `globals.css:86-106`) e con l'attenuazione scende a **2,48**. Portarle
        // ad AA vuol dire toccare quelle due classi o il token, che è un altro
        // lavoro: qui non si finge che 75 le salvi.
        //
        // ⚠️ IL 2,48 È RIMISURATO, e prima diceva 2,49 — un centesimo
        // arrotondato in su. Non cambia nessuna conclusione, e va corretto
        // proprio per quello: è una cifra che nessuno riverifica, del tipo che
        // questa corsia ha già trovato falso due volte nello stesso file. Rifà
        // il conto chi legge, con l'aritmetica di
        // `__tests__/a11y/contrasto-token.test.ts` e i token letti da
        // `globals.css`: `muted` #7B8582 al 75% sulla riga (`cream/40` su
        // bianco, #FFF9F4) appiattita anche lei al 75% verso il bianco della
        // card → 2,48:1.
        //
        // ─── E IN ALTO CONTRASTO IL CASO NON SI DÀ, MA NON PER IL MOTIVO CHE
        //     QUI STAVA SCRITTO ─────────────────────────────────────────────
        //
        // La riga di prima diceva «bianco al 75% su nero = 11,42:1». Quel numero
        // è giusto in sé — ed è l'unica cosa che era giusta: su questa bacheca
        // NIENTE diventa bianco su nero. Le due superfici sono le utility
        // `bg-white` e `bg-kidville-cream/40`, che `@theme inline` ha già
        // inlinato a un hex e che quindi NON seguono il rimappaggio dei token
        // dentro `[data-contrast="high"]`: la card resta bianca e la riga resta
        // #FFF9F4 anche in Alto Contrasto.
        //
        // Quello che cambia davvero, misurato il 2026-09-19 leggendo
        // `globals.css` e non ricordandolo: `[data-contrast="high"]
        // .text-kidville-muted { color: #000000 }` (`globals.css:719`) è una
        // regola GLOBALE, senza contenitore davanti. Le intestazioni di giorno e
        // la materia diventano quindi NERE su fondo chiaro — **20,11:1** a
        // riposo e **10,07:1** con l'attenuazione — cioè il caso non si dà
        // perché il token debole viene sostituito, non perché si ribalti il
        // fondo. La conclusione regge, e più di prima: 10,07 è il doppio della
        // soglia.
        //
        // `text-kidville-ink` invece in Alto Contrasto NON cambia affatto: tutte
        // e otto le sue regole sotto `[data-contrast="high"]` sono legate a un
        // contenitore (`kv-news-onbody`, `kv-recon-row`, `kv-recon-dialog`,
        // `kv-admin-nav`, `kv-admin-sheet`, `kv-admin-rowcard`, `kv-come-pagare`,
        // `kv-tab-giallo`) e questa schermata non ne porta nessuno. I 4,91 della
        // tabella qui sopra sono quindi il numero del testo dei compiti in
        // ENTRAMBI i temi, non solo in quello normale — ed è il motivo per cui
        // l'unico posto dove si poteva rompere qualcosa era, appunto, il tema
        // normale.
        <div
          aria-busy={caricamento || errore}
          className={cx('space-y-4', (caricamento || errore) && 'opacity-75 transition-opacity')}
        >
          {giorni.map(([giorno, lez]) => (
            <div key={giorno}>
              <p className="font-maven text-xs font-semibold text-kidville-muted mb-1">{fmtGiorno(giorno, f.locale)}</p>
              <ul className="space-y-1.5">
                {lez.map((l) => (
                  <li key={l.id} className="rounded-card bg-kidville-cream/40 p-2.5">
                    <div className="font-maven text-xs text-kidville-muted">{l.materia || t('compitiLezione')}</div>
                    {l.compiti && <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-sm text-kidville-ink">{l.compiti}</p>}
                    {l.individualizzate.filter((i) => i.compiti).map((i, idx) => (
                      <p key={idx} className="mt-1 rounded bg-kidville-info-soft px-2 py-1 font-maven text-xs text-kidville-info">{t('compitiIndividuali', { value: i.compiti ?? '' })}</p>
                    ))}
                    {/* Gli allegati del compito: la foto della pagina del libro o il
                        PDF della scheda, che dal registro si allegano proprio qui.
                        Erano già nel dato e resi solo in «Lezioni». */}
                    <AllegatiLezione allegati={l.allegati} etichettaVuota={t('lezioniAllegato')} />
                    {l.data_consegna_compiti && (
                      // Data di consegna: unico indicatore (chip), formato it-IT.
                      // Con il datepicker docente la data non va più scritta nel
                      // testo libero, evitando la doppia indicazione.
                      <p className="mt-1.5 inline-flex items-center gap-1 rounded-pill bg-kidville-error-soft px-2 py-0.5 font-maven text-[11px] font-semibold text-kidville-error">
                        <CalendarClock size={11} /> {t('compitiConsegna', { data: intlDateTime(f.locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(l.data_consegna_compiti)) })}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
