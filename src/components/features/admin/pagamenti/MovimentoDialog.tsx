'use client';

// ─── Popup centrale del movimento bancario (Riconciliazione v2) ───────────────
// Aperto cliccando una riga della lista a semaforo. Dà, in un punto solo:
//   · i suggerimenti ordinati (i CF-match primi, badge «CF») con «Conferma questo»;
//   · la ricerca manuale fra i pagamenti aperti (stessa fonte del pannello);
//   · le azioni sul movimento (Ignora / Riapri);
//   · a saldo avvenuto, Ricevuta + Fattura SdI (come il PagamentoDrawer);
//   · il punto d'innesto «Apri Incasso unico» per i bonifici di famiglia (multi-CF):
//     lo renderizza solo se il chiamante passa `onIncassoUnico` (impl. UI-2).
// Le risposte del server sono gestite senza crash: 409 «già saldato» e 409
// «già riconciliato da un altro operatore» diventano messaggi chiari (+ refetch).

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { AlertTriangle, Check, Clock, Download, FileCheck, FileText, Receipt, Search, X, Users } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { FatturaButton } from './FatturaButton';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import {
  chipFatturazione,
  classiChipFatturazione,
  labelPagamentoAperto,
  movimentoMultiCf,
  testoRicercaPagamento,
  FRASE_FATTURAZIONE,
  type MovimentoUi,
  type PagamentoApertoUi,
  type StatoFattura,
  type TonoFatturazione,
} from './riconciliazione-ui';

interface Props {
  movimento: MovimentoUi;
  aperti: PagamentoApertoUi[];
  userId: string;
  onClose: () => void;
  /** Refetch della lista dopo un'azione riuscita (o una corsa persa). */
  onDone: () => void;
  /** Ripristino focus WCAG 2.4.3: la riga che ha aperto il dialog. */
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
  /**
   * Predisposizione «Apri Incasso unico» per i bonifici di famiglia (multi-CF).
   * Reso SOLO se fornito e il movimento è multi-CF: l'implementazione è di UI-2.
   */
  onIncassoUnico?: (movimento: MovimentoUi) => void;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

const TITLE_ID = 'movimento-dialog-title';

/**
 * Occhiello: la parolina in Barlow che dice CHE COSA si sta guardando. Sta qui e
 * non in `ui.ts` perché è la voce di questa schermata (intestazione del popup,
 * etichette dei campi, titoletto dei documenti) e non una primitiva dell'app.
 */
const OCCHIELLO = 'font-barlow text-[11px] font-extrabold uppercase tracking-[0.08em] text-kidville-green';

/**
 * Il glifo di ogni chip di fatturazione. Mappa STATICA — nessuna icona costruita
 * da un dato. Sta in questo file, e non in `riconciliazione-ui.ts`, perché quello
 * è un modulo `.ts` di logica pura che non importa componenti React.
 */
export const ICONA_CHIP: Record<TonoFatturazione, typeof FileCheck> = {
  fatturata: FileCheck,
  attesa: Clock,
  scartata: AlertTriangle,
  da_fatturare: Receipt,
};

/**
 * IL CHIP DI FATTURAZIONE — UNO SOLO, per la riga della lista e per questo popup.
 *
 * Prima erano due: la riga usava la pelle di `CHIP_FATTURAZIONE` (carta bianca,
 * inchiostro di funzione, glifo), il popup un `Badge` generico senza glifo — e
 * «Da fatturare», che sulla riga è giallo pieno perché è l'unico stato che chiede
 * di agire, nel popup diventava grigio. Lo stesso dato, a due centimetri di
 * distanza, con due significati diversi.
 *
 * `suCarta` aggiunge il solo filetto: il chip «Fatturata» ha fondo bianco e senza
 * contorno sparirebbe dentro la card bianca del popup (sulla riga non serve,
 * perché lì sotto c'è il verde pieno).
 *
 * Esportato perché `RiconciliazionePanel` — che già importa questo file — lo usa
 * sulle righe: la dipendenza va dal pannello al popup, mai al contrario.
 */
export function ChipFatturazione({ fat, suCarta = false }: {
  fat: NonNullable<ReturnType<typeof chipFatturazione>>;
  suCarta?: boolean;
}) {
  const t = useTranslations('adminContabilita');
  const Icona = ICONA_CHIP[fat.tono];
  return (
    <span className={classiChipFatturazione(fat, suCarta)}>
      <Icona size={13} aria-hidden="true" />
      {/* `params` c'è solo quando l'etichetta ha un segnaposto («Fattura {numeri}»):
          passarli sempre è innocuo, ometterli quando servono farebbe LANCIARE
          next-intl — cioè l'intera lista al posto di un chip. */}
      {t(fat.labelKey, fat.params)}
    </span>
  );
}

/** Pill «CF» dell'aggancio per codice fiscale (su card bianca del dialog). */
function CfPill() {
  const t = useTranslations('adminContabilita');
  return (
    <span className="rounded-pill bg-kidville-green px-2 py-1 font-barlow text-[10px] font-extrabold uppercase leading-none text-kidville-white">
      {t('movdlgBadgeCf')}
    </span>
  );
}

export function MovimentoDialog({ movimento, aperti, userId, onClose, onDone, returnFocusRef, onIncassoUnico }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ricerca, setRicerca] = useState('');
  // Stato del pagamento collegato: serve solo ai movimenti confermati per capire
  // se mostrare Ricevuta (saldato) o la nota «Disponibile a saldo avvenuto».
  const [pagamentoStato, setPagamentoStato] = useState<string | null>(null);
  /**
   * Stato di FATTURAZIONE del pagamento collegato. Arrivava già nella stessa
   * risposta e veniva buttato via: senza, `FatturaButton` riparte da
   * `'non_richiesta'` e dice «Invia fattura» anche su un pagamento già
   * fatturato — chi lo preme riceve un 409 che non spiega niente.
   */
  const [pagamentoFattura, setPagamentoFattura] = useState<string | null>(null);
  const [loadingPag, setLoadingPag] = useState(movimento.stato === 'confermato' && !!movimento.pagamento_id);

  const stato = movimento.stato;
  const puoAbbinare = stato !== 'confermato';
  const isConfermato = stato === 'confermato';
  const isIgnorato = stato === 'ignorato';
  const suggerimenti = movimento.suggerimenti ?? [];
  const multiCf = movimentoMultiCf(suggerimenti);

  // Dettaglio del pagamento (solo movimenti confermati): stesso pattern di
  // PagamentoDrawer — setState solo in try (guardato da `active`) e in finally,
  // MAI nel catch (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (stato !== 'confermato' || !movimento.pagamento_id) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/${movimento.pagamento_id}?userId=${userId}`, { headers: hdr(userId) });
        const j = await r.json();
        if (active && j?.success) {
          const d = j.data as { stato?: string; fattura_stato?: string } | null;
          setPagamentoStato(d?.stato ?? null);
          // Assente su una risposta più vecchia: si degrada a `null` e il
          // pulsante torna a comportarsi come prima, senza rompersi.
          setPagamentoFattura(d?.fattura_stato ?? null);
        }
      } catch (err) {
        // Il dialog resta usabile senza lo stato: si logga, non si rompe.
        logClient({ livello: 'error', evento: 'fetch', messaggio: `pagamento-stato-ricevuta-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      } finally {
        if (active) setLoadingPag(false);
      }
    })();
    return () => { active = false; };
  }, [stato, movimento.pagamento_id, userId]);

  const azione = useCallback(async (az: 'conferma' | 'ignora' | 'riapri', pagamentoId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/pagamenti/riconciliazione/${movimento.id}`, {
        method: 'PATCH',
        headers: hdr(userId),
        body: JSON.stringify({ azione: az, pagamento_id: pagamentoId }),
      });
      // Nessun catch muto sul parse: un corpo non-JSON risale al catch che LOGGA.
      const j = (await r.json()) as { error?: string; success?: boolean };
      if (r.status === 409) {
        const msg = messaggioDaCorpo(j, t('movdlgOperazioneNonPossibile'));
        setError(msg);
        // Corsa persa / stato già cambiato da un altro operatore → risincronizza la lista.
        if (/operatore|confermato/i.test(msg)) onDone();
        return;
      }
      if (!r.ok || !j.success) {
        setError(messaggioDaCorpo(j, t('movdlgErroreOperazione')));
        return;
      }
      onDone();
      onClose();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `riconciliazione-${az}-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('movdlgErroreRete'));
    } finally {
      setBusy(false);
    }
  }, [movimento.id, userId, onDone, onClose, t]);

  const q = ricerca.trim().toLowerCase();
  const apertiFiltrati = (q.length === 0 ? aperti : aperti.filter((p) => testoRicercaPagamento(p).includes(q))).slice(0, 25);

  const saldato = isConfermato && pagamentoStato === 'pagato';
  /**
   * Il chip di questo popup nasce dalla STESSA funzione della riga della lista:
   * una sola tabella di verità, quindi il popup non può dire «Da fatturare» dove
   * la riga dice altro. `pagamentoFattura` arriva dal dettaglio del pagamento e
   * su una risposta vecchia è `null` → nessun chip, nessuna frase, e le azioni
   * restano quelle di prima (degradazione pulita).
   */
  // Gli stessi campi della riga: così il popup dice «Fattura FPR 1947/26» come la lista,
  // e non un generico «Fatturata» a due centimetri dal numero del documento.
  const fat = chipFatturazione({
    fattura_stato: (pagamentoFattura as StatoFattura | null) ?? null,
    pagamento_stato: pagamentoStato,
    fattura: movimento.fattura ?? null,
    pagamento_id: movimento.pagamento_id ?? null,
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('movdlgTitoloMovimento')} ${dataIt(movimento.data_operazione)}`}
      labelledBy={TITLE_ID}
      /* `kv-recon-dialog` è l'àncora dell'Alto Contrasto (globals.css): senza,
         in HC il popup resta la stessa carta bianca della luce normale, perché
         `@theme inline` inlina gli hex e nessun rimappaggio di token lo tocca.
         `sm:max-w-lg` e non `max-w-lg`: fra due utility di pari specificità
         decide l'ordine nel FOGLIO, e lì `max-w-md` di MODAL_CARD veniva dopo —
         il popup era largo 448px mentre il codice ne chiedeva 512. La variante
         di media query viene emessa dopo, quindi vince davvero.

         ⚠️ IL TETTO D'ALTEZZA NON È UN VEZZO: È CIÒ CHE RENDE «CHIUDI»
         RAGGIUNGIBILE. `Modal` centra la card in un `fixed inset-0` e blocca lo
         scorrimento del body (`document.body.style.overflow = 'hidden'`). La card
         non aveva né altezza massima né `overflow`: su un movimento da abbinare —
         suggerimenti PIÙ ricerca manuale — il popup supera l'altezza di un
         telefono, e ciò che esce non si raggiunge in NESSUN modo. Non è «si
         scorre dentro il popup»: non si scorreva affatto.
         `dvh` e non `vh`: su iOS `vh` conta anche la barra degli indirizzi che poi
         si ritira, cioè misura una finestra che non c'è. `2rem` è il `p-4` del
         contenitore di `Modal`, sopra e sotto. */
      className={cx(MODAL_CARD, 'kv-recon-dialog max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg')}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      {/* ── Intestazione: UN punto focale, la cifra ──────────────────────────
          L'occhiello «Movimento bancario» che stava qui sopra è stato tolto, e
          non per fare spazio: diceva ciò che la riga sotto dice meglio
          («Bonifico del 04/09/2026»), e in Alto Contrasto era uno dei sei
          elementi gialli che avevano tolto al giallo il suo significato.
          Toglierlo sistema anche l'allineamento della ✕, che con tre righe di
          testo a sinistra finiva otticamente in mezzo a due di esse: adesso la ✕
          vive nella STESSA riga flex della cifra, quindi è allineata per
          costruzione e non per una misura da riazzeccare a ogni modifica. */}
      <div className="mb-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id={TITLE_ID} className="min-w-0 font-barlow text-2xl font-black uppercase leading-none text-kidville-green">
            {formatEuro(movimento.importo)}
          </h2>
          {/* 44×44 (WCAG 2.5.8): era 28×28. E l'etichetta è «Chiudi il movimento»,
              non «Chiudi»: il piede ha già un bottone «Chiudi», e due comandi con
              lo stesso nome accessibile nella stessa finestra non si distinguono.
              `-mr-2` riporta il glifo all'angolo: cresce l'area toccabile, non il
              vuoto attorno. Mai `text-kidville-muted` (3,80:1). */}
          <button type="button" onClick={onClose} aria-label={t('movdlgChiudiDettaglio')}
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-pill text-kidville-sub transition-colors hover:bg-kidville-neutral-soft hover:text-kidville-ink">
            <X size={20} />
          </button>
        </div>
        <p className="mt-2 font-maven text-xs text-kidville-sub">{t('movdlgBonificoDel')} {dataIt(movimento.data_operazione)}</p>
      </div>

      {/* Causale / ordinante: etichettati come nelle email di sollecito, dove la
          stessa famiglia legge «Causale» e «Intestato a» — che è il testo di
          `movdlgOrdinante` dal 2026-09-05: prima c'era «Ordinante:», cioè una
          parola diversa da quella che la stessa persona legge nel sollecito, e
          l'unico occhiello della schermata coi due punti.
          Fondo crema PIENO e non `cream/60`: con l'alfa dentro il nome della
          classe, la regola di Alto Contrasto `.bg-kidville-cream` non lo
          raggiungerebbe nemmeno.
          Spaziature sulla scala 4/8 (erano 14px e 6px, mezzi passi): il popup è
          alto una decina di pixel in più e ha un ritmo che si legge. */}
      <div className="mb-4 rounded-card bg-kidville-cream p-4">
        <p className={OCCHIELLO}>{t('movdlgCausale')}</p>
        <p className="mt-2 font-maven text-sm leading-snug break-words text-kidville-ink" title={movimento.causale ?? ''}>
          {movimento.causale || t('movdlgNessunaCausale')}
        </p>
        {movimento.controparte && (
          <>
            <p className={cx(OCCHIELLO, 'mt-4')}>{t('movdlgOrdinante')}</p>
            <p className="mt-2 font-maven text-sm leading-snug break-words text-kidville-ink">{movimento.controparte}</p>
          </>
        )}
      </div>

      {error && <p role="alert" className="mb-4 rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">{error}</p>}

      {/* ── Abbinamento (movimenti non confermati) ─────────────────────────── */}
      {puoAbbinare && (
        <div className="space-y-4">
          {/* Bonifico di famiglia: innesto «Incasso unico» (impl. UI-2) */}
          {multiCf && onIncassoUnico && (
            <div className="rounded-card border-[1.5px] border-kidville-green-soft bg-kidville-green-soft p-4">
              <p className="flex items-center gap-1.5 font-maven text-sm font-bold text-kidville-green">
                <Users size={15} /> {t('movdlgBonificoFamiglia')}
              </p>
              <button type="button" onClick={() => onIncassoUnico(movimento)} disabled={busy} className={cx(BTN_PRIMARY_AA, 'mt-3 min-h-11')}>
                {t('movdlgApriIncassoUnico')}
              </button>
            </div>
          )}

          {/* Suggerimenti ordinati (CF-match primi) */}
          {suggerimenti.length > 0 && (
            <div>
              <h3 className={cx(OCCHIELLO, 'mb-2 block')}>{t('movdlgSuggerimenti')}</h3>
              <div className="space-y-2">
                {suggerimenti.map((s, i) => (
                  <div key={`${s.pagamento_id}-${i}`} className="flex items-center justify-between gap-2 rounded-input border border-kidville-line px-3 py-2">
                    <span className="flex min-w-0 items-center gap-2">
                      {s.cf_match && <CfPill />}
                      <span className="min-w-0 truncate font-maven text-sm text-kidville-ink">{s.label || s.pagamento_id}</span>
                    </span>
                    <button type="button" onClick={() => azione('conferma', s.pagamento_id)} disabled={busy}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill bg-kidville-green px-4 font-maven text-sm font-bold text-kidville-white transition-colors hover:bg-kidville-green-dark disabled:opacity-50">
                      <Check size={15} /> {t('movdlgConfermaQuesto')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Ricerca manuale fra i pagamenti aperti (stessa fonte del pannello) */}
          <div>
            <h3 className={cx(OCCHIELLO, 'mb-2 block')}>{t('movdlgCercaAltroPagamento')}</h3>
            <div className="relative mb-2">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub" />
              <input type="text" value={ricerca} onChange={(e) => setRicerca(e.target.value)} placeholder={t('movdlgCercaPlaceholder')}
                className={cx(INPUT, 'pl-9')} aria-label={t('movdlgCercaAriaLabel')} />
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {apertiFiltrati.length === 0 ? (
                <p className="px-1 py-2 font-maven text-xs text-kidville-sub">{t('movdlgNessunPagamentoCorrisponde')}</p>
              ) : apertiFiltrati.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-2 rounded-input bg-kidville-cream px-3 py-2">
                  <span className="min-w-0 truncate font-maven text-xs text-kidville-ink">{labelPagamentoAperto(p)}</span>
                  <button type="button" onClick={() => azione('conferma', p.id)} disabled={busy}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white disabled:opacity-50">
                    <Check size={14} /> {t('movdlgAbbina')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Movimento confermato: i DOCUMENTI ──────────────────────────────────
          Un riquadro solo, con un ordine di lettura: a che punto è la fattura
          (chip) → che cosa vuol dire (frase) → che cosa si può fare (azioni).
          Prima erano tre pillole in fila della stessa forma e dello stesso peso —
          «Ricevuta», «FATTURATA», «Fattura» — di cui una non era premibile.

          È una SUPERFICIE crema, gemella del riquadro della causale, e non più
          una card bianca con un filetto `border-kidville-line`: su fondo bianco
          quel filetto non si leggeva, e il blocco non aveva deciso se essere un
          contenitore — chip, frase e pulsanti sembravano galleggiare. Ora i due
          riquadri sono la stessa cosa e li separa lo spazio.
          Crema PIENO, mai `bg-kidville-cream/50`: con l'alfa dentro il nome della
          classe la regola di Alto Contrasto `.bg-kidville-cream` non lo
          raggiungerebbe, e il riquadro resterebbe chiaro sulla card nera. */}
      {isConfermato && (
        <section className="rounded-card bg-kidville-cream p-4">
          {/* Lo stato sta SULLA RIGA DELL'OCCHIELLO — «DOCUMENTI … FATTURATA» — e
              non più sopra i pulsanti: lì era il terzo di tre pillole identiche di
              cui una sola non si preme. Un titolo di riquadro e il suo stato sono
              la stessa informazione, e stanno sulla stessa riga. */}
          <div className="flex items-center justify-between gap-3">
            <h3 className={OCCHIELLO}>{t('movdlgDocumenti')}</h3>
            {!loadingPag && saldato && movimento.pagamento_id && fat && <ChipFatturazione fat={fat} suCarta />}
          </div>
          {loadingPag ? (
            <p className="mt-2 font-maven text-sm text-kidville-sub">{t('movdlgCaricamento')}</p>
          ) : saldato && movimento.pagamento_id ? (
            <>
              {/* Una frase per stato, mai una sola per due: «già emessa» su una
                  fattura in attesa era falso, e su una scartata non c'era niente —
                  cioè nessuna istruzione proprio dove qualcuno deve rifare il
                  lavoro. */}
              {fat && (
                <p className="mt-2 font-maven text-xs leading-relaxed text-kidville-sub">{t(FRASE_FATTURAZIONE[fat.tono])}</p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {/* Secondario: la ricevuta c'è sempre, non è mai l'azione da fare.
                    Fondo trasparente (in Alto Contrasto diventa il nero della card
                    da solo) e 44px di altezza — erano 28. */}
                <a href={`/api/pagamenti/ricevuta?pagamento_id=${movimento.pagamento_id}&userId=${userId}`}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border-[1.5px] border-kidville-green px-4 font-maven text-sm font-bold text-kidville-green transition-colors hover:bg-kidville-green-soft">
                  <Download size={15} /> {t('movdlgRicevuta')}
                </a>
                {/* «In attesa SDI» NON ha un pulsante: in quello stato FatturaButton
                    rende solo un badge con una rotella che gira, cioè la stessa
                    parola del chip qui sopra più un'animazione che non annuncia
                    niente. Lo stato si dice una volta.
                    Il guscio è ciò che dà la pelle al pulsante senza toccare
                    `FatturaButton`, che è condiviso con altre viste: `data-tono`
                    decide CTA pieno (c'è da emettere) o secondario (c'è già). */}
                {pagamentoFattura !== 'in_attesa' && (
                  <span className="kv-recon-azione-fattura" data-tono={fat?.tono ?? 'da_fatturare'}>
                    <FatturaButton
                      pagamentoId={movimento.pagamento_id}
                      userId={userId}
                      fatturaStato={pagamentoFattura ?? undefined}
                      onEmessa={onDone}
                    />
                  </span>
                )}
              </div>
            </>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 font-maven text-xs leading-relaxed text-kidville-sub">
              <FileText size={14} className="shrink-0" /> {t('movdlgRicevutaFatturaSaldo')}
            </p>
          )}
        </section>
      )}

      {/* ── Azioni sul movimento: un PIEDE, non due pillole che galleggiano ─── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-kidville-line pt-4">
        {(stato === 'da_abbinare' || stato === 'suggerito') && (
          <button type="button" onClick={() => azione('ignora')} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
            <X size={15} /> {t('movdlgIgnora')}
          </button>
        )}
        {(isConfermato || isIgnorato) && (
          <button type="button" onClick={() => azione('riapri')} disabled={busy} className={cx(BTN_SECONDARY, 'min-h-11')}>
            {t('movdlgRiapri')}
          </button>
        )}
        <button type="button" onClick={onClose} className={cx(BTN_SECONDARY, 'ml-auto min-h-11')}>{t('movdlgChiudi')}</button>
      </div>
    </Modal>
  );
}
