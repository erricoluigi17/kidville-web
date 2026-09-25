'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { GIORNI_CESTINO_REGISTRO } from '@/lib/primaria/cestino-registro';
import { BottoneSblocca, puoSbloccare, type BersaglioSblocco } from '@/components/features/primaria/BottoneSblocca';

/**
 * ELIMINARE DAL REGISTRO DI CLASSE DELLA PRIMARIA — la propria firma, o la lezione.
 *
 * Spec 2026-09-24, «2 Primaria» e «Decisioni aggiunte prima del lancio»:
 *  · chi ha firmato elimina la PROPRIA firma; se era l'UNICA, sparisce la lezione
 *    (argomento, compiti) e i suoi allegati vanno nel cestino;
 *  · Segreteria e Direzione eliminano la lezione INTERA.
 *
 * Il server è `DELETE /api/primaria/registro` (`?firmaId=` oppure `?registroId=`):
 * è lui a decidere chi e fino a quando (`@/lib/primaria/permesso-voce`). Qui si
 * sceglie soltanto COSA offrire, per non mettere sotto il dito un bottone che
 * risponderebbe 403.
 *
 * ─── LA VOCE BLOCCATA ────────────────────────────────────────────────────────
 * La GET del registro dichiara il termine (`termine`, e `bloccata` su righe e
 * firme): la riga bloccata mostra il messaggio e, alla sola Direzione, «Sblocca»
 * (`AvvisoVoceBloccata`) già al caricamento. Il 423 (`VOCE_BLOCCATA`, con
 * `giorniLimite`) resta il ripiego, quando lo stato è cambiato dopo la lettura:
 * la modale si chiude e la riga si segna bloccata. Lo sblocco sta sulla RIGA
 * e non dentro la modale di firma apposta: quella ha il velo sfocato come antenato,
 * e su Android un antenato con `backdrop-filter` toglie la modale dello sblocco
 * dall'albero di accessibilità (vedi `Modal`).
 */

/**
 * Chi può eliminare la lezione INTERA: lo stesso elenco di `RUOLI_LEZIONE_INTERA`
 * in `api/primaria/registro/route.ts`. Qui è solo per non offrire il bottone agli
 * altri: il gate vero resta sul server (403 `LEZIONE_ELIMINA_SOLO_STAFF`).
 */
const RUOLI_ELIMINA_LEZIONE = new Set(['segreteria', 'admin', 'coordinator']);

/** Vero se questo ruolo può eliminare la lezione intera. Fail-closed su un ruolo ignoto. */
export function puoEliminareLezione(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_ELIMINA_LEZIONE.has(ruolo);
}

/** Che cosa si sta per eliminare, con quello che la conferma deve dire. */
export type Eliminazione =
  | {
      modo: 'firma';
      firmaId: string;
      /** L'ora (1..8) della riga: serve alla pagina per segnare la riga bloccata. */
      ora: number;
      /** La firma è l'UNICA della lezione: eliminandola sparisce la lezione. */
      unica: boolean;
      /** Gli allegati della lezione (che vanno nel cestino se la lezione sparisce). */
      nAllegati: number;
    }
  | {
      modo: 'lezione';
      registroId: string;
      ora: number;
      nFirme: number;
      nAllegati: number;
    };

/** La URL della DELETE: una sola chiave fra `firmaId` e `registroId`, mai entrambe (lo zod le rifiuta). */
export function urlEliminazione(e: Eliminazione, userId: string): string {
  const q = new URLSearchParams(
    e.modo === 'firma' ? { firmaId: e.firmaId, userId } : { registroId: e.registroId, userId },
  );
  return `/api/primaria/registro?${q.toString()}`;
}

/**
 * Il bersaglio dello sblocco per una voce del registro rifiutata con 423.
 * Firma → la firma; lezione → la riga di registro (`entitaTipo: 'registro'`).
 */
export function bersaglioDi(e: Eliminazione): BersaglioSblocco {
  return e.modo === 'firma'
    ? { modo: 'voce', entitaTipo: 'firma', entitaId: e.firmaId }
    : { modo: 'voce', entitaTipo: 'registro', entitaId: e.registroId };
}

/** `giorniLimite` dal corpo di un 423, se c'è ed è un numero vero. */
export function giorniLimiteDa(corpo: unknown): number | null {
  const g = (corpo as { giorniLimite?: unknown } | null)?.giorniLimite;
  return typeof g === 'number' && Number.isFinite(g) ? g : null;
}

export type EsitoEliminazione =
  | { ok: true; eliminata: 'firma' | 'lezione'; allegatiNelCestino: number }
  | { ok: false; bloccata: true; giorniLimite: number | null }
  | { ok: false; bloccata: false; messaggio: string; ricarica: boolean };

/** La rotta della PAGINA (è il luogo dell'incidente, non la fetch): vedi `EventoClient.route`. */
function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/**
 * Manda la DELETE e ne legge l'esito. Non lancia mai: la rete che cade, il corpo
 * non JSON e il rifiuto del server hanno ciascuno il suo ramo, e il suo log.
 */
export async function inviaEliminazione(
  e: Eliminazione,
  userId: string,
  testi: { fallback: string; rete: string },
): Promise<EsitoEliminazione> {
  let res: Response;
  try {
    res = await fetch(urlEliminazione(e, userId), { method: 'DELETE', headers: { 'x-user-id': userId } });
  } catch (err) {
    // Un `catch` che non logga è un bug (AGENTS, regola 6): è la rete che manca.
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `registro-${e.modo}-eliminazione-non-inviata: ${nomeErrore(err)}`,
      route: paginaCorrente(),
      stato: 0,
    });
    return { ok: false, bloccata: false, messaggio: testi.rete, ricarica: false };
  }
  let corpo: unknown = null;
  try {
    corpo = await res.json();
  } catch (errJson) {
    // Un 502 o un 413 rispondono HTML: si prosegue col testo generico, non in silenzio.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `registro-${e.modo}-eliminazione-risposta-non-json: ${nomeErrore(errJson)}`,
      route: paginaCorrente(),
      stato: res.status,
    });
  }
  if (res.status === 423) {
    // Oltre il termine: non è un guasto, è la regola — `warn`, non `error`.
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `registro-${e.modo}-eliminazione-bloccata`,
      route: paginaCorrente(),
      stato: 423,
    });
    return { ok: false, bloccata: true, giorniLimite: giorniLimiteDa(corpo) };
  }
  if (!res.ok || (corpo as { success?: boolean } | null)?.success === false) {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `registro-${e.modo}-eliminazione-rifiutata`,
      route: paginaCorrente(),
      stato: res.status,
    });
    return {
      ok: false,
      bloccata: false,
      // Codice → catalogo nella lingua dell'interfaccia; mai `error.message` grezzo.
      messaggio: messaggioDaCorpo(corpo, testi.fallback),
      // 403/404: lo stato a schermo era vecchio (firma sparita, ruolo cambiato).
      ricarica: res.status === 403 || res.status === 404,
    };
  }
  const dati = (corpo as { data?: { eliminata?: unknown; allegatiNelCestino?: unknown } } | null)?.data;
  const n = dati?.allegatiNelCestino;
  return {
    ok: true,
    eliminata: dati?.eliminata === 'firma' ? 'firma' : 'lezione',
    allegatiNelCestino: typeof n === 'number' && Number.isFinite(n) ? n : 0,
  };
}

export interface ModaleEliminaRegistroProps {
  eliminazione: Eliminazione;
  userId: string;
  onChiudi: () => void;
  /** Eliminazione riuscita: la pagina mostra l'esito e rilegge il registro. */
  onEliminata: (esito: { eliminata: 'firma' | 'lezione'; allegatiNelCestino: number }) => void;
  /** 423: la pagina segna la riga come bloccata (messaggio + «Sblocca» alla Direzione). */
  onBloccata: (giorniLimite: number | null) => void;
  /** Rifiuto che rende vecchio lo stato a schermo: messaggio sopra la griglia e rilettura. */
  onRifiutata: (messaggio: string) => void;
}

/** La conferma dell'eliminazione: firma propria oppure lezione intera. */
export function ModaleEliminaRegistro({
  eliminazione,
  userId,
  onChiudi,
  onEliminata,
  onBloccata,
  onRifiutata,
}: ModaleEliminaRegistroProps) {
  const t = useTranslations('teacherPrimaria');
  const idBase = useId();
  const titoloId = `${idBase}-titolo`;
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);

  const firma = eliminazione.modo === 'firma';
  // Sparisce la lezione: sempre con «Elimina lezione», con la firma solo se è l'unica.
  const sparisceLezione = !firma || eliminazione.unica;
  const titolo = firma ? t('registroEliminaFirmaTitolo') : t('registroEliminaLezioneTitolo');

  const chiudi = () => {
    if (inVolo) return;
    onChiudi();
  };

  const conferma = async () => {
    // `aria-disabled` e non `disabled` (vedi `Btn`): la guardia sta qui.
    if (inVolo) return;
    setInVolo(true);
    setErrore('');
    const esito = await inviaEliminazione(eliminazione, userId, {
      fallback: t('registroEliminaErrore'),
      rete: t('comuneErroreRete'),
    });
    setInVolo(false);
    if (esito.ok) {
      onEliminata({ eliminata: esito.eliminata, allegatiNelCestino: esito.allegatiNelCestino });
      return;
    }
    if (esito.bloccata) {
      onBloccata(esito.giorniLimite);
      return;
    }
    if (esito.ricarica) {
      onRifiutata(esito.messaggio);
      return;
    }
    setErrore(esito.messaggio);
  };

  return (
    <Modal
      open
      onClose={chiudi}
      title={titolo}
      labelledBy={titoloId}
      // Un click distratto sullo sfondo non deve valere come risposta: Escape e
      // «Annulla» restano, e sono un annullamento esplicito.
      closeOnBackdrop={false}
      className="w-full max-w-md"
    >
      <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl" data-testid="registro-conferma-eliminazione">
        <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h2>
        <p className="font-maven mt-1 text-sm text-kidville-ink">
          {firma
            ? t('registroEliminaFirmaDomanda', { ora: eliminazione.ora })
            : t('registroEliminaLezioneDomanda', { ora: eliminazione.ora })}
        </p>

        {sparisceLezione && (
          <div
            data-testid="registro-avviso-lezione-sparisce"
            className="mt-3 space-y-1 rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-xs text-kidville-warn-strong"
          >
            <p>
              {firma
                ? t('registroEliminaFirmaUnica')
                : t('registroEliminaLezioneFirme', { n: eliminazione.nFirme })}
            </p>
            {eliminazione.nAllegati > 0 && (
              <p data-testid="registro-avviso-allegati-cestino">
                {t('registroEliminaAllegatiCestino', { n: eliminazione.nAllegati, giorni: GIORNI_CESTINO_REGISTRO })}
              </p>
            )}
          </div>
        )}

        {errore && (
          <p role="alert" className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong">
            {errore}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Btn variant="ghost" size="sm" onClick={chiudi}>
            {t('registroEliminaAnnulla')}
          </Btn>
          <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={() => void conferma()}>
            {inVolo
              ? t('registroEliminazioneInCorso')
              : firma
                ? t('registroEliminaFirmaConferma')
                : t('registroEliminaLezioneConferma')}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

export interface AvvisoVoceBloccataProps {
  bersaglio: BersaglioSblocco;
  /** Il termine in giorni, se il server l'ha detto. */
  giorniLimite: number | null;
  userId: string;
  ruolo: string | null | undefined;
  onSbloccato: () => void;
  /** Il contesto già tradotto per il nome accessibile di «Sblocca» (quale ora). */
  descrizioneAccessibile: string;
}

/**
 * Il messaggio della voce bloccata, sulla riga dell'ora. Alla Direzione anche
 * «Sblocca» (`BottoneSblocca`, modo voce o slot); agli altri l'indicazione di
 * chiedere lo sblocco, perché il comando non ce l'hanno.
 */
export function AvvisoVoceBloccata({
  bersaglio,
  giorniLimite,
  userId,
  ruolo,
  onSbloccato,
  descrizioneAccessibile,
}: AvvisoVoceBloccataProps) {
  const t = useTranslations('teacherPrimaria');
  const direzione = puoSbloccare(ruolo);
  const testo =
    giorniLimite !== null ? t('registroVoceBloccata', { giorni: giorniLimite }) : t('registroVoceBloccataSenzaGiorni');
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2" data-testid="registro-voce-bloccata">
      <p role="status" className="flex items-center gap-1 font-maven text-xs text-kidville-warn-strong">
        <Lock size={12} aria-hidden="true" />
        {testo} {direzione ? null : t('registroChiediSblocco')}
      </p>
      <BottoneSblocca
        bersaglio={bersaglio}
        userId={userId}
        ruolo={ruolo}
        onSbloccato={onSbloccato}
        descrizioneAccessibile={descrizioneAccessibile}
      />
    </div>
  );
}
