'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { creaCachePromesse } from '@/lib/rete/cache-promesse';
import { areaFromPath } from './active-role';
import { logClient, nomeErrore } from '@/lib/logging/client';

/* ════════════════════════════════════════════════════════════════════════════
 * I PROFILI DELLA PERSONA, letti UNA volta per sessione.
 *
 * ─── PERCHÉ UNA CACHE E NON UNA FETCH PER COMPONENTE ────────────────────────
 * Questo dato serve a QUATTRO posti che montano insieme nello stesso
 * caricamento: la voce «Cambia profilo» in ognuno dei tre menu (genitore,
 * docente, direzione) e il chip della veste nella AppBar. Senza deduplica sono
 * quattro `GET /api/me` identiche a millisecondi di distanza — otto in `next
 * dev`, dove StrictMode invoca gli effect due volte. È il difetto T11-F3, già
 * misurato e già risolto altrove con la stessa primitiva (`useTeacherGradi`).
 *
 * ─── LA CHIAVE È FISSA, E QUI VA BENE (altrove no) ──────────────────────────
 * `creaCachePromesse` avverte: «la chiave è l'IDENTITÀ; una chiave fissa
 * mostrerebbe a un genitore i figli di un altro». Su `/api/me` la chiave È il
 * cookie di sessione — la route non prende parametri — e non esiste nessun modo
 * di chiederla «per conto di un altro». Il cambio di persona passa da
 * `doLogout`, che fa `window.location.href = '/auth/login'`: una navigazione
 * dura, che ricarica il documento e con esso questo modulo. La cache non
 * sopravvive a un cambio di utente.
 * ════════════════════════════════════════════════════════════════════════════ */

/** Un profilo come lo espone `GET /api/me`: il ruolo reale e la sua area di casa. */
export interface Profilo {
  ruolo: string;
  area: string;
}

/** L'identità è il cookie di sessione: una chiave sola, e la nomina per quello che è. */
const CHIAVE_SESSIONE = 'sessione';

/** La veste scelta, come la scrive `cambiaRuoloAttivo` (e il picker del login). */
const CHIAVE_RUOLO = 'kv_user_role';

/**
 * `null` = non lo so (rete giù, route non-ok, corpo illeggibile). NON è `[]`:
 * `creaCachePromesse` scarta il `null` dalla cache, così il mount successivo
 * ritenta invece di congelare un «non lo so» per tutta la vita della pagina.
 */
const cacheProfili = creaCachePromesse<Profilo[] | null>(async () => {
  let res: Response;
  try {
    res = await fetch('/api/me');
  } catch (errore) {
    // Un `catch` che non logga è un bug (AGENTS.md, regola 6). Qui l'errore È
    // ignorabile per il PRODOTTO — lo switch semplicemente non compare, e per
    // 617 utenti su 622 non sarebbe comparso comunque — ma non per chi diagnostica:
    // senza questa riga, «il comando per cambiare veste non c'è» e «/api/me non
    // risponde» sarebbero lo stesso identico sintomo.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `profili-non-letti — http=nessuno errore=${nomeErrore(errore)}`,
    });
    return null;
  }
  if (!res.ok) {
    // ⚠️ `stato` NON viene passato, e non è una dimenticanza: `livelloEvento`
    // (`logging/client.ts`) applica `livelloFetch` a qualunque evento che porti uno
    // `stato` fra 400 e 599, e un 401 non è fra le `ANOMALIE_4XX` → l'evento
    // verrebbe **scartato in silenzio**. Lo status vive nel messaggio, dove nessun
    // filtro lo tocca. È la stessa trappola documentata su `registraCredenzialiRifiutate`.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `profili-non-letti — http=${res.status}`,
    });
    return null;
  }
  try {
    const dato = (await res.json()) as { profili?: unknown };
    return Array.isArray(dato?.profili) ? (dato.profili as Profilo[]) : [];
  } catch (errore) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `profili-non-letti — corpo illeggibile errore=${nomeErrore(errore)}`,
    });
    return null;
  }
});

/** I profili della sessione corrente, deduplicati fra tutti i consumatori. */
export function leggiProfili(): Promise<Profilo[] | null> {
  return cacheProfili.leggi(CHIAVE_SESSIONE);
}

/** Butta la cache. Serve ai test — e a chiunque debba ricaricare i profili a mano. */
export function invalidaProfiliCache(): void {
  cacheProfili.invalida();
}

function ruoloMemorizzato(): string | null {
  try {
    return window.localStorage.getItem(CHIAVE_RUOLO);
  } catch {
    // Storage negato (modalità privata, quota): non è un guasto e non ha niente da
    // dire. Il ripiego è il PERCORSO, che è comunque la fonte migliore delle due.
    return null;
  }
}

export interface StatoProfili {
  /** I profili REALI della persona (da `utenti` + ponte `parents`). */
  profili: Profilo[];
  /** La veste in cui si sta guardando questa schermata; `null` se ambigua. */
  ruoloAttivo: string | null;
  /** `false` finché `/api/me` non ha risposto: prima di allora non si mostra nulla. */
  pronta: boolean;
}

/**
 * I profili + LA VESTE ATTIVA — e la veste attiva la decide il PERCORSO.
 *
 * ─── PERCHÉ NON `kv_user_role` PER PRIMO ────────────────────────────────────
 * Il chip risponde a una domanda sola: «in che veste sto guardando QUESTA
 * schermata?». Se `localStorage` dicesse «genitore» mentre la AppBar è montata
 * su `/teacher`, il chip mentirebbe — e mentirebbe proprio a chi lo guarda per
 * non sbagliarsi. Il percorso è ciò che l'utente ha davanti agli occhi, e la
 * guardia d'area (`decideAreaAccess`) garantisce già che sia un'area concessa
 * dalla veste attiva: le due fonti non possono divergere a lungo.
 *
 * ─── QUANDO IL PERCORSO NON BASTA ───────────────────────────────────────────
 * Lo staff di gestione (admin/coordinator/segreteria) può aprire anche
 * `/teacher` (eccezione dichiarata in `AREE_PER_RUOLO`), ma la sua area di CASA
 * è `admin`: su `/teacher/attendance` nessun profilo combacia con l'area del
 * percorso. Lì si ricade su `kv_user_role`, e con la stessa regola di
 * `risolviRuoloAttivo`: **vale solo se nomina un ruolo che la persona ha
 * davvero**. Un valore stantìo o estraneo non concede niente — al massimo lascia
 * la veste ambigua, che è una risposta onesta.
 *
 * `kv_user_role` si legge dentro l'effetto e non in render: sul server quello
 * storage non esiste, e leggerlo durante il primo render darebbe HTML diverso
 * fra server e browser. Prima che l'effetto giri, `pronta` è `false` e chi usa
 * questo hook non disegna niente — quindi l'HTML combacia per costruzione.
 */
export function useProfili(): StatoProfili {
  const pathname = usePathname();
  const [profili, setProfili] = useState<Profilo[]>([]);
  const [memorizzato, setMemorizzato] = useState<string | null>(null);
  const [pronta, setPronta] = useState(false);

  useEffect(() => {
    let vivo = true;
    void leggiProfili().then((letti) => {
      if (!vivo) return;
      setProfili(letti ?? []);
      setMemorizzato(ruoloMemorizzato());
      setPronta(true);
    });
    return () => {
      vivo = false;
    };
  }, []);

  const area = areaFromPath(pathname ?? '');
  const daPercorso = area ? (profili.find((p) => p.area === area)?.ruolo ?? null) : null;
  const daRicordo = memorizzato && profili.some((p) => p.ruolo === memorizzato) ? memorizzato : null;

  return { profili, ruoloAttivo: daPercorso ?? daRicordo, pronta };
}
