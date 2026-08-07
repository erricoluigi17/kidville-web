'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useParentIdentity } from '@/lib/auth/use-parent-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { AlertCircle, Check } from 'lucide-react';
import { PageHeaderCard } from '@/components/ui/PageHeaderCard';
import { Btn } from '@/components/ui/Btn';
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch';
import { ComunicaAssenzaCard } from '@/components/features/parent/ComunicaAssenzaCard';

interface Presenza {
  id: string; data: string; stato: string;
  orario_entrata: string | null; orario_uscita: string | null;
  giustificata: boolean; giustificazione_testo: string | null;
  giustificata_il: string | null; note_appello: string | null;
}

// Le pillole di stato usano gli inchiostri FORTI, non le tinte di riempimento.
// Misurate a 11px (testo normale: la soglia è 4,5:1, non 3:1):
//   · `error` #E53935 su `error-soft` = 3,70:1 → `error-strong` #C62828 = 4,92:1
//   · `info`  #2A6FDB su `info-soft`  = 4,20:1 → `info-strong`  #1D4FA8 = 6,70:1
// `warn` resta scritto così perché `globals.css` lo RIMAPPA per intero a
// `warn-strong` (rete del 2026-08-02): a schermo è già 4,95:1. Sono gli stessi
// token che RIEPILOGO_TILES usa dieci righe più giù — la coerenza fra la pillola
// e il riquadro che la conta non era mai stata fatta.
const STATO_LABEL: Record<string, { labelKey: string; cls: string }> = {
  assente: { labelKey: 'assenzeStato_assente', cls: 'bg-kidville-error-soft text-kidville-error-strong' },
  ritardo: { labelKey: 'assenzeStato_ritardo', cls: 'bg-kidville-warn-soft text-kidville-warn' },
  uscita_anticipata: { labelKey: 'assenzeStato_uscita_anticipata', cls: 'bg-kidville-info-soft text-kidville-info-strong' },
};

interface Riepilogo {
  presente: number; assente: number; ritardo: number; uscita_anticipata: number;
}

// Riquadri del riepilogo in cima: un contatore per stato (presente incluso), coi
// token di contrasto *-strong su fondo *-soft. Senza il conteggio dei presenti un
// bambino a scuola era indistinguibile da un appello mai fatto (falla del collaudo).
const RIEPILOGO_TILES: { key: keyof Riepilogo; labelKey: string; cls: string }[] = [
  { key: 'presente', labelKey: 'assenzeTilePresenze', cls: 'bg-kidville-success-soft text-kidville-success-strong' },
  { key: 'assente', labelKey: 'assenzeTileAssenze', cls: 'bg-kidville-error-soft text-kidville-error-strong' },
  { key: 'ritardo', labelKey: 'assenzeTileRitardi', cls: 'bg-kidville-warn-soft text-kidville-warn-strong' },
  { key: 'uscita_anticipata', labelKey: 'assenzeTileUsciteAnt', cls: 'bg-kidville-info-soft text-kidville-info-strong' },
];

function oraDaTs(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function AssenzeGenitore() {
  const { parentId, studentId, ready } = useParentIdentity();
  const t = useTranslations('parentPrimaria');
  const f = useDateFormat();
  const [presenze, setPresenze] = useState<Presenza[]>([]);
  const [riepilogo, setRiepilogo] = useState<Riepilogo | null>(null);
  const [loading, setLoading] = useState(true);

  // Flusso giustifica con OTP/FES (backend esistente: /giustifica/otp + /giustifica).
  const [otpState, setOtpState] = useState<{ ticket: string; expiry: number; devCode?: string } | null>(null);
  const [otpTarget, setOtpTarget] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState('');
  const [motivo, setMotivo] = useState('');
  const [firmando, setFirmando] = useState(false);
  const [msg, setMsg] = useState('');

  const carica = useCallback(() => {
    if (!ready || !parentId || !studentId) return;
    fetch(`/api/parent/primaria/assenze?studentId=${studentId}&userId=${parentId}`, {
      headers: { 'x-user-id': parentId },
    })
      .then((r) => r.json())
      .then((d) => { if (d.success) { setPresenze(d.data); setRiepilogo(d.riepilogo ?? null); } })
      .finally(() => setLoading(false));
  }, [ready, studentId, parentId]);

  useEffect(() => { carica(); }, [carica]);

  const avviaGiustifica = async (presenzaId: string) => {
    if (!parentId) return;
    setMsg(''); setOtpTarget(presenzaId); setOtpCode(''); setMotivo('');
    const r = await fetch(`/api/parent/presenze/giustifica/otp?userId=${parentId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
    });
    const d = await r.json();
    // Niente prosa del server: è italiana per costruzione (T10-F1).
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('assenzeErroreOtp'))); setOtpTarget(null); return; }
    setOtpState(d.data);
  };

  const confermaGiustifica = async (p: Presenza) => {
    if (!otpState || !parentId) return;
    setFirmando(true);
    const r = await fetch(`/api/parent/presenze/giustifica?userId=${parentId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
      body: JSON.stringify({ studentId, data: p.data, motivo, code: otpCode, expiry: otpState.expiry, ticket: otpState.ticket }),
    });
    const d = await r.json();
    setFirmando(false);
    if (!r.ok) { setMsg(soloCatalogoDaCorpo(d, t('assenzeGiustNonRiuscita'))); return; }
    setOtpState(null); setOtpCode(''); setOtpTarget(null); setMotivo('');
    setMsg(t('assenzeGiustificataMsg'));
    carica();
  };

  const annulla = () => { setOtpTarget(null); setOtpState(null); setOtpCode(''); setMotivo(''); };

  const nonGiustificate = presenze.filter((p) => !p.giustificata);

  return (
    <div className="px-4 pt-5 pb-24">
      <PageHeaderCard
        eyebrow={t('eyebrow')}
        title={t('assenzeTitolo')}
        subtitle={t('assenzeSottotitolo')}
        className="mb-4"
      />

      {loading ? (
        <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>
      ) : (
        <div className="space-y-4">
          {/* Riepilogo: un contatore per stato (presenti inclusi). */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RIEPILOGO_TILES.map((tile) => (
              <div key={tile.key} className={`rounded-2xl px-3 py-3 ${tile.cls}`}>
                <p className="font-maven text-2xl font-bold leading-none">{riepilogo?.[tile.key] ?? 0}</p>
                <p className="font-maven text-xs mt-1 font-semibold">{t(tile.labelKey)}</p>
              </div>
            ))}
          </div>

          {/* Inchiostri FORTI anche qui: `success` su `success-soft` vale 2,89:1
              e `error` su `error-soft` 3,70:1 — cioè la fascia che dice com'è
              andata la firma era la meno leggibile della schermata. */}
          {msg && (
            <p className={`font-maven text-sm rounded-2xl px-4 py-2 ${msg.includes('✓') ? 'bg-kidville-success-soft text-kidville-success-strong' : 'bg-kidville-error-soft text-kidville-error-strong'}`}>{msg}</p>
          )}
          {nonGiustificate.length > 0 && (
            <div className="rounded-2xl bg-kidville-warn-soft border border-kidville-warn/30 px-4 py-3 flex items-center gap-2">
              <AlertCircle size={16} className="text-kidville-warn shrink-0" />
              <p className="font-maven text-sm text-kidville-warn">
                {t('assenzeNonGiustBanner', { count: nonGiustificate.length })}
              </p>
            </div>
          )}

          {/*
            Comunicare un'assenza IN ANTICIPO. Sta sopra la cronologia perché è
            l'azione; l'elenco sotto è consultazione e giustifica a posteriori.
            La card si legge da sé le assenze già comunicate (route
            `parent/presenze`, campo `comunicate`) e qui chiede solo di rileggere
            la cronologia: la riga appena creata è una `presenze` a tutti gli
            effetti e comparirebbe altrimenti solo dopo un ricaricamento a mano.
          */}
          <ComunicaAssenzaCard studentId={studentId} parentId={parentId} onAggiornato={carica} />

          <h2 className="font-maven text-sm font-semibold text-kidville-ink pt-1">
            {t('assenzeSezioneTitolo')}
          </h2>

          {presenze.length === 0 ? (
            <p className="font-maven text-sm text-kidville-sub">{t('assenzeVuoto')}</p>
          ) : (
          <div className="space-y-3">
          {presenze.map((p) => {
            const meta = STATO_LABEL[p.stato];
            const statoLabel = meta ? t(meta.labelKey) : p.stato;
            const statoCls = meta ? meta.cls : 'bg-kidville-neutral-soft text-kidville-sub';
            return (
              <div key={p.id} className="rounded-2xl bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-maven font-semibold ${statoCls}`}>{statoLabel}</span>
                    <span className="font-maven text-sm font-semibold text-kidville-ink">
                      {intlDateTime(f.locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(p.data))}
                    </span>
                  </div>
                  {/* `success-strong` (7,87:1 su bianco) e non `success`
                      (3,30:1): è il verde del RIEMPIMENTO, non un inchiostro.
                      `warn` è già rimappato a `warn-strong` da globals.css. */}
                  <span className={`font-maven text-xs ${p.giustificata ? 'text-kidville-success-strong' : 'text-kidville-warn'}`}>
                    {p.giustificata ? t('assenzeGiustificata') : t('assenzeDaGiustificare')}
                  </span>
                </div>

                {(p.stato === 'ritardo' && p.orario_entrata) && (
                  <p className="font-maven text-xs text-kidville-sub">{t('assenzeEntrata', { ora: oraDaTs(p.orario_entrata) })}</p>
                )}
                {(p.stato === 'uscita_anticipata' && p.orario_uscita) && (
                  <p className="font-maven text-xs text-kidville-sub">{t('assenzeUscita', { ora: oraDaTs(p.orario_uscita) })}</p>
                )}
                {p.giustificazione_testo && (
                  <p className="font-maven text-xs text-kidville-sub mt-1 italic">&ldquo;{p.giustificazione_testo}&rdquo;</p>
                )}
                {p.note_appello && (
                  <p className="font-maven text-xs text-kidville-sub mt-0.5">{t('assenzeNotaDocente', { value: p.note_appello })}</p>
                )}

                {/* Azione giustifica (backend esistente con OTP) */}
                {!p.giustificata && otpTarget !== p.id && (
                  <Btn
                    variant="primary"
                    size="sm"
                    onClick={() => avviaGiustifica(p.id)}
                    className="mt-3"
                  >
                    <Check size={14} /> {t('assenzeGiustifica')}
                  </Btn>
                )}

                {/* Conferma OTP/FES inline */}
                {otpTarget === p.id && otpState && (
                  <div className="mt-3 border-t border-kidville-line pt-3 space-y-2">
                    <textarea
                      value={motivo} onChange={(e) => setMotivo(e.target.value)}
                      placeholder={t('assenzeMotivoPlaceholder')}
                      className="w-full h-16 resize-none rounded-xl border border-kidville-line p-2 font-maven text-sm focus:border-kidville-green focus:outline-none"
                    />
                    <p className="font-maven text-sm text-kidville-sub">{t('otpIstruzione')}</p>
                    {otpState.devCode && (
                      <p className="font-maven text-xs text-kidville-warn">{t('devLabel')} <b>{otpState.devCode}</b></p>
                    )}
                    <div className="flex gap-2">
                      <input
                        type="text" value={otpCode} onChange={(e) => setOtpCode(e.target.value)}
                        placeholder="000000"
                        className="font-maven rounded-full border border-kidville-line px-3 py-1.5 text-sm w-28 text-center tracking-widest"
                      />
                      <Btn
                        variant="primary"
                        size="sm"
                        onClick={() => confermaGiustifica(p)}
                        disabled={firmando || !otpCode}
                      >
                        {firmando ? t('assenzeInvio') : t('conferma')}
                      </Btn>
                      {/* Era un `<button>` nudo dipinto di grigio: nessun fondo,
                          nessun bordo, e il suo unico segnale era un inchiostro a
                          2,51:1 — un COMANDO che non si vedeva essere un comando
                          (WCAG 1.4.11 oltre a 1.4.3). Ora è la stessa pillola
                          `ghost` usata per le azioni secondarie altrove: contorno
                          verde a 6,51:1 sul bianco della card. */}
                      <Btn variant="ghost" size="sm" onClick={annulla}>{t('annulla')}</Btn>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function AssenzeGenitorePage() {
  const t = useTranslations('parentPrimaria');
  return (
    <Suspense fallback={<div className="p-8 font-maven text-kidville-sub">{t('caricamento')}</div>}>
      <AssenzeGenitore />
    </Suspense>
  );
}
