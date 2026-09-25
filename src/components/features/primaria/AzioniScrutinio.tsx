'use client';

import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LockOpen, Trash2 } from 'lucide-react';
import { Btn } from '@/components/ui/Btn';
import { Modal } from '@/components/ui/Modal';
import { logClient } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';

/**
 * LE DUE AZIONI DISTRUTTIVE DELLO SCRUTINIO — compito S3 della spec 2026-09-24.
 *
 *  · «Riapri scrutinio»  → `POST /api/primaria/scrutinio/riapri` (compito S1):
 *    ritira la pubblicazione, cancella le pagelle PDF, riporta lo scrutinio ad
 *    APERTO. Le firme di ricezione dei genitori restano.
 *  · «Elimina pagella»   → `DELETE /api/primaria/pagella` (compito S2): toglie il
 *    PDF archiviato di UN alunno. Scrutinio, pubblicazione e firme non cambiano.
 *
 * ─── PERCHÉ UNA MODALE E NON `confirm()` ───────────────────────────────────
 * La spec chiede «una conferma che spiega le conseguenze». Tre conseguenze
 * distinte, una delle quali rassicurante (le firme restano), in una riga di
 * `confirm()` diventano un muro di testo che si approva senza leggerlo. Qui
 * stanno in un elenco, e il bottone di conferma dice COSA fa.
 *
 * ─── IL RUOLO QUI NON È UN PRESIDIO ─────────────────────────────────────────
 * Il gate vero è sul server (`requireStaff(request, ['admin','coordinator',
 * 'segreteria'])` + sede). Nascondere il comando serve a non offrire a una
 * maestra un bottone che risponderebbe 403. Il ruolo arriva come prop dalla
 * pagina, che l'ha già letto da `/api/primaria/me`.
 */

/** Segreteria e Direzione: gli stessi ruoli dei gate delle due route. */
const RUOLI_SEGRETERIA_DIREZIONE = new Set(['admin', 'coordinator', 'segreteria']);

/** Vero se questo ruolo può riaprire uno scrutinio chiuso. Fail-closed sul ruolo ignoto. */
export function puoRiaprireScrutinio(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_SEGRETERIA_DIREZIONE.has(ruolo);
}

/** Vero se questo ruolo può eliminare una singola pagella. Fail-closed sul ruolo ignoto. */
export function puoEliminarePagella(ruolo: string | null | undefined): boolean {
  return !!ruolo && RUOLI_SEGRETERIA_DIREZIONE.has(ruolo);
}

/** La rotta della PAGINA (è il luogo dell'incidente, non la fetch): vedi `EventoClient.route`. */
function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/**
 * Legge il corpo JSON della risposta. `null` = corpo illeggibile (proxy, pagina
 * d'errore HTML): il chiamante ripiega sul testo generico, ma non in silenzio.
 */
async function leggiCorpo(res: Response, operazione: string): Promise<unknown> {
  try {
    return await res.json();
  } catch (errJson) {
    logClient({
      livello: 'warn',
      evento: 'fetch',
      messaggio: `${operazione}-risposta-non-json: ${errJson instanceof Error ? errJson.name : 'errore'}`,
      route: paginaCorrente(),
      stato: res.status,
    });
    return null;
  }
}

function numeroDa(corpo: unknown, chiave: string): number {
  if (corpo && typeof corpo === 'object' && chiave in corpo) {
    const v = (corpo as Record<string, unknown>)[chiave];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

// ─── Riapri scrutinio ─────────────────────────────────────────────────────────

export interface RiapriScrutinioProps {
  scrutinioId: string;
  /** Identità applicativa (query `?userId=` + header `x-user-id`, come il resto della pagina). */
  userId: string;
  /** Il ruolo REALE di chi guarda. Senza, il comando non si mostra. */
  ruolo: string | null | undefined;
  /** Se lo scrutinio è pubblicato: la modale nomina il ritiro solo quando c'è. */
  pubblicato: boolean;
  /** Dopo una riapertura riuscita, col messaggio GIÀ TRADOTTO: la pagina lo mostra e ricarica. */
  onRiaperto: (messaggio: string) => void;
}

export function RiapriScrutinio({ scrutinioId, userId, ruolo, pubblicato, onRiaperto }: RiapriScrutinioProps) {
  const t = useTranslations('teacherPrimaria');
  const [aperto, setAperto] = useState(false);
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const idBase = useId();

  if (!puoRiaprireScrutinio(ruolo)) return null;

  const titoloId = `${idBase}-titolo`;

  const chiudi = () => {
    if (inVolo) return;
    setAperto(false);
    setErrore('');
  };

  const conferma = async () => {
    // `aria-disabled` invece di `disabled` (vedi la nota in `Btn`): la guardia sta qui.
    if (inVolo) return;
    setInVolo(true);
    setErrore('');
    try {
      const res = await fetch(`/api/primaria/scrutinio/riapri?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ scrutinioId }),
      });
      const corpo = await leggiCorpo(res, 'riapertura-scrutinio');
      if (!res.ok) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: 'riapertura-scrutinio-rifiutata',
          route: paginaCorrente(),
          stato: res.status,
        });
        // Codice → catalogo nella lingua dell'interfaccia; poi la prosa; poi il generico.
        setErrore(messaggioDaCorpo(corpo, t('scrutinioRiapriErrore')));
        return;
      }
      setAperto(false);
      onRiaperto(t('scrutinioRiaperto', { count: numeroDa(corpo, 'pagelleEliminate') }));
    } catch (err) {
      // Un `catch` che non logga è un bug (AGENTS, regola 6): qui ci cade la rete.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `riapertura-scrutinio-non-inviata: ${err instanceof Error ? err.name : 'errore'}`,
        route: paginaCorrente(),
      });
      setErrore(t('scrutinioAzioneErroreRete'));
    } finally {
      setInVolo(false);
    }
  };

  return (
    <>
      <Btn
        variant="danger"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={aperto}
        onClick={() => {
          setErrore('');
          setAperto(true);
        }}
      >
        <LockOpen size={15} aria-hidden="true" />
        {t('scrutinioRiapriBottone')}
      </Btn>

      <Modal open={aperto} onClose={chiudi} title={t('scrutinioRiapriTitolo')} labelledBy={titoloId} className="w-full max-w-md">
        <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
          <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
            {t('scrutinioRiapriTitolo')}
          </h2>
          <p className="font-maven mt-1 text-sm text-kidville-ink">{t('scrutinioRiapriSpiegazione')}</p>
          <ul data-testid="riapri-conseguenze" className="font-maven mt-2 list-disc space-y-1 pl-5 text-sm text-kidville-ink">
            {pubblicato && <li>{t('scrutinioRiapriConseguenzaPubblicazione')}</li>}
            <li>{t('scrutinioRiapriConseguenzaPdf')}</li>
            <li>{t('scrutinioRiapriConseguenzaFirme')}</li>
          </ul>

          {errore && (
            <p
              role="alert"
              className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
            >
              {errore}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={chiudi}>
              {t('scrutinioAzioneAnnulla')}
            </Btn>
            <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={conferma}>
              {inVolo ? t('scrutinioRiapriInCorso') : t('scrutinioRiapriConferma')}
            </Btn>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─── Elimina pagella ──────────────────────────────────────────────────────────

export interface EliminaPagellaProps {
  scrutinioId: string;
  alunnoId: string;
  /** Nome dell'alunno GIÀ composto dalla pagina: serve a schermo (mai nei log). */
  nomeAlunno: string;
  userId: string;
  ruolo: string | null | undefined;
  /** Dopo un'eliminazione riuscita, col messaggio GIÀ TRADOTTO. */
  onEliminata: (messaggio: string) => void;
}

export function EliminaPagella({ scrutinioId, alunnoId, nomeAlunno, userId, ruolo, onEliminata }: EliminaPagellaProps) {
  const t = useTranslations('teacherPrimaria');
  const [aperto, setAperto] = useState(false);
  const [errore, setErrore] = useState('');
  const [inVolo, setInVolo] = useState(false);
  const idBase = useId();

  if (!puoEliminarePagella(ruolo)) return null;

  const titoloId = `${idBase}-titolo`;

  const chiudi = () => {
    if (inVolo) return;
    setAperto(false);
    setErrore('');
  };

  const conferma = async () => {
    if (inVolo) return;
    setInVolo(true);
    setErrore('');
    try {
      const qs = new URLSearchParams({ scrutinioId, alunnoId, userId });
      const res = await fetch(`/api/primaria/pagella?${qs.toString()}`, {
        method: 'DELETE',
        headers: { 'x-user-id': userId },
      });
      const corpo = await leggiCorpo(res, 'eliminazione-pagella');
      if (!res.ok) {
        // Niente nome dell'alunno nel log: è un dato di un minore.
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: 'eliminazione-pagella-rifiutata',
          route: paginaCorrente(),
          stato: res.status,
        });
        setErrore(messaggioDaCorpo(corpo, t('pagellaEliminaErrore')));
        return;
      }
      setAperto(false);
      onEliminata(t('pagellaEliminata', { alunno: nomeAlunno }));
    } catch (err) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `eliminazione-pagella-non-inviata: ${err instanceof Error ? err.name : 'errore'}`,
        route: paginaCorrente(),
      });
      setErrore(t('scrutinioAzioneErroreRete'));
    } finally {
      setInVolo(false);
    }
  };

  return (
    <>
      {/* Il nome accessibile nomina l'alunno: in un elenco di trenta righe lo
          screen reader sentirebbe altrimenti trenta «Elimina pagella» uguali.
          Contiene l'etichetta visibile (WCAG 2.5.3). `Btn` e non un <button>
          su misura: la variante `danger` porta il contorno pieno che regge i
          3:1 sulla riga crema (WCAG 1.4.11, vedi la nota in `Btn`). */}
      <Btn
        variant="danger"
        size="sm"
        className="mt-2"
        aria-haspopup="dialog"
        aria-expanded={aperto}
        aria-label={t('pagellaEliminaNomeAccessibile', { alunno: nomeAlunno })}
        onClick={() => {
          setErrore('');
          setAperto(true);
        }}
      >
        <Trash2 size={13} aria-hidden="true" /> {t('pagellaEliminaBottone')}
      </Btn>

      <Modal open={aperto} onClose={chiudi} title={t('pagellaEliminaTitolo')} labelledBy={titoloId} className="w-full max-w-md">
        <div className="rounded-3xl border border-kidville-line bg-white p-5 shadow-2xl">
          <h2 id={titoloId} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
            {t('pagellaEliminaTitolo')}
          </h2>
          <p data-testid="elimina-pagella-spiegazione" className="font-maven mt-1 text-sm text-kidville-ink">
            {t('pagellaEliminaSpiegazione', { alunno: nomeAlunno })}
          </p>

          {errore && (
            <p
              role="alert"
              className="mt-3 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-sm text-kidville-error-strong"
            >
              {errore}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Btn variant="ghost" size="sm" onClick={chiudi}>
              {t('scrutinioAzioneAnnulla')}
            </Btn>
            <Btn variant="danger" size="sm" aria-disabled={inVolo} onClick={conferma}>
              {inVolo ? t('pagellaEliminaInCorso') : t('pagellaEliminaConferma')}
            </Btn>
          </div>
        </div>
      </Modal>
    </>
  );
}
