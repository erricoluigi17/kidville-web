'use client';

// ─── Modale «Svuota cassa» (chiusura on-demand, solo admin) ────────────────────
// Legge il saldo atteso dal server (GET /cassa/saldo), chiede il TOTALE CONTATO e
// mostra dal vivo la differenza — comunicata A PAROLE («Ammanco di …») e non solo
// col colore (WCAG 1.4.1) — più il riepilogo del prelievo. Alla conferma invia
// SOLO { scuola_id, contato, note }: il saldo atteso, la differenza e il prelievo
// li ricalcola il server (non ci si fida del client). Solo token `kidville-*`.
//
// Sede (P4b): ogni sede è un cassetto a sé (fondo, saldo, svuotamento). Con più
// sedi la si sceglie qui dentro, e finché non è scelta non si legge nessun saldo
// e non si può svuotare niente: il saldo mostrato è SEMPRE quello della sede che
// riceverà lo svuotamento.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { X, Wallet, Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import type { SaldoCassa, CassaNonDisponibile } from '@/lib/cassa/tipi';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { CampoSedeCassa, useSedeCassa, type SedeCassa } from './CassaSede';

interface Props {
  userId: string;
  /** Le sedi su cui l'utente può svuotare la cassa. Con una sola il selettore non compare. */
  sedi: SedeCassa[];
  /** La sede già scelta dalla pagina, o null (con più sedi si sceglie qui, obbligatoriamente). */
  sedeIniziale: string | null;
  onClose: () => void;
  onDone: () => void;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
}

interface EsitoChiusura {
  chiusura_id: string;
  saldo_atteso: number;
  contato: number;
  differenza: number;
  prelevato: number;
  fondo_lasciato: number;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });
const TITLE_ID = 'cassa-chiusura-title';
const ERRORE_ID = 'cassa-chiusura-errore';
const EPS = 0.005;

export function CassaChiusuraModal({ userId, sedi, sedeIniziale, onClose, onDone, returnFocusRef }: Props) {
  const t = useTranslations('adminContabilita');
  const { scuolaId, scegli } = useSedeCassa(sedi, sedeIniziale);
  const [saldo, setSaldo] = useState<SaldoCassa | CassaNonDisponibile | null>(null);
  const [loading, setLoading] = useState(scuolaId !== null);
  const [contatoStr, setContatoStr] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [esito, setEsito] = useState<EsitoChiusura | null>(null);
  // Saldo non letto (rete o rifiuto del server): si dice «impossibile leggere», non
  // «modulo non attivo», che è un'altra cosa.
  const [saldoIllegibile, setSaldoIllegibile] = useState(false);

  useEffect(() => {
    // Senza sede non si legge nessun saldo: niente `scuola_id` indovinato nell'URL.
    if (!scuolaId) return;
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/saldo?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
        if (!r.ok) {
          // Es. 403 SEDE_NON_ACCESSIBILE: il saldo di questa sede non si mostra.
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-saldo-rifiutato', route: '/admin/pagamenti', stato: r.status });
          if (active) setSaldoIllegibile(true);
          return;
        }
        const j = (await r.json()) as SaldoCassa | CassaNonDisponibile;
        if (active) setSaldo(j);
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-saldo-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setSaldoIllegibile(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
    // `t` NON è una dipendenza: il testo dell'errore si traduce al render. Tenerla qui
    // rileggeva il saldo a ogni render dove `t` non è stabile (il finto dei test).
  }, [userId, scuolaId]);

  const disponibile = saldo?.disponibile === true;
  const atteso = disponibile ? (saldo as SaldoCassa).saldo_atteso : 0;
  const fondo = disponibile ? (saldo as SaldoCassa).fondo : 0;

  const hasContato = contatoStr.trim() !== '' && Number.isFinite(Number(contatoStr));
  const contato = hasContato ? Number(contatoStr) : 0;
  const differenza = contato - atteso;
  const prelievo = Math.max(contato - fondo, 0);
  const fondoLasciato = Math.min(contato, fondo);

  const [contatoInvalido, setContatoInvalido] = useState(false);

  // Cambio di sede: il saldo in pagina era dell'altra, quindi si toglie SUBITO e si
  // rilegge. La risposta tardiva della sede precedente la scarta il flag `active`.
  // Anche il «Totale contato» (e la sua nota) erano del cassetto dell'altra sede: si
  // azzerano, altrimenti differenza e prelievo si ricalcolerebbero contro il saldo della
  // sede nuova con un numero contato altrove.
  const cambiaSede = (id: string) => {
    if (id === scuolaId) return;
    scegli(id);
    setSaldo(null);
    setSaldoIllegibile(false);
    setLoading(true);
    setError(null);
    setContatoInvalido(false);
    setContatoStr('');
    setNote('');
  };

  const conferma = async () => {
    setError(null);
    setContatoInvalido(false);
    if (!scuolaId) return; // il form non è nemmeno visibile senza sede: difesa in profondità
    if (!hasContato || contato < 0) { setError(t('cassaChiuErrContato')); setContatoInvalido(true); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/pagamenti/cassa/chiusura?userId=${userId}`, {
        method: 'POST',
        headers: hdr(userId),
        // SOLO questi tre campi: il server ricalcola saldo/differenza/prelievo.
        body: JSON.stringify({ scuola_id: scuolaId, contato, note: note.trim() || null }),
      });
      if (res.status === 503) { setError(t('cassaChiuErr503')); return; }
      const j = (await res.json()) as (EsitoChiusura & { error?: string });
      if (res.status === 409) { setError(messaggioDaCorpo(j, t('cassaChiuErr409'))); return; }
      if (!res.ok) { setError(messaggioDaCorpo(j, t('cassaChiuErrSvuot'))); return; }
      setEsito(j);
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-chiusura-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('cassaChiuErroreRete'));
    } finally {
      setSaving(false);
    }
  };

  // Differenza a parole (WCAG 1.4.1): il colore è un rinforzo, non l'unica indicazione.
  const diffBadge = () => {
    if (!hasContato) return null;
    if (differenza > EPS) return <Badge tone="warn">{t('cassaChiuEccedenzaDi')} {formatEuro(differenza)}</Badge>;
    if (differenza < -EPS) return <Badge tone="error">{t('cassaChiuAmmancoDi')} {formatEuro(Math.abs(differenza))}</Badge>;
    return <Badge tone="success">{t('cassaChiuQuadrata')}</Badge>;
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t('cassaChiuSvuotaCassa')}
      labelledBy={TITLE_ID}
      className={MODAL_CARD}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 id={TITLE_ID} className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green">
          <Wallet size={18} /> {t('cassaChiuSvuotaCassa')}
        </h3>
        <button onClick={onClose} aria-label={t('cassaChiuChiudi')} className="-mr-2 flex h-10 w-10 items-center justify-center rounded-pill text-kidville-sub hover:text-kidville-ink"><X size={20} /></button>
      </div>

      <CampoSedeCassa
        id="cassa-chiusura-sede"
        className="mb-3"
        sedi={sedi}
        valore={scuolaId}
        onCambia={cambiaSede}
        disabled={saving || esito !== null}
      />

      {!scuolaId ? (
        <p className="rounded-card bg-kidville-cream/60 px-3 py-6 text-center font-maven text-sm text-kidville-sub">
          {sedi.length === 0 ? t('cassaSedeNessuna') : t('cassaSedeScegliPerSaldo')}
        </p>
      ) : loading ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('cassaChiuCaricamentoSaldo')}</p>
      ) : saldoIllegibile ? (
        <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-6 text-center font-maven text-sm text-kidville-error-strong">
          {t('cassaChiuErrSaldo')}
        </p>
      ) : !disponibile ? (
        <p className="rounded-card bg-kidville-cream/60 px-3 py-6 text-center font-maven text-sm text-kidville-sub">
          {t('cassaChiuNonAttivo')}
        </p>
      ) : esito ? (
        <div className="space-y-3">
          <div role="status" className="flex items-center gap-2 rounded-card bg-kidville-success-soft px-3 py-2.5">
            <Check size={18} className="text-kidville-success-strong" />
            <span className="font-maven text-sm font-bold text-kidville-success-strong">{t('cassaChiuSvuotata')}</span>
          </div>
          <div className="rounded-card bg-kidville-cream/60 p-3 font-maven text-sm text-kidville-ink">
            {sedi.length > 1 && (
              <RigaEsito etichetta={t('cassaSedeLabel')} valore={sedi.find((s) => s.id === scuolaId)?.nome.trim() || scuolaId} />
            )}
            <RigaEsito etichetta={t('cassaChiuEsitoSaldoAtteso')} valore={formatEuro(esito.saldo_atteso)} />
            <RigaEsito etichetta={t('cassaChiuEsitoContato')} valore={formatEuro(esito.contato)} />
            <RigaEsito
              etichetta={t('cassaChiuEsitoDifferenza')}
              valore={esito.differenza === 0 ? t('cassaChiuQuadrata') : `${esito.differenza > 0 ? t('cassaChiuEccedenzaDi') : t('cassaChiuAmmancoDi')} ${formatEuro(Math.abs(esito.differenza))}`}
            />
            <RigaEsito etichetta={t('cassaChiuEsitoPrelevato')} valore={formatEuro(esito.prelevato)} />
            <RigaEsito etichetta={t('cassaChiuEsitoFondoLasciato')} valore={formatEuro(esito.fondo_lasciato)} />
          </div>
          <button onClick={onDone} className={cx(BTN_PRIMARY_AA, 'w-full')}>{t('cassaChiuFatto')}</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-card bg-kidville-cream/60 p-3">
            <div className="flex items-center justify-between font-maven text-sm">
              <span className="text-kidville-sub">{t('cassaChiuSaldoAttesoInCassa')}</span>
              <span className="font-bold text-kidville-green">{formatEuro(atteso)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between font-maven text-xs">
              <span className="text-kidville-sub">{t('cassaChiuFondoCassa')}</span>
              <span className="text-kidville-ink">{formatEuro(fondo)}</span>
            </div>
          </div>

          <div>
            <label htmlFor="cassa-chiusura-contato" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaChiuTotaleContato')}</label>
            <input
              id="cassa-chiusura-contato"
              type="number" min="0" step="0.01" value={contatoStr}
              onChange={(e) => { setContatoStr(e.target.value); if (contatoInvalido) setContatoInvalido(false); }}
              className={INPUT}
              placeholder={t('cassaChiuPlaceholderContato')}
              {...(contatoInvalido ? { 'aria-invalid': true as const, 'aria-describedby': ERRORE_ID } : {})}
            />
          </div>

          {hasContato && (
            <div className="rounded-card border-[1.5px] border-kidville-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-maven text-xs text-kidville-sub">{t('cassaChiuDifferenzaDiCassa')}</span>
                {diffBadge()}
              </div>
              <p className="font-maven text-sm text-kidville-ink">
                {prelievo > EPS
                  ? <>{t('cassaChiuPrelevaPre')}<strong>{formatEuro(prelievo)}</strong>{t('cassaChiuPrelevaMid')}<strong>{formatEuro(fondoLasciato)}</strong>{t('cassaChiuPrelevaPost')}</>
                  : <>{t('cassaChiuNoPrelievoPre')}<strong>{formatEuro(fondoLasciato)}</strong>{t('cassaChiuNoPrelievoPost')}</>}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="cassa-chiusura-note" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaChiuNote')}</label>
            <input id="cassa-chiusura-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} maxLength={500} />
          </div>

          {error && <p id={ERRORE_ID} role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>{t('cassaChiuAnnulla')}</button>
            <button onClick={conferma} disabled={saving} className={cx(BTN_PRIMARY_AA, 'flex-1')}>
              {saving ? t('cassaChiuSvuotamentoInCorso') : t('cassaChiuConfermaSvuotamento')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RigaEsito({ etichetta, valore }: { etichetta: string; valore: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-kidville-sub">{etichetta}</span>
      <span className="font-bold text-kidville-ink">{valore}</span>
    </div>
  );
}
