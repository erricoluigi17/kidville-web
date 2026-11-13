'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { Drawer, TABLE, TABLE_WRAP, TD, TH, TROW } from '@/components/ui/cockpit'
import { DateTimeField } from '@/components/ui/DateTimeField'
import { StatoElenco, testiStatoElenco } from '@/components/ui/StatoElenco'
import { bcp47 } from '@/i18n/config'
import { formatData } from '@/lib/i18n/date'
import type { DettaglioVotazione as DettaglioDati, RisultatoScheda } from '@/lib/votazioni/tipi'
import { useCorrezioneAnno } from '@/components/features/anno/useCorrezioneAnno'
import { leggiDettaglio, scrivi, type LetturaDettaglio } from './chiamate'
import { cifreLocali, stessoIstante } from './scadenza'

/**
 * VOTAZIONI · IL DETTAGLIO DI UNA VOTAZIONE (pannello laterale).
 *
 * Testata (titolo, stato, scadenza), poi UNA sezione per scheda — classe o istituto: nome, affluenza («12 su 30
 * hanno votato»), i candidati con i voti, l'esito e, sotto, «chi ha votato chi». Le azioni stanno in fondo.
 *
 * ── L'ESITO ─────────────────────────────────────────────────────────────────────────
 * `eletti` ha UN elemento (eletto), più di uno (parità: decide la segreteria, e il testo dice fra chi) o nessuno.
 * I nomi si ricavano dai `candidati` della stessa scheda; i pari si elencano con `Intl.ListFormat` nella lingua
 * dell'app («A, B e C»). Nessuna percentuale: con `aventiDiritto` a 0 (una classe senza genitori con account) la
 * divisione darebbe NaN, e «0 su 0» dice già tutto.
 *
 * ── QUALI AZIONI, E PERCHÉ ──────────────────────────────────────────────────────────
 *  · «Chiudi ora» solo se `stato === 'aperta'`: chiudere una votazione già chiusa è un 409;
 *  · «Proroga» solo se `chiusaIl === null`: una votazione chiusa A MANO non si riapre con una proroga (il server
 *    risponde 409), mentre una SCADUTA da sola sì — la proroga la riapre;
 *  · «Elimina» solo con `votanti === 0`: con dei voti dentro non si cancella (409 `VOTAZIONE_CON_VOTI`).
 * Ognuna chiede conferma nello stesso pannello, non in una finestra sopra (un dialogo dentro un pannello è un
 * trabocchetto per la tastiera). Se il server dice che lo stato è cambiato nel frattempo (già chiusa, con voti),
 * la schermata RILEGGE e avvisa l'elenco: mostrare di nuovo gli stessi comandi sarebbe farli sbagliare.
 *
 * ── LA LETTURA ──────────────────────────────────────────────────────────────────────
 * Il risultato porta la votazione per cui è stato chiesto (`per`): se `votazioneId` cambia, quello vecchio si
 * scarta e si vede «caricamento», mai la votazione sbagliata. Rileggere dopo un'azione NON svuota la vista (il
 * messaggio dell'azione resta, i dati si aggiornano a risposta arrivata).
 */

const CAMPO =
  'min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-kidville-ink'

type Lettura = LetturaDettaglio & { per: string }

export function DettaglioVotazione({
  votazioneId,
  onChiudi,
  onCambiata,
  onEliminata,
}: {
  votazioneId: string
  onChiudi: () => void
  /** Lo stato è cambiato (chiusa, prorogata, o il server ha detto che era già cambiato): l'elenco va riletto. */
  onCambiata: () => void
  /** La votazione non c'è più. */
  onEliminata: () => void
}) {
  const t = useTranslations('votazioniAdmin')
  const ts = useTranslations('shared')
  const locale = useLocale()

  const [lettura, setLettura] = useState<Lettura | null>(null)
  const [tentativo, setTentativo] = useState(0)
  useEffect(() => {
    let vivo = true
    void leggiDettaglio(votazioneId).then((esito) => {
      if (vivo) setLettura({ ...esito, per: votazioneId })
    })
    return () => {
      vivo = false
    }
  }, [votazioneId, tentativo])
  const corrente = lettura?.per === votazioneId ? lettura : null

  const rileggi = () => setTentativo((n) => n + 1)
  const riprova = () => {
    setLettura(null)
    rileggi()
  }

  const votazione = corrente?.esito === 'ok' ? corrente.votazione : null

  const sottotitolo = votazione && (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Badge tone={votazione.stato === 'aperta' ? 'success' : 'neutral'}>
        {votazione.stato === 'aperta' ? t('statoAperta') : t('statoChiusa')}
      </Badge>
      <span>{t('intestazioneScadenza', { data: formatData(votazione.scadenza, locale, 'dataOra') })}</span>
      {votazione.chiusaIl && <span>{t('intestazioneChiusaIl', { data: formatData(votazione.chiusaIl, locale, 'dataOra') })}</span>}
    </span>
  )

  return (
    <Drawer
      open
      onClose={onChiudi}
      width={760}
      pieno
      title={votazione ? votazione.titolo : t('dettaglioTitolo')}
      subtitle={sottotitolo || undefined}
    >
      {corrente === null && (
        <StatoElenco stato="caricamento" testi={{ ...testiStatoElenco(ts) }} />
      )}
      {corrente?.esito === 'errore' && (
        <StatoElenco
          stato="errore"
          testi={{ ...testiStatoElenco(ts), erroreTitolo: t('dettaglioErroreTitolo'), erroreCorpo: t('dettaglioErroreCorpo') }}
          onRiprova={riprova}
        />
      )}
      {corrente?.esito === 'non-trovata' && (
        <p role="status" className="py-12 text-center font-maven text-sm text-kidville-sub">
          {t('dettaglioNonTrovata')}
        </p>
      )}
      {votazione && (
        <div className="space-y-6">
          {votazione.schede.map((s) => (
            <SchedaRisultato key={`${s.ambito}:${s.sectionId ?? 'istituto'}`} scheda={s} locale={locale} />
          ))}
          <AzioniVotazione
            key={votazione.id}
            votazione={votazione}
            onCambiata={() => {
              rileggi()
              onCambiata()
            }}
            onEliminata={onEliminata}
          />
        </div>
      )}
    </Drawer>
  )
}

// ── Una scheda ──────────────────────────────────────────────────────────────────────

function SchedaRisultato({ scheda, locale }: { scheda: RisultatoScheda; locale: string }) {
  const t = useTranslations('votazioniAdmin')
  const idTitolo = useId()

  const titolo =
    scheda.ambito === 'istituto' ? t('schedaIstituto', { nomeSede: scheda.nome }) : t('schedaClasse', { nome: scheda.nome })

  const nomiEletti = scheda.eletti.map((id) => scheda.candidati.find((c) => c.utenteId === id)?.nome ?? '—')
  const esito =
    nomiEletti.length === 0
      ? t('esitoNessunVoto')
      : nomiEletti.length === 1
        ? t('esitoEletto', { nome: nomiEletti[0] })
        : t('esitoParita', { nomi: new Intl.ListFormat(bcp47(locale), { style: 'long', type: 'conjunction' }).format(nomiEletti) })

  return (
    <section aria-labelledby={idTitolo} className="space-y-3 rounded-2xl border border-kidville-line p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={idTitolo} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {titolo}
        </h3>
        <p className="font-maven text-sm text-kidville-sub">{t('affluenza', { votanti: scheda.votanti, aventi: scheda.aventiDiritto })}</p>
      </div>

      {scheda.candidati.length > 0 && (
        <div className={TABLE_WRAP}>
          <table className={TABLE} aria-labelledby={idTitolo}>
            <thead>
              <tr>
                <th scope="col" className={TH}>{t('colCandidato')}</th>
                <th scope="col" className={TH}>{t('colVoti')}</th>
              </tr>
            </thead>
            <tbody>
              {scheda.candidati.map((c) => (
                <tr key={c.utenteId} className={TROW}>
                  <td className={`${TD} font-maven text-sm text-kidville-ink`}>{c.nome}</td>
                  <td className={`${TD} font-maven text-sm font-bold text-kidville-ink`}>{c.voti}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="font-maven text-sm font-bold text-kidville-ink">{esito}</p>

      {scheda.voti.length > 0 && (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <caption className="pb-2 text-left font-maven text-xs font-semibold text-kidville-sub">
              {t('chiCaption', { scheda: titolo })}
            </caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>{t('colElettore')}</th>
                <th scope="col" className={TH}>{t('colScelta')}</th>
                <th scope="col" className={TH}>{t('colOra')}</th>
              </tr>
            </thead>
            <tbody>
              {scheda.voti.map((v) => (
                <tr key={v.elettoreId} className={TROW}>
                  <td className={`${TD} font-maven text-sm text-kidville-ink`}>{v.elettoreNome}</td>
                  <td className={`${TD} font-maven text-sm text-kidville-ink`}>{v.candidatoNome}</td>
                  <td className={`${TD} font-maven text-sm text-kidville-ink`}>
                    {/* Il voto cambiato mostra l'ora dell'ULTIMA scelta, e lo dice: l'altra è sparita. */}
                    <span>{formatData(v.aggiornatoIl ?? v.votatoIl, locale, 'dataOra')}</span>
                    {v.aggiornatoIl && (
                      <Badge tone="warn" className="ml-2">
                        {t('modificato')}
                      </Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

// ── Le azioni ───────────────────────────────────────────────────────────────────────

type Pannello = 'chiudi' | 'proroga' | 'elimina'
type Messaggio = { tipo: 'ok' | 'errore'; testo: string }

function AzioniVotazione({
  votazione,
  onCambiata,
  onEliminata,
}: {
  votazione: DettaglioDati
  onCambiata: () => void
  onEliminata: () => void
}) {
  const t = useTranslations('votazioniAdmin')
  const idBase = useId()
  const idProroga = `${idBase}-proroga`
  const idData = `${idBase}-data`
  const idOra = `${idBase}-ora`
  const percorso = `/api/admin/votazioni/${encodeURIComponent(votazione.id)}`

  const [pannello, setPannello] = useState<Pannello | null>(null)
  const [nuovaScadenza, setNuovaScadenza] = useState('')
  const [inCorso, setInCorso] = useState(false)
  const [messaggio, setMessaggio] = useState<Messaggio | null>(null)
  const lavoroRef = useRef(false)
  // Chiudere, prorogare o eliminare una votazione di un anno già chiuso è una CORREZIONE (PR 4.9): il server risponde 409 con
  // `correzione_possibile` e il nome dell'anno, il dialogo chiede il motivo e la richiesta riparte con `correzione` nel corpo.
  const { inviaConCorrezione, dialogo } = useCorrezioneAnno()

  const puoChiudere = votazione.stato === 'aperta'
  const puoProrogare = votazione.chiusaIl === null
  const puoEliminare = votazione.votanti === 0

  /** Una scrittura alla volta: un secondo clic mentre la prima è in volo non fa niente. */
  const lavora = async (corpo: () => Promise<void>) => {
    if (lavoroRef.current) return
    lavoroRef.current = true
    setInCorso(true)
    setMessaggio(null)
    try {
      await corpo()
    } finally {
      lavoroRef.current = false
      setInCorso(false)
    }
  }

  const chiudi = () =>
    lavora(async () => {
      const r = await scrivi('PATCH', percorso, { azione: 'chiudi' }, t('erroreAzione'), 'votazioni-chiudi', inviaConCorrezione)
      setPannello(null)
      if (r.ok) {
        setMessaggio({ tipo: 'ok', testo: t('chiusaFatto') })
        onCambiata()
      } else if (r.codice === 'VOTAZIONE_CHIUSA') {
        // Era già chiusa (da una collega, o per scadenza): il testo del catalogo parla ai genitori, qui si parla alla
        // segreteria, e si rilegge perché la schermata mostrava uno stato vecchio.
        setMessaggio({ tipo: 'errore', testo: t('erroreGiaChiusa') })
        onCambiata()
      } else {
        setMessaggio({ tipo: 'errore', testo: r.testo })
      }
    })

  const prorogaCambiata = nuovaScadenza !== '' && !stessoIstante(nuovaScadenza, votazione.scadenza)
  const proroga = () =>
    lavora(async () => {
      if (!prorogaCambiata) return
      const r = await scrivi(
        'PATCH',
        percorso,
        { azione: 'proroga', scadenza: cifreLocali(nuovaScadenza) },
        t('erroreAzione'),
        'votazioni-proroga',
        inviaConCorrezione,
      )
      if (r.ok) {
        setPannello(null)
        setMessaggio({ tipo: 'ok', testo: t('prorogaFatto') })
        onCambiata()
      } else if (r.codice === 'VOTAZIONE_CHIUSA') {
        setPannello(null)
        setMessaggio({ tipo: 'errore', testo: r.testo })
        onCambiata()
      } else {
        // Il pannello RESTA aperto coi suoi valori: si cambia la data e si riprova.
        setMessaggio({ tipo: 'errore', testo: r.testo })
      }
    })

  const elimina = () =>
    lavora(async () => {
      // Corpo JSON vuoto (non assente): su un anno chiuso la correzione viaggia lì dentro, mai nella URL.
      const r = await scrivi('DELETE', percorso, {}, t('erroreAzione'), 'votazioni-elimina', inviaConCorrezione)
      setPannello(null)
      if (r.ok || r.codice === 'VOTAZIONE_NON_TROVATA') {
        // Già eliminata da una collega vale come eliminata: il risultato voluto c'è.
        onEliminata()
      } else {
        setMessaggio({ tipo: 'errore', testo: r.testo })
        // Qualcuno ha votato nel frattempo: lo stato mostrato è vecchio, e «Elimina» non deve restare lì.
        if (r.codice === 'VOTAZIONE_CON_VOTI') onCambiata()
      }
    })

  const apriProroga = () => {
    setMessaggio(null)
    setNuovaScadenza(votazione.scadenza)
    setPannello('proroga')
  }
  const apriConferma = (p: 'chiudi' | 'elimina') => {
    setMessaggio(null)
    setPannello(p)
  }

  return (
    <div className="space-y-3 border-t border-kidville-line pt-4">
      {messaggio?.tipo === 'errore' && (
        <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{messaggio.testo}</span>
        </div>
      )}
      {messaggio?.tipo === 'ok' && (
        <p role="status" className="font-maven text-sm font-semibold text-kidville-green">
          {messaggio.testo}
        </p>
      )}

      {pannello === null && (
        <div className="flex flex-wrap items-center gap-2">
          {puoChiudere && <Btn variant="secondary" onClick={() => apriConferma('chiudi')}>{t('azioneChiudi')}</Btn>}
          {puoProrogare && <Btn variant="secondary" onClick={apriProroga}>{t('azioneProroga')}</Btn>}
          {puoEliminare && <Btn variant="danger" onClick={() => apriConferma('elimina')}>{t('azioneElimina')}</Btn>}
        </div>
      )}

      {pannello === 'chiudi' && (
        <div className="space-y-3 rounded-2xl border border-kidville-line p-4">
          <p className="font-maven text-sm text-kidville-ink">{t('chiudiDomanda')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="danger" aria-disabled={inCorso ? 'true' : undefined} onClick={() => void chiudi()}>
              {inCorso ? t('inCorso') : t('chiudiConferma')}
            </Btn>
            <Btn variant="secondary" onClick={() => setPannello(null)}>{t('chiudiRinuncia')}</Btn>
          </div>
        </div>
      )}

      {pannello === 'proroga' && (
        <div className="space-y-3 rounded-2xl border border-kidville-line p-4">
          <p id={idProroga} className="font-maven text-xs font-semibold text-kidville-sub">
            {t('prorogaEtichetta')}
          </p>
          <DateTimeField
            value={nuovaScadenza}
            onChange={setNuovaScadenza}
            idData={idData}
            idOra={idOra}
            labelledBy={idProroga}
            etichettaData={t('giorno')}
            etichettaOra={t('ora')}
            className={CAMPO}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Btn disabled={!prorogaCambiata} aria-disabled={inCorso ? 'true' : undefined} onClick={() => void proroga()}>
              {inCorso ? t('inCorso') : t('prorogaConferma')}
            </Btn>
            <Btn variant="secondary" onClick={() => setPannello(null)}>{t('annulla')}</Btn>
          </div>
        </div>
      )}

      {pannello === 'elimina' && (
        <div className="space-y-3 rounded-2xl border border-kidville-line p-4">
          <p className="font-maven text-sm text-kidville-ink">{t('eliminaDomanda')}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="danger" aria-disabled={inCorso ? 'true' : undefined} onClick={() => void elimina()}>
              {inCorso ? t('inCorso') : t('eliminaConferma')}
            </Btn>
            <Btn variant="secondary" onClick={() => setPannello(null)}>{t('eliminaRinuncia')}</Btn>
          </div>
        </div>
      )}
      {dialogo}
    </div>
  )
}
