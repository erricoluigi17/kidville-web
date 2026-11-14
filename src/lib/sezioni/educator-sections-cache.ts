'use client';

import { creaCachePromesse } from '@/lib/rete/cache-promesse';

/**
 * GET /api/educator-sections — le sezioni assegnate al docente.
 *
 * Stessa storia di `diary/config`: il valore non cambia dentro un ingresso in
 * pagina, ma ogni componente che ne ha bisogno apriva la propria richiesta, e
 * con StrictMode (`next dev`, che è come gira l'E2E in CI) ognuna diventava due.
 *
 * ⚠️ La chiave è l'uuid del docente e non può diventare fissa: le sezioni sono
 * l'elenco dei bambini di cui quel docente è responsabile. Mostrarne una altrui
 * non è un problema di prestazioni, è un problema di isolamento fra sedi.
 */
export interface SezioneDocente {
  /**
   * L'IDENTITÀ della sezione. `name` non lo è: fra sedi si ripete («2 ANNI A»
   * esiste a Giugliano e ad Aversa), e rinominare una sezione lo cambia senza
   * toccare `alunni.classe_sezione` — cioè svuota la classe agli occhi della
   * maestra, con 200 e senza un log (misurato il 2026-09-02 su cinque sezioni
   * di Giugliano). `/api/educator-sections` lo restituisce da sempre: era già
   * qui, e nessuno lo usava.
   *
   * ⚠️ Facoltativo perché la risposta ha anche una forma vecchia (`sectionNames`,
   * i soli nomi) che l'id non ce l'ha. Chi lo usa manda `sectionId` solo se c'è,
   * e le route accettano entrambe le strade.
   */
  id?: string;
  name: string;
  school_type: string | null;
  /**
   * La SEDE della sezione (2026-09-28). `/api/educator-sections` la manda da sempre; serve al diario,
   * perché le routine sono della sede della sezione, non di quella principale di chi compila (una
   * Direzione su più sedi apriva una sezione di Aversa con le routine di Giugliano). Facoltativa
   * per la forma vecchia della risposta.
   */
  scuolaId?: string;
  /** Una classe di un anno `in_chiusura` o `chiuso` (con `passati`): si apre, non si scrive (L6-1). */
  solaLettura?: boolean;
  /** `etichetta_breve` dell'anno («2026/27») e il suo stato (`corrente`, `in_chiusura`, `chiuso`). */
  annoEtichetta?: string | null;
  annoStato?: string | null;
  /** Primo e ultimo giorno dell'anno di quella classe (`YYYY-MM-DD`): servono all'appello in sola lettura e alla frase «arrivano con l'inizio dell'anno». */
  annoInizio?: string | null;
  annoFine?: string | null;
}

/** «TEST Infanzia · 2026/27»: l'anno accanto al nome, perché la stessa classe esiste in più anni. */
export function nomeConAnno(s: Pick<SezioneDocente, 'name' | 'annoEtichetta'>, formato: (nome: string, anno: string) => string): string {
  return s.annoEtichetta ? formato(s.name, s.annoEtichetta) : s.name;
}

export interface EducatorSectionsRisposta {
  sections?: SezioneDocente[];
  /** Forma vecchia della risposta: solo i nomi. */
  sectionNames?: string[];
}

const SUFFISSO_PASSATI = '|passati';

async function caricaSezioni(chiave: string): Promise<EducatorSectionsRisposta | null> {
  const passati = chiave.endsWith(SUFFISSO_PASSATI);
  const userId = passati ? chiave.slice(0, -SUFFISSO_PASSATI.length) : chiave;
  try {
    const res = await fetch(`/api/educator-sections?userId=${userId}${passati ? '&passati=1' : ''}`);
    if (!res.ok) return null;
    return (await res.json()) as EducatorSectionsRisposta;
  } catch {
    return null;
  }
}

const cache = creaCachePromesse(caricaSezioni);

/**
 * L'elenco SCADE, come quello dei figli (L6-4): un docente con l'app aperta a cavallo del passaggio d'anno non vedeva la
 * classe nuova né quella vecchia finché non ricaricava. Dentro la finestra la richiesta resta una sola (deduplica).
 */
const DURATA_ELENCO_SEZIONI_MS = 30_000;
const lettiAlle = new Map<string, number>();
/** Ultima lettura RIUSCITA per chiave: alla ripresa la rete spesso non è tornata, e il vecchio si sostituisce solo con un nuovo riuscito. */
const ultimoBuono = new Map<string, EducatorSectionsRisposta>();

/** Sezioni del docente indicato. `null` = non determinabile (e senza una lettura precedente riuscita). */
export async function fetchEducatorSections(
  userId: string | null,
  opzioni: { passati?: boolean } = {},
): Promise<EducatorSectionsRisposta | null> {
  const chiave = `${userId ?? ''}${opzioni.passati ? SUFFISSO_PASSATI : ''}`;
  const ora = Date.now();
  const letto = lettiAlle.get(chiave);
  if (letto === undefined || ora - letto > DURATA_ELENCO_SEZIONI_MS) {
    if (letto !== undefined) cache.invalida(chiave);
    lettiAlle.set(chiave, ora);
  }
  const risposta = await cache.leggi(chiave);
  if (risposta) {
    ultimoBuono.set(chiave, risposta);
    return risposta;
  }
  return ultimoBuono.get(chiave) ?? null;
}

/** Alla ripresa dell'app: la prossima lettura riparte dal server, ma l'ultima riuscita resta per il caso senza rete. */
export function scadiEducatorSections(): void {
  lettiAlle.clear();
  cache.invalida();
}

/** Svuota la cache (cambio identità, e fra un test e l'altro): butta anche l'ultima lettura riuscita. */
export function invalidaEducatorSectionsCache(userId?: string): void {
  if (userId === undefined) {
    lettiAlle.clear();
    ultimoBuono.clear();
    cache.invalida();
    return;
  }
  for (const chiave of [userId, `${userId}${SUFFISSO_PASSATI}`]) {
    lettiAlle.delete(chiave);
    ultimoBuono.delete(chiave);
    cache.invalida(chiave);
  }
}

/**
 * Normalizza la risposta in un elenco di sezioni, qualunque forma abbia.
 * Vive qui, con la richiesta, perché era già duplicata parola per parola in
 * più pagine — e una regola valida per due strade deve stare in un posto solo.
 */
export function sezioniDallaRisposta(risposta: EducatorSectionsRisposta | null): SezioneDocente[] {
  if (!risposta) return [];
  if (Array.isArray(risposta.sections)) return risposta.sections;
  if (Array.isArray(risposta.sectionNames)) {
    return risposta.sectionNames.map((name) => ({ name, school_type: null }));
  }
  return [];
}
