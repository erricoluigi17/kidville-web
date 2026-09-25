'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { MOTIVAZIONE_SBLOCCO_MAX } from '@/lib/primaria/sblocco-motivazione';

/**
 * «SBLOCCA» — l'autorizzazione della Direzione a scrivere oltre il termine.
 *
 * Sostituisce il vecchio `SbloccaOraButton` (che sapeva sbloccare solo un'ora mai firmata)
 * e lo estende alle tre cose che la spec del 2026-09-24 chiede di poter sbloccare:
 *
 *  · una VOCE     → `{ entitaTipo, entitaId }` (valutazione, nota, impreparato,
 *                   allegato, firma, riga di registro già scritta);
 *  · uno SLOT     → `{ sectionId, data, oraLezione }` (l'ora mai firmata: la riga
 *                   non esiste, quindi non c'è un uuid da mandare);
 *  · un GIORNO    → `{ sectionId, data }` (tutte le voci della classe quel giorno).
 *
 * ─── PERCHÉ CHIEDE IL MOTIVO ────────────────────────────────────────────────
 * `sblocchi_audit.motivazione` è `NOT NULL` perché quella riga è la sola traccia
 * di un'autorizzazione a scrivere in ritardo su un registro di minori. Un motivo
 * precompilato dal client riempirebbe la colonna e svuoterebbe l'audit.
 *
 * ─── IL RUOLO QUI NON È UN PRESIDIO ─────────────────────────────────────────
 * Il gate vero è sul server (`requireStaff(request, ['admin','coordinator'])`).
 * Nascondere il comando serve a non offrire a una maestra — o alla Segreteria —
 * un pulsante che risponderebbe 403. Il ruolo arriva come prop dalla pagina che
 * l'ha già risolto: una `fetch('/api/me')` per ogni voce dell'elenco sarebbe N
 * chiamate per un'informazione che il chiamante ha già.
 */

/** I ruoli che il gate della route accetta. Una regola sola, due strade. */
const RUOLI_DIREZIONE = new Set(['admin', 'coordinator']);

/**
 * Vero se questo ruolo può autorizzare una scrittura fuori termine.
 * Esportata perché la pagina che monta il bottone deve poter decidere lo stesso
 * (per esempio per scrivere «chiedi lo sblocco alla Direzione» a chi non ce l'ha).
 */
export function puoSbloccare(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_DIREZIONE.has(ruolo);
}

/** I tipi di voce che si sbloccano per riga (lo stesso elenco della route, meno `giorno`). */
export type TipoVoceSbloccabile = 'registro' | 'firma' | 'valutazione' | 'nota' | 'impreparato' | 'allegato';

export type BersaglioSblocco =
  | { modo: 'voce'; entitaTipo: TipoVoceSbloccabile; entitaId: string }
  | { modo: 'slot'; sectionId: string; data: string; oraLezione: number }
  | { modo: 'giorno'; sectionId: string; data: string };

export interface BottoneSbloccaProps {
  /** Che cosa si sblocca: una voce, un'ora mai firmata o il giorno della classe. */
  bersaglio: BersaglioSblocco;
  /** Identità applicativa di chi autorizza (query `?userId=` + header `x-user-id`). */
  userId: string;
  /** Il ruolo REALE di chi sta guardando. Senza, il comando non si mostra. */
  ruolo: string | null | undefined;
  /** Chiamata dopo uno sblocco andato a buon fine: la pagina ricarica i dati. */
  onSbloccato: () => void;
  /**
   * Il contesto della voce, GIÀ TRADOTTO dal chiamante (es. «Sblocca la
   * valutazione di Matematica del 07/09»). In un elenco di voci bloccate lo
   * screen reader sentirebbe altrimenti una fila di «Sblocca» uguali, senza sapere
   * a quale voce si riferisce ciascuno. Diventa il nome accessibile del bottone e
   * il sottotitolo della modale. Conviene che contenga l'etichetta visibile
   * («Sblocca»): chi comanda a voce pronuncia quello che vede (WCAG 2.5.3); se non
   * la contiene, il componente la antepone.
   */
  descrizioneAccessibile?: string;
}

/**
 * Il nome accessibile del bottone: la descrizione del chiamante, che contenga
 * l'etichetta visibile (WCAG 2.5.3 «label in name»). `undefined` = nessuna
 * descrizione, il nome resta il testo visibile.
 */
export function nomeAccessibileSblocco(etichetta: string, descrizione: string | undefined): string | undefined {
  const d = descrizione?.trim();
  if (!d) return undefined;
  return d.toLocaleLowerCase().includes(etichetta.toLocaleLowerCase()) ? d : `${etichetta}: ${d}`;
}

/** Il corpo della POST: la stessa forma che lo schema zod della route accetta. */
export function corpoSblocco(bersaglio: BersaglioSblocco, motivazione: string): Record<string, unknown> {
  switch (bersaglio.modo) {
    case 'voce':
      return { entitaTipo: bersaglio.entitaTipo, entitaId: bersaglio.entitaId, motivazione };
    case 'slot':
      // Il tipo resta `registro`: è lo slot che `primaria/registro:POST` sa leggere.
      return {
        entitaTipo: 'registro',
        sectionId: bersaglio.sectionId,
        data: bersaglio.data,
        oraLezione: bersaglio.oraLezione,
        motivazione,
      };
    case 'giorno':
      return { entitaTipo: 'giorno', sectionId: bersaglio.sectionId, data: bersaglio.data, motivazione };
  }
}

/** La rotta della PAGINA (è il luogo dell'incidente, non la fetch): vedi `EventoClient.route`. */
function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export function BottoneSblocca({ bersaglio, userId, ruolo, onSbloccato, descrizioneAccessibile }: BottoneSbloccaProps) {
  const t = useTranslations('teacherPrimaria');
  const [aperto, setAperto] = useState(false);
  const [motivazione, setMotivazione] = useState('');
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const idBase = useId();

  // Fail-closed: un ruolo che non conosciamo non è la Direzione.
  if (!puoSbloccare(ruolo)) return null;

  const campoId = `${idBase}-motivo`;
  const titoloId = `${idBase}-titolo`;
  const conteggioId = `${idBase}-conteggio`;
  const etichetta =
    bersaglio.modo === 'voce' ? t('sbloccaBottoneVoce') : bersaglio.modo === 'slot' ? t('sbloccaBottoneOra') : t('sbloccaBottoneGiorno');
  const titolo =
    bersaglio.modo === 'voce' ? t('sbloccaTitoloVoce') : bersaglio.modo === 'slot' ? t('sbloccaTitoloOra') : t('sbloccaTitoloGiorno');
  const spiegazione =
    bersaglio.modo === 'voce'
      ? t('sbloccaSpiegazioneVoce')
      : bersaglio.modo === 'slot'
        ? t('sbloccaSpiegazioneOra')
        : t('sbloccaSpiegazioneGiorno');
  const nomeAccessibile = nomeAccessibileSblocco(etichetta, descrizioneAccessibile);
  const contesto = descrizioneAccessibile?.trim();

  const chiudi = () => {
    if (inVolo) return;
    setAperto(false);
    setErrore('');
  };

  const autorizza = async () => {
    // `aria-disabled` invece di `disabled` (vedi la nota in `Btn`): la guardia sta
    // qui, così il fuoco non torna a `<body>` mentre la richiesta è in volo.
    if (inVolo) return;
    const motivo = motivazione.trim();
    if (!motivo) {
      setErrore(t('sbloccaMotivoObbligatorio'));
      return;
    }
    setInVolo(true);
    setErrore('');
    try {
      const res = await fetch(`/api/primaria/sblocca?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify(corpoSblocco(bersaglio, motivo)),
      });
      // `null` = corpo illeggibile: il messaggio resta il generico tradotto.
      let corpo: unknown = null;
      try {
        corpo = await res.json();
      } catch (errJson) {
        // Un corpo non JSON (proxy, pagina d'errore): si prosegue col testo
        // generico, ma non in silenzio.
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `sblocco-risposta-non-json: ${errJson instanceof Error ? errJson.name : 'errore'}`,
          route: paginaCorrente(),
          stato: res.status,
        });
      }
      if (!res.ok) {
        // Il MOTIVO non entra nel log: è testo libero scritto su una classe di
        // minori, e `app_log` si interroga in SQL per trenta giorni.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `sblocco-non-registrato: ${bersaglio.modo}`,
          route: paginaCorrente(),
          stato: res.status,
        });
        // Codice → catalogo nella lingua dell'interfaccia; senza codice, la prosa
        // del server; senza nemmeno quella, il generico tradotto. Leggere `error`
        // e basta mostrerebbe italiano a una Direzione con l'interfaccia inglese.
        setErrore(messaggioDaCorpo(corpo, t('sbloccaErrore')));
        return;
      }
      setMotivazione('');
      setAperto(false);
      onSbloccato();
    } catch (err) {
      // Un `catch` che non logga è un bug (AGENTS, regola 6): qui ci cade la rete
      // che manca, cioè il caso in cui nessuno saprebbe mai che la Direzione ha
      // provato a sbloccare e non ci è riuscita.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `sblocco-non-inviato: ${err instanceof Error ? err.name : 'errore'}`,
        route: paginaCorrente(),
      });
      setErrore(t('sbloccaErroreRete'));
    } finally {
      setInVolo(false);
    }
  };

  return (
    <>
      <Btn
        variant="secondary"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={aperto}
        aria-label={nomeAccessibile}
        onClick={() => {
          setErrore('');
          setAperto(true);
        }}
      >
        <KeyRound size={15} aria-hidden="true" />
        {etichetta}
      </Btn>

      <Modal open={aperto} onClose={chiudi} title={titolo} labelledBy={titoloId} className="w-full max-w-md">
        <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
          <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
            {titolo}
          </h2>
          {/* Il contesto della voce (se il chiamante l'ha dato): chi apre la modale
              da un elenco deve sapere QUALE voce sta sbloccando. */}
          {contesto && (
            <p data-testid="sblocca-contesto" className="font-maven mt-1 text-sm font-semibold text-kidville-ink">
              {contesto}
            </p>
          )}
          <p className="font-maven mt-1 text-xs text-kidville-sub">{spiegazione}</p>

          {errore && (
            <p
              role="alert"
              className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
            >
              {errore}
            </p>
          )}

          <label htmlFor={campoId} className="mt-3 block font-maven text-xs font-semibold text-kidville-sub">
            {t('sbloccaMotivo')}
          </label>
          {/* Il tetto è la STESSA costante dello schema zod della route: oltre, il
              server risponderebbe un 400 generico che non dice «troppo lungo».
              Il conteggio lo rende visibile prima, invece di fermare la tastiera
              senza spiegazione. */}
          <textarea
            id={campoId}
            value={motivazione}
            onChange={(e) => setMotivazione(e.target.value)}
            rows={3}
            maxLength={MOTIVAZIONE_SBLOCCO_MAX}
            aria-required="true"
            aria-describedby={conteggioId}
            className="font-maven mt-1 w-full rounded-card border border-kidville-line bg-kidville-white px-3 py-2 text-sm text-kidville-ink"
          />
          <p id={conteggioId} className="font-maven mt-1 text-right text-xs text-kidville-sub">
            {t('sbloccaMotivoConteggio', { usati: motivazione.length, max: MOTIVAZIONE_SBLOCCO_MAX })}
          </p>

          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={chiudi}>
              {t('sbloccaAnnulla')}
            </Btn>
            <Btn variant="primary" size="sm" aria-disabled={inVolo} onClick={autorizza}>
              {inVolo ? t('sbloccaAutorizzoInCorso') : t('sbloccaAutorizza')}
            </Btn>
          </div>
        </div>
      </Modal>
    </>
  );
}
