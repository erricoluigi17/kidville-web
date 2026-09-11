import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * ════════════════════════════════════════════════════════════════════════════
 * IL MOTIVO DELLO SCARTO ESCE DALLA ROTTA — E SOLO VERSO LA SEGRETERIA.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ─── IL DIFETTO, MISURATO IN PRODUZIONE IL 2026-09-11 ──────────────────────
 *
 * `fatture_emesse.sdi_scarto_motivo` era SCRITTA in quattro punti
 * (`lib/aruba/emissione.ts` ×3 e `pagamenti/fattura/sync`) e LETTA DA NESSUNA
 * ROTTA: `grep -rn sdi_scarto_motivo src/` non trovava nemmeno una `select`.
 * Quando lo SDI respinge una fattura, la Segreteria riceve la notifica «Fattura
 * scartata dallo SDI» e poi non ha nessuna schermata dove leggerne il perché:
 * resta una query SQL, cioè nessuno.
 *
 * Le due righe che in produzione hanno quel campo valorizzato dicono anche DOVE
 * va mostrato, e non è un posto solo:
 *   · `sdi_stato = 4` (scartata), `pagamenti.fattura_stato = 'scartata'`, PDF presente;
 *   · `sdi_stato = 2` (errore di upload), `pagamenti.fattura_stato = 'emessa'`, PDF ASSENTE.
 * La seconda è la più insidiosa: in quel caso la schermata della Segreteria oggi
 * non rende NIENTE — nessun comando, perché il PDF non c'è — e il motivo per cui
 * la fattura non è mai partita resta in una colonna che nessuno legge.
 *
 * ─── LA METÀ CHE CONTA DI PIÙ: CHI *NON* DEVE VEDERLO ──────────────────────
 *
 * Questa rotta ha DUE chiamanti: la Segreteria (`FatturaButton`) e il GENITORE
 * (`StoricoPagamenti`) — il gate è `assertFatturaInScope`, che ammette la
 * famiglia per legame e lo staff per plesso. Il motivo di uno scarto è prosa
 * tecnica di Aruba/SDI («00311 - Codice destinatario non valido»): alla famiglia
 * non dice niente di utile e dice troppo di come funziona la fatturazione della
 * scuola. Non basta che la UI del genitore non lo renda — UNA RISPOSTA HTTP SI
 * ISPEZIONA — quindi il campo non deve proprio viaggiare.
 *
 * ─── PERCHÉ IL FINTO DATABASE *PROIETTA* ───────────────────────────────────
 *
 * ⚠️ Un mock piatto qui sarebbe verde con e senza la correzione: se le righe
 * finte portassero sempre tutte le colonne, la rotta potrebbe dimenticarsi
 * `sdi_scarto_motivo` nella `.select(…)` e il campo uscirebbe lo stesso. Il
 * finto qui sotto restituisce SOLO le colonne davvero richieste — come fa
 * PostgREST — così «non l'ho chiesta al database» e «non l'ho messa nella
 * risposta» diventano lo stesso rosso.
 */

const log = vi.hoisted(() => ({ logEvento: vi.fn(), logErrore: vi.fn(), logOk: vi.fn() }))
vi.mock('@/lib/logging/logger', () => log)

/** uuid sintetici: il repository è pubblico. */
const PID = 'aaaaaaaa-0000-4000-8000-0000000000d1'
const ALUNNO = 'bbbbbbbb-0000-4000-8000-0000000000d2'

/** Prosa tecnica del provider: un codice SDI vero, nessun dato di nessuno. */
const MOTIVO = '00311 - Codice destinatario non valido'

const h = vi.hoisted(() => ({
  utente: null as Record<string, unknown> | null,
  righe: [] as Record<string, unknown>[],
  /** Le proiezioni chieste a `fatture_emesse`: è lì che si vede se la colonna è stata chiesta. */
  proiezioni: [] as string[],
  nomiBucket: [] as { name: string }[],
}))

vi.mock('@/lib/auth/require-staff', () => ({
  requireUser: vi.fn(async () => ({ user: h.utente })),
  requireStaff: vi.fn(async () => ({ user: h.utente })),
}))

/**
 * Il gate è finto DI PROPOSITO, e non è una scorciatoia: chi può leggere l'elenco
 * ce l'ha già il suo file di prove (`fattura-genitore-multisede.test.ts`, con lo
 * scope VERO sopra un database finto). Qui si misura un'altra cosa — a parità di
 * accesso concesso, QUALI CAMPI escono — e mescolare le due farebbe passare per
 * «campo omesso» un semplice 403.
 */
vi.mock('@/lib/pagamenti/scope-fattura', () => ({
  assertFatturaInScope: vi.fn(async () => null),
}))

vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from(table: string) {
      const b: Record<string, unknown> = {}
      /** Le colonne chieste a QUESTA query: vuote finché non passa dalla `select`. */
      let colonne: string[] = []
      b.select = (proiezione: string) => {
        if (table === 'fatture_emesse') {
          h.proiezioni.push(proiezione)
          colonne = String(proiezione).split(',').map((c) => c.trim()).filter(Boolean)
        }
        return b
      }
      b.eq = () => b
      b.order = () => b
      b.limit = () => b
      b.maybeSingle = async () => ({
        data: table === 'pagamenti' ? { id: PID, alunno_id: ALUNNO } : null,
        error: null,
      })
      // PostgREST non lancia e NON regala colonne: torna ciò che gli è stato chiesto.
      b.then = (ok: (v: unknown) => unknown) =>
        ok(table === 'fatture_emesse'
          ? { data: h.righe.map((r) => Object.fromEntries(colonne.map((c) => [c, r[c]]))), error: null }
          : { data: [], error: null })
      return b
    },
    storage: {
      from: () => ({
        list: async () => ({ data: h.nomiBucket, error: null }),
      }),
    },
  }),
}))

import { GET as LISTA } from '@/app/api/pagamenti/fattura/list/route'

const chiedi = () => LISTA(new Request(`http://test/api/pagamenti/fattura/list?pagamento_id=${PID}`))

const SEGRETERIA = { id: 'd0d0d0d0-0000-4000-8000-0000000000d3', role: 'segreteria', scuola_id: 'sc-1' }
const GENITORE = { id: 'e0e0e0e0-0000-4000-8000-0000000000d4', role: 'genitore', scuola_id: 'sc-1' }

/** Una quota SCARTATA: il PDF c'è (è il caso `sdi_stato = 4` misurato in produzione). */
const rigaScartata = (numero = 1948) => ({
  id: `f-${numero}`,
  numero,
  anno: 2026,
  quota_label: null,
  quota_adult_id: null,
  intestatario: { nome: 'Nome', cognome: 'Cognome' },
  pdf_path: `${PID}-${numero}.pdf`,
  sdi_stato: 4,
  sdi_stato_label: 'Scartata dallo SDI',
  sdi_scarto_motivo: MOTIVO,
})

beforeEach(() => {
  vi.clearAllMocks()
  h.utente = { ...SEGRETERIA }
  h.righe = [rigaScartata()]
  h.proiezioni = []
  h.nomiBucket = [{ name: `${PID}-1948.pdf` }]
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la colonna si chiede al database e arriva alla Segreteria', () => {
  it('la `select` nomina `sdi_scarto_motivo` (senza, il dato non esce dal database)', async () => {
    await chiedi()
    expect(h.proiezioni).toHaveLength(1)
    expect(
      h.proiezioni[0],
      'la rotta non chiede la colonna: qualunque cosa risponda, il motivo non può uscire',
    ).toContain('sdi_scarto_motivo')
  })

  it('la risposta alla Segreteria porta il motivo, per esteso', async () => {
    const j = await (await chiedi()).json()
    expect(j.data).toHaveLength(1)
    // Per esteso, non troncato: è il testo con cui si corregge e si ritrasmette.
    expect(j.data[0].sdi_scarto_motivo).toBe(MOTIVO)
  })

  it('senza motivo il campo c’è e vale `null`: il contratto non cambia di forma', async () => {
    h.righe = [{ ...rigaScartata(), sdi_stato: 6, sdi_stato_label: 'Consegnata', sdi_scarto_motivo: null }]
    const j = await (await chiedi()).json()
    expect(j.data[0]).toHaveProperty('sdi_scarto_motivo', null)
  })

  it('il motivo esce ANCHE quando il PDF non c’è — è il caso «errore di upload»', async () => {
    // `sdi_stato = 2`, nessun `pdf_path`: in produzione questa riga è su un
    // pagamento che risulta «emessa», e oggi la Segreteria non vede niente.
    // Se il motivo viaggiasse solo insieme a un comando di scarico, resterebbe
    // invisibile proprio nel caso in cui la fattura non è mai partita.
    h.righe = [{ ...rigaScartata(), sdi_stato: 2, pdf_path: null, sdi_stato_label: 'Errore upload' }]
    h.nomiBucket = []
    const j = await (await chiedi()).json()
    expect(j.data[0]).toMatchObject({ pdf_disponibile: false, sdi_scarto_motivo: MOTIVO })
  })

  it('quota ri-emessa: vince il numero più alto, e con lui il suo motivo (assente)', async () => {
    // La riga scartata e la sua ri-emissione hanno lo stesso `quota_adult_id`:
    // l'elenco ne tiene una sola, la più recente. Il motivo deve seguire QUELLA —
    // mostrare lo scarto di un documento già sostituito manderebbe la Segreteria
    // a correggere una fattura che è già ripartita.
    h.righe = [
      { ...rigaScartata(1948), quota_adult_id: 'q-1' },
      { ...rigaScartata(1949), quota_adult_id: 'q-1', sdi_stato: 6, sdi_stato_label: 'Consegnata', sdi_scarto_motivo: null },
    ]
    const j = await (await chiedi()).json()
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({ numero: 1949, sdi_scarto_motivo: null })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('al GENITORE il motivo non viaggia affatto', () => {
  beforeEach(() => { h.utente = { ...GENITORE } })

  it('la risposta non contiene né il campo né la prosa del provider', async () => {
    const res = await chiedi()
    const corpo = await res.text()

    // Sul TESTO grezzo, non sull'oggetto: è quello che si legge negli strumenti
    // per sviluppatori del browser, ed è la superficie che conta.
    expect(corpo).not.toContain('sdi_scarto_motivo')
    expect(corpo).not.toContain(MOTIVO)
    expect(corpo).not.toContain('Codice destinatario')

    const j = JSON.parse(corpo)
    // …e il campo non c'è nemmeno come chiave con valore nullo.
    expect(Object.keys(j.data[0])).not.toContain('sdi_scarto_motivo')
  })

  it('e intanto riceve tutto il resto: l’elenco non è vuoto per caso', async () => {
    // Senza questa metà, la prova qui sopra resterebbe verde su una rotta che al
    // genitore non risponde più niente — cioè su un difetto peggiore.
    const j = await (await chiedi()).json()
    expect(j).toMatchObject({ success: true })
    expect(j.data).toHaveLength(1)
    expect(j.data[0]).toMatchObject({ numero: 1948, anno: 2026, pdf_disponibile: true })
  })
})

// ═════════════════════════════════════════════════════════════════════════════
describe('la regola guarda i ruoli REALI, non la veste indossata', () => {
  it('chi in segreteria sta guardando l’app da genitore continua a leggerlo', async () => {
    // Una segretaria che è anche mamma non smette di essere una segretaria: il
    // cookie del ruolo attivo sceglie quale vista si guarda, non cosa si può.
    // (È la distinzione che `predicati-ruolo.ts` custodisce: `haUnRuolo` sui ruoli
    // del database, `agisceComeGenitore` sulla veste.)
    h.utente = { ...SEGRETERIA, role: 'genitore', ruoli: ['segreteria', 'genitore'] }
    const j = await (await chiedi()).json()
    expect(j.data[0].sdi_scarto_motivo).toBe(MOTIVO)
  })

  it('un educatore non lo legge: il gate lo fa passare solo se è famiglia del bambino', async () => {
    // Ramo difensivo: `assertFatturaInScope` non ammette gli `educator`, ma qui il
    // gate è finto — e la regola del CAMPO non deve appoggiarsi al gate per valere.
    h.utente = { id: 'f0f0f0f0-0000-4000-8000-0000000000d5', role: 'educator', scuola_id: 'sc-1' }
    const corpo = await (await chiedi()).text()
    expect(corpo).not.toContain('sdi_scarto_motivo')
    expect(corpo).not.toContain(MOTIVO)
  })
})
