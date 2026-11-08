'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { Toggle } from '@/components/ui/cockpit'
import { DateTimeField } from '@/components/ui/DateTimeField'
import { Modal } from '@/components/ui/Modal'
import { TITOLO_MAX, titoloPredefinito, type GenitoreScheda } from '@/lib/votazioni/tipi'
import { useAnnoDi } from '@/lib/context/calendario-context'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { idCreato, leggiClassi, scrivi, type ClasseDellaSede, type LetturaClassi } from './chiamate'
import { cifreLocali } from './scadenza'
import { SceltaCandidati } from './SceltaCandidati'

/**
 * VOTAZIONI · APRIRE UNA VOTAZIONE.
 *
 * Un dialogo solo: titolo, classi che votano, l'istituto (facoltativo, con i suoi candidati) e la scadenza.
 * «Apri votazione» resta SPENTO finché il corpo non starebbe in piedi, e sotto il pulsante una riga dice il
 * PRIMO motivo per cui è spento (titolo, nessuna scheda, istituto senza candidati, scadenza mancante): un
 * pulsante grigio senza spiegazione è un vicolo cieco.
 *
 * ── LE CLASSI ───────────────────────────────────────────────────────────────────────
 * Vengono da `GET /api/admin/sections/scoped`, che risponde per TUTTE le sedi dell'utente: qui si tengono solo
 * quelle della sede della votazione (`leggiClassi`). Si raggruppano per `school_type` (nido, infanzia, primaria,
 * poi «altre»), con «Seleziona tutte» per gruppo e per l'insieme. Un'altra sede non si offre mai.
 *
 * ── LA SCADENZA ─────────────────────────────────────────────────────────────────────
 * Non ha un valore di partenza: una data proposta per comodità, dimenticata, apre una votazione che chiude
 * quando nessuno se lo aspetta. `DateTimeField` parla ISO; al server va `YYYY-MM-DDTHH:MM` di Roma (`cifreLocali`).
 *
 * ── GLI ERRORI E IL DOPPIO CLIC ─────────────────────────────────────────────────────
 * Un rifiuto del server si mostra col testo di catalogo del suo `codice` (una classe già in un'altra votazione
 * aperta, una scadenza passata…) e il dialogo RESTA com'è: si cambia e si riprova. Mentre la richiesta è in volo il
 * pulsante è un messaggio («Apertura in corso…») con `aria-disabled` e una guardia nel gestore, non `disabled`:
 * `disabled` sposta il fuoco sul `<body>` e un secondo clic partirebbe comunque se la guardia mancasse.
 */

const GRADI = ['nido', 'infanzia', 'primaria'] as const
type GradoNoto = (typeof GRADI)[number]
type Gruppo = { grado: GradoNoto | 'altro'; classi: ClasseDellaSede[] }

const CAMPO =
  'min-h-[44px] w-full rounded-xl border border-kidville-line bg-kidville-white px-3 font-maven text-kidville-ink'

/** I gruppi nell'ordine della scuola (nido, infanzia, primaria, altre); un gruppo vuoto non esiste. */
function raggruppa(classi: ClasseDellaSede[]): Gruppo[] {
  const noti = new Set<string>(GRADI)
  const gruppi: Gruppo[] = GRADI.map((grado) => ({ grado, classi: classi.filter((c) => c.grado === grado) }))
  gruppi.push({ grado: 'altro', classi: classi.filter((c) => !noti.has(c.grado)) })
  return gruppi.filter((g) => g.classi.length > 0)
}

export function NuovaVotazioneForm({
  scuolaId,
  onCreata,
  onAnnulla,
}: {
  scuolaId: string
  /** `id` della votazione creata, o `null` se il server non l'ha restituito. */
  onCreata: (id: string | null) => void
  onAnnulla: () => void
}) {
  const t = useTranslations('votazioniAdmin')
  const ts = useTranslations('shared')
  const idBase = useId()
  const idTitoloModale = `${idBase}-modale`
  const idTitolo = `${idBase}-titolo`
  const idQuando = `${idBase}-quando`
  const idData = `${idBase}-data`
  const idOra = `${idBase}-ora`
  const idAiutoScadenza = `${idBase}-aiuto-scadenza`
  const idAiutoApri = `${idBase}-aiuto-apri`

  // ── Le classi della sede ────────────────────────────────────────────────────────
  const [tentativo, setTentativo] = useState(0)
  const [classiLette, setClassiLette] = useState<{ chiave: string; lettura: LetturaClassi } | null>(null)
  const chiaveClassi = `${scuolaId}|${tentativo}`
  useEffect(() => {
    let vivo = true
    void leggiClassi(scuolaId).then((lettura) => {
      if (vivo) setClassiLette({ chiave: chiaveClassi, lettura })
    })
    return () => {
      vivo = false
    }
  }, [scuolaId, chiaveClassi])
  const classiCorrenti = classiLette?.chiave === chiaveClassi ? classiLette.lettura : null
  const classi = classiCorrenti?.esito === 'ok' ? classiCorrenti.classi : []
  const gruppi = raggruppa(classi)
  const tutteLeClassi = gruppi.flatMap((g) => g.classi)

  // ── Il modulo ───────────────────────────────────────────────────────────────────
  // Il titolo scritto dalla segreteria non si sovrascrive mai: finché non scrive vale il proposto, che segue
  // l'anno scolastico di OGGI della sede (il calendario può arrivare dopo il primo disegno).
  const [oggi] = useState(() => oggiFiscaleISO())
  const annoDi = useAnnoDi(scuolaId)
  const [titoloScritto, setTitoloScritto] = useState<string | null>(null)
  const titolo = titoloScritto ?? titoloPredefinito(annoDi(oggi).etichettaBreve)
  const [scelte, setScelte] = useState<string[]>([])
  const [istituto, setIstituto] = useState(false)
  const [candidati, setCandidati] = useState<GenitoreScheda[]>([])
  const [scadenza, setScadenza] = useState('')
  const [inCorso, setInCorso] = useState(false)
  const [errore, setErrore] = useState('')
  const inviaRef = useRef(false)

  const spuntata = (id: string) => scelte.includes(id)
  const alterna = (id: string) => setScelte((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const tutteSpuntate = (ids: string[]) => ids.length > 0 && ids.every(spuntata)
  const impostaGruppo = (ids: string[], acceso: boolean) =>
    setScelte((s) => (acceso ? [...s, ...ids.filter((id) => !s.includes(id))] : s.filter((id) => !ids.includes(id))))

  const etichettaGrado = (grado: Gruppo['grado']) =>
    grado === 'nido'
      ? t('gradoNido')
      : grado === 'infanzia'
        ? t('gradoInfanzia')
        : grado === 'primaria'
          ? t('gradoPrimaria')
          : t('gradoAltro')

  // Il PRIMO motivo per cui non si può aprire; `null` se si può.
  const motivo: string | null =
    titolo.trim() === ''
      ? t('aiutoTitolo')
      : scelte.length === 0 && !istituto
        ? t('aiutoNessunaScheda')
        : istituto && candidati.length === 0
          ? t('aiutoIstitutoSenzaCandidati')
          : cifreLocali(scadenza) === ''
            ? t('aiutoScadenza')
            : null

  const invia = async () => {
    if (inviaRef.current || motivo !== null) return
    inviaRef.current = true
    setInCorso(true)
    setErrore('')
    try {
      const esito = await scrivi(
        'POST',
        '/api/admin/votazioni',
        {
          scuolaId,
          titolo: titolo.trim(),
          scadenza: cifreLocali(scadenza),
          // Nell'ordine della pagina (nido, infanzia, primaria), non in quello delle spunte.
          sectionIds: tutteLeClassi.filter((c) => spuntata(c.id)).map((c) => c.id),
          rappresentanteIstituto: istituto,
          // Candidati senza istituto sarebbero una scheda che non esiste: non partono.
          candidatiIstituto: istituto ? candidati.map((g) => g.utenteId) : [],
        },
        t('erroreCrea'),
        'votazioni-crea',
      )
      if (!esito.ok) {
        setErrore(esito.testo)
        return
      }
      onCreata(await idCreato(esito.res))
    } finally {
      inviaRef.current = false
      setInCorso(false)
    }
  }

  return (
    <Modal open onClose={onAnnulla} title={t('formTitolo')} labelledBy={idTitoloModale} className="w-full max-w-2xl">
      <div className="max-h-[90vh] overflow-y-auto rounded-3xl border border-kidville-line bg-kidville-white p-5 shadow-2xl">
        <h2 id={idTitoloModale} className="font-barlow text-lg font-black uppercase leading-tight text-kidville-green">
          {t('formTitolo')}
        </h2>

        <form
          className="mt-4 space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            void invia()
          }}
        >
          <div className="space-y-1">
            <label htmlFor={idTitolo} className="block font-maven text-xs font-semibold text-kidville-sub">
              {t('formTitoloCampo')}
            </label>
            <input
              id={idTitolo}
              type="text"
              value={titolo}
              maxLength={TITOLO_MAX}
              onChange={(e) => setTitoloScritto(e.target.value)}
              style={{ fontSize: '16px' }}
              className={CAMPO}
            />
          </div>

          {/* Le classi */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-maven text-xs font-semibold text-kidville-sub">{t('formClassiLegenda')}</p>
              {tutteLeClassi.length > 0 && (
                <Btn
                  variant="secondary"
                  size="sm"
                  onClick={() => impostaGruppo(tutteLeClassi.map((c) => c.id), !tutteSpuntate(tutteLeClassi.map((c) => c.id)))}
                >
                  {tutteSpuntate(tutteLeClassi.map((c) => c.id)) ? t('deselezionaTutteLeClassi') : t('selezionaTutteLeClassi')}
                </Btn>
              )}
            </div>

            {classiCorrenti === null && (
              <p role="status" className="font-maven text-sm text-kidville-sub">
                {ts('caricamentoInCorso')}
              </p>
            )}
            {classiCorrenti?.esito === 'errore' && (
              <div className="flex flex-wrap items-center gap-3">
                <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{t('classiErrore')}</span>
                </div>
                <Btn variant="secondary" size="sm" onClick={() => setTentativo((n) => n + 1)}>
                  {ts('paginaErroreRiprova')}
                </Btn>
              </div>
            )}
            {classiCorrenti?.esito === 'ok' && gruppi.length === 0 && (
              <p className="font-maven text-sm text-kidville-sub">{t('classiNessuna')}</p>
            )}

            {gruppi.map((g) => {
              const ids = g.classi.map((c) => c.id)
              const tutte = tutteSpuntate(ids)
              const nome = etichettaGrado(g.grado)
              return (
                <fieldset key={g.grado} className="rounded-2xl border border-kidville-line p-3">
                  <legend className="px-1 font-barlow text-sm font-bold uppercase text-kidville-green">{nome}</legend>
                  <div className="mb-2 flex justify-end">
                    <Btn
                      variant="ghost"
                      size="sm"
                      onClick={() => impostaGruppo(ids, !tutte)}
                      aria-label={tutte ? t('deselezionaGruppoNome', { gruppo: nome }) : t('selezionaGruppoNome', { gruppo: nome })}
                    >
                      {tutte ? t('deselezionaGruppo') : t('selezionaGruppo')}
                    </Btn>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {g.classi.map((c) => (
                      <label
                        key={c.id}
                        className="flex min-h-[44px] cursor-pointer items-center gap-3 rounded-xl border border-kidville-line px-3 font-maven text-sm text-kidville-ink"
                      >
                        <input type="checkbox" checked={spuntata(c.id)} onChange={() => alterna(c.id)} className="h-5 w-5 accent-kidville-green" />
                        <span>{c.nome}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )
            })}
          </div>

          {/* L'istituto */}
          <div className="space-y-3 rounded-2xl border border-kidville-line p-3">
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="font-maven text-sm font-semibold text-kidville-ink">{t('istitutoEtichetta')}</span>
              <Toggle on={istituto} onClick={() => setIstituto((v) => !v)} />
            </label>
            <p className="font-maven text-xs text-kidville-sub">{t('istitutoAiuto')}</p>
            {istituto && <SceltaCandidati scuolaId={scuolaId} scelti={candidati} onChange={setCandidati} />}
          </div>

          {/* La scadenza */}
          <div className="space-y-1">
            <p id={idQuando} className="font-maven text-xs font-semibold text-kidville-sub">
              {t('scadenzaLegenda')}
            </p>
            <DateTimeField
              value={scadenza}
              onChange={setScadenza}
              idData={idData}
              idOra={idOra}
              labelledBy={idQuando}
              aria-describedby={idAiutoScadenza}
              etichettaData={t('giorno')}
              etichettaOra={t('ora')}
              className={CAMPO}
            />
            <p id={idAiutoScadenza} className="font-maven text-xs text-kidville-sub">
              {t('scadenzaAiuto')}
            </p>
          </div>

          {errore && (
            <div role="alert" className="flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{errore}</span>
            </div>
          )}

          <div className="space-y-2">
            {motivo !== null && (
              <p id={idAiutoApri} className="text-right font-maven text-xs text-kidville-sub">
                {motivo}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Btn variant="secondary" onClick={onAnnulla}>
                {t('annulla')}
              </Btn>
              <Btn
                type="submit"
                disabled={motivo !== null}
                aria-disabled={inCorso ? 'true' : undefined}
                aria-describedby={motivo !== null ? idAiutoApri : undefined}
              >
                {inCorso ? t('aperturaInCorso') : t('apriVotazione')}
              </Btn>
            </div>
          </div>
        </form>
      </div>
    </Modal>
  )
}
