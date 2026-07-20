'use client';

// ─── Modale «Svuota cassa» (chiusura on-demand, solo admin) ────────────────────
// Legge il saldo atteso dal server (GET /cassa/saldo), chiede il TOTALE CONTATO e
// mostra dal vivo la differenza — comunicata A PAROLE («Ammanco di …») e non solo
// col colore (WCAG 1.4.1) — più il riepilogo del prelievo. Alla conferma invia
// SOLO { scuola_id, contato, note }: il saldo atteso, la differenza e il prelievo
// li ricalcola il server (non ci si fida del client). Solo token `kidville-*`.

import { useEffect, useState } from 'react';
import { X, Wallet, Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Badge';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient } from '@/lib/logging/client';
import type { SaldoCassa, CassaNonDisponibile } from '@/lib/cassa/tipi';

interface Props {
  userId: string;
  scuolaId: string;
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
const testoErrore = (e: unknown) => (e instanceof Error ? e.message : String(e));
const TITLE_ID = 'cassa-chiusura-title';
const EPS = 0.005;

export function CassaChiusuraModal({ userId, scuolaId, onClose, onDone, returnFocusRef }: Props) {
  const [saldo, setSaldo] = useState<SaldoCassa | CassaNonDisponibile | null>(null);
  const [loading, setLoading] = useState(true);
  const [contatoStr, setContatoStr] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [esito, setEsito] = useState<EsitoChiusura | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/saldo?userId=${userId}&scuola_id=${scuolaId}`, { headers: hdr(userId) });
        const j = (await r.json()) as SaldoCassa | CassaNonDisponibile;
        if (active) setSaldo(j);
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `GET saldo cassa (chiusura) — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setError('Impossibile leggere il saldo di cassa.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId]);

  const disponibile = saldo?.disponibile === true;
  const atteso = disponibile ? (saldo as SaldoCassa).saldo_atteso : 0;
  const fondo = disponibile ? (saldo as SaldoCassa).fondo : 0;

  const hasContato = contatoStr.trim() !== '' && Number.isFinite(Number(contatoStr));
  const contato = hasContato ? Number(contatoStr) : 0;
  const differenza = contato - atteso;
  const prelievo = Math.max(contato - fondo, 0);
  const fondoLasciato = Math.min(contato, fondo);

  const conferma = async () => {
    setError(null);
    if (!hasContato || contato < 0) { setError('Inserisci il totale contato (un numero maggiore o uguale a zero).'); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/pagamenti/cassa/chiusura?userId=${userId}`, {
        method: 'POST',
        headers: hdr(userId),
        // SOLO questi tre campi: il server ricalcola saldo/differenza/prelievo.
        body: JSON.stringify({ scuola_id: scuolaId, contato, note: note.trim() || null }),
      });
      if (res.status === 503) { setError('Il modulo cassa non è ancora attivo su questo ambiente.'); return; }
      const j = (await res.json()) as (EsitoChiusura & { error?: string });
      if (res.status === 409) { setError(j.error ?? 'Chiusura non possibile in questo momento.'); return; }
      if (!res.ok) { setError(j.error ?? 'Errore durante lo svuotamento.'); return; }
      setEsito(j);
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `POST chiusura cassa — ${testoErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError('Errore di rete: riprova.');
    } finally {
      setSaving(false);
    }
  };

  // Differenza a parole (WCAG 1.4.1): il colore è un rinforzo, non l'unica indicazione.
  const diffBadge = () => {
    if (!hasContato) return null;
    if (differenza > EPS) return <Badge tone="warn">Eccedenza di {formatEuro(differenza)}</Badge>;
    if (differenza < -EPS) return <Badge tone="error">Ammanco di {formatEuro(Math.abs(differenza))}</Badge>;
    return <Badge tone="success">Cassa quadrata</Badge>;
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Svuota cassa"
      labelledBy={TITLE_ID}
      className={MODAL_CARD}
      style={{ boxShadow: MODAL_SHADOW }}
      returnFocusRef={returnFocusRef}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 id={TITLE_ID} className="flex items-center gap-2 font-barlow text-lg font-black uppercase text-kidville-green">
          <Wallet size={18} /> Svuota cassa
        </h3>
        <button onClick={onClose} aria-label="Chiudi" className="text-kidville-muted hover:text-kidville-ink"><X size={20} /></button>
      </div>

      {loading ? (
        <p className="py-8 text-center font-maven text-sm text-kidville-muted">Caricamento del saldo…</p>
      ) : !disponibile ? (
        <p className="rounded-card bg-kidville-cream/60 px-3 py-6 text-center font-maven text-sm text-kidville-muted">
          Modulo cassa non ancora attivo su questo ambiente.
        </p>
      ) : esito ? (
        <div className="space-y-3">
          <div role="status" className="flex items-center gap-2 rounded-card bg-kidville-success-soft px-3 py-2.5">
            <Check size={18} className="text-kidville-success" />
            <span className="font-maven text-sm font-bold text-kidville-success">Cassa svuotata correttamente.</span>
          </div>
          <div className="rounded-card bg-kidville-cream/60 p-3 font-maven text-sm text-kidville-ink">
            <RigaEsito etichetta="Saldo atteso" valore={formatEuro(esito.saldo_atteso)} />
            <RigaEsito etichetta="Contato" valore={formatEuro(esito.contato)} />
            <RigaEsito
              etichetta="Differenza"
              valore={esito.differenza === 0 ? 'Cassa quadrata' : `${esito.differenza > 0 ? 'Eccedenza' : 'Ammanco'} di ${formatEuro(Math.abs(esito.differenza))}`}
            />
            <RigaEsito etichetta="Prelevato" valore={formatEuro(esito.prelevato)} />
            <RigaEsito etichetta="Fondo lasciato in cassa" valore={formatEuro(esito.fondo_lasciato)} />
          </div>
          <button onClick={onDone} className={cx(BTN_PRIMARY_AA, 'w-full')}>Fatto</button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-card bg-kidville-cream/60 p-3">
            <div className="flex items-center justify-between font-maven text-sm">
              <span className="text-kidville-sub">Saldo atteso in cassa</span>
              <span className="font-bold text-kidville-green">{formatEuro(atteso)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between font-maven text-xs">
              <span className="text-kidville-sub">Fondo cassa (resta dopo lo svuotamento)</span>
              <span className="text-kidville-ink">{formatEuro(fondo)}</span>
            </div>
          </div>

          <div>
            <label htmlFor="cassa-chiusura-contato" className="mb-1 block font-maven text-xs text-kidville-sub">Totale contato (€)</label>
            <input
              id="cassa-chiusura-contato"
              type="number" min="0" step="0.01" value={contatoStr}
              onChange={(e) => setContatoStr(e.target.value)}
              className={INPUT}
              placeholder="Quanto contante hai davvero contato"
            />
          </div>

          {hasContato && (
            <div className="rounded-card border-[1.5px] border-kidville-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-maven text-xs text-kidville-sub">Differenza di cassa:</span>
                {diffBadge()}
              </div>
              <p className="font-maven text-sm text-kidville-ink">
                {prelievo > EPS
                  ? <>Preleva <strong>{formatEuro(prelievo)}</strong> e lascia <strong>{formatEuro(fondoLasciato)}</strong> di fondo in cassa.</>
                  : <>Non c&apos;è nulla da prelevare: in cassa restano <strong>{formatEuro(fondoLasciato)}</strong> di fondo.</>}
              </p>
            </div>
          )}

          <div>
            <label htmlFor="cassa-chiusura-note" className="mb-1 block font-maven text-xs text-kidville-sub">Note (facoltative)</label>
            <input id="cassa-chiusura-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} className={INPUT} maxLength={500} />
          </div>

          {error && <p role="alert" className="font-maven text-xs text-kidville-error-strong">{error}</p>}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>Annulla</button>
            <button onClick={conferma} disabled={saving} className={cx(BTN_PRIMARY_AA, 'flex-1')}>
              {saving ? 'Svuotamento…' : 'Conferma svuotamento'}
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
