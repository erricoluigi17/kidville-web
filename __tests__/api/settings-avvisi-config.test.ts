import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SEDE_A } from '../fixtures/sedi'

/**
 * PATCH /api/admin/settings — `avvisi_config` DEVE restare un oggetto APERTO.
 *
 * ─── IL DIFETTO CHE QUESTO FILE IMPEDISCE ───────────────────────────────────
 *
 * Lo schema della route è `z.looseObject({ promemoria_giorni_prima: … })`, e non
 * `z.object`. La differenza sembra uno stile e non lo è: **un oggetto chiuso
 * scarta in silenzio le chiavi che non conosce**, e `avvisi_config` ne porta altre
 * quattro che nessuno schema nomina —
 *
 *   · `ruoli_pubblicazione` ....... chi può pubblicare un avviso in quella sede
 *   · `allegati_max_mb`
 *   · `scadenza_default_giorni`
 *   · `conferma_lettura_abilitata`
 *
 * Il pannello (`AvvisiSettings.tsx`) fa `save({ avvisi_config: cfg })` con
 * l'oggetto INTERO a ogni «Salva»: con `z.object` quelle quattro chiavi non
 * arriverebbero mai alla colonna. Su una sede che non ha ancora una riga
 * `admin_settings` — Aversa e Cesa sono nate con `avvisi_config = {}` — il primo
 * salvataggio archivierebbe la SOLA `promemoria_giorni_prima`, e
 * `ruoli_pubblicazione` non verrebbe scritto affatto. Su una sede che la riga ce
 * l'ha, lo shallow-merge della route conserva il valore vecchio: peggio ancora,
 * perché la modifica dei ruoli sparisce **con la schermata che dice «Salvato»**.
 *
 * ─── DOVE GUARDA QUESTO FILE, ALLA LETTERA ──────────────────────────────────
 *
 * ⚠️ Non «in colonna»: nel PAYLOAD che la route passa a `.upsert(…)`. Il finto di
 * `createAdminClient` cattura quell'oggetto in `h.upserted`, e da lì in poi non
 * c'è nessun Postgres. Ciò che si misura è quindi «zod non ha scartato la
 * chiave», non «la chiave è archiviata» — la seconda dipende anche dal tipo della
 * colonna, da un trigger, da un default e dal `jsonb` che riordina le chiavi.
 *
 * La distinzione è piccola e va scritta lo stesso, perché è il confine della
 * promessa: un `avvisi_config` che PostgREST rifiutasse — colonna assente su un
 * ambiente non migrato, per dire — passerebbe di qui verde. Il difetto che questo
 * file impedisce ha un nome preciso, `z.object` al posto di `z.looseObject`, e
 * quello si vede tutto nel payload; la prova che la riga arriva davvero in
 * tabella è un altro mestiere (l'E2E), e questo file non la dà.
 *
 * ─── PERCHÉ IL TEST ESISTE, VISTO CHE IL CODICE È GIÀ GIUSTO ────────────────
 *
 * Perché `looseObject` → `object` è una modifica che SEMBRA un irrigidimento
 * virtuoso: chiunque passi di qui per «stringere la validazione» la farà, e senza
 * questo file non vedrebbe nessun rosso. Il commento accanto allo schema lo
 * spiega; un commento però non è un meccanismo — la prima volta che serve, nessuno
 * lo sta leggendo.
 *
 * Prova di rottura ESEGUITA (2026-09-19): sostituito `z.looseObject` con
 * `z.object` in `src/app/api/admin/settings/route.ts` →
 *   · «le cinque chiavi del pannello sopravvivono» ROSSO (4 chiavi perse);
 *   · «il cambio dei ruoli non viene inghiottito dal merge» ROSSO (resta il
 *     valore vecchio, con HTTP 200);
 *   · gli estremi restano verdi — perché la chiave che lo schema conosce non
 *     cambia comportamento. Sono due difese diverse e non possono dividersi
 *     un'asserzione.
 * Ripristinato `z.looseObject` → tutti verdi.
 */

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  upserted: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/require-staff', () => ({ requireStaff: h.requireStaff }))
vi.mock('@/lib/auth/scope', async () => {
  const { SEDE_A: SEDE } = await import('../fixtures/sedi')
  return {
    resolveScuolaScrittura: async () => ({ scuolaId: SEDE }),
    resolveScuoleAttive: async () => [SEDE],
  }
})
vi.mock('@/lib/supabase/server-client', () => ({
  createAdminClient: async () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      let colonne = '*'
      b.select = (cols?: string) => { if (typeof cols === 'string') colonne = cols; return b }
      b.eq = () => b
      b.maybeSingle = async () => {
        if (!h.existing) return { data: null, error: null }
        if (colonne === '*') return { data: h.existing, error: null }
        const chieste = colonne.split(',').map((c) => c.trim()).filter(Boolean)
        const riga = h.existing as Record<string, unknown>
        return {
          data: Object.fromEntries(chieste.filter((c) => c in riga).map((c) => [c, riga[c]])),
          error: null,
        }
      }
      b.upsert = (row: Record<string, unknown>) => {
        h.upserted = row
        return { select: () => ({ single: async () => ({ data: row, error: null }) }) }
      }
      return b
    },
  }),
}))

import { PATCH } from '@/app/api/admin/settings/route'

const req = (body: unknown) =>
  new Request('http://localhost/api/admin/settings', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest

/** L'oggetto che il pannello Impostazioni → Avvisi manda davvero, tutto intero. */
const CONFIG_DEL_PANNELLO = {
  ruoli_pubblicazione: ['admin'],
  conferma_lettura_abilitata: false,
  allegati_max_mb: 25,
  scadenza_default_giorni: 45,
  promemoria_giorni_prima: 5,
}

beforeEach(() => {
  vi.clearAllMocks()
  h.upserted = null
  h.existing = null
  h.requireStaff.mockResolvedValue({ user: { id: 'staff-1', role: 'segreteria' } })
})

describe('PATCH /api/admin/settings — `avvisi_config` è un oggetto APERTO', () => {
  it('🔑 le CINQUE chiavi del pannello sopravvivono tutte fino all’upsert (sede senza riga pregressa)', async () => {
    // Nessuna riga `admin_settings`: è il caso di una sede nuova, e quello in cui
    // lo shallow-merge non ha niente da conservare. Ciò che zod scarta qui, non
    // esiste più da nessuna parte.
    //
    // «fino all'upsert» e non «in colonna»: si osserva il payload passato a
    // PostgREST (vedi il riquadro in testa). È il punto esatto in cui il difetto
    // inseguito si vede — dopo zod, prima della rete.
    const res = await PATCH(req({ scuola_id: SEDE_A, avvisi_config: CONFIG_DEL_PANNELLO }))

    expect(res.status).toBe(200)
    expect(
      h.upserted?.avvisi_config,
      'Con `z.object` al posto di `z.looseObject` restano solo le chiavi dichiarate: ' +
        'la sede perde `ruoli_pubblicazione` e non può più pubblicare un avviso.',
    ).toEqual(CONFIG_DEL_PANNELLO)
    // L'asserzione per NOME, oltre a quella sull'oggetto: se un giorno
    // `CONFIG_DEL_PANNELLO` venisse ridotto, il `toEqual` sopra resterebbe verde
    // confrontando due oggetti mutilati allo stesso modo.
    for (const chiave of ['ruoli_pubblicazione', 'allegati_max_mb', 'scadenza_default_giorni', 'conferma_lettura_abilitata', 'promemoria_giorni_prima']) {
      expect(h.upserted?.avvisi_config, `chiave «${chiave}» scartata in silenzio`).toHaveProperty(chiave)
    }
  })

  it('🔑 il cambio dei RUOLI non viene inghiottito dal merge (sede con riga pregressa)', async () => {
    // Qui il danno è più difficile da vedere che nel caso precedente: lo shallow
    // merge conserva il valore VECCHIO, quindi la PATCH risponde 200 e la
    // schermata scrive «Salvato» mentre in colonna non è cambiato niente.
    h.existing = {
      avvisi_config: {
        ruoli_pubblicazione: ['admin', 'teacher'],
        allegati_max_mb: 10,
        scadenza_default_giorni: 30,
        conferma_lettura_abilitata: true,
        promemoria_giorni_prima: 3,
      },
    }

    const res = await PATCH(req({ scuola_id: SEDE_A, avvisi_config: CONFIG_DEL_PANNELLO }))

    expect(res.status).toBe(200)
    const salvato = h.upserted?.avvisi_config as Record<string, unknown>
    expect(salvato.ruoli_pubblicazione, 'la segreteria ha tolto «teacher» e la colonna non se n’è accorta').toEqual(['admin'])
    expect(salvato.conferma_lettura_abilitata).toBe(false)
    expect(salvato.allegati_max_mb).toBe(25)
    expect(salvato.scadenza_default_giorni).toBe(45)
  })

  it('una chiave che nessuno ha mai nominato passa comunque (è ciò che «aperto» significa)', async () => {
    // Il pannello cresce, la route non lo sa: è successo quattro volte su cinque
    // chiavi. Una configurazione di sede non deve poter sparire perché un file di
    // validazione è rimasto indietro rispetto a una schermata.
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      avvisi_config: { ...CONFIG_DEL_PANNELLO, chiave_di_domani: 'x' },
    }))

    expect(res.status).toBe(200)
    expect(h.upserted?.avvisi_config).toHaveProperty('chiave_di_domani', 'x')
  })
})

describe('PATCH /api/admin/settings — `promemoria_giorni_prima`: gli estremi', () => {
  const patch = (valore: unknown) =>
    PATCH(req({ scuola_id: SEDE_A, avvisi_config: { ...CONFIG_DEL_PANNELLO, promemoria_giorni_prima: valore } }))

  it('0 è ACCETTATO: è lo spegnimento, non un valore mancante', async () => {
    // La scansione lo legge così (`giorni <= 0 → continue`). Rifiutarlo
    // toglierebbe alla segreteria l'unico modo di spegnere i solleciti.
    const res = await patch(0)
    expect(res.status).toBe(200)
    expect((h.upserted?.avvisi_config as Record<string, unknown>).promemoria_giorni_prima).toBe(0)
  })

  it('30 è ACCETTATO: è il tetto della schermata', async () => {
    const res = await patch(30)
    expect(res.status).toBe(200)
    expect((h.upserted?.avvisi_config as Record<string, unknown>).promemoria_giorni_prima).toBe(30)
  })

  it('10000 è RIFIUTATO con 400, e NIENTE viene scritto', async () => {
    // Era il difetto aperto: fino al 2026-09-19 il valore lo limitavano solo i
    // `min`/`max` del `<NumberField>`, quindi una PATCH fatta a mano entrava in
    // colonna e il filtro grossolano della scansione cominciava a trascinare dal
    // database trent'anni di avvisi ogni notte.
    const res = await patch(10_000)
    expect(res.status).toBe(400)
    expect(h.upserted, 'un 400 che ha comunque scritto è peggio di un 500').toBeNull()
  })

  it('-1 è RIFIUTATO con 400 (un promemoria non si manda dopo la scadenza)', async () => {
    const res = await patch(-1)
    expect(res.status).toBe(400)
    expect(h.upserted).toBeNull()
  })

  it('2.5 è RIFIUTATO con 400: i giorni civili si contano interi', async () => {
    // Senza `.int()` un mezzo giorno arriverebbe a `giorniCiviliMancanti`, che
    // confronta MEZZANOTTI: il confronto `mancano > giorni` diventerebbe vero o
    // falso a seconda dell'arrotondamento, cioè un promemoria una notte sì e una no.
    const res = await patch(2.5)
    expect(res.status).toBe(400)
    expect(h.upserted).toBeNull()
  })

  it('un `avvisi_config` SENZA quella chiave è accettato (la chiave è opzionale)', async () => {
    // Il pannello dei ruoli e quello dei promemoria sono la stessa schermata oggi,
    // ma un salvataggio parziale non deve diventare un 400: la chiave ha un
    // ripiego dichiarato (`DEFAULT_AVVISI_CONFIG`) proprio perché può mancare.
    const res = await PATCH(req({
      scuola_id: SEDE_A,
      avvisi_config: { ruoli_pubblicazione: ['admin', 'teacher'], allegati_max_mb: 10 },
    }))
    expect(res.status).toBe(200)
    expect(h.upserted?.avvisi_config).toEqual({ ruoli_pubblicazione: ['admin', 'teacher'], allegati_max_mb: 10 })
  })
})
