'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldAlert, Loader2, Trash2, AlertTriangle, UserX } from 'lucide-react';
import { SedeIcon } from '@/components/ui/SedeIcon';
import { cx } from '@/lib/ui/cx';
import { useSediAttive } from '@/lib/context/sede-context';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { AvvisoOblio, type ContiOblio, type StatoMisuraOblio } from './AvvisoOblio';

interface Candidato {
  id: string;
  nome: string;
  cognome: string;
  classe_sezione?: string | null;
  stato?: string | null;
  // Sede del minore (da `gdpr/candidates`). Con tre plessi il nominativo NON è
  // più una chiave: «Rossi Beta / 2 ANNI» può esistere in due sedi.
  scuola_id?: string | null;
  genitori: { id: string; nome: string }[];
}

interface DryRun extends ContiOblio {
  alunno: number;
  parents: number;
  parents_non_anonimizzati: number;
  file_da_rimuovere: number;
  nominativo_conferma: string;
}

// Pannello Diritto all'oblio (DL-034) — riservato alla Direzione (gate server).
// Layout DR: 2 colonne (lista candidati | dettaglio con dry-run + doppia conferma).
// Compliance: la cancellazione ANONIMIZZA (irreversibile), NON elimina fisicamente;
// audit e registri fiscali (fatture) sono preservati per obbligo di legge.
export function OblioPanel({ userId }: { userId: string }) {
  const t = useTranslations('adminAltro');
  // Con più di una sede accessibile ogni candidato porta scritto il suo plesso:
  // qui si conferma un'anonimizzazione IRREVERSIBILE digitando un nominativo, e
  // due bambini omonimi in due sedi renderebbero quella conferma indistinguibile.
  // Con una sola sede l'informazione sarebbe solo rumore e resta nascosta.
  const { sedi } = useSediAttive();
  const piuSedi = sedi.length > 1;
  const nomeSede = (scuolaId?: string | null) =>
    sedi.find((s) => s.id === scuolaId)?.nome ?? t('ricevutiSedeSconosciuta');
  const [list, setList] = useState<Candidato[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<Candidato | null>(null);
  const [dry, setDry] = useState<DryRun | null>(null);
  // A che punto è la misura di «che cosa distrugge». Vale come GATE della
  // conferma: finché non è `ok` il bottone rosso resta spento. Vedi `apri()`.
  const [misura, setMisura] = useState<StatoMisuraOblio>('assente');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const hdr = { 'Content-Type': 'application/json', 'x-user-id': userId };

  const load = useCallback(async () => {
    // niente setLoading(true) sincrono: loading parte true da useState(true)
    // (react-hooks set-state-in-effect); refetch senza spinner, accettato.
    try {
      const res = await fetch('/api/admin/gdpr/candidates', { headers: { 'x-user-id': userId } });
      const j = await res.json();
      if (Array.isArray(j)) setList(j);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { load(); }, [load]);

  // LA MISURA CHE FALLISCE NON PUÒ ESSERE MUTA.
  //
  // Fino al 2026-08-13 questa funzione faceva `if (res.ok) setDry(j)` e basta:
  // niente ramo `else`, niente messaggio. Con il dry-run in errore la schermata
  // restava identica a «non ho ancora scelto nessuno» — le stesse etichette con
  // i due punti e il vuoto dopo — la parola «non misurato» non compariva PROPRIO
  // nel caso in cui nulla era stato misurato, e il bottone rosso restava
  // premibile (il nominativo da digitare arriva comunque dal fallback qui
  // sotto). Cioè: la conferma alla cieca tornava esattamente com'era, in
  // silenzio, e per giunta nel ramo più probabile.
  //
  // ⚠️ QUI NON SI CHIAMA `logClient`, E NON È UNA DIMENTICANZA. Il patch di
  // `fetch` installato da `installaLoggerClient` (`src/instrumentation-client.ts`)
  // logga già OGNI `!res.ok` e ogni rete caduta, con la politica dei livelli in
  // un posto solo (`livelloFetch`): un 500 esce `error`, un 401 non esce affatto
  // perché il server lo ha già registrato. Aggiungere una riga qui sarebbe la
  // terza copia di quella regola — che è esattamente ciò che la testata di
  // `logging/client.ts` vieta, e il modo in cui le copie divergono.
  //
  // Ciò che il log NON può fare, e che manca, è FERMARE la conferma:
  // `misura = 'fallita'` fa comparire il riquadro rosso e SPEGNE il bottone.
  const misuraDi = useCallback(async (c: Candidato) => {
    setDry(null);
    setMisura('in-corso');
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: c.id, mode: 'dryrun' }) });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j || typeof j !== 'object') { setMisura('fallita'); return; }
      setDry(j);
      setMisura('ok');
    } catch {
      // Rete caduta: stessa conseguenza di un 500, e per la stessa ragione. Il
      // `catch` non è muto (AGENTS.md, regola 6) — il patch di `fetch` ha già
      // scritto la riga `POST /api/admin/gdpr/erase — <errore>` prima di
      // rilanciare; qui si aggiunge la sola cosa che manca al log, cioè fermare
      // la conferma.
      setMisura('fallita');
    } finally {
      setBusy(false);
    }
    // `hdr` è ricostruito a ogni render (oggetto letterale): entrarci in
    // dipendenza rifarebbe la misura a ogni giro. Dipende solo da `userId`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const apri = async (c: Candidato) => {
    setTarget(c);
    setConfirm('');
    await misuraDi(c);
  };

  const esegui = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await fetch('/api/admin/gdpr/erase', { method: 'POST', headers: hdr, body: JSON.stringify({ alunno_id: target.id, mode: 'execute', confirm }) });
      const j = await res.json();
      if (!res.ok) { alert(messaggioDaCorpo(j, t('errore'))); return; }
      setTarget(null);
      setMisura('assente');
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 p-6 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={16} /> {t('caricamento')}</div>;

  const nomeConferma = dry?.nominativo_conferma ?? (target ? `${target.cognome} ${target.nome}`.toUpperCase() : '');

  return (
    <div className="space-y-4">
      {/* banner compliance: anonimizza ≠ cancella */}
      <div className="flex items-start gap-3 rounded-2xl border border-kidville-warn/30 bg-kidville-warn-soft p-4">
        <ShieldAlert size={20} className="mt-0.5 shrink-0 text-kidville-warn" />
        <p className="font-maven text-[13px] leading-relaxed text-kidville-ink/80">
          {t.rich('oblioBanner', { strong: (c) => <strong>{c}</strong> })}
        </p>
      </div>

      {/* CHE COSA SI DISTRUGGE, DETTO PRIMA.
          Fino al 2026-08-12 questo riquadro non esisteva e la Direzione confermava
          un'anonimizzazione IRREVERSIBILE leggendo «file da rimuovere: 3». Dentro
          quel numero ci sono le PAGELLE del bambino e i suoi CERTIFICATI MEDICI.
          Il riquadro è lo STESSO componente del pannello delle richieste (che
          fino al 2026-08-13 confermava alla cieca): uno solo, alimentato dal
          dry-run di chi lo mostra — così l'operatore non legge mai numeri che
          appartengono a un altro bambino. */}
      <AvvisoOblio
        stato={misura}
        conti={dry}
        genitoriAnonimizzati={dry ? dry.parents : null}
        onRiprova={target ? () => { void misuraDi(target); } : undefined}
      />

      {list.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-kidville-line bg-kidville-white/60 p-10 text-center">
          <UserX size={26} className="mx-auto text-kidville-muted" />
          <p className="mt-2 font-maven text-sm text-kidville-muted">{t('oblioVuoto')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr] lg:items-start">
          {/* colonna sinistra: candidati */}
          <aside className="rounded-2xl border border-kidville-line bg-kidville-white p-2">
            {list.map((c) => {
              const on = target?.id === c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => apri(c)}
                  className={cx('flex w-full flex-col gap-0.5 rounded-xl px-3 py-2.5 text-left transition-colors', on ? 'bg-kidville-error-soft' : 'hover:bg-kidville-cream')}
                >
                  <span className="flex items-center gap-2 font-barlow text-sm font-extrabold uppercase text-kidville-green">
                    {c.cognome} {c.nome}
                    <span className="rounded-pill bg-kidville-neutral-soft px-2 py-0.5 font-maven text-[10px] font-semibold uppercase text-kidville-muted">{c.stato ?? t('oblioStatoNonIscritto')}</span>
                  </span>
                  <span className="truncate font-maven text-[11.5px] text-kidville-muted">
                    {c.classe_sezione ? t('oblioClasse', { classe: c.classe_sezione }) : ''}{t('oblioGenitori', { elenco: c.genitori.map((g) => g.nome).join(', ') || '—' })}
                  </span>
                  {piuSedi && (
                    <span className="flex items-center gap-1 font-maven text-[11.5px] font-semibold text-kidville-green">
                      <SedeIcon size={12} className="shrink-0" /> {nomeSede(c.scuola_id)}
                    </span>
                  )}
                </button>
              );
            })}
          </aside>

          {/* colonna destra: dettaglio + dry-run + doppia conferma */}
          <section className="rounded-2xl border-t-4 border-kidville-error bg-kidville-white p-5 shadow-sm" style={{ boxShadow: '0 1px 3px rgba(0,84,75,.04), 0 8px 24px -18px rgba(0,84,75,.28)' }}>
            {!target ? (
              <div className="flex flex-col items-center justify-center py-10 text-center">
                <Trash2 size={24} className="text-kidville-muted" />
                <p className="mt-2 font-maven text-sm text-kidville-muted">{t('oblioNonSelezionato')}</p>
              </div>
            ) : (
              <>
                <h3 className="flex items-center gap-2 font-barlow text-xl font-black uppercase tracking-wide text-kidville-error">
                  <AlertTriangle size={20} /> {t('oblioTitoloCancellazione')}
                </h3>
                <p className={cx('mt-2 font-maven text-sm text-kidville-ink/80', piuSedi ? 'mb-2' : 'mb-4')}>
                  {t.rich('oblioAvviso', { nome: `${target.cognome} ${target.nome}`, strong: (c) => <strong>{c}</strong> })}
                </p>
                {/* La sede resta sotto gli occhi anche nel passo di conferma e di
                    esecuzione: è l'ultimo punto in cui l'operazione si può fermare. */}
                {piuSedi && (
                  <p className="mb-4 flex items-center gap-1.5 font-maven text-sm text-kidville-ink/80">
                    <SedeIcon size={14} className="shrink-0 text-kidville-green" /> {t('oblioSede')}{' '}
                    <strong>{nomeSede(target.scuola_id)}</strong>
                  </p>
                )}

                {/* Lo stesso numero non si mostra due volte con due nomi diversi.
                    Qui c'era anche «File personali rimossi: 3», che è
                    ESATTAMENTE il valore mostrato sopra come «Documento
                    d'identità e domanda d'iscrizione: 3»: chi legge non aveva
                    modo di sapere che era lo stesso 3 e non 6. Il numero resta
                    dov'è nominato per quello che è. */}
                {misura === 'in-corso' ? (
                  <div className="flex items-center gap-2 py-3 font-maven text-sm text-kidville-muted"><Loader2 className="animate-spin" size={14} /> {t('oblioDryRun')}</div>
                ) : dry ? (
                  <div className="mb-4 space-y-1 rounded-xl bg-kidville-cream p-3.5 font-maven text-xs text-kidville-ink/80">
                    <div>{t('oblioAnagrafica')} <strong>{dry.alunno}</strong></div>
                    <div>{t('oblioGenitoriAnon')} <strong>{dry.parents}</strong></div>
                    {dry.parents_non_anonimizzati > 0 && <div className="text-kidville-warn">{t('oblioGenitoriMantenuti', { n: dry.parents_non_anonimizzati })}</div>}
                  </div>
                ) : null}

                <label className="mb-1.5 block font-maven text-xs font-semibold text-kidville-muted">
                  {t('oblioConfermaDigita')} <span className="font-mono text-kidville-error">{nomeConferma}</span>
                </label>
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder={t('oblioPlaceholderNome')}
                  className="mb-4 w-full rounded-xl border-2 border-kidville-line px-3 py-2 text-sm outline-none focus:border-kidville-error"
                />

                <div className="flex justify-end gap-3">
                  <button onClick={() => { setTarget(null); setMisura('assente'); }} className="rounded-pill border border-kidville-line px-4 py-2 font-maven text-sm text-kidville-muted hover:bg-kidville-cream">{t('annulla')}</button>
                  {/* `misura !== 'ok'` È IL GATE, non un dettaglio di stato:
                      un'anonimizzazione irreversibile non si conferma su numeri
                      che nessuno ha letto. Prima bastava digitare il nominativo
                      — che il fallback fornisce comunque — e il bottone partiva
                      anche col dry-run caduto. Chi vuole procedere ha il
                      «Riprova la misura» nel riquadro rosso qui sopra. */}
                  <button
                    disabled={busy || !confirm.trim() || misura !== 'ok'}
                    onClick={esegui}
                    className="rounded-pill bg-kidville-error px-5 py-2 font-barlow text-sm font-black uppercase tracking-wider text-kidville-white hover:opacity-90 disabled:opacity-50"
                  >
                    {busy ? t('oblioBtnAnonimizzando') : t('oblioBtnAnonimizza')}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
