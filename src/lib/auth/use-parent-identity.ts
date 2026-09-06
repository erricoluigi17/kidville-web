'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { logClient } from '@/lib/logging/client';
import { creaCachePromesse } from '@/lib/rete/cache-promesse';
import { useSessionIdentity } from './use-session-identity';
import { getCurrentStudentId } from './current-user';
// Solo il TIPO: `import type` sparisce in compilazione, quindi il modulo server
// (che importa il logger del server e i tipi di `@supabase/supabase-js`) non
// entra nel bundle del browser. Il vocabolario dei motivi però resta uno solo —
// due unioni parallele si sarebbero disallineate al primo motivo nuovo.
import type { MotivoFiglioNascosto } from '@/lib/alunni/attivo';

/**
 * Anagrafica minima di un figlio, come la restituisce /api/parent/students.
 * `ChildSwitcher` ha bisogno di nome, cognome e sezione: senza, dovrebbe rifare
 * per conto suo la stessa GET che l'identità ha appena fatto.
 */
export interface FiglioAnagrafica {
  id: string;
  nome: string;
  cognome: string;
  classe_sezione: string | null;
  /**
   * La sede del bambino. Additivi e opzionali, perché un genitore può avere
   * figli in DUE plessi: senza questi due campi il selettore mostra due chip
   * indistinguibili quando le sezioni si chiamano uguale — e «2 ANNI» esiste
   * davvero in più plessi. La GET li restituisce già
   * (`api/parent/students/route.ts:39-69`): qui venivano scartati dal mapping.
   */
  scuola_id?: string | null;
  scuola_nome?: string | null;
}

export interface ParentIdentity {
  parentId: string | null;
  studentId: string | null;
  /**
   * Elenco COMPLETO dei figli del genitore (m3): serve al feed unificato degli
   * avvisi, che mostra le comunicazioni di TUTTI i figli, non solo del primo.
   * `studentId` resta il figlio "attivo" (primo/URL) per i consumatori storici.
   * `[]` quando la lista non è (ancora) determinabile — nessun figlio o fetch fallita.
   */
  figliIds: string[];
  /**
   * «HO DEI FIGLI, MA NESSUNO È ANCORA VISIBILE» — che non è «non ho figli».
   *
   * Vero quando il backend ha trovato dei legami di famiglia ma il filtro li ha
   * tolti tutti: bambino senza classe, ritirato, archiviato. Misurato in
   * produzione il 2026-09-05: sono 4 account genitore. Senza questo campo la
   * loro app è identica a quella di chi non ha proprio figli — cioè vuota, e
   * senza una frase che dica cosa fare. Resta `false` finché `ready` non è vero.
   */
  inAttesa: boolean;
  /**
   * PERCHÉ non è visibile nessuno — perché «in attesa» era vero per 3 famiglie
   * su 4 e falso per la quarta.
   *
   * Misurato in produzione il 2026-09-06: dei 4 account senza figli visibili, 3
   * hanno l'unico figlio senza sezione e 1 ce l'ha ARCHIVIATO. A quella famiglia
   * la frase «appena la classe è assegnata qui compare tutto» prometteva una
   * classe che non arriverà mai. `null` quando non c'è niente da spiegare, o
   * quando il server non manda il campo (client più nuovo del server, o
   * viceversa): là si ricade sulla frase generica, cioè sul comportamento di
   * ieri.
   */
  motivoAssenza: MotivoFiglioNascosto | null;
  ready: boolean; // false finché l'auto-resolve non è completato
}

/** Esito della rivalidazione di uno studentId "noto" contro i figli reali. */
export interface RivalidazioneFiglio {
  /** L'id alunno da usare dopo la rivalidazione. */
  studentId: string | null;
  /** Scrivere kv_student_id = studentId nel localStorage. */
  aggiornaCache: boolean;
  /** Rimuovere kv_student_id dal localStorage: era stantio/altrui/inesistente. */
  rimuoviCache: boolean;
}

/**
 * Decisione PURA di rivalidazione. Dato l'id "noto" (URL/localStorage) e la
 * lista dei figli REALI del genitore, stabilisce quale alunno usare e come
 * toccare la cache.
 *
 * `figliIds === null` significa "lista non determinabile" (fetch fallita, rete
 * giù, endpoint 4xx/5xx): si degrada al noto SENZA toccare la cache — una cache
 * buona non va cancellata per un blip di rete. È il punto che impedisce che il
 * fix diventi un nuovo modo di perdere l'identità offline.
 */
export function decidiFiglioRivalidato(
  known: string | null,
  figliIds: string[] | null,
): RivalidazioneFiglio {
  // Lista non determinabile: degrada al noto, cache intatta.
  if (figliIds === null) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  const primo = figliIds[0] ?? null;

  // Il noto è un figlio reale: resta com'è, nessuna scrittura.
  if (known && figliIds.includes(known)) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  // Il noto NON è tra i figli (cache stantia, URL altrui, alunno TEST ricreato):
  // butta la cache e passa al primo figlio. È il bug del 403 deterministico
  // della mensa: qui si auto-guarisce per TUTTE le pagine genitore.
  if (known) {
    return { studentId: primo, aggiornaCache: primo !== null, rimuoviCache: true };
  }
  // Nessun noto: primo figlio (comportamento storico), aggiorna la cache.
  return { studentId: primo, aggiornaCache: primo !== null, rimuoviCache: false };
}

export interface EsitoFigli {
  /** I figli da mostrare: già filtrati dal server. */
  figli: FiglioAnagrafica[];
  /** L'elenco è vuoto perché il filtro ha tolto tutto, non perché non c'è nessuno. */
  inAttesa: boolean;
  /** Quale dei tre motivi, per scegliere la frase. `null` = frase generica. */
  motivoAssenza: MotivoFiglioNascosto | null;
}

/** I tre soli valori che il campo può portare: il resto della rete non è un motivo. */
const MOTIVI_ASSENZA: readonly MotivoFiglioNascosto[] = ['archiviato', 'ritirato', 'senza-sezione'];

/**
 * Il motivo, se il corpo ne porta uno DEI TRE. Una stringa qualunque diventa
 * `null` e riporta alla frase generica: un campo nuovo non deve poter mandare a
 * schermo un ramo che nessuno ha scritto.
 *
 * Esportata perché la stessa risposta la legge anche `parent/modulistica`, che
 * chiama `/api/parent/students` per conto proprio (le serve l'anagrafica intera
 * dei figli, non i soli id): due letture scritte a mano si sarebbero fidate di
 * due insiemi di stringhe diversi.
 */
export function leggiMotivoAssenza(v: unknown): MotivoFiglioNascosto | null {
  return typeof v === 'string' && (MOTIVI_ASSENZA as readonly string[]).includes(v)
    ? (v as MotivoFiglioNascosto)
    : null;
}

/**
 * «NON È ANCORA VISIBILE» oppure «NON C'È PIÙ»: la sola distinzione che cambia
 * la frase, e sta qui perché la fanno in DUE — la home e la modulistica. Scritta
 * due volte, il giorno che si sposta un motivo se ne aggiorna una sola, e
 * l'altra continua a promettere una classe a una famiglia che non l'aspetta.
 *
 * `senza-sezione` è un bambino ISCRITTO che aspetta la classe: per lui la
 * promessa è vera. `ritirato` e `archiviato` no, e per loro non c'è nemmeno un
 * self-service da offrire — `alunnoNonStampabile`
 * (`@/lib/prestampati/prefill.ts`) rifiuta con 409 «non è più fra gli iscritti»
 * già da prima di questo lavoro.
 */
export function eMotivoNonPiuIscritto(motivo: MotivoFiglioNascosto | null | undefined): boolean {
  return motivo === 'ritirato' || motivo === 'archiviato';
}

/**
 * La richiesta vera. Non lancia mai: `null` significa "non determinabile"
 * (rete giù, endpoint non-ok, corpo inatteso) e il chiamante degrada al noto.
 */
async function caricaFigli(parentId: string): Promise<EsitoFigli | null> {
  let res: Response;
  try {
    res = await fetch(`/api/parent/students?userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    });
  } catch {
    // Rete non disponibile: la rivalidazione è best-effort. Si degrada al noto
    // (ritorna null, la cache resta valida). Non si logga: l'offline è uno stato
    // normale e non è l'incidente che ci interessa osservare qui.
    return null;
  }
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  if (!body || !Array.isArray(body.data)) return null;
  const figli = (body.data as Array<Record<string, unknown>>)
    .filter((x) => typeof x?.id === 'string')
    .map((x) => ({
      id: x.id as string,
      nome: typeof x.nome === 'string' ? x.nome : '',
      cognome: typeof x.cognome === 'string' ? x.cognome : '',
      classe_sezione: typeof x.classe_sezione === 'string' ? x.classe_sezione : null,
      scuola_id: typeof x.scuola_id === 'string' ? x.scuola_id : null,
      scuola_nome: typeof x.scuola_nome === 'string' ? x.scuola_nome : null,
    }));
  // `in_attesa` è additivo: un backend che non lo manda (o una risposta in cache
  // vecchia) vale `false`, cioè il comportamento di prima.
  const inAttesa = figli.length === 0 && body.in_attesa === true;
  // Il motivo vale SOLO dentro `inAttesa`: fuori di lì non c'è nessuna schermata
  // da scegliere, e un motivo che sopravvive a un elenco pieno è solo un campo
  // che aspetta di essere letto per sbaglio.
  return { figli, inAttesa, motivoAssenza: inAttesa ? leggiMotivoAssenza(body.motivo_assenza) : null };
}

/**
 * Deduplica: la chiave è il **parentId**, mai una chiave fissa. Home,
 * `useChildSchoolType` (due volte: home e BottomNav) e `ChildSwitcher` montano
 * insieme e chiedevano cinque volte lo stesso elenco; ora la richiesta è una e
 * chi arriva mentre è in volo si attacca a quella. Su esito non determinabile
 * la voce viene rimossa: un blip di rete non congela un `null` per sempre.
 */
const cacheFigli = creaCachePromesse(caricaFigli);

/**
 * L'esito COMPLETO della lettura: i figli e il perché di un elenco vuoto.
 * `null` = non determinabile (rete giù, endpoint non-ok, corpo inatteso).
 */
export function fetchEsitoFigli(parentId: string): Promise<EsitoFigli | null> {
  return cacheFigli.leggi(parentId);
}

/**
 * Elenco COMPLETO dei figli del genitore (anagrafica), dalla cache condivisa.
 * `null` = non determinabile. Firma invariata: `ChildSwitcher` legge da qui.
 */
export async function fetchFigli(parentId: string): Promise<FiglioAnagrafica[] | null> {
  const esito = await fetchEsitoFigli(parentId);
  return esito ? esito.figli : null;
}

/**
 * Butta l'elenco in cache: al cambio di figlio/di account il prossimo lettore
 * deve ripartire dal backend, non da ciò che era vero per il genitore prima.
 * Senza argomento svuota tutto (è anche ciò che serve fra un test e l'altro).
 */
export function invalidaFigliCache(parentId?: string): void {
  cacheFigli.invalida(parentId);
}

/**
 * Chiede al backend gli id dei figli del genitore. Ritorna la lista, oppure
 * `null` se NON determinabile (rete giù, endpoint non-ok, corpo inatteso): il
 * chiamante degrada al noto. Non lancia mai.
 */
export async function fetchFigliIds(parentId: string): Promise<string[] | null> {
  const figli = await fetchFigli(parentId);
  return figli ? figli.map((f) => f.id) : null;
}

/**
 * Rivalida uno studentId "noto" contro i figli reali del genitore.
 * Combina fetch + decisione pura. Senza `parentId` non può rivalidare → degrada
 * al noto senza chiamare il backend.
 */
export async function rivalidaFiglio(
  known: string | null,
  parentId: string | null,
): Promise<RivalidazioneFiglio> {
  if (!parentId) {
    return { studentId: known, aggiornaCache: false, rimuoviCache: false };
  }
  const figliIds = await fetchFigliIds(parentId);
  return decidiFiglioRivalidato(known, figliIds);
}

/**
 * Risolve parentId e studentId per le pagine genitore.
 * parentId viene dall'identità di sessione (URL → localStorage → /api/me →
 * null+redirect login, vedi useSessionIdentity).
 *
 * studentId: URL o localStorage danno un id "noto", che NON è più preso per buono
 * a scatola chiusa — viene RIVALIDATO contro i figli reali del genitore
 * (/api/parent/students). Se il noto non è tra i figli (cambio account senza
 * logout, URL stantio, alunno TEST ricreato) la cache viene ripulita e si passa
 * al primo figlio; se la fetch fallisce si degrada al noto (nessun blocco).
 * Nessun fallback demo (M4).
 */
export function useParentIdentity(): ParentIdentity {
  const session = useSessionIdentity();
  const searchParams = useSearchParams();
  // Inizializza solo dall'URL per evitare hydration mismatch (localStorage non
  // è disponibile durante SSR). Il useEffect risolve/rivalida dopo il mount.
  const fromUrl = searchParams.get('id');
  const [studentId, setStudentId] = useState<string | null>(fromUrl);
  const [figliIds, setFigliIds] = useState<string[]>([]);
  const [inAttesa, setInAttesa] = useState<boolean>(false);
  const [motivoAssenza, setMotivoAssenza] = useState<MotivoFiglioNascosto | null>(null);
  const [studentReady, setStudentReady] = useState<boolean>(false);

  useEffect(() => {
    if (!session.ready) return;
    const parentId = session.userId;
    let cancelled = false;

    const resolve = async () => {
      // `known`: URL esplicita o localStorage. NB: getCurrentStudentId, se l'id
      // è in URL, lo persiste in cache — lo rivalidiamo comunque subito dopo.
      const known = getCurrentStudentId(searchParams);

      // UNA sola fetch per mount: prende la lista COMPLETA dei figli (m3, feed
      // unificato avvisi) e da quella deriva anche il singolo `studentId` con la
      // decisione pura. Non si passa più da `rivalidaFiglio` per non fare due giri
      // (la lista servirebbe comunque, e sarebbe una seconda chiamata a /students).
      const lettura = parentId ? await fetchEsitoFigli(parentId) : null;
      const figli = lettura ? lettura.figli.map((f) => f.id) : null;
      const esito = decidiFiglioRivalidato(known, figli);
      if (cancelled) return;

      if (esito.rimuoviCache) {
        try { localStorage.removeItem('kv_student_id'); } catch { /* ignore */ }
        // Breadcrumb: cache stantia/altrui rilevata e corretta. È esattamente il
        // log che avrebbe reso visibile il 403 ricorrente della mensa. Solo uuid
        // (nessun nome/email): passano la redazione.
        if (known) {
          logClient({
            livello: 'warn',
            evento: 'react',
            messaggio: `parent-identity: studentId noto non tra i figli del genitore → autorecupero (noto=${known} genitore=${parentId ?? 'nessuno'} nuovo=${esito.studentId ?? 'nessuno'})`,
          });
        }
      }
      if (esito.aggiornaCache && esito.studentId) {
        try { localStorage.setItem('kv_student_id', esito.studentId); } catch { /* ignore */ }
      }

      setStudentId(esito.studentId);
      setFigliIds(figli ?? []);
      // ⚠️ Solo su una lettura RIUSCITA. Con `lettura === null` (rete giù) la lista
      // è «non determinabile» e si degrada al noto: mostrare «l'iscrizione è in
      // lavorazione» a chi è semplicemente offline sarebbe una bugia, e per giunta
      // manderebbe una famiglia in segreteria per un problema di rete.
      setInAttesa(lettura !== null && lettura.inAttesa);
      setMotivoAssenza(lettura !== null ? lettura.motivoAssenza : null);
      setStudentReady(true);
    };
    void resolve();
    return () => { cancelled = true; };
  }, [session.ready, session.userId, searchParams]);

  return { parentId: session.userId, studentId, figliIds, inAttesa, motivoAssenza, ready: session.ready && studentReady };
}
