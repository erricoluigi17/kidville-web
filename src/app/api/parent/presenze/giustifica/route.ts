import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { assertGenitoreNonSospeso } from '@/lib/pagamenti/sospensione'
import { getUserEmail, verifyTicket, codeHash } from '@/lib/auth/otp-ticket'
import { buildSignatureLog, extractRequestMeta } from '@/lib/fea/signature-log'
import { recordSignerSlot } from '@/lib/fea/slots'
import { logFeaEvent } from '@/lib/fea/audit'
import { getModuleConfig } from '@/lib/settings/module-config'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { docentiDiSezione } from '@/lib/sezioni/docenti'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { limitaVerificaOtp } from '@/lib/security/otp-rate-limit'
import { MOTIVO_MAX_CARATTERI, motivoNormalizzato } from '@/lib/presenze/limiti-testo'
import { azzeramentoPresaVisione, PRESA_VISIONE_AZZERATA } from '@/lib/presenze/presa-visione'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// `data` resta stringa permissiva (oggi il DB accetta anche formati non YYYY-MM-DD);
// `motivo` permissivo: oggi qualunque tipo è accettato (i non-string diventano null).
// code/expiry/ticket: oggi possono mancare o arrivare come numero — la verifica
// vera la fa verifyTicket (HMAC), e solo se l'OTP è richiesto dalle impostazioni.
const postBodySchema = z.object({
  studentId: zUuid,
  data: z.string().min(1),
  motivo: z.unknown().optional(),
  code: z.unknown().optional(),
  expiry: z.unknown().optional(),
  ticket: z.unknown().optional(),
})

// POST /api/parent/presenze/giustifica?userId=
// body: { studentId, data, motivo, code, expiry, ticket }
// Il genitore giustifica un'assenza/ritardo/uscita del figlio. Solo primaria.
// Protetta da conferma OTP email (FES): richiedi prima l'OTP via /giustifica/otp.
export const POST = withRoute('parent/presenze/giustifica:POST', async (request: NextRequest) => {
  try {
    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { studentId, data, motivo, code, expiry, ticket } = b.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response
    const userId = auth.user.id

    const supabase = await createAdminClient()

    // Sospensione moroso (DL-021 · M4): il genitore sospeso non può giustificare
    // (azione di servizio). Guard DOPO l'identità di sessione e PRIMA della verifica
    // OTP: un account sospeso non deve neppure innescare la firma. Solo SCRITTURA.
    const sospesoErr = await assertGenitoreNonSospeso(supabase, userId)
    if (sospesoErr) return sospesoErr

    // IL MOTIVO HA UNA LUNGHEZZA MASSIMA, QUI COME SUL GEMELLO.
    //
    // Le route che scrivono `presenze.giustificazione_testo` sono due, e il tetto del
    // collaudo del 2026-08-07 era stato messo solo su `comunica-assenza`: da questa porta i
    // 200.000 caratteri passavano ancora, con in più una firma elettronica appesa. Il numero
    // sta in `@/lib/presenze/limiti-testo` e non in due costanti gemelle: due copie della
    // stessa misura divergono al primo ritocco.
    //
    // ─── DOVE STA, E PERCHÉ NON ALTROVE ─────────────────────────────────────
    //
    //  · NON in zod: lo schema decide PRIMA di `requireParentOfStudent`, e un 400 emesso lì
    //    scavalcherebbe il 403 sul figlio altrui che la prova adversarial pretende;
    //  · PRIMA di `limitaVerificaOtp` e della verifica del codice: un errore di forma non
    //    deve consumare un tentativo del budget OTP, che è un presidio contro chi INDOVINA
    //    — bruciarlo con un incollaggio sbagliato farebbe pagare a un genitore distratto una
    //    protezione pensata per un altro.
    //
    // Si misura il testo NORMALIZZATO, che è quello che finirebbe in tabella.
    const motivoTesto = motivoNormalizzato(motivo) ?? ''
    if (motivoTesto.length > MOTIVO_MAX_CARATTERI) {
      // La LUNGHEZZA, mai il testo: è un dato sanitario di un minore. Il numero dice se è un
      // incollaggio sbagliato o un collaudo con 200.000 caratteri; `error_code` è in lista
      // bianca di `redact`, `codice` non lo sarebbe.
      logEvento('registro', 'warn', {
        operazione: 'parent/presenze/giustifica:POST',
        error_code: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
        alunno_id: studentId,
        stato: 400,
        n: motivoTesto.length,
      })
      return NextResponse.json(
        {
          error: `Il motivo non può superare ${MOTIVO_MAX_CARATTERI} caratteri`,
          codice: 'ASSENZA_MOTIVO_TROPPO_LUNGO',
        },
        { status: 400 },
      )
    }

    // Gating primaria: la giustifica genitore è ammessa solo per la scuola primaria.
    //
    // ═══ LA QUARTA COSA CHE LA PORTA GEMELLA AVEVA GIÀ IMPARATO ══════════════
    //
    // PostgREST NON LANCIA: ritorna `{ error }` (AGENTS.md, regola 7), e il
    // `try/catch` che avvolge questo handler su quel ramo non scatta mai. Senza
    // il controllo, un guasto di lettura usciva dalla porta del 404: al genitore
    // di primaria — con l'OTP appena verificato — si diceva che suo figlio NON
    // ESISTE, e la firma non veniva registrata senza che una riga lo spiegasse.
    // Il gemello `comunica-assenza` l'aveva chiusa; questa porta no, ed è quella
    // con la firma elettronica appesa.
    const { data: alunno, error: alunnoErr } = await supabase
      .from('alunni')
      .select('id, section_id, scuola_id')
      .eq('id', studentId)
      .maybeSingle()
    if (alunnoErr) {
      logErrore({ operazione: 'parent/presenze/giustifica:POST', stato: 500, evento: 'db' }, alunnoErr)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'GIUSTIFICA_NON_SALVATA' },
        { status: 500 },
      )
    }
    if (!alunno) return NextResponse.json({ error: 'Alunno non trovato' }, { status: 404 })

    const presenzeCfg = await getModuleConfig<{
      giustifica_max_giorni_retroattivi: number
      giustifica_richiede_firma_otp: boolean
    }>(supabase, 'presenze_config', alunno.scuola_id)

    // Finestra retroattiva configurabile dall'admin (default 5 giorni).
    const maxGiorni = Number(presenzeCfg.giustifica_max_giorni_retroattivi ?? 5)
    const giorniPassati = Math.floor((Date.now() - new Date(data).getTime()) / 86_400_000)
    if (giorniPassati > maxGiorni) {
      return NextResponse.json(
        { error: `Giustifica non più possibile: sono passati più di ${maxGiorni} giorni. Contatta la segreteria.` },
        { status: 403 }
      )
    }

    const richiedeOtp = presenzeCfg.giustifica_richiede_firma_otp !== false

    // Tetto sui TENTATIVI di verifica del codice (sicurezza W5 · S30), sullo stesso budget
    // delle altre tre firme del genitore — vedi `@/lib/security/otp-rate-limit`. Il codice è
    // di sei cifre e un confronto HMAC fallito NON consuma il ticket (`verifyTicket` non
    // scrive niente): senza tetto provarli tutti era gratis, e ciò che si ottiene indovinando
    // non è un accesso, è la giustificazione di un'assenza apposta a nome di un genitore vero.
    // Il tetto vale SOLO quando l'OTP è richiesto: se la scuola l'ha disattivato non c'è nessun
    // codice da indovinare, e contare le giustifiche sbarrerebbe soltanto chi ne ha più d'una.
    if (richiedeOtp) {
      const troppe = await limitaVerificaOtp(userId)
      if (troppe) return troppe
    }

    // Conferma OTP email (FES) prima di procedere (se richiesta dalle impostazioni).
    const email = await getUserEmail(supabase, userId)
    if (!email) return NextResponse.json({ error: 'Email del genitore non trovata' }, { status: 400 })
    const { ip, userAgent } = extractRequestMeta(request)
    if (richiedeOtp) {
      const check = verifyTicket(email, String(code ?? ''), Number(expiry ?? 0), String(ticket ?? ''))
      if (!check.ok) {
        await logFeaEvent(supabase, { entitaTipo: 'giustifica', signerUserId: userId, email, evento: 'verify_failed', ip, userAgent })
        return NextResponse.json({ error: check.error }, { status: 400 })
      }
    }

    // IL GRADO NON LETTO NON È «NON SEI DELLA PRIMARIA». Stessa regola 7, e qui
    // il degrado era ancora più insidioso: `sez` restava `null`, `schoolType`
    // diventava `null`, e il confronto `!== 'primaria'` era vero per COSTRUZIONE
    // — cioè un guasto del database usciva come un rifiuto di merito, 403, su una
    // famiglia che ha diritto a giustificare. Il gemello (`parent/presenze:GET`)
    // sullo stesso `sections` degrada a `warn` perché lì il grado decide solo
    // un'etichetta; qui decide un ACCESSO, e un accesso non si nega al buio.
    let schoolType: string | null = null
    if (alunno.section_id) {
      const { data: sez, error: sezErr } = await supabase
        .from('sections')
        .select('school_type')
        .eq('id', alunno.section_id)
        .maybeSingle()
      if (sezErr) {
        logErrore({ operazione: 'parent/presenze/giustifica:POST', stato: 500, evento: 'db' }, sezErr)
        return NextResponse.json(
          { error: 'Errore interno', codice: 'GIUSTIFICA_NON_SALVATA' },
          { status: 500 },
        )
      }
      schoolType = sez?.school_type ?? null
    }
    if (schoolType !== 'primaria') {
      return NextResponse.json({ error: 'Giustifica disponibile solo per la scuola primaria' }, { status: 403 })
    }

    const firma = richiedeOtp
      ? buildSignatureLog({
          method: 'OTP_EMAIL',
          email,
          ip,
          userAgent,
          hash: codeHash(email, String(code), Number(expiry)),
        })
      : buildSignatureLog({ method: 'CONFERMA_APP', email, ip, userAgent })

    // Aggiorna la riga presenza del giorno (deve esistere: appello registrato dal docente).
    //
    // ═══ LE TRE COSE CHE LA PORTA GEMELLA AVEVA GIÀ IMPARATO ═════════════════
    //
    // `comunica-assenza` scrive LA STESSA COLONNA della stessa tabella, e nel
    // ciclo del 2026-08-07 vi sono state chiuse tre cose che qui erano ancora
    // aperte — con in più una firma elettronica appesa:
    //
    //  1. IL MOTIVO VUOTO NON CANCELLA. `giustificazione_testo: motivoTesto ||
    //     null` su un UPDATE azzera il testo già archiviato — dato sanitario di
    //     un minore — senza che nessuno l'abbia chiesto. Con il motivo vuoto la
    //     colonna non si nomina affatto: nominarla a `null` la azzererebbe
    //     esattamente come prima.
    //  2. SI CHIEDE UNA COLONNA, NON VENTICINQUE. `.select()` nudo è `select *`,
    //     e ciò che torna da un UPDATE non è quello che hai scritto: è quello
    //     che C'ERA — `note_appello` (la nota del docente sul bambino),
    //     `registrato_da`/`utente_id` (identificativi di personale) e
    //     `giustificazione_firma`, che porta email, indirizzo IP e user agent.
    //     Di tutto questo al client serve `id`.
    //  3. LA PROSA DI POSTGREST NON ESCE. Il `message` è inglese con dentro nomi
    //     di colonne e vincoli, e finiva davanti a un genitore. Resta nel log,
    //     intero, che è dove dice PERCHÉ.
    // ═══ 4. LA PRESA VISIONE DECADE COL TESTO, NON A OGNI FIRMA (Q5) ═════════
    //
    // Qui c'era `giust_vista_il: null` incollato nel payload, con il commento
    // «una nuova giustifica azzera l'eventuale presa visione precedente». Verso
    // giusto, regola sbagliata per difetto opposto a quello del gemello: firmare
    // di nuovo lo STESSO testo faceva perdere al docente una lettura che aveva
    // davvero fatto. E il gemello (`comunica-assenza`) non azzerava affatto.
    //
    // Una regola valida per due strade vive in un posto solo:
    // `@/lib/presenze/presa-visione`.
    //
    // Serve il testo ARCHIVIATO, che questa rotta non leggeva mai: l'UPDATE era
    // cieco. Si chiede la sola colonna che serve — è un dato sanitario di un
    // minore, non esce da qui e non entra in nessun log.
    const { data: prima, error: primaErr } = await supabase
      .from('presenze')
      .select('giustificazione_testo')
      .eq('alunno_id', studentId)
      .eq('data', data)
      .maybeSingle()
    if (primaErr) {
      // PostgREST non lancia: senza questa riga il guasto uscirebbe come
      // «nessun testo precedente», cioè come «il testo è cambiato». Il degrado
      // è quello PRUDENTE — si azzera, il docente rilegge — perché una presa
      // visione tenuta in piedi per errore è un'affermazione falsa su chi ha
      // letto che cosa; una tolta per errore costa una rilettura.
      logEvento('registro', 'warn', {
        operazione: 'parent/presenze/giustifica:POST',
        esito: 'testo-precedente-non-letto',
        alunno_id: studentId,
      }, primaErr)
    }
    /** Ciò che l'UPDATE scriverà davvero: `undefined` = la colonna non si nomina. */
    const testoDaScrivere = motivoTesto || undefined
    const azzeraVisione = primaErr
      ? PRESA_VISIONE_AZZERATA
      : azzeramentoPresaVisione(
          (prima?.giustificazione_testo as string | null | undefined) ?? null,
          testoDaScrivere,
        )
    const aggiornamento: Record<string, unknown> = {
      giustificata: true,
      giustificata_da: userId,
      giustificata_il: new Date().toISOString(),
      giustificazione_firma: firma,
      ...azzeraVisione,
    }
    // Lo stesso valore appena misurato, normalizzato una volta sola e nello stesso modo
    // del gemello: il tetto deve valere sul testo che arriva davvero in tabella.
    if (motivoTesto) aggiornamento.giustificazione_testo = motivoTesto

    const { data: updated, error } = await supabase
      .from('presenze')
      .update(aggiornamento)
      .eq('alunno_id', studentId)
      .eq('data', data)
      .select('id')
      .maybeSingle()

    if (error) {
      logErrore({ operazione: 'parent/presenze/giustifica:POST', stato: 500, evento: 'db' }, error)
      return NextResponse.json(
        { error: 'Errore interno', codice: 'GIUSTIFICA_NON_SALVATA' },
        { status: 500 },
      )
    }
    if (!updated) return NextResponse.json({ error: 'Nessuna assenza registrata per quella data' }, { status: 404 })

    // Ledger slot firmatari (additivo, best-effort).
    if (updated?.id) {
      await recordSignerSlot(supabase, {
        entitaTipo: 'giustifica',
        entitaId: updated.id,
        signerUserId: userId,
        signatureLog: firma,
      })
      await logFeaEvent(supabase, {
        entitaTipo: 'giustifica',
        entitaId: updated.id,
        signerUserId: userId,
        email,
        evento: 'signed',
        hash: firma.hash,
        ip,
        userAgent,
      })
    }

    // Notifica ai docenti della sezione (best-effort): giustifica ricevuta.
    try {
      // Qui il degrado è ACCETTABILE — la notifica parte con «un alunno» al posto
      // del nome — ma non deve essere MUTO: `warn`, come già fa il gemello. Senza,
      // «perché la maestra ha ricevuto un avviso senza nome?» non ha risposta.
      const { data: anagrafica, error: anagraficaErr } = await supabase
        .from('alunni')
        .select('nome, cognome')
        .eq('id', studentId)
        .maybeSingle()
      if (anagraficaErr) {
        logEvento('registro', 'warn', {
          operazione: 'parent/presenze/giustifica:POST',
          esito: 'anagrafica-non-letta',
          alunno_id: studentId,
        }, anagraficaErr)
      }
      const docenti = (await docentiDiSezione(supabase, alunno.section_id as string)).filter((id) => id !== userId)
      const nomeAlunno = [anagrafica?.nome, anagrafica?.cognome].filter(Boolean).join(' ') || 'un alunno'
      await notificaEvento(supabase, {
        tipo: 'giustifica_ricevuta',
        scuolaId: (alunno.scuola_id as string | undefined) ?? null,
        utenteIds: docenti,
        titolo: 'Giustifica ricevuta',
        corpo: `Il genitore di ${nomeAlunno} ha giustificato l'assenza del ${data}.`,
        link: `/teacher/primaria/${alunno.section_id}/appello`,
        entitaTipo: 'presenza',
        entitaId: (updated as { id?: string })?.id ?? null,
      })
    } catch (e) {
      // La giustifica è registrata, ma il docente non la vedrà arrivare: notifica persa.
      logEvento('notifica', 'error', {
        operazione: 'parent/presenze/giustifica:POST',
        tipo: 'giustifica_ricevuta',
        esito: 'notifica_non_inviata',
      }, e)
    }

    return NextResponse.json({ success: true, data: { id: updated?.id ?? null } })
  } catch (err) {
    logErrore({ operazione: 'parent/presenze/giustifica:POST', stato: 500 }, err)
    // Il messaggio dell'eccezione NON esce: può portare dettagli interni
    // (percorsi, nomi di colonne, testo di un vincolo) davanti a un genitore.
    // È già andato nel log una riga sopra, che è dove serve.
    return NextResponse.json(
      { error: 'Errore interno', codice: 'GIUSTIFICA_NON_SALVATA' },
      { status: 500 },
    )
  }
})
