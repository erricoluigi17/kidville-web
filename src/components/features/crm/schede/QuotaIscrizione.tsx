'use client'

import { useId, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/Badge'
import { Btn } from '@/components/ui/Btn'
import { DateField } from '@/components/ui/DateField'
import { ETICHETTA_CAMPO_FILTRO } from '@/components/ui/BarraFiltri'
import { dataCivile } from '@/i18n/config'
import { annoDellaQuota, etichettaAnno } from '@/lib/crm/quota-anno'
import { QUOTA_METODI, QUOTA_MOTIVI_BLOCCO, type BambinoDettaglioRow, type MetodoQuota } from '@/lib/crm/tipi'
import { useDateFormat } from '@/lib/i18n/date'
import { soloCatalogoDaCorpo } from '@/lib/ui/esito-fetch'
import { importoDaTesto, importoLeggibile, importoPerCampo } from './quota-importo'
import { chiama, leggiJson, scrittura } from './rete'
import { CAMPO, COLLEGAMENTO_PASTIGLIA, MESSAGGIO_ERRORE, TESTO_SECONDARIO } from './stile'

/**
 * CRM della segreteria · LA QUOTA D'ISCRIZIONE NELLA SCHEDA DI UN BAMBINO (spec 2026-10-31, §5.1 e §5.5).
 *
 * Al posto della vecchia spunta «quota saldata»: la segreteria segna importo, giorno e metodo, li corregge,
 * li toglie, e vede a che punto è il passaggio in contabilità. Non scrive mai in proprio: parla con le tre
 * route `…/quota` (PUT, DELETE, `riprova`), e dopo ogni gesto riuscito chiama `onCambiata()` — la scheda si
 * rilegge e lo stato che si vede è sempre quello che il database ha.
 *
 * ── Per stato (`bambino.quota_stato`) ───────────────────────────────────────────────────────────────
 *  · nessuno          il bottone «Segna la quota d'iscrizione»;
 *  · `senza_importo`  la vecchia spunta: si completa dal modulo;
 *  · `in_attesa`      i dati segnati, e «in attesa dell'alunno» (o, se il bambino è già collegato,
 *                     «in attesa del passaggio in contabilità» con Riprova). Correggi · Togli;
 *  · `bloccata`       il motivo del blocco, Riprova e — per `gia_pagata` — «È lo stesso pagamento», che è lo
 *                     stesso `DELETE` di «Togli» con le parole giuste. Correggi per tutte;
 *  · `in_contabilita` SOLA LETTURA, con il collegamento allo scadenzario: da lì in poi si corregge in
 *                     contabilità come ogni altro incasso. Per un bonifico la cui voce non è ancora pagata:
 *                     «in contabilità, in attesa del bonifico» (lo `stato` della voce lo porta la GET della
 *                     scheda in `quota_pagamento_stato`).
 *
 * ── Il modulo ───────────────────────────────────────────────────────────────────────────────────────
 *  · l'IMPORTO si scrive all'italiana: la virgola vale come il punto, due decimali al massimo, maggiore di
 *    zero e non oltre il tetto della route. Il resto non parte: il bottone resta spento e il perché si legge;
 *  · il GIORNO è `DateField` e PARTE VALORIZZATO con oggi (a Roma). La richiesta lo manda SEMPRE: un campo
 *    vuoto o a metà («15/10/20», un carattere cancellato) non vale «oggi» — il `DateField` consegna `''` per
 *    una data incompleta, e omettere `giorno` farebbe registrare il contante nella cassa di oggi senza avvisare.
 *    Quindi vuoto o incompleto spegne il bottone e dice «Indica un giorno valido». Non ha un `max`: un giorno
 *    dopo oggi spegne il bottone con la stessa frase della route (`QUOTA_GIORNO_FUTURO`);
 *  · l'ANNO non si sceglie, si legge («Anno scolastico 2027/28»): viene dall'anno di ingresso del bambino.
 *    Con `non_indicato` il modulo dice di indicarlo prima e il bottone resta spento;
 *  · un `409 QUOTA_CASSA_CHIUSA` mette nel campo il giorno che la route propone (oggi), con la sua frase.
 *
 * ── Il doppio clic ──────────────────────────────────────────────────────────────────────────────────
 * Review Focus 1 della spec: due richieste in volo con i contanti lascerebbero due entrate in cassa. Il
 * bottone si spegne mentre la richiesta è in volo, e un `ref` chiude la porta nello stesso istante del clic,
 * prima che lo `state` faccia in tempo a disabilitarlo (la funzione SQL, per conto suo, blocca la riga).
 *
 * ── 🔴 DATI DI MINORI ───────────────────────────────────────────────────────────────────────────────
 * Importi, metodi e giorni sono quelli di una famiglia: nei log del browser passano solo il nome
 * dell'operazione e lo stato HTTP (lo fa `chiama`), e il testo di un rifiuto è sempre quello del CATALOGO,
 * mai la prosa del server.
 */

const GIORNO_ISO = /^\d{4}-\d{2}-\d{2}$/

const eMetodo = (v: unknown): v is MetodoQuota => (QUOTA_METODI as readonly unknown[]).includes(v)

const urlQuota = (schedaId: string, bambinoId: string) =>
  `/api/admin/crm/schede/${encodeURIComponent(schedaId)}/bambini/${encodeURIComponent(bambinoId)}/quota`

export function QuotaIscrizione({
  schedaId,
  bambino,
  onCambiata,
}: {
  schedaId: string
  bambino: BambinoDettaglioRow
  onCambiata: () => void
}) {
  const t = useTranslations('crmSchede')
  const date = useDateFormat()
  const idTitolo = useId()
  const [modulo, setModulo] = useState(false)
  const [azione, setAzione] = useState<'riprova' | 'togli' | null>(null)
  const [errore, setErrore] = useState<string | null>(null)
  const inVolo = useRef(false)

  const url = urlQuota(schedaId, bambino.id)
  const stato = bambino.quota_stato
  const motivo = bambino.quota_blocco_motivo
  const motivoNoto = (QUOTA_MOTIVI_BLOCCO as readonly unknown[]).includes(motivo) ? motivo : null

  /** Riprova il passaggio, o toglie la quota (che per `gia_pagata` si chiama «È lo stesso pagamento»). */
  const lancia = async (quale: 'riprova' | 'togli') => {
    if (inVolo.current) return
    inVolo.current = true
    setAzione(quale)
    setErrore(null)

    const res =
      quale === 'togli'
        ? await chiama('quota-togli', url, { method: 'DELETE' })
        : await chiama('quota-riprova', `${url}/riprova`, { method: 'POST' })

    let rilettura = false
    let messaggio: string | null = null
    if (res === null) {
      messaggio = t('quotaErrore')
    } else if (!res.ok) {
      messaggio = soloCatalogoDaCorpo(await leggiJson(res, `quota-${quale}`), t('quotaErrore'))
    } else if (quale === 'togli') {
      rilettura = true
    } else {
      const esito = ((await leggiJson(res, 'quota-riprova')) as { data?: { esito?: unknown } } | null)?.data?.esito
      if (esito === 'ok' || esito === 'bloccata' || esito === 'gia_in_contabilita') rilettura = true
      else messaggio = esito === 'non_pronta' ? t('quotaRiprovaNonPronta') : t('quotaErrore')
    }

    inVolo.current = false
    setAzione(null)
    if (messaggio !== null) setErrore(messaggio)
    if (rilettura) onCambiata()
  }

  const importo = importoLeggibile(bambino.quota_importo)
  const metodo = eMetodo(bambino.quota_metodo) ? t(`quotaMetodo_${bambino.quota_metodo}`) : null
  const giorno = bambino.quota_saldata_il !== null ? date.dataBreve(bambino.quota_saldata_il) : ''
  const riepilogo = importo !== null && metodo !== null && giorno !== '' ? t('quotaRiepilogo', { importo, metodo, giorno }) : null
  const anno = bambino.quota_anno !== null ? t('quotaAnno', { anno: etichettaAnno(bambino.quota_anno) }) : null

  const occupato = azione !== null
  const collegato = bambino.alunno_id !== null
  const stessoPagamento = stato === 'bloccata' && motivoNoto === 'gia_pagata'

  const apri = () => {
    setErrore(null)
    setModulo(true)
  }

  const dettagli = (
    <>
      {riepilogo !== null && <p className="font-maven text-sm text-kidville-ink">{riepilogo}</p>}
      {anno !== null && <p className={TESTO_SECONDARIO}>{anno}</p>}
    </>
  )

  const azioni = (quali: { riprova: boolean }) => (
    <div className="flex flex-wrap gap-2">
      {quali.riprova && (
        <Btn variant="secondary" size="sm" disabled={occupato} onClick={() => void lancia('riprova')}>
          {azione === 'riprova' ? t('salvataggio') : t('riprova')}
        </Btn>
      )}
      <Btn variant="ghost" size="sm" disabled={occupato} onClick={apri}>
        {t('quotaCorreggi')}
      </Btn>
      <Btn variant={stessoPagamento ? 'secondary' : 'ghost'} size="sm" disabled={occupato} onClick={() => void lancia('togli')}>
        {azione === 'togli' ? t('salvataggio') : stessoPagamento ? t('quotaStessoPagamento') : t('quotaTogli')}
      </Btn>
    </div>
  )

  let contenuto: React.ReactNode
  if (modulo) {
    contenuto = (
      <ModuloQuota
        url={url}
        bambino={bambino}
        titolo={t('quotaTitolo')}
        onFatto={() => {
          setModulo(false)
          onCambiata()
        }}
        onAnnulla={() => setModulo(false)}
      />
    )
  } else if (stato === 'senza_importo') {
    contenuto = (
      <>
        <Badge tone="neutral">{t('quotaStatoSenzaImporto')}</Badge>
        <div>
          <Btn variant="secondary" size="sm" onClick={apri}>
            {t('quotaCompleta')}
          </Btn>
        </div>
      </>
    )
  } else if (stato === 'in_attesa') {
    contenuto = (
      <>
        <Badge tone="info">{collegato ? t('quotaStatoAttesaPassaggio') : t('quotaStatoAttesaAlunno')}</Badge>
        {dettagli}
        {azioni({ riprova: collegato })}
      </>
    )
  } else if (stato === 'bloccata') {
    contenuto = (
      <>
        <Badge tone="warn">{t('quotaStatoBloccata')}</Badge>
        {motivoNoto !== null && <p className="font-maven text-sm text-kidville-ink">{t(`quotaBlocco_${motivoNoto}`)}</p>}
        {dettagli}
        {azioni({ riprova: true })}
      </>
    )
  } else if (stato === 'in_contabilita') {
    // Un bonifico passa in contabilità «da pagare» e lo chiude la banca: finché la voce non è pagata lo si dice.
    const inAttesaBonifico =
      bambino.quota_metodo === 'bonifico' &&
      typeof bambino.quota_pagamento_stato === 'string' &&
      bambino.quota_pagamento_stato !== 'pagato'
    contenuto = (
      <>
        {/* In attesa = blu (`inCorso`), non verde: il verde di «in contabilità» dice «fatto», e un bonifico che la
            banca non ha ancora chiuso non lo è. (`info` qui è verde, la stessa faccia di «fatto»: non basta.) */}
        <Badge tone={inAttesaBonifico ? 'inCorso' : 'success'}>
          {inAttesaBonifico ? t('quotaStatoAttesaBonifico') : t('quotaStatoInContabilita')}
        </Badge>
        {dettagli}
        <div>
          <Link href="/admin/pagamenti?vista=scadenzario" className={COLLEGAMENTO_PASTIGLIA}>
            {t('quotaApriContabilita')}
          </Link>
        </div>
      </>
    )
  } else {
    contenuto = (
      <div>
        <Btn variant="secondary" size="sm" onClick={apri}>
          {t('quotaSegna')}
        </Btn>
      </div>
    )
  }

  return (
    <section aria-labelledby={idTitolo} className="space-y-2 border-t border-kidville-line pt-3">
      <h5 id={idTitolo} className="font-barlow text-[13px] font-extrabold uppercase tracking-[0.04em] text-kidville-sub">
        {t('quotaTitolo')}
      </h5>
      {contenuto}
      {errore !== null && !modulo && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// IL MODULO
// ════════════════════════════════════════════════════════════════════════════════════════════════

function ModuloQuota({
  url,
  bambino,
  titolo,
  onFatto,
  onAnnulla,
}: {
  url: string
  bambino: BambinoDettaglioRow
  /** Il nome accessibile del modulo (lo stesso della sezione). */
  titolo: string
  onFatto: () => void
  onAnnulla: () => void
}) {
  const t = useTranslations('crmSchede')
  const ts = useTranslations('shared')
  const id = useId()
  const [importo, setImporto] = useState(() => importoPerCampo(bambino.quota_importo))
  // Oggi a Roma: è il giorno proposto (o quello già segnato, se si corregge) e il confine del futuro.
  const oggi = dataCivile()
  const [giorno, setGiorno] = useState(() => bambino.quota_saldata_il ?? oggi)
  const [metodo, setMetodo] = useState<MetodoQuota>(() => (eMetodo(bambino.quota_metodo) ? bambino.quota_metodo : 'contanti'))
  const [invio, setInvio] = useState(false)
  const [errore, setErrore] = useState<string | null>(null)
  const inVolo = useRef(false)

  const correzione = bambino.quota_stato === 'in_attesa' || bambino.quota_stato === 'bloccata'

  const importoNumero = importoDaTesto(importo)
  const importoErrato = importo.trim() !== '' && importoNumero === null
  // L'anno si ricava dall'anno di ingresso, adesso: lo stesso calcolo che la route rifà al momento di salvare.
  const annoQuota = annoDellaQuota(bambino.anno_ingresso)
  // `DateField` consegna `''` per una data vuota, incompleta o inesistente: non è «oggi», è un giorno che manca.
  const giornoValido = GIORNO_ISO.test(giorno)
  const giornoFuturo = giornoValido && giorno > oggi
  const pronto = importoNumero !== null && annoQuota !== null && giornoValido && !giornoFuturo && !invio

  const invia = async () => {
    if (!pronto || importoNumero === null || inVolo.current) return
    inVolo.current = true
    setInvio(true)
    setErrore(null)

    // `giorno` parte SEMPRE: omesso, il server prenderebbe oggi e un giorno scritto a metà finirebbe in cassa oggi.
    const res = await chiama('quota-segna', url, scrittura('PUT', { importo: importoNumero, giorno, metodo }))

    if (res === null) {
      setErrore(t('quotaErrore'))
    } else if (!res.ok) {
      const rifiuto = (await leggiJson(res, 'quota-segna')) as { codice?: unknown; giornoProposto?: unknown } | null
      setErrore(soloCatalogoDaCorpo(rifiuto, t('quotaErrore')))
      if (rifiuto?.codice === 'QUOTA_CASSA_CHIUSA') {
        // La route propone oggi: nel campo, così basta confermare. Se non lo manda, oggi lo sa anche il browser.
        setGiorno(typeof rifiuto.giornoProposto === 'string' && GIORNO_ISO.test(rifiuto.giornoProposto) ? rifiuto.giornoProposto : oggi)
      }
    } else {
      inVolo.current = false
      setInvio(false)
      onFatto()
      return
    }
    inVolo.current = false
    setInvio(false)
  }

  return (
    <form
      noValidate
      aria-label={titolo}
      onSubmit={(e) => {
        e.preventDefault()
        void invia()
      }}
      className="space-y-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-importo`} className={ETICHETTA_CAMPO_FILTRO}>
            {t('quotaImporto')}
          </label>
          <input
            id={`${id}-importo`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={importo}
            disabled={invio}
            aria-invalid={importoErrato}
            aria-describedby={importoErrato ? `${id}-importo-aiuto` : undefined}
            onChange={(e) => setImporto(e.target.value)}
            className={CAMPO}
          />
          {importoErrato && (
            <p id={`${id}-importo-aiuto`} className={`mt-1 ${TESTO_SECONDARIO}`}>
              {t('quotaImportoNonValido')}
            </p>
          )}
        </div>
        <div>
          <label htmlFor={`${id}-giorno`} className={ETICHETTA_CAMPO_FILTRO}>
            {t('quotaGiorno')}
          </label>
          <DateField
            id={`${id}-giorno`}
            value={giorno}
            onChange={setGiorno}
            disabled={invio}
            aria-describedby={`${id}-giorno-aiuto`}
            className={CAMPO}
          />
          <p id={`${id}-giorno-aiuto`} className={`mt-1 ${TESTO_SECONDARIO}`}>
            {!giornoValido ? t('quotaGiornoNonValido') : giornoFuturo ? ts('erroreCrmQuotaGiornoFuturo') : t('quotaGiornoOggi')}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`${id}-metodo`} className={ETICHETTA_CAMPO_FILTRO}>
            {t('quotaMetodo')}
          </label>
          <select
            id={`${id}-metodo`}
            value={metodo}
            disabled={invio}
            onChange={(e) => setMetodo(e.target.value as MetodoQuota)}
            className={CAMPO}
          >
            {QUOTA_METODI.map((m) => (
              <option key={m} value={m}>
                {t(`quotaMetodo_${m}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end">
          {/* L'anno si legge e non si sceglie: viene dall'anno di ingresso del bambino. */}
          <p className="pb-3 font-maven text-sm text-kidville-ink">
            {annoQuota !== null ? t('quotaAnno', { anno: etichettaAnno(annoQuota) }) : t('quotaAnnoServe')}
          </p>
        </div>
      </div>

      {errore !== null && (
        <p role="alert" className={MESSAGGIO_ERRORE}>
          {errore}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Btn variant="ghost" size="sm" disabled={invio} onClick={onAnnulla}>
          {t('annulla')}
        </Btn>
        <Btn type="submit" size="sm" disabled={!pronto}>
          {invio ? t('salvataggio') : correzione ? t('quotaConfermaCorrezione') : t('quotaConferma')}
        </Btn>
      </div>
    </form>
  )
}
