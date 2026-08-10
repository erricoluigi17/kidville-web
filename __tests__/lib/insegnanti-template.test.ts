import { describe, it, expect } from 'vitest'
import {
  INSEGNANTE_FIELDS,
  CONSENSI_INSEGNANTI_FIELDS,
  CONSENSI_INSEGNANTI_VERSIONE,
  GRADI_OPTIONS,
  TITOLI_STUDIO,
  CANDIDATURA_LIMITI,
} from '@/lib/forms/insegnanti-template'
import { validateField } from '@/lib/forms/validate-fields'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { EVENTI_NOTI, EVENTI_PERSISTITI } from '@/lib/logging/logger'
import { ESTENSIONI_ALLEGATO_PUBBLICO } from '@/lib/upload/allegati-pubblici'
import { LIMITE_UPLOAD_MB, limiteUploadByte } from '@/lib/upload/limite-piattaforma'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import schemaSnapshot from '../fixtures/candidature-schema-snapshot.json'
import itShared from '../../messages/it/shared.json'
import enShared from '../../messages/en/shared.json'

/**
 * Il modulo pubblico di candidatura delle insegnanti (`/lavora-con-noi`).
 *
 * Questo file sorveglia le FONDAMENTA condivise — il template dei campi, i
 * consensi, il vocabolario dei log e i codici d'errore — cioè le tre cose che
 * route e interfaccia importeranno senza poterle ridiscutere.
 *
 * ── PERCHÉ C'È UNA FOTOGRAFIA DELLO SCHEMA, E NON UN ELENCO RIBATTUTO A MANO ──
 *
 * La prima versione di questo file confrontava gli id con un elenco copiato a mano
 * e derivava `db_mapping` dall'id stesso (`toBe(`candidature_insegnanti.${f.id}`)`):
 * una tautologia, verde qualunque cosa ci fosse scritto. Aggiungere una quarta
 * fascia d'età o rinominare un id avrebbe lasciato l'albero verde e ucciso il primo
 * invio vero con `PGRST204` o `22P02` — cioè esattamente la classe di difetto che
 * questa corsia dichiara di voler prevenire.
 *
 * Ora l'atteso viene da `__tests__/fixtures/candidature-schema-snapshot.json`,
 * scattato dal DB di produzione con `candidature-schema-fotografia.mjs` (stessa
 * forma dei fixture già in uso per migrazioni, RLS e FK di sede). Il lock gira
 * offline: in CI le credenziali di produzione non ci sono e non devono esserci.
 */

const campo = (id: string) => INSEGNANTE_FIELDS.find((f) => f.id === id)

/** Le colonne vere della tabella, per nome. */
const COLONNE = new Map(schemaSnapshot.colonne.map((c) => [c.nome, c]))

/** Tutti i sorgenti `.ts`/`.tsx` sotto `src/`, per le prove che leggono il codice. */
function sorgentiSrc(dir = join(process.cwd(), 'src')): string[] {
  const fuori: string[] = []
  for (const voce of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, voce.name)
    if (voce.isDirectory()) fuori.push(...sorgentiSrc(p))
    else if (/\.tsx?$/.test(voce.name)) fuori.push(p)
  }
  return fuori
}

const COME_RIGENERARE =
  'Rigenera la fotografia: `node __tests__/fixtures/candidature-schema-fotografia.mjs --sql` → ' +
  'esegui la query sul DB di produzione (sola lettura) → ' +
  '`node __tests__/fixtures/candidature-schema-fotografia.mjs < risposta.json`.'

describe('template di candidatura insegnanti · il legame con lo schema vero', () => {
  it('la fotografia dello schema non è stata addomesticata a mano (sha256)', () => {
    // Senza questa prova basterebbe aggiungere una riga alla fotografia per far
    // tacere il lock su un id inventato: cioè per rimettere il difetto che il lock
    // esiste per impedire. Stesse chiavi e stesso ordine di `normalizza()` in
    // `__tests__/fixtures/candidature-schema-fotografia.mjs`.
    const atteso = createHash('sha256')
      .update(JSON.stringify({
        tabella: schemaSnapshot.tabella,
        colonne: schemaSnapshot.colonne,
        enum_school_type: schemaSnapshot.enum_school_type,
        check: schemaSnapshot.check,
      }))
      .digest('hex')
    expect(schemaSnapshot.sha256, `fotografia modificata a mano. ${COME_RIGENERARE}`).toBe(atteso)
  })

  it('la fotografia è piena e plausibile (se cade, il lock si sta autoingannando)', () => {
    // Un lock che gira su una fotografia vuota passa sempre: è il modo più
    // silenzioso di non controllare niente.
    expect(schemaSnapshot.tabella).toBe('candidature_insegnanti')
    expect(schemaSnapshot.colonne.length, 'fotografia troppo magra').toBeGreaterThan(15)
    expect(schemaSnapshot.enum_school_type.length).toBeGreaterThan(1)
    expect(schemaSnapshot.check.length).toBeGreaterThan(1)
  })

  it('la fotografia esiste accanto al generatore che la sa rifare', () => {
    // Una fotografia senza lo script che la rigenera è una fotografia che, alla
    // prima migrazione, nessuno saprà più aggiornare se non a mano — cioè falsando
    // lo sha256 qui sopra.
    const fixtures = readdirSync(join(process.cwd(), '__tests__', 'fixtures'))
    expect(fixtures).toContain('candidature-schema-fotografia.mjs')
    expect(fixtures).toContain('candidature-schema-snapshot.json')
    const generatore = readFileSync(
      join(process.cwd(), '__tests__', 'fixtures', 'candidature-schema-fotografia.mjs'), 'utf8',
    )
    expect(generatore, 'il generatore non legge più `information_schema`').toContain('information_schema.columns')
    expect(generatore, 'il generatore non legge più le etichette dell’enum').toContain('pg_enum')
  })

  it('ogni id del template è una COLONNA vera di `candidature_insegnanti`', () => {
    const ids = INSEGNANTE_FIELDS.map((f) => f.id)
    expect(new Set(ids).size, 'due campi con lo stesso id: il secondo sovrascriverebbe il primo').toBe(ids.length)
    // È il confronto che conta: un id inventato non fa rosso da nessun'altra parte,
    // PostgREST risponderebbe `PGRST204` sul primo invio vero.
    const inesistenti = ids.filter((id) => !COLONNE.has(id))
    expect(
      inesistenti,
      `campi che puntano a colonne che in produzione NON esistono. ${COME_RIGENERARE}`,
    ).toEqual([])

    for (const f of INSEGNANTE_FIELDS) {
      // L'atteso viene dalla FOTOGRAFIA, non dall'id del campo: derivarlo dall'id
      // renderebbe questa riga una tautologia (era il difetto della prima stesura).
      const colonna = COLONNE.get(f.id)!
      expect(f.db_mapping, `il campo ${f.id} non dichiara la colonna di destinazione`)
        .toBe(`${schemaSnapshot.tabella}.${colonna.nome}`)
    }
  })

  it('nessun campo del template punta a una colonna DI SERVIZIO che la route riempie da sé', () => {
    // `id`, `scuola_id`, `stato`, i timestamp e l'esito dell'istruttoria non sono
    // dati che si chiedono a chi si candida: se uno di questi comparisse fra i
    // campi del modulo, il modulo PUBBLICO permetterebbe di sceglierseli.
    const diServizio = new Set([
      'id', 'scuola_id', 'stato', 'consents_log', 'creata_il', 'aggiornata_il',
      'evasa_il', 'evasa_da', 'utente_id', 'motivo_rifiuto',
    ])
    const intrusi = INSEGNANTE_FIELDS.map((f) => f.id).filter((id) => diServizio.has(id))
    expect(intrusi, 'campi del modulo pubblico su colonne di servizio').toEqual([])
  })

  it('l’ordine dei campi è quello di COMPILAZIONE, non quello delle colonne', () => {
    // Detto qui perché la prima stesura di questo file dichiarava l'elenco
    // «misurato su `information_schema.columns`» e poi lo scriveva in un ordine che
    // NON era quello di `ordinal_position`: in produzione `gradi` è la colonna 10,
    // PRIMA di `titolo_studio`, mentre nel modulo viene dopo `anni_esperienza`.
    // I due ordini sono diversi di proposito — si chiede il titolo di studio e poi
    // le fasce, che è come la conversazione va — ma allora l'ordine del modulo non
    // va spacciato per una misura del database.
    const posizioni = INSEGNANTE_FIELDS.map((f) => COLONNE.get(f.id)!.posizione)
    const ordinate = [...posizioni].sort((a, b) => a - b)
    expect(
      posizioni,
      'se un giorno i due ordini coincidessero questa prova andrebbe tolta, non "aggiustata"',
    ).not.toEqual(ordinate)
    // E la divergenza è esattamente quella misurata: `gradi` sta prima di
    // `titolo_studio` in tabella e dopo nel modulo.
    expect(COLONNE.get('gradi')!.posizione).toBeLessThan(COLONNE.get('titolo_studio')!.posizione)
    const idsModulo = INSEGNANTE_FIELDS.map((f) => f.id)
    expect(idsModulo.indexOf('gradi')).toBeGreaterThan(idsModulo.indexOf('titolo_studio'))
  })
})

describe('template di candidatura insegnanti · i campi', () => {
  it('NON chiede il codice fiscale: serve all’assunzione, non alla candidatura', () => {
    // Minimizzazione (art. 5 §1 lett. c GDPR). Il modulo è PUBBLICO e senza
    // login: un codice fiscale raccolto qui sarebbe un identificativo nazionale
    // in una tabella che chiunque può alimentare.
    const sospetti = INSEGNANTE_FIELDS.filter(
      (f) => /fiscal|codice_fiscale|\bcf\b/i.test(f.id) || /codice fiscale/i.test(f.label),
    )
    expect(sospetti.map((f) => f.id)).toEqual([])
  })

  it('nome, cognome ed email sono obbligatori; residenza e telefono no', () => {
    for (const id of ['nome', 'cognome', 'email']) {
      expect(campo(id)?.required, `${id} dovrebbe essere obbligatorio`).toBe(true)
    }
    for (const id of ['telefono', 'residence_city', 'residence_province', 'cv_path']) {
      expect(campo(id)?.required ?? false, `${id} dovrebbe essere facoltativo`).toBe(false)
    }
    expect(campo('email')?.type).toBe('email')
    expect(campo('telefono')?.type).toBe('phone')
    expect(campo('cv_path')?.type).toBe('file')
  })

  it('la provincia di residenza eredita il comportamento «provincia» dall’id', () => {
    // `isProvinceField` guarda il SUFFISSO `_province`: da lì arrivano gratis
    // l’auto-maiuscolo, lo snap su blur («Napoli» → «NA») e il controllo che la
    // sigla esista davvero. Chiamarlo `provincia_residenza` avrebbe spento tutto
    // in silenzio.
    expect(campo('residence_province')?.id).toMatch(/_province$/)
    expect(validateField(campo('residence_province')!, 'XY')).not.toBeNull()
    expect(validateField(campo('residence_province')!, 'NA')).toBeNull()
    expect(validateField(campo('residence_province')!, ''), 'è facoltativo').toBeNull()
  })

  it('gli anni di esperienza stanno fra 0 e 60, come il CHECK del database', () => {
    const anni = campo('anni_esperienza')!
    expect(anni.type).toBe('number')
    expect(anni.validation?.min).toBe(0)
    expect(anni.validation?.max).toBe(60)
    expect(validateField(anni, 61)).not.toBeNull()
    expect(validateField(anni, -1)).not.toBeNull()
    expect(validateField(anni, 0)).toBeNull()
    expect(validateField(anni, 60)).toBeNull()
  })

  it('la presentazione è una textarea con un tetto di 1000 caratteri', () => {
    const note = campo('note')!
    expect(note.type).toBe('textarea')
    expect(note.validation?.max_length).toBe(1000)
    expect(validateField(note, 'a'.repeat(1001))).not.toBeNull()
    expect(validateField(note, 'a'.repeat(1000))).toBeNull()
  })

  it('titolo di studio e disponibilità sono select chiuse', () => {
    const titolo = campo('titolo_studio')!
    expect(titolo.type).toBe('select')
    expect(titolo.options).toEqual(TITOLI_STUDIO)
    expect(validateField(titolo, 'inventato')).toBe('Selezione non valida')
    expect(validateField(titolo, TITOLI_STUDIO[0].value)).toBeNull()
    expect(campo('disponibilita')?.type).toBe('select')
    expect((campo('disponibilita')?.options ?? []).length).toBeGreaterThan(1)
  })
})

describe('template di candidatura insegnanti · il CV allegato', () => {
  /*
   * PERCHÉ QUESTE QUATTRO RIGHE ESISTONO (rilievo della revisione del 2026-08-10).
   *
   * Il campo `cv_path` era l'unica metà del template che nessuno aveva MISURATO
   * dal lato che conta: lo Storage. Dichiarava `accept: '.pdf,.doc,.docx,.jpg,
   * .jpeg,.png'` e `max_size_mb: 5`, due numeri scritti a occhio, mentre in
   * produzione (misurato il 2026-08-10, `select id, file_size_limit,
   * allowed_mime_types from storage.buckets`):
   *
   *   · NON esiste nessun bucket per i curriculum — la sola strada pubblica di
   *     caricamento del repo scrive in `form_attachments`;
   *   · `form_attachments` ammette 5 tipi e NON comprende né `application/msword`
   *     né `…wordprocessingml.document`, e il gate applicativo gemello
   *     (`ESTENSIONI_ALLEGATO_PUBBLICO`) ammette `pdf jpg jpeg png webp heic`.
   *
   * Quindi il selettore di file OFFRIVA `.doc`/`.docx` — il formato in cui la
   * maggioranza dei curriculum viaggia — su un modulo PUBBLICO, e il server li
   * avrebbe respinti con un 415 DOPO che la persona aveva compilato tutto. È il
   * difetto «bucket più stretto del gate» per cui in questo repo esistono
   * `src/lib/allegati/mime.ts` e il lock `allegati-mime-dichiarati.test.ts`,
   * spostato di un campo. All'opposto `.heic` — il formato che produce l'iPhone,
   * ammesso sia dal gate sia dal bucket — non era offerto.
   */

  /** L'`accept` normalizzato: minuscolo, senza punto, senza spazi. */
  const estensioniOfferte = (): string[] =>
    (campo('cv_path')!.accept ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean)

  it('l’`accept` è ESATTAMENTE l’allowlist pubblica del repo, non una lista sua', () => {
    // Il confronto è con la FONTE, non con una stringa ribattuta qui: chi allarga
    // o stringe `ESTENSIONI_ALLEGATO_PUBBLICO` (e la migrazione del bucket, che il
    // lock `upload-pubblico-con-tetto` tiene allineata a quella costante) rende
    // rossa questa riga invece di lasciare divergere il selettore in silenzio.
    const offerte = estensioniOfferte()
    expect(new Set(offerte).size, 'estensione ripetuta nell’`accept`').toBe(offerte.length)
    expect(
      [...offerte].sort(),
      'il selettore del CV offre estensioni che il gate pubblico (`verificaAllegatoPubblico`) ' +
      'non accetta, o ne nasconde di accettate: chi compila sceglie un file e viene respinto ' +
      'DOPO, con un 415, su un modulo senza login e senza nessuno a cui chiedere.',
    ).toEqual([...ESTENSIONI_ALLEGATO_PUBBLICO].sort())
  })

  it('`.doc` e `.docx` NON si offrono, `.heic` sì (la regressione misurata)', () => {
    // Regressione mirata: il caso concreto, scritto per nome, così una riscrittura
    // dell'`accept` che ripristini il difetto non passi per una svista di elenco.
    const offerte = estensioniOfferte()
    expect(
      offerte.filter((e) => e === 'doc' || e === 'docx'),
      'nessun bucket né gate pubblico di questo repo accetta Word: offrirlo è una promessa ' +
      'che il server rompe. Se il Word deve entrare, si allarga PRIMA la lista del gate e la ' +
      '`allowed_mime_types` del bucket, con la migrazione.',
    ).toEqual([])
    expect(offerte, 'il formato che produce l’iPhone è ammesso dal gate: escluderlo qui ' +
      'respinge una foto del curriculum valida').toContain('heic')
  })

  it('il tetto del CV è una promessa che la PIATTAFORMA può mantenere', () => {
    // IL VINCOLO CHE DECIDE NON È IL BUCKET, ed è la misura che mancava. Il bucket
    // `form_attachments` sta a 8 MB (8388608, misurato), ma sopra il tetto di
    // Vercel la richiesta non arriva MAI alla route: `limiteUploadByte` taglia a
    // 4 MB (`@/lib/upload/limite-piattaforma`, dove il 413 è misurato dal vivo — 41
    // tentativi falliti in un giorno sul modulo pubblico). `max_size_mb: 5`
    // dichiarava quindi un tetto che nessuno poteva mantenere: il `Math.min` lo
    // riportava a 4 e il campo prometteva 5.
    //
    // Questa riga dice esattamente questo: il `Math.min` NON deve mordere. Se
    // qualcuno rialza `maxCvMb` sopra il tetto di piattaforma, diventa rossa.
    const mb = CANDIDATURA_LIMITI.maxCvMb
    expect(mb).toBeGreaterThan(0)
    expect(
      limiteUploadByte(mb),
      `il campo promette ${mb} MB ma la piattaforma ne lascia passare ${LIMITE_UPLOAD_MB}: ` +
      'sopra quel tetto la route non parte nemmeno e il 413 non è nostro (non risponde in JSON).',
    ).toBe(mb * 1024 * 1024)
    // …e il campo dichiara quel numero, non un secondo numero suo.
    expect(campo('cv_path')?.max_size_mb).toBe(mb)
  })

  it('il template PRESCRIVE alla route il bucket e il gate, come ha fatto per i `gradi`', () => {
    // Un commento è una prescrizione solo se qualcuno si accorge quando sparisce.
    // Qui la prescrizione è: nessun bucket nuovo (in produzione non ce n'è uno per
    // i curriculum) e nessun gate inventato — `form_attachments` +
    // `verificaAllegatoPubblico`, le due cose che già esistono.
    const sorgente = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    expect(sorgente, 'il template non prescrive più il bucket').toContain('form_attachments')
    expect(sorgente, 'il template non prescrive più il gate pubblico').toContain('verificaAllegatoPubblico')
  })
})

describe('template di candidatura insegnanti · i gradi (multi-valore obbligatorio)', () => {
  it('sono una checkbox obbligatoria, e i `value` sono LE ETICHETTE DELL’ENUM', () => {
    const gradi = campo('gradi')!
    expect(gradi.type).toBe('checkbox')
    expect(gradi.required).toBe(true)
    expect(gradi.options).toEqual(GRADI_OPTIONS)

    // È il confronto che conta, e la prima stesura non lo faceva: ricopiava le tre
    // coppie label/value dal sorgente, cioè si confrontava con se stessa. La colonna
    // `gradi` è di tipo `school_type_enum[]` (fotografia: udt `_school_type_enum`),
    // quindi un `value` che non sia un'etichetta dell'enum NON entra in tabella:
    // Postgres lo rifiuta con `22P02`, e su un modulo pubblico quel rifiuto grezzo
    // diventerebbe un 500 opaco.
    expect(COLONNE.get('gradi')!.udt, 'la colonna `gradi` non è più un array di enum').toBe('_school_type_enum')
    expect(
      GRADI_OPTIONS.map((o) => o.value).sort(),
      `i valori del modulo non coincidono con le etichette di \`school_type_enum\`. ${COME_RIGENERARE}`,
    ).toEqual([...schemaSnapshot.enum_school_type].sort())

    // Le etichette a schermo restano una scelta redazionale (l'età fra parentesi):
    // si controlla che ci siano e che nominino la fascia, non che siano una stringa
    // ribattuta qui dentro.
    for (const o of GRADI_OPTIONS) {
      expect(o.label.toLowerCase(), `l’etichetta di ${o.value} non nomina la fascia`).toContain(
        o.value === 'nido' ? 'nido' : o.value === 'infanzia' ? 'infanzia' : 'primaria',
      )
      expect(o.label, `l’etichetta di ${o.value} non dichiara l’età`).toMatch(/\(\d+-\d+\)/)
    }
  })

  it('«almeno un grado» lo garantisce `validateField`, NON il vincolo del database', () => {
    // Il modulo tiene: `eVuoto()` tratta una checkbox come vuota quando il valore
    // non è un array o è un array vuoto, e `required` fa il resto.
    const gradi = campo('gradi')!
    expect(validateField(gradi, [])).toBe('Campo obbligatorio')
    expect(validateField(gradi, undefined)).toBe('Campo obbligatorio')
    expect(validateField(gradi, null)).toBe('Campo obbligatorio')
    expect(validateField(gradi, ['nido'])).toBeNull()
    expect(validateField(gradi, ['nido', 'primaria'])).toBeNull()

    // MA IL DATABASE NON RIPETE QUESTO CONFINE, e per due settimane questo file ha
    // scritto il contrario. Il CHECK in tabella è `array_length(gradi, 1) >= 1`, e
    // su un array vuoto `array_length` vale NULL: un CHECK che vale NULL PASSA.
    // Misurato in produzione il 2026-08-10:
    //   select (array_length('{}'::text[],1) >= 1)  →  NULL
    //   create temp table t (g text[] not null default '{}' check (array_length(g,1) >= 1));
    //   insert into t default values;                →  1 riga scritta, con `{}`
    // Sommato al `not null default '{}'` della colonna, una route che semplicemente
    // NON manda `gradi` archivia una candidatura con zero fasce, in silenzio.
    const vincolo = schemaSnapshot.check.find((k) => k.nome.includes('gradi'))
    expect(vincolo, 'il CHECK sui gradi è sparito dalla fotografia').toBeDefined()
    expect(
      vincolo!.definizione,
      'il vincolo è cambiato: se ora copre l’array vuoto (es. `cardinality(gradi) >= 1`), ' +
      'aggiorna il commento del template — non limitarti a rendere verde questa riga',
    ).toContain('array_length(gradi, 1) >= 1')
    expect(COLONNE.get('gradi')!.nullable, 'la colonna è NOT NULL: il default `{}` la riempie da sé').toBe(false)
    expect(COLONNE.get('gradi')!.default).toBe("'{}'::school_type_enum[]")
  })

  it('`validateField` NON controlla l’appartenenza sulla checkbox: filtra la route', () => {
    // Il controllo «Selezione non valida» in `validate-fields.ts` è scritto per
    // `select` e `radio`, non per `checkbox`: un valore inventato passa la
    // validazione del modulo e arriva all'INSERT, dove prende `22P02`.
    // Questa riga è il motivo per cui il template PRESCRIVE alla route di filtrare
    // contro `GRADI_OPTIONS`. Se un domani `validateField` imparasse a controllare
    // anche le checkbox, questa prova diventa rossa: è il momento di togliere la
    // prescrizione dal template, non di cancellare il test.
    const gradi = campo('gradi')!
    expect(
      validateField(gradi, ['fascia_inventata']),
      'la checkbox ora controlla l’appartenenza: aggiorna il template',
    ).toBeNull()
    // Il confronto: sul `select` lo stesso valore inventato viene respinto.
    expect(validateField(campo('titolo_studio')!, 'inventato')).toBe('Selezione non valida')
  })

  it('il template PRESCRIVE alla route le due difese che il database non dà', () => {
    // Un commento è una prescrizione solo se qualcuno si accorge quando sparisce.
    // Le due difese sono: `gradi` sempre esplicito nell'INSERT (contro l'array
    // vuoto che il CHECK lascia passare) e filtro contro `GRADI_OPTIONS` (contro il
    // 22P02). Chi riscrive quel commento deve riscrivere anche questa riga.
    const sorgente = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    // `[\s\S]` invece del flag `s`: il target di questo tsconfig è precedente a
    // es2018 e `dotAll` non è disponibile.
    expect(sorgente, 'il template non prescrive più `gradi` esplicito').toMatch(/gradi[\s\S]{0,80}ESPLICITO/i)
    expect(sorgente, 'il template non prescrive più il filtro contro GRADI_OPTIONS').toContain('22P02')
    expect(sorgente, 'il template non nomina più il buco dell’array vuoto').toMatch(/array_length/i)
  })
})

describe('template di candidatura insegnanti · i consensi', () => {
  it('sono due blocchi `consent`: la presa visione, e la sola conservazione', () => {
    expect(CONSENSI_INSEGNANTI_FIELDS).toHaveLength(2)
    for (const c of CONSENSI_INSEGNANTI_FIELDS) expect(c.type).toBe('consent')
    const [informativa, conservazione] = CONSENSI_INSEGNANTI_FIELDS
    expect(informativa.id).toBe('presa_visione_informativa')
    expect(informativa.required).toBe(true)
    expect(informativa.link).toBe('/privacy')
    expect(conservazione.id).toBe('consenso_conservazione_candidatura')
    expect(conservazione.required ?? false, 'un consenso obbligatorio non è libero').toBe(false)
  })

  it('la conservazione dichiara i 24 mesi e la revocabilità nel testo che si archivia', () => {
    const conservazione = CONSENSI_INSEGNANTI_FIELDS[1]
    // Il file argomenta (art. 13 §2 lett. a) che il termine PROMESSO all'interessata
    // e il termine APPLICATO dal futuro cron non possono divergere.
    expect(conservazione.text).toContain(`${CANDIDATURA_LIMITI.mesiConservazione} mesi`)
    expect(conservazione.text).toMatch(/revocabil/i)

    /*
     * ⚠️ E il legame NON è retto solo dalla riga qui sopra (rilievo della revisione
     * del 2026-08-10, fondato: fino a quel momento il testo ribatteva il letterale
     * «per 24 mesi» mentre due documenti — PRD e questo commento — dichiaravano che
     * era interpolato). L'asserzione sul valore intercetta la divergenza, ma NON
     * distingue «interpolato» da «ribattuto uguale»: finché il numero sta scritto a
     * mano, il primo `mesiConservazione: 36` renderebbe rosso questo test invece di
     * cambiare il testo, e il testo del consenso resterebbe quello vecchio.
     * Perciò qui si guarda il SORGENTE, ed è l'unica riga che rende vera la frase.
     */
    const sorgenteTemplate = readFileSync(
      join(process.cwd(), 'src', 'lib', 'forms', 'insegnanti-template.ts'), 'utf8',
    )
    expect(
      sorgenteTemplate,
      'il testo del consenso non interpola più `CANDIDATURA_LIMITI.mesiConservazione`: ' +
        'il termine promesso all’interessata è tornato a essere un numero scritto a mano, ' +
        'cioè una seconda costante indipendente per lo stesso limite.',
    ).toContain('${CANDIDATURA_LIMITI.mesiConservazione} mesi')
    // Le righe di sola prosa si scartano: i commenti del file NOMINANO i 24 mesi
    // per spiegarli, e conterebbero come se il letterale fosse tornato.
    const codiceTemplate = sorgenteTemplate.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
    expect(
      codiceTemplate,
      'il numero dei mesi è di nuovo scritto a mano dentro il testo del consenso',
    ).not.toMatch(/per\s+\d+\s+mesi/)
  })

  it('il testo dei consensi ha una versione datata, da archiviare accanto alla risposta', () => {
    expect(CONSENSI_INSEGNANTI_VERSIONE).toBe('2026-08-10')
    expect(CONSENSI_INSEGNANTI_VERSIONE).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('i limiti del modulo sono dichiarati in un posto solo', () => {
    expect(CANDIDATURA_LIMITI.maxCvMb).toBeGreaterThan(0)
    expect(CANDIDATURA_LIMITI.maxPresentazione).toBe(1000)
    expect(CANDIDATURA_LIMITI.mesiConservazione).toBe(24)
    // Il tetto del CV è quello dichiarato al campo: due numeri per lo stesso
    // limite finiscono per divergere.
    expect(campo('cv_path')?.max_size_mb).toBe(CANDIDATURA_LIMITI.maxCvMb)
  })
})

describe('candidature · vocabolario dei log e codici d’errore', () => {
  it('`candidatura` è un evento NOTO: la route può nominarlo senza aggiungere niente', () => {
    // Il vocabolario è chiuso (`EVENTI_NOTI`): senza questa riga il primo
    // `logEvento('candidatura', …)` della route sarebbe respinto dal lock
    // `eventi-log`, e chi la scrive si troverebbe a dover toccare il logger.
    expect(EVENTI_NOTI.has('candidatura')).toBe(true)
  })

  it('la PERSISTENZA di `candidatura` segue il battito, e arriva insieme alla route', () => {
    /*
     * Questa è la riga che tiene onesta la corsia, ed è nata da un rosso vero.
     *
     * `candidatura` era stato messo in `EVENTI_PERSISTITI` PRIMA che esistesse la
     * route: il lock `__tests__/architecture/eventi-log.test.ts` («ogni evento di
     * EVENTI_PERSISTITI ha almeno un percorso di SUCCESSO che logga») diventava
     * rosso, e restava rosso appeso a un altro agente. Un'allowlist che promette un
     * battito inesistente è la stessa bugia che quel lock esiste per impedire:
     * «nessun log» tornerebbe a non distinguere «non si candida nessuno» da «il
     * modulo non è mai partito».
     *
     * Quindi qui non si asserisce uno stato fisso ma un BICONDIZIONALE: l'evento sta
     * in `EVENTI_PERSISTITI` se e solo se nel sorgente esiste un ramo felice che lo
     * emette — in una qualunque delle DUE forme che il lock condiviso riconosce
     * (vedi la nota qui sotto). Finché la route non c'è, entrambi i lati sono falsi
     * e l'albero è verde; nel momento in cui la route aggiunge il battito senza
     * promuovere l'evento, questa riga diventa rossa e dice esattamente cosa fare.
     * È la promozione automatica che il commento nel logger da solo non poteva
     * garantire.
     *
     * NOTA per chi legge la revisione: spostare `candidatura` in
     * `DEROGHE_INFO_NON_PERSISTITI` NON era una via d'uscita. Quella mappa è
     * sorvegliata da «nessuna deroga è morta», che confronta le sue chiavi con gli
     * eventi che hanno davvero un `logEvento(evento, 'info')` nel sorgente: senza la
     * route, `candidatura` sarebbe finito fra le deroghe morte e il file sarebbe
     * rimasto rosso, solo su un'altra riga.
     */
    /*
     * ⚠️ IL BATTITO HA DUE FORME, NON UNA (rilievo della revisione del 2026-08-10).
     *
     * Fino a oggi questa riga riconosceva solo `logEvento(evento,'info',…)` col
     * livello letterale, mentre il lock condiviso — che è l'autorità in materia —
     * ne conta due (`__tests__/architecture/eventi-log.test.ts:352-355`):
     * `CON_INFO_LETTERALE` e `CON_INFO_DA_EXTERNAL_FETCH`, cioè
     * `externalFetch(…, { evento })`, che è l'UNICO battito di `email`, `push` e
     * `fattura` — nel repo non esiste (e non deve esistere) un
     * `logEvento('email','info',…)` scritto a mano.
     *
     * La conseguenza era concreta e nel verso peggiore: se la route farà partire
     * l'email di conferma della candidatura via `externalFetch({ evento:
     * 'candidatura' })` — la forma che AGENTS.md §3 IMPONE per i provider esterni —
     * il lock condiviso considererebbe l'evento coperto, la promozione in
     * `EVENTI_PERSISTITI` sarebbe corretta, e questa riga sarebbe diventata ROSSA
     * su un'implementazione giusta. Una seconda copia più stretta della stessa
     * regola è la trappola che questo repo si è già scritto in memoria: «una regola
     * valida per due strade deve vivere in un posto solo».
     *
     * Perché qui non si IMPORTA lo scanner condiviso: sta dentro un file di test
     * pieno di `describe`, e importarlo eseguirebbe quel lock una seconda volta.
     * Quindi si riconoscono le due forme con una lettura più GROSSOLANA (una
     * finestra dopo `externalFetch(`, invece dell'estrattore a parentesi bilanciate
     * del lock condiviso), e la grossolanità è deliberatamente orientata: SU QUESTO
     * ASSE può sbagliare solo RICONOSCENDO un battito, mai negandolo. L'errore verso
     * cui pende è quello che il lock condiviso poi respinge da sé — «evento
     * persistito senza percorso felice» — non un rosso su codice corretto.
     * L'asse delle VIRGOLETTE è invece allineato al lock e non "orientato": vedi la
     * nota sulle regex, poche righe più giù, che dice perché e cosa succede se una
     * route userà il doppio apice.
     *
     * Il valore che questa riga aggiunge al lock condiviso, e che resta: là
     * `candidatura` potrebbe scampare finendo in `DEROGHE_INFO_NON_PERSISTITI`;
     * qui no. Il successo di una candidatura si persiste, punto.
     */
    // Le righe di SOLA PROSA si scartano prima di cercare, esattamente come fa
    // `senzaProsa()` nel lock `eventi-log`: senza, il commento qui sopra e quello
    // in `logger.ts` — che la chiamata la NOMINANO per spiegarla — verrebbero
    // contati come se il battito ci fosse già.
    /*
     * ⚠️ SOLO L'APICE SINGOLO, come l'autorità in materia (secondo rilievo della
     * revisione del 2026-08-10, fondato e misurato). Il lock condiviso riconosce
     * unicamente l'apice singolo — `eventi-log.test.ts:40,48`
     * (`/logEvento\(\s*'([a-z_][a-z_0-9]*)'/`) e la riga 210
     * (`/evento:\s*'([a-z_][a-z_0-9]*)'/`) — e nel repo non c'è né `.prettierrc` né
     * una regola eslint `quotes`, quindi `logEvento("candidatura", "info", …)` è
     * scrivibile. Con la classe `['"]` questa riga avrebbe visto quel battito e
     * preteso la promozione in `EVENTI_PERSISTITI`, mentre il lock condiviso — che
     * non lo vede — sarebbe diventato rosso per «evento persistito senza percorso
     * felice»: due rossi simultanei e nessuno dei due risolvibile senza toccare un
     * test. Cioè esattamente il verso che la nota qui sopra dichiara di non avere.
     * Restringendo, le due letture coincidono in ogni caso: se un domani una route
     * scriverà il battito a doppio apice, entrambe non lo vedranno e l'albero
     * resterà verde e coerente — il modo di accorgersene è che `candidatura` non
     * arriva in `app_log`, e la correzione è UNA: riscrivere la chiamata con
     * l'apice singolo, che è la forma usata in tutto `src/`.
     */
    const LETTERALE = /logEvento\(\s*'candidatura'\s*,\s*'info'/
    const DA_EXTERNAL_FETCH = /externalFetch\s*\([\s\S]{0,600}?evento:\s*'candidatura'/
    const emette = sorgentiSrc().some((f) => {
      const codice = readFileSync(f, 'utf8').split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
      return LETTERALE.test(codice) || DA_EXTERNAL_FETCH.test(codice)
    })

    expect(
      EVENTI_PERSISTITI.has('candidatura'),
      emette
        ? 'il sorgente ha un ramo felice per `candidatura` — `logEvento(\'candidatura\', \'info\', …)` ' +
          'oppure `externalFetch(…, { evento: \'candidatura\' })` — ma l’evento NON è in ' +
          '`EVENTI_PERSISTITI`: il successo non arriva in `app_log`, e «nessun log» torna a ' +
          'significare insieme «non si candida nessuno» e «il modulo è rotto». Aggiungilo in ' +
          'src/lib/logging/logger.ts, nello STESSO commit della route. E NON spostarlo in ' +
          '`DEROGHE_INFO_NON_PERSISTITI`: il successo di una candidatura si persiste.'
        : 'nessun ramo felice emette ancora `candidatura`, quindi l’evento non può stare in ' +
          '`EVENTI_PERSISTITI`: il lock `eventi-log` diventerebbe rosso per un battito promesso ' +
          'e mai emesso. Promuovilo insieme alla route, non prima.',
    ).toBe(emette)
  })

  it('i sette codici della candidatura sono dichiarati e tradotti in entrambe le lingue', () => {
    const it = itShared as Record<string, string>
    const en = enShared as Record<string, string>
    const attesi = [
      'CANDIDATURA_NON_INVIATA',
      'CANDIDATURA_GIA_INVIATA',
      'CANDIDATURE_NON_DISPONIBILI',
      'CANDIDATURA_NON_TROVATA',
      'CANDIDATURA_GIA_EVASA',
      'CANDIDATURA_EMAIL_GIA_STAFF',
      'CANDIDATURA_EMAIL_GIA_GENITORE',
    ]
    const mancanti: string[] = []
    for (const codice of attesi) {
      const chiave = (CODICI_ERRORE as Record<string, string>)[codice]
      if (!chiave) { mancanti.push(`${codice}: non dichiarato in CODICI_ERRORE`); continue }
      if (!it[chiave]?.trim()) mancanti.push(`${codice} → messages/it/shared.json:${chiave}`)
      if (!en[chiave]?.trim()) mancanti.push(`${codice} → messages/en/shared.json:${chiave}`)
    }
    expect(mancanti).toEqual([])
  })
})
