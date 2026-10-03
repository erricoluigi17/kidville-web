// Il MOTORE dei caricamenti nativi (`KVMotoreCaricamenti`, compito I2), pilotato a comando con le finte di `fakes.swift`.
//
// Ogni scenario crea un `BancoMotore` (il motore vero + trasporto, rinnovo, segreti, notifica, rete, orologio e pianificatore finti), fa
// succedere una cosa alla volta e guarda le CONSEGUENZE: lo stato della voce su disco, la copia del video, i segreti, ciò che il trasporto
// ha ricevuto, ciò che il rinnovo ha chiesto, i log scritti nel registro, la notifica mostrata, ciò che è stato inoltrato al JS.
//
// I valori attesi sono scritti qui dalla spec (§4.4, §4.5, §5, §8): le attese 30 s / 1' / 2' / 5' / 10', la soglia dei 10 minuti di S0, il tetto
// di 3 rinnovi dopo una PUT rifiutata, i ritentativi che si loggano ai tentativi 1, 2, 4, 8… Non si ricalcolano con il codice che si prova.
//
// `casuale` è fisso a 0,5: lo scarto delle attese è nullo, e le attese sono esattamente quelle della tabella.

import Foundation

private func num(_ v: Int) -> KVValoreCampo { .numero(Int64(v)) }
private func tes(_ v: String) -> KVValoreCampo { .testo(v) }
private func boo(_ v: Bool) -> KVValoreCampo { .booleano(v) }

/// I campi di un evento, senza `versione_app` (che c'è sempre e si prova a parte).
private func campi(_ e: KVEventoRegistrato?) -> [String: KVValoreCampo] {
    var c = e?.campi ?? [:]
    c.removeValue(forKey: "versione_app")
    return c
}

/// Gli scenari del motore, per nome. `KV_SOLO=<pezzo del nome>` ne esegue solo alcuni (per lavorare su uno senza rifare tutto): senza, girano tutti.
func provaMotore() {
    let scenari: [(String, () -> Void)] = [
        ("InvioRiuscito", provaMotoreInvioRiuscito),
        ("PutRifiutataERinnovo", provaMotorePutRifiutataERinnovo),
        ("RinnovoDuplicatoENegato", provaMotoreRinnovoDuplicatoENegato),
        ("RotazioneDelToken", provaMotoreRotazioneDelToken),
        ("RinnovoLimitatoOTransitorio", provaMotoreRinnovoLimitatoOTransitorio),
        ("RinnovoCiclico", provaMotoreRinnovoCiclico),
        ("Transitori", provaMotoreTransitori),
        ("SogliaDiS0", provaMotoreSogliaDiS0),
        ("TokenEFileAssenti", provaMotoreTokenEFileAssenti),
        ("Annulla", provaMotoreAnnulla),
        ("ChiusuraForzata", provaMotoreChiusuraForzata),
        ("BackgroundENotifica", provaMotoreBackgroundENotifica),
        ("Rete", provaMotoreRete),
        ("Ricollega", provaMotoreRicollega),
        ("AvvioERiconciliazione", provaMotoreAvvioERiconciliazione),
        ("CodaIllegibile", provaMotoreCodaIllegibile),
        ("AccodamentoRifiuti", provaMotoreAccodamentoRifiuti),
        ("AccodamentoRipetuto", provaMotoreAccodamentoRipetuto),
        ("Ripristini", provaMotoreRipristini),
        ("TerminaleSalvaPrima", provaMotoreTerminaleSalvaPrima),
        ("Registro", provaMotoreRegistro),
        ("VersoIlJS", provaMotoreVersoIlJS),
        ("SegretiNonDisponibili", provaMotoreSegretiNonDisponibili),
        ("TaskDiAltriGiri", provaMotoreTaskDiAltriGiri),
        ("PulizieConUnTaskVivo", provaMotorePulizieConUnTaskVivo),
        ("RiconciliazioneInPrimoPiano", provaMotoreRiconciliazioneInPrimoPiano),
        ("IndirizziNeiSegreti", provaMotoreIndirizziNeiSegreti),
        ("Sequenze", provaMotoreASequenze),
    ]
    let solo = ProcessInfo.processInfo.environment["KV_SOLO"]
    for (nome, scenario) in scenari where solo == nil || nome.contains(solo!) {
        scenario()
    }
}

// MARK: - Un video che arriva

func provaMotoreInvioRiuscito() {
    sezione("Motore — accoda → PUT da file → 200 → inviato; copia e segreti cancellati a fine corsa")
    let banco = BancoMotore()
    let esito = banco.accoda(1, byte: 1000)
    guard case .accodato(let restituita) = esito else {
        verifica("accoda → accodato", false, "\(esito)")
        return
    }
    verificaUguali("accoda restituisce la voce in coda (stesso job)", restituita.jobId, uuid(1))
    let v = banco.voce(1)
    verificaUguali("la voce è in-invio: il task è partito subito", v?.stato, .inInvio)
    verificaUguali("… un ciclo avviato", v?.tentativi, 1)
    verificaUguali("… creata in primo piano", v?.creatoInBackground, false)
    verificaTutto("… dell'utente, della sede e dell'intento che il JS ha dato", [v?.utenteId, v?.scuolaId, v?.intentId], [uuid(utenteProva), uuid(900), uuid(101)])
    verificaTutto("… col nome (solo per lo schermo), il peso e il MIME", [v?.nome, "\(v?.byte ?? 0)", v?.mime], ["Gita.mov", "1000", "video/quicktime"])
    verificaUguali("… e il percorso della copia relativo, nel posto giusto", v?.file, "file/\(uuid(1).uuidString.lowercased()).mov")
    verifica("il preparato si è spostato: la copia c'è in file/ e non c'è più in scelti/", esiste(banco.copia(1)) && !esiste(banco.scelto("e1")))
    verificaUguali("… e pesa quanto il video", (try? FileManager.default.attributesOfItem(atPath: banco.copia(1).path))?[.size] as? Int, 1000)
    verificaUguali("i segreti sono nel Portachiavi: token, URL firmato, content-type del server, indirizzo del rinnovo", banco.segreti.segreti(uuid(1)),
                   KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    verificaUguali("i testi delle notifiche li ha passati il JS: restano nella coda", banco.coda.testi, testiProva)
    verificaUguali("la destinazione dei log è quella del sito", banco.registro.stato().destinazione?.absoluteString, urlRegistroProva)
    let rimosseAlLancio = banco.notificatore.rimozioni

    verificaUguali("UN task creato", banco.trasporto.numeroCreati, 1)
    let r = banco.trasporto.richiesta(0)
    verificaUguali("… per il job giusto", r.job, uuid(1))
    verificaUguali("… sull'URL firmato", r.url.absoluteString, urlPutProva(1))
    verificaUguali("… col solo content-type del server", r.contentType, "video/quicktime")
    verificaUguali("… dal file della copia", r.file.standardizedFileURL.path, banco.copia(1).standardizedFileURL.path)
    verificaUguali("… di tanti byte quanti ne ha il video", r.byte, 1000)
    verificaUguali("… subito, senza attese (`earliestBeginDate` assente)", r.nonPrima, nil)
    verificaUguali("nessun rinnovo (l'URL è appena firmato)", banco.rinnovo.numeroChiamate, 0)
    verificaUguali("il registro ha UNA riga: video-nativo-accodato", banco.messaggi, [messaggio("video-nativo-accodato", job: 1)])
    verificaUguali("… coi suoi campi: peso, MIME, motore", campi(banco.eventi("video-nativo-accodato").first), ["byte": num(1000), "mime": tes("video/quicktime"), "ambiente": tes("urlsession")])
    verificaUguali("… livello warn (un successo si logga a warn)", banco.eventi("video-nativo-accodato").first?.livello, .warn)
    verificaUguali("… dell'utente della voce (x-user-id)", banco.eventi("video-nativo-accodato").first?.utenteId, uuid(utenteProva))
    verificaUguali("al JS sono arrivati prima `in-coda` e poi `in-invio`", banco.emessi.map { $0.voce.stato }.prefix(2).map { $0 }, [.inCoda, .inInvio])

    orologioProva = t0.addingTimeInterval(8)
    banco.completa(banco.trasporto.id(0), putRiuscita(durata: 8), byteInviati: 1000)
    verificaUguali("PUT 200: la voce è inviata", banco.stato(1), .inviato)
    verificaUguali("… senza codice", banco.voce(1)?.codice, nil)
    verifica("… la COPIA è cancellata", !esiste(banco.copia(1)))
    verifica("… i SEGRETI sono cancellati dal Portachiavi", !banco.segreti.contiene(uuid(1)) && banco.segreti.cancellazioni.contains(uuid(1)))
    verificaUguali("… due righe di log: accodato e inviato", banco.messaggi, [messaggio("video-nativo-accodato", job: 1), messaggio("video-nativo-inviato", job: 1)])
    let inviato = banco.eventi("video-nativo-inviato").first
    verificaUguali("… video-nativo-inviato: peso, durata in millisecondi, cicli, rinnovi, esito, primo piano",
                   campi(inviato), ["byte": num(1000), "ms": num(8000), "tentativi": num(1), "rinnovi": num(0), "esito": tes("put"), "in_background": boo(false)])
    verificaUguali("… livello warn", inviato?.livello, .warn)
    verificaUguali("al JS è arrivato `inviato`", banco.emessi.last?.voce.stato, .inviato)
    verifica("il registro dei log è stato svuotato verso il sito (a ogni transizione terminale)", banco.trasportoLog.richieste.count >= 1 && banco.trasportoLog.richieste.first?.url.absoluteString == urlRegistroProva)
    verificaUguali("… con l'identità dell'insegnante", banco.trasportoLog.richieste.first?.utenteId, uuid(utenteProva))
    verificaUguali("nessuna notifica (l'app era in primo piano e la rete c'era)", banco.notificatore.numeroMostrate, 0)
    verificaUguali("… e nessuna notifica da togliere: il centro delle notifiche non è stato interpellato per toglierne una che non c'era", banco.notificatore.rimozioni, rimosseAlLancio)
    verificaUguali("il lavoro in background non si è aperto (nessun rilancio)", banco.lavoro.iniziati, 0)
    verificaUguali("il motore ha un solo task creato in tutto", banco.trasporto.numeroCreati, 1)

    // Il giorno dopo: la voce terminale c'è ancora (il JS la legge), e `dimentica` la toglie
    verificaUguali("`dimentica` toglie la voce terminale", banco.motore.dimentica([uuid(1)]), 1)
    verifica("… e non c'è più", banco.voce(1) == nil)
}

// MARK: - Una PUT rifiutata: rinnovo e nuova PUT

func provaMotorePutRifiutataERinnovo() {
    sezione("Motore — 400 InvalidJWT a trasferimento COMPLETO (S0-b): put-oltre-scadenza, rinnovo con il token, nuova PUT, conto dei rinnovi")
    let banco = BancoMotore()
    banco.accoda(1)
    orologioProva = t0.addingTimeInterval(7800)
    banco.completa(banco.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 7800))
    verificaUguali("il rinnovo è partito, UNO", banco.rinnovo.numeroChiamate, 1)
    verificaUguali("… sull'indirizzo del rinnovo del sito", banco.rinnovo.chiamate.first?.url.absoluteString, urlRinnovoProva)
    verificaUguali("… col token del Portachiavi", banco.rinnovo.chiamate.first?.token, tokenA)
    verificaUguali("… senza una PUT in più nel frattempo", banco.trasporto.numeroCreati, 1)
    verificaTutto("la voce aspetta il rinnovo ancora in-invio, con l'URL rifiutato azzerato (il giro dopo non lo rispedisce)", [banco.stato(1) == .inInvio, banco.voce(1)?.urlScadeIl == nil], [true, true])
    verificaUguali("log: accodato e put-oltre-scadenza", banco.messaggi, [messaggio("video-nativo-accodato", job: 1), "put-oltre-scadenza: job=\(uuid(1).uuidString.lowercased())"])
    let oltre = banco.eventi("put-oltre-scadenza").first
    verificaUguali("… put-oltre-scadenza porta la durata del trasferimento in secondi", campi(oltre), ["durata_s": num(7800)])
    verificaUguali("… e lo stato HTTP della PUT", oltre?.stato, 400)

    // Il rinnovo dà un token che vale più a lungo di quello di partenza (48 ore): se la voce non lo registrasse, il controllo sotto non lo vedrebbe.
    verificaUguali("(setup) prima del rinnovo il token della voce vale 48 ore", KVPoliticaCaricamento.isoZ(banco.voce(1)?.tokenScadeIl ?? .distantPast), iso(t0.addingTimeInterval(48 * 3600)))
    let scadenzaToken = t0.addingTimeInterval(72 * 3600)
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "b"), contentType: "video/mp4", scadeIl: scadenzaToken))
    verificaUguali("rinnovo da-caricare: nasce UN task nuovo", banco.trasporto.numeroCreati, 2)
    let r = banco.trasporto.richiesta(1)
    verificaUguali("… sull'URL NUOVO", r.url.absoluteString, urlPutProva(1, "b"))
    verificaUguali("… col content-type del rinnovo", r.contentType, "video/mp4")
    verificaUguali("… subito", r.nonPrima, nil)
    let v = banco.voce(1)
    verificaUguali("la voce: un rinnovo contato", v?.rinnovi, 1)
    verificaUguali("… un rinnovo di fila dopo una PUT rifiutata", v?.rinnoviConsecutivi, 1)
    verificaUguali("… l'URL nuovo vale 7.200 secondi dal momento della RICEZIONE", v?.urlScadeIl, orologioProva.addingTimeInterval(7200))
    verificaUguali("… e il token vale fino a quando dice il server (la scadenza del TOKEN)", KVPoliticaCaricamento.isoZ(v?.tokenScadeIl ?? .distantPast), iso(scadenzaToken))
    verificaUguali("… ancora un ciclo (il rinnovo dopo una PUT rifiutata è lo stesso giro)", v?.tentativi, 1)
    verificaUguali("i segreti hanno l'URL e il content-type nuovi e il token di prima", banco.segreti.segreti(uuid(1)),
                   KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1, "b"), contentType: "video/mp4", urlRinnovo: urlRinnovoProva))
    let rinnovoLog = banco.eventi("video-nativo-rinnovo").first
    verificaTutto("log del rinnovo: esito da-caricare, stato 200", [rinnovoLog?.messaggio, rinnovoLog?.stato.map { String($0) }], [messaggio("video-nativo-rinnovo", job: 1, "da-caricare"), "200"])
    verificaUguali("… col numero di rinnovi e il nome d'errore della PUT che l'ha causato", campi(rinnovoLog), ["rinnovi": num(1), "error_code": tes("InvalidJWT")])

    banco.completa(banco.trasporto.id(1), putRiuscita())
    verificaUguali("la nuova PUT riesce: inviato", banco.stato(1), .inviato)
    verificaUguali("… i rinnovi di fila si azzerano a ogni esito che non è un rifiuto", banco.voce(1)?.rinnoviConsecutivi, 0)
    verifica("… copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    verificaTutto("… video-nativo-inviato con tentativi 1 e rinnovi 1", [campi(banco.eventi("video-nativo-inviato").first)["tentativi"], campi(banco.eventi("video-nativo-inviato").first)["rinnovi"]],
                   [num(1), num(1)])
    verificaUguali("in tutto: accodato, put-oltre-scadenza, rinnovo, inviato", banco.messaggi.map { $0.split(separator: ":").first.map(String.init) ?? "" },
                   ["video-nativo-accodato", "put-oltre-scadenza", "video-nativo-rinnovo", "video-nativo-inviato"])

    sezione("Motore — InvalidJWT con i byte NON finiti (S0-c: URL già scaduto alla partenza): rinnovo, ma niente put-oltre-scadenza")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: false, durata: 0))
    verificaUguali("il rinnovo parte comunque", b2.rinnovo.numeroChiamate, 1)
    verificaUguali("… e non si scrive put-oltre-scadenza (la firma non è scaduta DURANTE l'invio)", b2.eventi("put-oltre-scadenza").count, 0)
}

func provaMotoreRinnovoDuplicatoENegato() {
    sezione("Motore — la seconda PUT rifiutata come duplicato (400 con 409 nel corpo): il rinnovo dice «arrivato» → inviato (gia-arrivato)")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.completa(banco.trasporto.id(0), putRifiutata(400, errore: "Duplicate", completo: false, durata: 0))
    verificaUguali("il rifiuto porta al rinnovo (è il rinnovo a dire se il file c'è)", banco.rinnovo.numeroChiamate, 1)
    banco.rispondiRinnovo(rinnovoArrivato)
    verificaUguali("rinnovo arrivato: la voce è inviata", banco.stato(1), .inviato)
    verificaUguali("… senza una PUT in più", banco.trasporto.numeroCreati, 1)
    verifica("… copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    let rinnovoLog = banco.eventi("video-nativo-rinnovo").first
    verificaTutto("log: rinnovo `arrivato`, col nome d'errore Duplicate", [rinnovoLog?.messaggio, campi(rinnovoLog)["error_code"].map { "\($0)" }],
                   [messaggio("video-nativo-rinnovo", job: 1, "arrivato"), "\(tes("Duplicate"))"])
    let inviato = banco.eventi("video-nativo-inviato").first
    verificaUguali("log: inviato con esito gia-arrivato", campi(inviato)["esito"], tes("gia-arrivato"))
    verificaUguali("… e put-oltre-scadenza NON c'è (un duplicato non è una firma scaduta)", banco.eventi("put-oltre-scadenza").count, 0)

    sezione("Motore — rinnovo 404: TOKEN_NON_VALIDO; rinnovo `annullato`: ANNULLATO_DAL_SERVER; entrambi con copia e segreti cancellati")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), putRifiutata(403, errore: nil))
    b2.rispondiRinnovo(rinnovoNonTrovato)
    verificaUguali("rinnovo 404 senza un token più recente: fallita", b2.stato(1), .fallito)
    verificaUguali("… con TOKEN_NON_VALIDO", b2.voce(1)?.codice, .tokenNonValido)
    verifica("… copia e segreti cancellati", !esiste(b2.copia(1)) && !b2.segreti.contiene(uuid(1)))
    verificaUguali("… nessuna PUT in più", b2.trasporto.numeroCreati, 1)
    verificaUguali("log: accodato, rinnovo negato, fallito", b2.messaggi, [messaggio("video-nativo-accodato", job: 1), messaggio("video-nativo-rinnovo", job: 1, "negato"),
                                                                           messaggio("video-nativo-fallito", job: 1, "TOKEN_NON_VALIDO")])
    let fallito = b2.eventi("video-nativo-fallito").first
    verificaUguali("… fallito è un error", fallito?.livello, .error)
    verificaUguali("… sull'operazione rinnovo, coi cicli e i rinnovi", campi(fallito), ["operazione": tes("rinnovo"), "tentativi": num(1), "rinnovi": num(0)])
    verificaUguali("… e lo stato HTTP dell'ultimo scambio (il 404 del rinnovo)", fallito?.stato, 404)
    verificaUguali("il rinnovo negato porta lo stato 404", b2.eventi("video-nativo-rinnovo").first?.stato, 404)

    let b3 = BancoMotore()
    b3.accoda(1)
    b3.completa(b3.trasporto.id(0), putRifiutata(403, errore: nil))
    b3.rispondiRinnovo(rinnovoAnnullato)
    verificaUguali("rinnovo `annullato`: la voce è annullata", b3.stato(1), .annullato)
    verificaUguali("… con ANNULLATO_DAL_SERVER", b3.voce(1)?.codice, .annullatoDalServer)
    verifica("… copia e segreti cancellati", !esiste(b3.copia(1)) && !b3.segreti.contiene(uuid(1)))
    let annullato = b3.eventi("video-nativo-annullato").first
    verificaUguali("log: video-nativo-annullato dal server", annullato?.messaggio, messaggio("video-nativo-annullato", job: 1, "server"))
    verificaUguali("… e nessun `fallito`", b3.eventi("video-nativo-fallito").count, 0)
}

func provaMotoreRotazioneDelToken() {
    sezione("Motore — la rotazione del token: un 404 col token vecchio, ma nel Portachiavi ce n'è uno più recente → si riprova con quello")
    let banco = BancoMotore()
    banco.accoda(1, token: tokenA, firma: "a")
    banco.completa(banco.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 4000))
    verificaUguali("il rinnovo parte col token A", banco.rinnovo.chiamate.map { $0.token }, [tokenA])
    // Mentre il rinnovo è in volo il JS riapre l'intento (stesso job, token ruotato)
    let richiesta = banco.richiesta(1, token: tokenB, firma: "r")
    verifica("(setup) il secondo preparato è in scelti/", esiste(banco.scelto("e1")))
    let ripetuto = banco.motore.accoda(richiesta)
    banco.attendi()
    guard case .giaInCoda(let corrente) = ripetuto else {
        verifica("l'apertura ripetuta è «già in coda»", false, "\(ripetuto)")
        return
    }
    verificaUguali("accoda ripetuto: restituisce la voce che c'è", corrente.jobId, uuid(1))
    verificaUguali("i segreti hanno il token NUOVO e il nuovo URL", banco.segreti.segreti(uuid(1)), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(1, "r"), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    verificaTutto("nessun task in più, nessun secondo `accodato`", [banco.trasporto.numeroCreati, banco.eventi("video-nativo-accodato").count], [1, 1])
    verifica("il secondo preparato (il video è già in file/) è stato tolto da scelti/", !esiste(banco.scelto("e1")) && esiste(banco.copia(1)))
    verificaTutto("il rinnovo di prima è ancora in volo, e non se ne è aggiunto un altro", [banco.rinnovo.numeroChiamate, banco.rinnovo.senzaRisposta], [1, 1])

    // Il rinnovo col token vecchio risponde 404 (il server ha ruotato)
    banco.rispondiRinnovo(rinnovoNonTrovato)
    verificaUguali("il 404 NON chiude la voce: si riprova col token più recente, SUBITO", banco.rinnovo.chiamate.map { $0.token }, [tokenA, tokenB])
    verificaUguali("… la voce è ancora viva", banco.stato(1), .inInvio)
    verificaUguali("… e c'è un solo rinnovo in volo (quello nuovo)", banco.rinnovo.senzaRisposta, 1)
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "c"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaUguali("il rinnovo col token B: nasce la nuova PUT", banco.trasporto.numeroCreati, 2)
    verificaUguali("… sull'URL del rinnovo", banco.trasporto.richiesta(1).url.absoluteString, urlPutProva(1, "c"))
    verificaUguali("i segreti: il token B resta (non si torna al vecchio), l'URL è quello nuovo", banco.segreti.segreti(uuid(1)),
                   KVSegretiVoce(token: tokenB, urlPut: urlPutProva(1, "c"), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    verificaUguali("log del rinnovo: prima `negato` (404), poi `da-caricare`", banco.eventi("video-nativo-rinnovo").map { $0.messaggio },
                   [messaggio("video-nativo-rinnovo", job: 1, "negato"), messaggio("video-nativo-rinnovo", job: 1, "da-caricare")])
    verificaUguali("… e il rinnovo che consegna l'URL è l'unico contato", banco.voce(1)?.rinnovi, 1)

    sezione("Motore — un 404 col token GIÀ più recente non si riprova: TOKEN_NON_VALIDO (niente giro all'infinito)")
    let b2 = BancoMotore()
    b2.accoda(1, token: tokenB)
    b2.completa(b2.trasporto.id(0), putRifiutata(403, errore: nil))
    b2.rispondiRinnovo(rinnovoNonTrovato)
    verificaTutto("404 col token che è l'ultimo del Portachiavi: fallita", [b2.stato(1), b2.voce(1)?.codice], ["fallito", "tokenNonValido"])
    verificaUguali("… un solo rinnovo", b2.rinnovo.numeroChiamate, 1)

    sezione("Motore — il token ruota MENTRE il rinnovo è in volo, e il rinnovo RIESCE: l'URL nuovo si scrive sopra il token più recente, mai sopra quello vecchio")
    let b3 = BancoMotore()
    b3.accoda(1, token: tokenA, firma: "a")
    b3.completa(b3.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 4000))
    _ = b3.motore.accoda(b3.richiesta(1, token: tokenB, firma: "r"))
    b3.attendi()
    verificaUguali("(setup) l'apertura ripetuta ha messo il token B nel Portachiavi, e il rinnovo in volo è quello col token A",
                   [b3.segreti.segreti(uuid(1))?.token, b3.rinnovo.chiamate.last?.token, b3.rinnovo.senzaRisposta == 1 ? "in volo" : "no"], [tokenB, tokenA, "in volo"])
    b3.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "c"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaUguali("il rinnovo col token A consegna l'URL nuovo: nel Portachiavi resta il token B, con l'URL nuovo (al giro dopo il vecchio non serve più a niente)",
                   b3.segreti.segreti(uuid(1)), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(1, "c"), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    verificaTutto("… la PUT nuova è partita sull'URL nuovo, e senza un secondo rinnovo", [b3.trasporto.numeroCreati, b3.trasporto.richiesta(1).url.absoluteString, b3.rinnovo.numeroChiamate],
                  [2, urlPutProva(1, "c"), 1])
}

func provaMotoreRinnovoLimitatoOTransitorio() {
    sezione("Motore — rinnovo 429: esito `tetto` nel log, attesa del Retry-After, e la CAUSA (PUT rifiutata) si ricorda per il giro dopo")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.completa(banco.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: false, durata: 0))
    banco.rispondiRinnovo(rinnovoLimitato("120"))
    let tetto = banco.eventi("video-nativo-rinnovo").first
    verificaTutto("log: video-nativo-rinnovo `tetto` (429), non `server`", [tetto?.messaggio, tetto?.stato.map { String($0) }], [messaggio("video-nativo-rinnovo", job: 1, "tetto"), "429"])
    verificaUguali("… coi rinnovi (nessuno consegnato) e il nome d'errore della PUT", campi(tetto), ["rinnovi": num(0), "error_code": tes("InvalidJWT")])
    verificaUguali("la voce aspetta: in-attesa", banco.stato(1), .inAttesa)
    verificaTutto("… e al JS è arrivato che aspetta (in-attesa, FIRMA_RIFIUTATA): l'attesa dopo un rinnovo non passa da nessun altro avviso", [banco.emessi.last?.voce.stato, banco.emessi.last?.voce.codice],
                  [KVStatoCaricamento.inAttesa, KVCodiceCaricamento.firmaRifiutata])
    verificaUguali("… col codice FIRMA_RIFIUTATA (è la causa: la PUT è stata rifiutata)", banco.voce(1)?.codice, .firmaRifiutata)
    verificaUguali("… fino a 120 secondi (Retry-After vince sui 30 s)", banco.voce(1)?.prossimoTentativoIl, t0.addingTimeInterval(120))
    verificaUguali("… e un timer per svegliarla", banco.pianificatore.prossimoFra, 120)
    verificaTutto("… nessun rinnovo nuovo e nessuna PUT in attesa", [banco.rinnovo.numeroChiamate, banco.trasporto.numeroCreati], [1, 1])
    banco.avanza(119)
    verificaTutto("a 119 secondi non succede niente", [banco.rinnovo.numeroChiamate, banco.stato(1) == .inAttesa], [1, true])
    banco.avanza(1)
    verificaUguali("a 120 secondi il giro ricomincia: un secondo rinnovo, col token", banco.rinnovo.chiamate.map { $0.token }, [tokenA, tokenA])
    verificaTutto("… la voce è tornata in-invio e il ciclo è il secondo", [banco.stato(1) == .inInvio, banco.voce(1)?.tentativi == 2], [true, true])
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "b"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaUguali("il rinnovo riesce: nasce la PUT", banco.trasporto.numeroCreati, 2)
    verificaUguali("… e il rinnovo CONTA come rinnovo dopo una PUT rifiutata (la causa si è ricordata attraverso l'attesa): rinnoviConsecutivi 1", banco.voce(1)?.rinnoviConsecutivi, 1)
    verificaUguali("… con il nome d'errore della PUT anche nella seconda riga del rinnovo", campi(banco.eventi("video-nativo-rinnovo").last)["error_code"], tes("InvalidJWT"))

    sezione("Motore — rinnovo 5xx → `server`, rete caduta → `rete`: attesa e nuovo giro; CHE UN RINNOVO FALLITO NON CHIUDE LA VOCE")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), putRifiutata(403, errore: nil))
    b2.rispondiRinnovo(rinnovoErroreServer)
    verificaUguali("rinnovo 503: log `server`", b2.eventi("video-nativo-rinnovo").last?.messaggio, messaggio("video-nativo-rinnovo", job: 1, "server"))
    verificaTutto("… la voce aspetta 30 secondi come FIRMA_RIFIUTATA", [b2.stato(1), b2.voce(1)?.codice, b2.voce(1)?.prossimoTentativoIl], ["inAttesa", "firmaRifiutata", t0.addingTimeInterval(30)])
    b2.avanza(30)
    b2.rispondiRinnovo(rinnovoSenzaRete)
    verificaUguali("secondo giro: rinnovo senza risposta → log `rete`", b2.eventi("video-nativo-rinnovo").last?.messaggio, messaggio("video-nativo-rinnovo", job: 1, "rete"))
    verificaUguali("… e aspetta 60 secondi (secondo tentativo)", b2.voce(1)?.prossimoTentativoIl, t0.addingTimeInterval(30 + 60))
    verificaTutto("… ancora viva, con la causa nel codice", [b2.stato(1), b2.voce(1)?.codice], ["inAttesa", "firmaRifiutata"])
    b2.avanza(60)
    b2.rispondiRinnovo(KVEsitoRinnovoRete(statoHTTP: 200, corpo: Data("non è JSON".utf8), retryAfter: nil))
    verificaTutto("terzo giro: 200 ma fuori schema → transitorio, mai un'azione: nessuna PUT, e (tentativo 3) nessuna riga nuova nel log, che si dirada come quello dei ritentativi",
                  [b2.eventi("video-nativo-rinnovo").count, b2.trasporto.numeroCreati], [2, 1])
    verificaUguali("… i rinnovi consecutivi non sono saliti (nessun URL consegnato)", b2.voce(1)?.rinnoviConsecutivi, 0)
    b2.avanza(120)
    b2.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "z"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaTutto("quarto giro: il rinnovo riesce e la PUT nasce", [b2.trasporto.numeroCreati, b2.voce(1)?.rinnovi], [2, 1])
    verificaUguali("… e conta come dopo una PUT rifiutata, anche se la causa ha attraversato tre attese", b2.voce(1)?.rinnoviConsecutivi, 1)
}

func provaMotoreRinnovoCiclico() {
    sezione("Motore — RINNOVO_CICLICO: oltre 3 rinnovi di fila dopo una PUT rifiutata il video si chiude (e il 4° rinnovo si logga `da-caricare`, non `tetto`)")
    let banco = BancoMotore()
    banco.accoda(1)
    for giro in 1...3 {
        banco.completa(banco.trasporto.ultimoId, putRifiutata(403, errore: nil))
        banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "g\(giro)"), scadeIl: t0.addingTimeInterval(48 * 3600)))
        verificaTutto("giro \(giro): rinnovo riuscito, la PUT successiva è partita", [banco.trasporto.numeroCreati, banco.stato(1)], [giro + 1, "inInvio"])
        verificaUguali("… rinnoviConsecutivi \(giro)", banco.voce(1)?.rinnoviConsecutivi, giro)
    }
    banco.completa(banco.trasporto.ultimoId, putRifiutata(403, errore: nil))
    verificaUguali("la quarta PUT rifiutata chiede il quarto rinnovo", banco.rinnovo.numeroChiamate, 4)
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "g4"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaUguali("il quarto rinnovo, anche se consegna un URL, chiude la voce: fallita", banco.stato(1), .fallito)
    verificaUguali("… con RINNOVO_CICLICO", banco.voce(1)?.codice, .rinnovoCiclico)
    verificaUguali("… e nessuna quinta PUT", banco.trasporto.numeroCreati, 4)
    verifica("… copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    let rinnovi = banco.eventi("video-nativo-rinnovo")
    verificaUguali("log: quattro righe di rinnovo, TUTTE `da-caricare` (il tetto del rinnovo, il 429, non c'entra)", rinnovi.map { $0.messaggio }, Array(repeating: messaggio("video-nativo-rinnovo", job: 1, "da-caricare"), count: 4))
    verificaUguali("… coi rinnovi 1, 2, 3, 4 (il quarto ha consegnato un URL, e conta)", rinnovi.map { campi($0)["rinnovi"] }, [num(1), num(2), num(3), num(4)])
    let fallito = banco.eventi("video-nativo-fallito").first
    verificaUguali("log: RINNOVO_CICLICO è il CODICE di video-nativo-fallito", fallito?.messaggio, messaggio("video-nativo-fallito", job: 1, "RINNOVO_CICLICO"))
    verificaUguali("… operazione rinnovo, un ciclo, quattro rinnovi", campi(fallito), ["operazione": tes("rinnovo"), "tentativi": num(1), "rinnovi": num(4)])
    verificaUguali("… e nessuna riga con esito `tetto` in tutto il registro", banco.messaggi.filter { $0.hasSuffix(" tetto") }.count, 0)

    sezione("Motore — il conto riparte da zero se fra un rifiuto e l'altro la PUT ha avuto un transitorio (un'ora di Storage in 5xx non chiude un video)")
    let b2 = BancoMotore()
    b2.accoda(1)
    for giro in 1...3 {
        b2.completa(b2.trasporto.ultimoId, putRifiutata(403, errore: nil))
        b2.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "h\(giro)"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    }
    verificaUguali("(setup) tre rinnovi di fila", b2.voce(1)?.rinnoviConsecutivi, 3)
    b2.completa(b2.trasporto.ultimoId, putTransitoria(503))
    verificaUguali("un transitorio: i rinnovi di fila si azzerano", b2.voce(1)?.rinnoviConsecutivi, 0)
    b2.completa(b2.trasporto.ultimoId, putRifiutata(403, errore: nil))
    b2.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "k"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaTutto("… e il rinnovo successivo non chiude la voce", [b2.stato(1), b2.voce(1)?.rinnoviConsecutivi], ["inInvio", 1])
}

// MARK: - I transitori e la soglia di S0

func provaMotoreTransitori() {
    sezione("Motore — 503: in-attesa, attese 30 s / 1' / 2' / 5' / 10', log ai tentativi 1, 2, 4; il prossimo task nasce SUBITO con `earliestBeginDate`")
    let banco = BancoMotore()
    banco.accoda(1)
    let attese: [TimeInterval] = [30, 60, 120, 300, 600]
    for (indice, attesa) in attese.enumerated() {
        let tentativo = indice + 1
        banco.completa(banco.trasporto.ultimoId, putTransitoria(503), byteInviati: 400)
        let v = banco.voce(1)
        verificaTutto("fallimento \(tentativo): in-attesa col codice SERVER", [v?.stato, v?.codice], ["inAttesa", "server"])
        verificaUguali("… prossimo tentativo fra \(Int(attesa)) secondi", v?.prossimoTentativoIl, t0.addingTimeInterval(attesa))
        verificaUguali("… il prossimo task è già creato (\(tentativo + 1) in tutto)", banco.trasporto.numeroCreati, tentativo + 1)
        verificaUguali("… col suo `earliestBeginDate`", banco.trasporto.richiesta(tentativo).nonPrima, t0.addingTimeInterval(attesa))
        verificaUguali("… e il ciclo è il \(tentativo + 1)°", v?.tentativi, tentativo + 1)
        verificaUguali("… nessun rinnovo (un'URL firmato da meno di 10 minuti alla partenza non si rinnova)", banco.rinnovo.numeroChiamate, 0)
    }
    let ritenti = banco.eventi("video-nativo-ritento")
    verificaUguali("5 fallimenti, ma si loggano solo i tentativi 1, 2 e 4: tre righe", ritenti.map { campi($0)["tentativo"] }, [num(1), num(2), num(4)])
    verificaUguali("… col codice SERVER nel messaggio", ritenti.map { $0.messaggio }, Array(repeating: messaggio("video-nativo-ritento", job: 1, "SERVER"), count: 3))
    verificaUguali("… lo stato HTTP 503", ritenti.map { $0.stato }, [503, 503, 503])
    verificaUguali("… l'attesa in secondi", ritenti.map { campi($0)["attesa_s"] }, [num(30), num(60), num(300)])
    verificaUguali("… e i byte spediti", ritenti.map { campi($0)["byte_inviati"] }, [num(400), num(400), num(400)])
    verificaUguali("… livello warn", ritenti.first?.livello, .warn)

    // Un'altra attivazione dell'app (un avviso di sistema chiuso, il centro di controllo): il task differito creato IN PRIMO PIANO non si tocca
    let attivazioni = banco.trasporto.numeroCreati
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verificaTutto("una riattivazione dell'app non ricrea un task differito creato in primo piano (resta nel sistema col suo `earliestBeginDate`)",
                  [banco.trasporto.numeroCreati, banco.trasporto.annullati.count, banco.voce(1)?.tentativi], [attivazioni, 0, 6])

    // Il task differito parte: i primi byte portano la voce a in-invio
    banco.trasporto.avanzamento(banco.trasporto.ultimoId, byte: 0)
    banco.attendi()
    verificaUguali("un avanzamento a ZERO byte non è l'inizio del trasferimento: la voce aspetta ancora", banco.stato(1), .inAttesa)
    orologioProva = t0.addingTimeInterval(600) // il task differito parte quando dice il suo `earliestBeginDate`
    banco.trasporto.avanzamento(banco.trasporto.ultimoId, byte: 5000)
    banco.attendi()
    verificaUguali("i primi byte del task differito: la voce è in-invio", banco.stato(1), .inInvio)
    verificaTutto("… senza codice e senza attesa", [banco.voce(1)?.codice == nil, banco.voce(1)?.prossimoTentativoIl == nil], [true, true])
    orologioProva = t0.addingTimeInterval(700)
    banco.completa(banco.trasporto.ultimoId, putRiuscita())
    verificaUguali("poi la PUT riesce: inviato", banco.stato(1), .inviato)
    verificaUguali("… con 6 cicli", campi(banco.eventi("video-nativo-inviato").first)["tentativi"], num(6))
    verificaUguali("… e la durata conta dai primi byte del task che è riuscito, non dalla sua creazione né dall'attesa (creato a t0, primi byte a t0+600, finito a t0+700: 100 s)",
                   campi(banco.eventi("video-nativo-inviato").first)["ms"], num(100 * 1000))

    sezione("Motore — HTTP 408 e 429: transitori con `Retry-After`; 413: TROPPO_GRANDE senza rinnovo; 5xx con corpo InvalidJWT resta transitorio")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.ultimoId, putTransitoria(429, retryAfter: "600"))
    verificaUguali("429 con Retry-After 600: attesa 600 s (più lunga di 30)", b2.voce(1)?.prossimoTentativoIl, t0.addingTimeInterval(600))
    verificaTutto("… codice SERVER, nessun rinnovo", [b2.voce(1)?.codice, b2.rinnovo.numeroChiamate], ["server", 0])
    b2.completa(b2.trasporto.ultimoId, putTransitoria(408))
    verificaTutto("408: transitorio (tentativo 2: 60 s)", [b2.voce(1)?.codice, b2.voce(1)?.prossimoTentativoIl], ["server", t0.addingTimeInterval(60)])
    b2.completa(b2.trasporto.ultimoId, KVRispostaPut(statoHTTP: 503, corpo: corpoStorage(statusCode: "400", errore: "InvalidJWT"), durataSecondi: 4000, trasferimentoCompleto: true))
    verificaTutto("503 con un corpo InvalidJWT: ancora transitorio (e nessun put-oltre-scadenza)", [b2.rinnovo.numeroChiamate, b2.eventi("put-oltre-scadenza").count], [0, 0])

    let b3 = BancoMotore()
    b3.accoda(1)
    b3.completa(b3.trasporto.ultimoId, putRifiutata(413, errore: nil), byteInviati: 700)
    verificaTutto("413: fallita TROPPO_GRANDE", [b3.stato(1), b3.voce(1)?.codice], ["fallito", "troppoGrande"])
    verificaUguali("… e al JS restano i byte che erano partiti, quelli dell'ultimo avviso del sistema (700), non zero", b3.motore.elenco(perUtente: uuid(utenteProva)).first?["byteInviati"] as? NSNumber, NSNumber(value: 700))
    verificaUguali("… senza rinnovo", b3.rinnovo.numeroChiamate, 0)
    verifica("… copia e segreti cancellati", !esiste(b3.copia(1)) && !b3.segreti.contiene(uuid(1)))
    verificaUguali("… log fallito sull'operazione put", campi(b3.eventi("video-nativo-fallito").first)["operazione"], tes("put"))
    let b4 = BancoMotore()
    b4.accoda(1)
    b4.completa(b4.trasporto.ultimoId, putRifiutata(400, errore: "EntityTooLarge"))
    verificaTutto("400 col corpo EntityTooLarge: TROPPO_GRANDE (lo Storage manda un 413 come 400)", [b4.stato(1), b4.voce(1)?.codice, b4.rinnovo.numeroChiamate], ["fallito", "troppoGrande", 0])
    verificaUguali("… lo stato HTTP del log è quello della PUT", b4.eventi("video-nativo-fallito").first?.stato, 400)
}

func provaMotoreSogliaDiS0() {
    sezione("Motore — S0: prima di OGNI PUT si rinnova se l'URL, al momento in cui la PUT partirebbe, è firmato da PIÙ di 10 minuti")
    // Un fallimento a t0+580 con 30 s di attesa: la PUT partirebbe a t0+610, URL firmato a t0 → 610 s → rinnovo.
    let banco = BancoMotore()
    banco.accoda(1)
    orologioProva = t0.addingTimeInterval(580)
    banco.completa(banco.trasporto.ultimoId, putTransitoria(503))
    verificaUguali("a t0+580 con 30 s di attesa (partenza a 610 s dalla firma): il rinnovo parte PRIMA del nuovo task", banco.rinnovo.numeroChiamate, 1)
    verificaTutto("… col token, sul sito", [banco.rinnovo.chiamate.first?.token, banco.rinnovo.chiamate.first?.url.absoluteString], [tokenA, urlRinnovoProva])
    verificaUguali("… e il task nuovo ancora non c'è", banco.trasporto.numeroCreati, 1)
    verificaTutto("… la voce aspetta in-attesa(SERVER)", [banco.stato(1), banco.voce(1)?.codice], ["inAttesa", "server"])
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "n"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaTutto("rinnovo riuscito: nasce il task, differito di 30 s", [banco.trasporto.numeroCreati, banco.trasporto.richiesta(1).nonPrima], [2, t0.addingTimeInterval(610)])
    verificaUguali("… sull'URL nuovo", banco.trasporto.richiesta(1).url.absoluteString, urlPutProva(1, "n"))
    verificaTutto("… e questo rinnovo (l'URL era solo vecchio, la PUT non era stata rifiutata) NON conta come rinnovo dopo un rifiuto", [banco.voce(1)?.rinnovi, banco.voce(1)?.rinnoviConsecutivi], [1, 0])
    verificaUguali("… l'URL nuovo vale 7.200 s dalla RICEZIONE (t0+580)", banco.voce(1)?.urlScadeIl, t0.addingTimeInterval(580 + 7200))
    verificaUguali("… e nel log il rinnovo non porta un nome d'errore (nessuna PUT rifiutata)", campi(banco.eventi("video-nativo-rinnovo").first), ["rinnovi": num(1)])

    // a t0+570 la partenza è a 600 s esatti: non si rinnova («più di»)
    let b2 = BancoMotore()
    b2.accoda(1)
    orologioProva = t0.addingTimeInterval(570)
    b2.completa(b2.trasporto.ultimoId, putTransitoria(503))
    verificaUguali("a t0+570 con 30 s di attesa (partenza a 600 s esatti): NIENTE rinnovo («più di» 10 minuti)", b2.rinnovo.numeroChiamate, 0)
    verificaTutto("… il task nuovo c'è già, differito", [b2.trasporto.numeroCreati, b2.trasporto.richiesta(1).nonPrima], [2, t0.addingTimeInterval(600)])

    sezione("Motore — il rinnovo proattivo che non riesce non spedisce l'URL vecchio: aspetta e rinnova di nuovo; il registro non si riempie")
    let b3 = BancoMotore()
    b3.accoda(1)
    orologioProva = t0.addingTimeInterval(700)
    b3.completa(b3.trasporto.ultimoId, putTransitoria(503))
    b3.rispondiRinnovo(rinnovoSenzaRete)
    verificaUguali("rinnovo senza rete: nessun task con l'URL vecchio", b3.trasporto.numeroCreati, 1)
    verificaTutto("… la voce aspetta (SERVER, perché la causa era l'URL vecchio e non una PUT rifiutata)", [b3.stato(1), b3.voce(1)?.codice], ["inAttesa", "rete"])
    verificaUguali("… il log del rinnovo `rete` c'è (tentativo 2) ", b3.eventi("video-nativo-rinnovo").map { $0.messaggio }, [messaggio("video-nativo-rinnovo", job: 1, "rete")])
    // Un guasto lungo: ogni ripresa dopo più di 10 minuti rinnova; il log dei rinnovi si dirada come quello dei ritentativi
    var righeDiRinnovo = 1
    for giro in 3...12 {
        b3.avanza(900)
        b3.rispondiRinnovo(rinnovoErroreServer)
        let ora = b3.eventi("video-nativo-rinnovo").count
        if ora > righeDiRinnovo { righeDiRinnovo = ora; _ = giro }
    }
    verifica("dopo 10 giri falliti il log del rinnovo ha poche righe (ai tentativi 2, 4, 8, … non a ogni giro): \(righeDiRinnovo)", righeDiRinnovo <= 5 && righeDiRinnovo >= 3)
    verificaUguali("… e il motore non ha mai spedito con l'URL vecchio", b3.trasporto.numeroCreati, 1)
}

// MARK: - Token scaduto, copia assente

func provaMotoreTokenEFileAssenti() {
    sezione("Motore — il token è scaduto (orologio ≥ rinnovo.scadeIl): TOKEN_SCADUTO, e non si insiste")
    let banco = BancoMotore()
    let r = banco.richiesta(1, scadenzaToken: t0.addingTimeInterval(100))
    _ = banco.motore.accoda(r)
    banco.attendi()
    orologioProva = t0.addingTimeInterval(200)
    banco.completa(banco.trasporto.ultimoId, putTransitoria(503))
    verificaUguali("al giro dopo il transitorio il token è scaduto: fallita", banco.stato(1), .fallito)
    verificaUguali("… con TOKEN_SCADUTO", banco.voce(1)?.codice, .tokenScaduto)
    verificaTutto("… nessun rinnovo e nessun task nuovo", [banco.rinnovo.numeroChiamate, banco.trasporto.numeroCreati], [0, 1])
    verifica("… copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    let fallito = banco.eventi("video-nativo-fallito").first
    verificaTutto("log: fallito TOKEN_SCADUTO sull'operazione rinnovo", [fallito?.messaggio, campi(fallito)["operazione"]],
                   [messaggio("video-nativo-fallito", job: 1, "TOKEN_SCADUTO"), tes("rinnovo")])
    verificaUguali("… e il PUT che aveva fallito è nel log come ritento (503), prima", banco.messaggi.map { $0.split(separator: ":").first.map(String.init) ?? "" },
                   ["video-nativo-accodato", "video-nativo-ritento", "video-nativo-fallito"])

    sezione("Motore — la copia sparita (FILE_ASSENTE) o di peso diverso (PESO_DIVERSO) chiude la voce, sull'operazione copia")
    let b2 = BancoMotore()
    b2.accoda(1)
    try! FileManager.default.removeItem(at: b2.copia(1))
    b2.completa(b2.trasporto.ultimoId, putTransitoria(503))
    verificaTutto("copia assente al giro dopo: fallita FILE_ASSENTE", [b2.stato(1), b2.voce(1)?.codice], ["fallito", "fileAssente"])
    verificaUguali("… operazione copia", campi(b2.eventi("video-nativo-fallito").first)["operazione"], tes("copia"))
    verifica("… e i segreti sono cancellati", !b2.segreti.contiene(uuid(1)))
    let b3 = BancoMotore()
    b3.accoda(1)
    scrivi(b3.copia(1), byte: 999)
    b3.completa(b3.trasporto.ultimoId, putTransitoria(503))
    verificaTutto("copia di un altro peso: fallita PESO_DIVERSO", [b3.stato(1), b3.voce(1)?.codice], ["fallito", "pesoDiverso"])
    verificaUguali("… operazione copia", campi(b3.eventi("video-nativo-fallito").first)["operazione"], tes("copia"))

    let b5 = BancoMotore()
    b5.accoda(1)
    try! FileManager.default.removeItem(at: b5.copia(1))
    orologioProva = t0.addingTimeInterval(700) // l'URL è vecchio: un rinnovo servirebbe, se il file ci fosse
    b5.completa(b5.trasporto.ultimoId, putTransitoria(503))
    verificaTutto("copia assente e URL vecchio: la voce si chiude FILE_ASSENTE SENZA spendere un rinnovo (il file non c'è, il rinnovo non servirebbe a niente)",
                  [b5.stato(1), b5.voce(1)?.codice, b5.rinnovo.numeroChiamate, b5.trasporto.numeroCreati], ["fallito", "fileAssente", 0, 1])

    sezione("Motore — la copia sparisce MENTRE il rinnovo è in volo: al rinnovo riuscito non si consegna al sistema un file che non c'è")
    let b4 = BancoMotore()
    b4.accoda(1)
    b4.completa(b4.trasporto.ultimoId, putRifiutata(403, errore: nil))
    try! FileManager.default.removeItem(at: b4.copia(1))
    b4.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "b"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaTutto("nessun task nuovo, e la voce è fallita FILE_ASSENTE (sull'operazione copia)", [b4.trasporto.numeroCreati, b4.stato(1), b4.voce(1)?.codice, campi(b4.eventi("video-nativo-fallito").first)["operazione"]],
                  [1, "fallito", "fileAssente", tes("copia")])
    verifica("… e i segreti sono cancellati", !b4.segreti.contiene(uuid(1)))
}

// MARK: - Annulla

func provaMotoreAnnulla() {
    sezione("Motore — `annulla` dal JS: ferma il task, cancella copia e segreti, stato annullato; il completamento del task fermato si ignora")
    let banco = BancoMotore()
    banco.accoda(1)
    let id = banco.trasporto.id(0)
    banco.trasporto.avanzamento(id, byte: 300)
    banco.attendi()
    verificaUguali("annulla restituisce true (c'era una voce viva)", banco.motore.annulla(job: uuid(1)), true)
    banco.attendi()
    verificaUguali("il task è stato fermato", banco.trasporto.annullati, [id])
    verificaTutto("la voce è annullata, senza codice (non l'ha fermata il server)", [banco.stato(1), banco.voce(1)?.codice], ["annullato", nil])
    verifica("copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    let log = banco.eventi("video-nativo-annullato").first
    verificaTutto("log: video-nativo-annullato dall'utente, coi byte già spediti", [log?.messaggio, campi(log)["byte_inviati"]], [messaggio("video-nativo-annullato", job: 1, "utente"), num(300)])
    let prima = banco.messaggi
    banco.completa(id, KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)))
    verificaTutto("il completamento del task fermato (NSURLErrorCancelled) non cambia niente", [banco.messaggi, [banco.stato(1) == .annullato]], [prima, [true]])
    verificaUguali("annulla ancora: false (la voce non è più viva)", banco.motore.annulla(job: uuid(1)), false)
    verificaUguali("annulla un job che non c'è: false", banco.motore.annulla(job: uuid(55)), false)
    verificaUguali("al JS è arrivato `annullato`", banco.emessi.last?.voce.stato, .annullato)

    sezione("Motore — `annulla` mentre il rinnovo è in volo: il rinnovo che risponde dopo non resuscita la voce")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.ultimoId, putRifiutata(403, errore: nil))
    verificaUguali("(setup) rinnovo in volo", b2.rinnovo.senzaRisposta, 1)
    _ = b2.motore.annulla(job: uuid(1))
    b2.attendi()
    b2.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "z"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    verificaTutto("il rinnovo risponde da-caricare dopo l'annullamento: nessun task nuovo, la voce resta annullata", [b2.trasporto.numeroCreati, b2.stato(1)], [1, "annullato"])
    verifica("… e i segreti non sono tornati", !b2.segreti.contiene(uuid(1)))
    verifica("… né la copia", !esiste(b2.copia(1)))
    b2.avanza(1000)
    verificaTutto("… nemmeno col passare del tempo (nessun timer rimasto)", [b2.trasporto.numeroCreati, b2.rinnovo.numeroChiamate], [1, 1])

    sezione("Motore — `annulla` di una voce che aspetta un'attesa: il timer non la fa ripartire")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.completa(b3.trasporto.ultimoId, putTransitoria(503))
    _ = b3.motore.annulla(job: uuid(1))
    b3.attendi()
    b3.avanza(5000)
    verificaTutto("dopo l'annullamento nessun timer rifa partire niente", [b3.trasporto.numeroCreati == 2, b3.stato(1) == .annullato, b3.rinnovo.numeroChiamate], [true, true, 0])
    verificaUguali("… e il task differito che era stato creato è stato fermato", b3.trasporto.annullati.contains(b3.trasporto.id(1)), true)

    sezione("Motore — `annulla` di una voce che aspetta il suo timer (rinnovo fallito, nessun task): il timer di risveglio si toglie con la voce")
    let b4 = BancoMotore()
    b4.accoda(1)
    b4.completa(b4.trasporto.id(0), putRifiutata(403, errore: nil))
    b4.rispondiRinnovo(rinnovoErroreServer)
    verificaTutto("(setup) la voce aspetta il rinnovo che è fallito, senza task, col suo timer di risveglio", [b4.stato(1), b4.trasporto.numeroCreati, b4.pianificatore.pendenti], [KVStatoCaricamento.inAttesa, 1, 1])
    _ = b4.motore.annulla(job: uuid(1))
    b4.attendi()
    verificaUguali("annullata la voce, non resta nessun timer in attesa", b4.pianificatore.pendenti, 0)
}

// MARK: - Chiusura forzata, background, notifica, rete

private let chiusuraForzata = KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled),
                                            motivoAnnullamento: NSURLErrorCancelledReasonUserForceQuitApplication)

func provaMotoreChiusuraForzata() {
    sezione("Motore — chiusura forzata dal multitasking: NSURLErrorCancelled + userForceQuitApplication → si ricrea alla RIAPERTURA, non prima")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.motore.notificaSeFermo()
    banco.attendi()
    banco.completa(banco.trasporto.id(0), chiusuraForzata, byteInviati: 400)
    verificaTutto("la voce aspetta la riapertura: in-attesa con CHIUSURA_FORZATA", [banco.stato(1), banco.voce(1)?.codice], ["inAttesa", "chiusuraForzata"])
    verificaUguali("… nessun task nuovo: a app in background non si ricrea niente", banco.trasporto.numeroCreati, 1)
    verificaUguali("… nessun ritento (non è un transitorio: è l'utente che ha chiuso)", banco.eventi("video-nativo-ritento").count, 0)
    verificaUguali("… e nessuna notifica (non è una questione di rete)", banco.notificatore.numeroMostrate, 0)
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verificaTutto("alla riapertura il trasferimento si ricrea", [banco.trasporto.numeroCreati, banco.stato(1), banco.voce(1)?.codice], [2, "inInvio", nil])
    verificaUguali("… in primo piano", banco.voce(1)?.creatoInBackground, false)
    verificaUguali("… col ciclo successivo", banco.voce(1)?.tentativi, 2)
    verificaUguali("… e subito, senza `earliestBeginDate`", banco.trasporto.richiesta(1).nonPrima, nil)
    let ripreso = banco.eventi("video-nativo-ripreso-dopo-chiusura").first
    verificaTutto("log: video-nativo-ripreso-dopo-chiusura coi byte spediti prima della chiusura", [ripreso?.messaggio, campi(ripreso)["byte_inviati"]],
                   [messaggio("video-nativo-ripreso-dopo-chiusura", job: 1), num(400)])
    verificaTutto("… e il motore dichiara il rientro in primo piano con le voci vive (primo-piano, nessuna in invio al momento)",
                   [banco.eventi("caricamenti-nativi-motore").map { $0.messaggio }, [campi(banco.eventi("caricamenti-nativi-motore").first)["task_vivi"]]],
                   [["caricamenti-nativi-motore: urlsession primo-piano"], [num(0)]])

    sezione("Motore — se il completamento della chiusura forzata arriva ad app già in primo piano, la voce si ricrea subito")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), chiusuraForzata, byteInviati: 700)
    verificaTutto("ricreata subito: due task, in-invio", [b2.trasporto.numeroCreati, b2.stato(1)], [2, "inInvio"])
    verificaUguali("… col log del ripreso", campi(b2.eventi("video-nativo-ripreso-dopo-chiusura").first)["byte_inviati"], num(700))

    sezione("Motore — un annullamento di sistema per un ALTRO motivo (aggiornamento in background spento) è un transitorio, non una chiusura forzata")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.completa(b3.trasporto.id(0), KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled), motivoAnnullamento: NSURLErrorCancelledReasonBackgroundUpdatesDisabled))
    verificaTutto("transitorio RETE, con ritento e attesa", [b3.voce(1)?.codice, b3.eventi("video-nativo-ritento").count], ["rete", 1])
    verificaUguali("… e nessun «ripreso dopo chiusura»", b3.eventi("video-nativo-ripreso-dopo-chiusura").count, 0)
}

func provaMotoreBackgroundENotifica() {
    sezione("Motore — a app in background un errore di rete mostra la notifica locale «in attesa di rete» (UNA, senza nomi); all'apertura si toglie")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.motore.notificaSeFermo()
    banco.attendi()
    verificaUguali("app in background con la rete non nota e un invio in corso: nessuna notifica (non c'è motivo)", banco.notificatore.numeroMostrate, 0)
    banco.completa(banco.trasporto.id(0), putSenzaRete(-1009))
    verificaTutto("un task finisce con errore di rete a app in background: in-attesa RETE", [banco.stato(1), banco.voce(1)?.codice], ["inAttesa", "rete"])
    verificaUguali("… la notifica locale parte, UNA", banco.notificatore.numeroMostrate, 1)
    verificaTutto("… col titolo e il testo d'attesa che il JS ha dato (nessun nome, nessun file)", [banco.notificatore.mostrate.first?.titolo, banco.notificatore.mostrate.first?.corpo],
                   [testiProva.titolo, testiProva.attesaRete])
    verificaUguali("log: accodato, ritento (rete, stato 0), attesa-rete", banco.messaggi, [messaggio("video-nativo-accodato", job: 1), messaggio("video-nativo-ritento", job: 1, "RETE"),
                                                                                         messaggio("video-nativo-attesa-rete", job: 1)])
    verificaUguali("… video-nativo-attesa-rete: notifica partita e autorizzata", campi(banco.eventi("video-nativo-attesa-rete").first), ["notifica": boo(true), "autorizzata": boo(true)])
    verificaTutto("… il ritento ha stato 0 (nessuna risposta), attesa 30 s e nessun byte", [banco.eventi("video-nativo-ritento").first?.stato, campi(banco.eventi("video-nativo-ritento").first)["attesa_s"],
                                                                                         campi(banco.eventi("video-nativo-ritento").first)["byte_inviati"]], [0, num(30), num(0)])
    verificaTutto("il prossimo task è già nel sistema, differito di 30 s e creato in background", [banco.trasporto.numeroCreati, banco.trasporto.richiesta(1).nonPrima, banco.voce(1)?.creatoInBackground],
                   [2, t0.addingTimeInterval(30), true])
    banco.completa(banco.trasporto.id(1), putSenzaRete(-1005))
    verificaTutto("un secondo errore di rete mentre la notifica c'è già: non se ne mostra un'altra (è una sola, sostituita)", [banco.notificatore.numeroMostrate, banco.eventi("video-nativo-attesa-rete").count], [1, 1])
    let rimosseDaApertura = banco.notificatore.rimozioni
    // Un task creato in background che ha già spedito dei byte non si tocca (la riapertura non butta via un invio in corso)
    let bgConByte = BancoMotore()
    bgConByte.accoda(1)
    bgConByte.motore.notificaSeFermo()
    bgConByte.attendi()
    bgConByte.completa(bgConByte.trasporto.id(0), putSenzaRete())
    bgConByte.trasporto.avanzamento(bgConByte.trasporto.id(1), byte: 5000)
    bgConByte.attendi()
    bgConByte.motore.riprendiInPrimoPiano()
    bgConByte.attendi()
    verificaTutto("un task creato in background che ha già spedito byte NON si ricrea alla riapertura (l'invio in corso non si butta via)",
                  [bgConByte.trasporto.numeroCreati, bgConByte.trasporto.annullati.count, bgConByte.stato(1)], [2, 0, "inInvio"])
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verificaUguali("all'apertura dell'app la notifica si toglie", banco.notificatore.rimozioni, rimosseDaApertura + 1)
    verificaTutto("… e il task creato in background con 0 byte (per iOS discrezionale) si ferma e si ricrea in primo piano", [banco.trasporto.annullati.contains(banco.trasporto.id(2)), banco.trasporto.numeroCreati], [true, 4])
    verificaTutto("… subito, in-invio, creato in primo piano", [banco.stato(1), banco.trasporto.richiesta(3).nonPrima == nil, banco.voce(1)?.creatoInBackground], [KVStatoCaricamento.inInvio, true, false])
    banco.completa(banco.trasporto.id(2), KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)))
    verificaTutto("il completamento del task fermato (cancellato) non fa niente", [banco.stato(1), banco.trasporto.numeroCreati], ["inInvio", 4])

    sezione("Motore — in background un 5xx o un 429 NON mostra la notifica: è «in attesa di rete» solo quando la rete manca")
    let bs = BancoMotore()
    bs.accoda(1)
    bs.motore.notificaSeFermo()
    bs.attendi()
    bs.completa(bs.trasporto.id(0), putTransitoria(503))
    bs.completa(bs.trasporto.id(1), putTransitoria(429, retryAfter: "60"))
    verificaTutto("due transitori del server a app in background: in-attesa SERVER, nessuna notifica, nessuna riga attesa-rete", [bs.voce(1)?.codice, bs.notificatore.numeroMostrate, bs.eventi("video-nativo-attesa-rete").count],
                  ["server", 0, 0])
    verificaUguali("… ma il prossimo task c'è (creato in background)", [bs.trasporto.numeroCreati, bs.voce(1)?.creatoInBackground] as [AnyHashable?], [3, true] as [AnyHashable?])

    sezione("Motore — con l'app in PRIMO PIANO un errore di rete non mostra nessuna notifica")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), putSenzaRete())
    verificaTutto("in-attesa RETE, ritento scritto, ma nessuna notifica", [b2.voce(1)?.codice, b2.eventi("video-nativo-ritento").count, b2.notificatore.numeroMostrate], ["rete", 1, 0])
    verificaUguali("… e il task differito è creato in primo piano", b2.voce(1)?.creatoInBackground, false)

    sezione("Motore — notifiche NON autorizzate: `video-nativo-attesa-rete` con notifica=false, e `notifica-locale-non-autorizzata` UNA volta sola")
    let b3 = BancoMotore()
    b3.notificatore.esito = KVEsitoNotificaAttesa(autorizzata: false, programmata: false)
    b3.accoda(1)
    b3.motore.notificaSeFermo()
    b3.attendi()
    b3.completa(b3.trasporto.id(0), putSenzaRete())
    verificaUguali("log: attesa-rete con notifica e autorizzata falsi", campi(b3.eventi("video-nativo-attesa-rete").first), ["notifica": boo(false), "autorizzata": boo(false)])
    verificaTutto("… e notifica-locale-non-autorizzata (warn)", [b3.eventi("notifica-locale-non-autorizzata").count, b3.eventi("notifica-locale-non-autorizzata").first?.livello], [1, KVLivelloLog.warn])
    b3.completa(b3.trasporto.id(1), putSenzaRete())
    verificaUguali("un secondo errore: la notifica non era partita, si riprova (due tentativi)", b3.notificatore.numeroMostrate, 2)
    verificaUguali("… ma `notifica-locale-non-autorizzata` resta UNA (per installazione)", b3.eventi("notifica-locale-non-autorizzata").count, 1)
    verificaUguali("… e le righe attesa-rete sono due", b3.eventi("video-nativo-attesa-rete").count, 2)

    sezione("Motore — l'attesa cambia causa (prima la rete, poi il server): la notifica «in attesa di rete» non resta a dire una cosa che non è più vera")
    let bc = BancoMotore()
    bc.accoda(1)
    bc.motore.notificaSeFermo()
    bc.attendi()
    bc.completa(bc.trasporto.id(0), putSenzaRete())
    verificaUguali("(setup) la notifica è partita per la rete", bc.notificatore.numeroMostrate, 1)
    let rimosseBc = bc.notificatore.rimozioni
    bc.completa(bc.trasporto.id(1), putTransitoria(503))
    verificaTutto("il task differito finisce con un 503: la voce aspetta il SERVER, la rete non c'entra più, e la notifica si toglie", [bc.voce(1)?.codice, bc.notificatore.rimozioni],
                  [KVCodiceCaricamento.server, rimosseBc + 1])

    sezione("Motore — il sistema accetta la richiesta ma poi la notifica non parte (programmata=false): si riprova al prossimo errore")
    let b4 = BancoMotore()
    b4.notificatore.esito = KVEsitoNotificaAttesa(autorizzata: true, programmata: false)
    b4.accoda(1)
    b4.motore.notificaSeFermo()
    b4.attendi()
    b4.completa(b4.trasporto.id(0), putSenzaRete())
    verificaTutto("autorizzata ma non programmata: attesa-rete(notifica false, autorizzata true), e niente `non-autorizzata`",
                   [campi(b4.eventi("video-nativo-attesa-rete").first)["notifica"], campi(b4.eventi("video-nativo-attesa-rete").first)["autorizzata"], b4.eventi("notifica-locale-non-autorizzata").count],
                   [boo(false), boo(true), 0])
}

func provaMotoreRete() {
    sezione("Motore — il monitor di rete: `unsatisfied` porta in-invio a in-attesa(RETE) (persistito), `satisfied` le riporta in-invio")
    let banco = BancoMotore()
    verifica("il monitor di rete è partito con il motore", banco.rete.partita)
    banco.accoda(1)
    banco.rete.imposta(false)
    banco.attendi()
    verificaTutto("rete assente: la voce è in-attesa con RETE", [banco.stato(1), banco.voce(1)?.codice], ["inAttesa", "rete"])
    verificaTutto("… il task è ancora lì (ci pensa il sistema: i task in background aspettano la rete da soli)", [banco.trasporto.numeroCreati, banco.trasporto.annullati.count], [1, 0])
    verificaUguali("… nessun log (non è un ritento: nessun tentativo è fallito)", banco.messaggi, [messaggio("video-nativo-accodato", job: 1)])
    let riletta = KVCodaCaricamenti(cartella: banco.radice, orologio: { orologioProva })
    _ = riletta.carica()
    verificaTutto("… e lo stato sta su disco", [riletta.voce(uuid(1))?.stato, riletta.voce(uuid(1))?.codice], [KVStatoCaricamento.inAttesa, KVCodiceCaricamento.rete])
    verificaUguali("al JS è arrivato `in-attesa`", banco.emessi.last?.voce.stato, .inAttesa)
    banco.rete.imposta(true)
    banco.attendi()
    verificaTutto("rete tornata: la voce è di nuovo in-invio", [banco.stato(1), banco.voce(1)?.codice], [KVStatoCaricamento.inInvio, nil])
    verificaUguali("… senza un task nuovo (quello del sistema riprende da solo)", banco.trasporto.numeroCreati, 1)

    sezione("Motore — rete tornata con una voce in-attesa(RETE) SENZA task: riparte subito; con una in-attesa(SERVER) NO (ha la sua attesa)")
    let b2 = BancoMotore()
    b2.accoda(1, token: tokenA)
    b2.accoda(2, token: tokenB)
    orologioProva = t0.addingTimeInterval(700) // l'URL è firmato da più di 10 minuti: prima di ogni nuova PUT serve un rinnovo
    b2.completa(b2.trasporto.id(0), putTransitoria(503))
    b2.rispondiRinnovo(rinnovoErroreServer)
    b2.completa(b2.trasporto.id(1), putSenzaRete())
    b2.rispondiRinnovo(rinnovoSenzaRete)
    verificaTutto("(setup) la 1 aspetta come SERVER e la 2 come RETE, entrambe senza un task nuovo (il rinnovo non è riuscito)",
                  [b2.stato(1), b2.voce(1)?.codice, b2.stato(2), b2.voce(2)?.codice, b2.trasporto.numeroCreati, b2.rinnovo.numeroChiamate], ["inAttesa", "server", "inAttesa", "rete", 2, 2])
    b2.rete.imposta(false)
    b2.rete.imposta(true)
    b2.attendi()
    verificaTutto("la voce in-attesa(SERVER) non è toccata dalla rete che torna", [b2.stato(1), b2.voce(1)?.codice], ["inAttesa", "server"])
    verificaTutto("la voce in-attesa(RETE) senza task riparte SUBITO: un nuovo rinnovo, col SUO token (l'URL è ancora vecchio)", [b2.rinnovo.numeroChiamate, b2.rinnovo.chiamate.last?.token], [3, tokenB])
    verificaUguali("… e la voce è tornata in-invio (un ciclo nuovo)", [b2.stato(2), b2.voce(2)?.tentativi] as [AnyHashable?], [KVStatoCaricamento.inInvio, 3] as [AnyHashable?])

    sezione("Motore — rete assente e app che va in background: la notifica parte SUBITO; torna la rete e si toglie")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.rete.imposta(false)
    b3.attendi()
    verificaUguali("(setup) in primo piano nessuna notifica", b3.notificatore.numeroMostrate, 0)
    b3.motore.notificaSeFermo()
    b3.attendi()
    verificaUguali("in background con la rete assente e un invio in corso: la notifica parte subito", b3.notificatore.numeroMostrate, 1)
    verificaUguali("… col testo d'attesa che il JS ha dato", b3.notificatore.mostrate.first?.corpo, testiProva.attesaRete)
    verificaUguali("… e il log attesa-rete", campi(b3.eventi("video-nativo-attesa-rete").first), ["notifica": boo(true), "autorizzata": boo(true)])
    let rimosse = b3.notificatore.rimozioni
    b3.rete.imposta(true)
    b3.attendi()
    verificaUguali("la rete torna: la notifica si toglie", b3.notificatore.rimozioni, rimosse + 1)
    verificaUguali("… e la voce è in-invio", b3.stato(1), .inInvio)
    // l'ultima voce si annulla con la rete ancora assente: non c'è più niente da aspettare, la notifica si toglie
    let b6 = BancoMotore()
    b6.accoda(1)
    b6.rete.imposta(false)
    b6.motore.notificaSeFermo()
    b6.attendi()
    verificaUguali("(setup) notifica mostrata a rete assente", b6.notificatore.numeroMostrate, 1)
    let rimosseB6 = b6.notificatore.rimozioni
    _ = b6.motore.annulla(job: uuid(1))
    b6.attendi()
    verificaUguali("annullata l'ultima voce, a rete ancora assente: la notifica si toglie (non resta un avviso su un invio che non c'è più)", b6.notificatore.rimozioni, rimosseB6 + 1)
    // la rete è assente da prima: una voce accodata adesso è in-invio (il sistema aspetta la rete) e basta a tenere la notifica
    let b8 = BancoMotore()
    b8.accoda(1)
    b8.rete.imposta(false)
    b8.motore.notificaSeFermo()
    b8.attendi()
    b8.accoda(2, token: tokenB)
    verificaTutto("(setup) la 1 aspetta la rete (notifica mostrata); la 2, accodata a rete assente, è in-invio", [b8.voce(1)?.codice, b8.stato(2), b8.notificatore.numeroMostrate],
                  [KVCodiceCaricamento.rete, KVStatoCaricamento.inInvio, 1])
    let rimosseB8 = b8.notificatore.rimozioni
    _ = b8.motore.annulla(job: uuid(1))
    b8.attendi()
    verificaUguali("annullata la 1, la rete è ancora assente e la 2 non può partire: la notifica RESTA", b8.notificatore.rimozioni, rimosseB8)
    // rete assente, nessuna voce da inviare: niente notifica
    let b4 = BancoMotore()
    b4.rete.imposta(false)
    b4.motore.notificaSeFermo()
    b4.attendi()
    verificaUguali("rete assente ma NIENTE da inviare: nessuna notifica", b4.notificatore.numeroMostrate, 0)
    // un invio concluso toglie la notifica d'attesa
    let b5 = BancoMotore()
    b5.accoda(1)
    b5.motore.notificaSeFermo()
    b5.attendi()
    b5.completa(b5.trasporto.id(0), putSenzaRete())
    verificaUguali("(setup) notifica mostrata", b5.notificatore.numeroMostrate, 1)
    let rimosseB5 = b5.notificatore.rimozioni
    b5.trasporto.avanzamento(b5.trasporto.id(1), byte: 100)
    b5.attendi()
    verificaTutto("i primi byte del task ripreso: la voce è in-invio e la notifica si toglie", [b5.stato(1), b5.notificatore.rimozioni], [KVStatoCaricamento.inInvio, rimosseB5 + 1])
    b5.completa(b5.trasporto.id(1), putRiuscita())
    verificaTutto("a invio concluso resta tolta", [b5.stato(1), b5.notificatore.numeroMostrate], [KVStatoCaricamento.inviato, 1])

    sezione("Motore — la notifica «in attesa di rete» si toglie quando nessuna voce aspetta più la RETE, anche se un'altra aspetta il server")
    let b7 = BancoMotore()
    b7.accoda(1)
    b7.accoda(2, token: tokenB)
    b7.motore.notificaSeFermo()
    b7.attendi()
    b7.completa(b7.trasporto.id(0), putSenzaRete())
    let differitoDellaUno = b7.trasporto.ultimoId
    b7.completa(b7.trasporto.id(1), putTransitoria(503))
    verificaTutto("(setup) la 1 aspetta la rete (e la notifica è partita), la 2 aspetta il server", [b7.voce(1)?.codice, b7.voce(2)?.codice, b7.notificatore.numeroMostrate],
                  [KVCodiceCaricamento.rete, KVCodiceCaricamento.server, 1])
    let rimosseB7 = b7.notificatore.rimozioni
    b7.trasporto.avanzamento(differitoDellaUno, byte: 50)
    b7.attendi()
    verificaTutto("la 1 riprende a spedire: nessuna voce aspetta più la rete (resta la 2, per il server) e la notifica si toglie", [b7.stato(1), b7.notificatore.rimozioni],
                  [KVStatoCaricamento.inInvio, rimosseB7 + 1])
}

// MARK: - Il rilancio in background: `ricollega`

/// Un processo lanciato in background dal sistema: una voce in invio con il suo task (55) ancora vivo nella sessione.
private func bancoDiUnRilancio() -> BancoMotore {
    return BancoMotore(inBackground: true, inPrimoPiano: false) { b in
        b.coda.carica()
        var v = voce(1, byte: 100, creatoIl: t0, utente: utenteProva)
        v.urlScadeIl = t0.addingTimeInterval(7200)
        _ = b.coda.aggiungi(v)
        scrivi(b.radice.appendingPathComponent(v.file), byte: 100)
        _ = b.coda.applica(.trasferimentoAvviato, a: uuid(1))
        b.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        b.trasporto.extraVivi = [KVTaskVivo(job: uuid(1), identificativo: 55, byteInviati: 100)]
    }
}

func provaMotoreRicollega() {
    sezione("Motore — `ricollega`: il completamento del sistema si chiama sul main DOPO il lavoro conseguente (rinnovo, nuovo task, svuotamento del registro)")
    let banco = bancoDiUnRilancio()
    verificaUguali("il motore dichiara il rilancio in background con le voci vive", banco.eventi("caricamenti-nativi-motore").map { $0.messaggio }, ["caricamenti-nativi-motore: urlsession rilancio-background"])
    verificaUguali("… in_coda 0, in_invio 1, task_vivi 1", campi(banco.eventi("caricamenti-nativi-motore").first), ["in_coda": num(0), "in_invio": num(1), "task_vivi": num(1)])
    verificaUguali("avvia non crea task (l'app non è attiva)", banco.trasporto.numeroCreati, 0)
    var chiamate = 0
    banco.motore.ricollega("it.kidville.app.caricamenti") { chiamate += 1 }
    banco.attendi()
    verificaUguali("ricollega apre un lavoro in background", banco.lavoro.iniziati, 1)
    // Il sistema consegna gli eventi: il task 55 è finito con 400 InvalidJWT → serve un rinnovo
    let richiesteAvvio = banco.trasportoLog.richieste.count
    orologioProva = t0.addingTimeInterval(11) // l'ultimo invio dei log è di più di 10 secondi fa: l'ultimo svuotamento PUÒ partire
    banco.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: 55, putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 7000), byteInviati: 100)
    banco.trasporto.consegnaEventi()
    banco.attendi()
    banco.giraIlMain()
    verificaTutto("il rinnovo è partito e il completamento NON è stato chiamato: il lavoro conseguente non è finito", [banco.rinnovo.numeroChiamate, chiamate], [1, 0])
    banco.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "b"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    banco.giraIlMain()
    verificaTutto("risposto il rinnovo (e creato il nuovo task, in background) il completamento scatta, UNA volta", [banco.trasporto.numeroCreati, chiamate], [1, 1])
    verificaUguali("… il nuovo task nato in background è segnato come tale (per riprendiInPrimoPiano)", banco.voce(1)?.creatoInBackground, true)
    verificaUguali("… prima del completamento il registro si è svuotato UN'ALTRA volta, con i log di ciò che è appena successo (put-oltre-scadenza e rinnovo)",
                   [banco.trasportoLog.richieste.count, banco.trasportoLog.eventi(banco.trasportoLog.richieste.count - 1).compactMap { ($0["messaggio"] as? String).map { String($0.split(separator: ":").first ?? "") } }.contains("video-nativo-rinnovo")] as [AnyHashable?],
                   [richiesteAvvio + 1, true] as [AnyHashable?])
    verificaUguali("… il lavoro in background si è chiuso", banco.lavoro.terminati, [1])
    verificaUguali("un secondo `didFinishEvents` senza un nuovo `ricollega` non richiama niente", { () -> Int in
        banco.trasporto.consegnaEventi()
        banco.attendi()
        banco.giraIlMain()
        return chiamate
    }(), 1)

    sezione("Motore — `didFinishEvents` arrivato PRIMA di `ricollega` (la sessione si crea in avvia, che precede): il completamento scatta lo stesso")
    let b2 = bancoDiUnRilancio()
    b2.trasporto.consegnaEventi()
    b2.attendi()
    var c2 = 0
    b2.motore.ricollega("it.kidville.app.caricamenti") { c2 += 1 }
    b2.attendi()
    b2.giraIlMain()
    verificaUguali("eventi finiti prima, poi ricollega: il completamento scatta (dopo lo svuotamento del registro)", c2, 1)

    sezione("Motore — un tetto di ~20 secondi: se gli eventi non finiscono mai il completamento si chiama comunque")
    let b3 = bancoDiUnRilancio()
    var c3 = 0
    b3.motore.ricollega("it.kidville.app.caricamenti") { c3 += 1 }
    b3.attendi()
    b3.avanza(19)
    b3.giraIlMain()
    verificaUguali("a 19 secondi il completamento non è ancora scattato", c3, 0)
    b3.avanza(1)
    b3.giraIlMain()
    verificaUguali("a 20 secondi scatta (il sistema ne darebbe ~30, poi termina l'app)", c3, 1)
    verificaUguali("… e il lavoro in background si chiude", b3.lavoro.terminati, [1])

    sezione("Motore — il sistema ritira il tempo (`beginBackgroundTask` scade): si chiude subito")
    let b4 = bancoDiUnRilancio()
    var c4 = 0
    b4.motore.ricollega("it.kidville.app.caricamenti") { c4 += 1 }
    b4.attendi()
    b4.lavoro.scade(1)
    b4.attendi()
    b4.giraIlMain()
    verificaUguali("alla scadenza il completamento scatta, UNA volta", c4, 1)
    verificaUguali("… e non si ripete al timer del tetto", { () -> Int in b4.avanza(30); b4.giraIlMain(); return c4 }(), 1)

    sezione("Motore — un identificativo che non è il nostro: il completamento si chiama subito, senza aprire lavori")
    let b5 = bancoDiUnRilancio()
    var c5 = 0
    b5.motore.ricollega("altra.sessione") { c5 += 1 }
    b5.giraIlMain()
    verificaUguali("completamento chiamato", c5, 1)
    verificaUguali("… nessun lavoro aperto", b5.lavoro.iniziati, 0)

    sezione("Motore — due richiami di fila: il primo si chiude (la sessione è una)")
    let b6 = bancoDiUnRilancio()
    var primo = 0
    var secondo = 0
    b6.motore.ricollega("it.kidville.app.caricamenti") { primo += 1 }
    b6.attendi()
    b6.motore.ricollega("it.kidville.app.caricamenti") { secondo += 1 }
    b6.attendi()
    b6.giraIlMain()
    verificaTutto("il primo completamento è chiamato al secondo richiamo, il secondo aspetta", [primo, secondo], [1, 0])
    verificaTutto("… e il lavoro in background del primo richiamo si chiude subito: ne resta aperto UNO, quello del secondo", [b6.lavoro.terminati, b6.lavoro.aperti], [[1], 1])
    b6.trasporto.consegnaEventi()
    b6.attendi()
    b6.giraIlMain()
    verificaTutto("finiti gli eventi scatta anche il secondo", [primo, secondo], [1, 1])
    verificaUguali("… e il lavoro del secondo si chiude alla fine: nessuno resta aperto", b6.lavoro.aperti, 0)

    sezione("Motore — due richiami a dieci secondi l'uno dall'altro: il tetto dei 20 secondi è quello del SECONDO (il timer del primo non chiude il lavoro del secondo)")
    let b9 = bancoDiUnRilancio()
    var primoRichiamo = 0
    var secondoRichiamo = 0
    b9.motore.ricollega("it.kidville.app.caricamenti") { primoRichiamo += 1 }
    b9.attendi()
    b9.avanza(10)
    b9.motore.ricollega("it.kidville.app.caricamenti") { secondoRichiamo += 1 }
    b9.attendi()
    b9.avanza(10)
    b9.giraIlMain()
    verificaUguali("a 20 secondi dal primo richiamo (il suo tetto) il secondo, arrivato a 10, non è ancora chiuso", [primoRichiamo, secondoRichiamo], [1, 0])
    b9.avanza(9)
    b9.giraIlMain()
    verificaUguali("… a 29 secondi non ancora", secondoRichiamo, 0)
    b9.avanza(1)
    b9.giraIlMain()
    verificaUguali("… a 30 secondi (20 dal SUO richiamo) sì", secondoRichiamo, 1)

    sezione("Motore — un secondo rilancio dopo che il primo si è chiuso aspetta i SUOI eventi: il segno «eventi finiti» non sopravvive al giro")
    let b10 = bancoDiUnRilancio()
    var giroUno = 0
    var giroDue = 0
    b10.motore.ricollega("it.kidville.app.caricamenti") { giroUno += 1 }
    b10.attendi()
    b10.trasporto.consegnaEventi()
    b10.attendi()
    b10.giraIlMain()
    verificaUguali("(setup) primo giro: gli eventi sono arrivati e il completamento è scattato", giroUno, 1)
    b10.motore.ricollega("it.kidville.app.caricamenti") { giroDue += 1 }
    b10.attendi()
    b10.giraIlMain()
    verificaUguali("il secondo giro, senza eventi nuovi, NON è già chiuso (la sessione deve ancora consegnare i suoi)", giroDue, 0)
    b10.trasporto.consegnaEventi()
    b10.attendi()
    b10.giraIlMain()
    verificaUguali("… e si chiude quando arrivano", giroDue, 1)

    sezione("Motore — `ricollega` crea la sessione se non c'è ancora: è su quella che il sistema consegna gli eventi in sospeso")
    let b11 = BancoMotore(avvia: false, inPrimoPiano: false)
    verificaUguali("(setup) prima di tutto nessun trasporto agganciato", b11.trasporto.delegato == nil, true)
    b11.motore.ricollega("it.kidville.app.caricamenti") { }
    b11.attendi()
    verificaUguali("dopo `ricollega` il trasporto è agganciato al motore (la sessione esiste e consegna a lui)", b11.trasporto.delegato != nil, true)

    sezione("Motore — eventi consegnati con l'app in PRIMO PIANO non lasciano un segno che chiuda in anticipo un richiamo futuro")
    let b7 = BancoMotore()
    b7.trasporto.consegnaEventi()
    b7.attendi()
    b7.motore.notificaSeFermo()
    b7.attendi()
    var c7 = 0
    b7.motore.ricollega("it.kidville.app.caricamenti") { c7 += 1 }
    b7.attendi()
    b7.giraIlMain()
    verificaUguali("il richiamo successivo aspetta i SUOI eventi (non è «già finito»)", c7, 0)
    b7.trasporto.consegnaEventi()
    b7.attendi()
    b7.giraIlMain()
    verificaUguali("… e scatta quando arrivano", c7, 1)
}

// MARK: - L'avvio: riconciliare prima di pulire

func provaMotoreAvvioERiconciliazione() {
    sezione("Motore — avvia(): riconcilia la coda con i task del sistema e SOLO POI pulisce; non crea task; segreti senza voce tolti")
    func bancoConUnPassato(inBackground: Bool = false, inPrimoPiano: Bool = false) -> BancoMotore {
        return BancoMotore(inBackground: inBackground, avvia: true, inPrimoPiano: inPrimoPiano) { b in
            b.coda.carica()
            func semina(_ n: Int, byte: Int64 = 100, tokenScade: Date = t0.addingTimeInterval(48 * 3600)) {
                var v = voce(n, byte: byte, creatoIl: t0, tokenScadeIl: tokenScade, utente: utenteProva)
                v.urlScadeIl = t0.addingTimeInterval(7200)
                _ = b.coda.aggiungi(v)
                scrivi(b.radice.appendingPathComponent(v.file), byte: Int(byte))
                b.segreti.semina(uuid(n), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(n), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
            }
            // 1: in invio, con un task vivo del sistema (700 byte già spediti su 1.000)
            semina(1, byte: 1000)
            _ = b.coda.applica(.trasferimentoAvviato, a: uuid(1))
            b.trasporto.extraVivi.append(KVTaskVivo(job: uuid(1), identificativo: 55, byteInviati: 700))
            // 2: in attesa dopo un 5xx, senza task
            semina(2)
            _ = b.coda.applica(.trasferimentoAvviato, a: uuid(2))
            _ = b.coda.applica(.inAttesa(.server), a: uuid(2))
            b.coda.aggiorna(uuid(2)) { $0.prossimoTentativoIl = t0.addingTimeInterval(3600) }
            // 3: terminale di otto giorni fa
            orologioProva = t0.addingTimeInterval(-8 * 86400)
            semina(3)
            _ = b.coda.applica(.trasferimentoAvviato, a: uuid(3))
            _ = b.coda.applica(.fallito(.tokenNonValido), a: uuid(3))
            // 4: in invio col token SCADUTO (a t0+200), e il suo task è finito con successo mentre l'app era morta: l'evento arriva alla creazione della sessione
            orologioProva = t0.addingTimeInterval(200)
            semina(4, tokenScade: t0.addingTimeInterval(100))
            _ = b.coda.applica(.trasferimentoAvviato, a: uuid(4))
            b.trasporto.primaDiRispondere = { [unowned b] in
                b.trasporto.completaDiUnaVitaPrecedente(job: uuid(4), task: 77, putRiuscita(durata: 40), byteInviati: 100)
            }
            // 8: segreti senza voce; 9: un task del sistema che nessuna voce nomina
            b.segreti.semina(uuid(8), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(8), contentType: "video/mp4", urlRinnovo: urlRinnovoProva))
            b.trasporto.extraVivi.append(KVTaskVivo(job: uuid(9), identificativo: 66, byteInviati: 0))
        }
    }
    let banco = bancoConUnPassato()
    verificaUguali("avvia non ha creato nessun task (l'app non è attiva)", banco.trasporto.numeroCreati, 0)
    verificaUguali("il task finito mentre l'app era morta (4) è `inviato`: l'evento della sessione è stato applicato PRIMA della pulizia", banco.stato(4), .inviato)
    verificaTutto("… e NON `fallito` TOKEN_SCADUTO (il token era scaduto, ma il video era arrivato)", [banco.eventi("video-nativo-fallito").count, banco.voce(4)?.codice == nil ? 1 : 0], [0, 1])
    verificaUguali("… col log inviato (durata 40 s dalla sessione, mai nel mio orologio)", banco.eventi("video-nativo-inviato").map { $0.messaggio }, [messaggio("video-nativo-inviato", job: 4)])
    verifica("… copia e segreti del 4 cancellati", !esiste(banco.copia(4)) && !banco.segreti.contiene(uuid(4)))
    verificaUguali("la voce 1 (in invio, task vivo) è stata adottata: i byte spediti sono quelli del task", banco.motore.elenco(perUtente: uuid(utenteProva)).first(where: { ($0["jobId"] as? String) == uuid(1).uuidString.lowercased() })?["byteInviati"] as? NSNumber, NSNumber(value: 700))
    verificaTutto("… e resta in-invio, senza un task nuovo", [banco.stato(1), banco.trasporto.numeroCreati], [KVStatoCaricamento.inInvio, 0])
    verificaTutto("la voce 2 (in attesa, senza task) non è toccata dall'avvio", [banco.stato(2), banco.voce(2)?.codice], [KVStatoCaricamento.inAttesa, KVCodiceCaricamento.server])
    verifica("la voce terminale di otto giorni fa (3) è stata tolta dalla pulizia", banco.voce(3) == nil)
    verifica("il task del sistema che nessuna voce nomina (9) è stato fermato", banco.trasporto.annullati.contains(66))
    verifica("i segreti senza voce (8) sono stati tolti; quelli delle voci vive (1, 2) restano", !banco.segreti.contiene(uuid(8)) && banco.segreti.contiene(uuid(1)) && banco.segreti.contiene(uuid(2)))
    verificaTutto("il motore dichiara l'avvio con le voci vive: in_coda 0, in_invio 1, task_vivi 1", [banco.eventi("caricamenti-nativi-motore").map { $0.messaggio }, [campi(banco.eventi("caricamenti-nativi-motore").first)["in_invio"], campi(banco.eventi("caricamenti-nativi-motore").first)["task_vivi"]]],
                   [["caricamenti-nativi-motore: urlsession avvio"], [num(1), num(1)]])
    verifica("il registro si è svuotato all'avvio verso la destinazione di produzione, che in Release è nota fin dall'inizio", banco.trasportoLog.richieste.first?.url.absoluteString == urlRegistroProva)
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verificaTutto("alla riapertura la voce senza task (2) riparte, e solo quella: UN task, per il job 2", [banco.trasporto.numeroCreati, banco.trasporto.richiesta(0).job], [1, uuid(2)])
    verificaTutto("… subito, senza aspettare l'attesa che aveva", [banco.trasporto.richiesta(0).nonPrima == nil, banco.voce(2)?.prossimoTentativoIl == nil], [true, true])
    verificaUguali("al primo rientro dopo un avvio in primo piano non si scrive un secondo «motore» (avvio e primo-piano sono la stessa cosa)", banco.eventi("caricamenti-nativi-motore").count, 1)
    verificaUguali("… e quella voce aspettava per un 5xx, non per una chiusura forzata: nessuna riga video-nativo-ripreso-dopo-chiusura", banco.eventi("video-nativo-ripreso-dopo-chiusura").count, 0)

    sezione("Motore — lanciato dal sistema in background l'avvio si dichiara `rilancio-background`, e l'apertura successiva `primo-piano`")
    let b2 = bancoConUnPassato(inBackground: true)
    verificaUguali("avvio da rilancio", b2.eventi("caricamenti-nativi-motore").map { $0.messaggio }, ["caricamenti-nativi-motore: urlsession rilancio-background"])
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verificaUguali("poi l'utente apre l'app: `primo-piano`", b2.eventi("caricamenti-nativi-motore").map { $0.messaggio },
                   ["caricamenti-nativi-motore: urlsession rilancio-background", "caricamenti-nativi-motore: urlsession primo-piano"])

    sezione("Motore — senza voci vive l'avvio non scrive niente (il log del motore c'è solo con voci vive)")
    let b3 = BancoMotore()
    verificaUguali("nessuna riga di log", b3.messaggi, [])
    verificaTutto("nessun task, nessun rinnovo, nessuna notifica", [b3.trasporto.numeroCreati, b3.rinnovo.numeroChiamate, b3.notificatore.numeroMostrate], [0, 0, 0])
    verificaUguali("la sessione è stata interrogata all'avvio e al rientro (taskVivi)", b3.trasporto.chiamateTaskVivi >= 2, true)

    sezione("Motore — un sistema che non risponde a `getAllTasks`: dopo 15 secondi l'avvio si completa da solo (riconcilia e pulisce); la risposta tardiva non rifà niente")
    let lento = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        b.coda.carica()
        orologioProva = t0.addingTimeInterval(-8 * 86400)
        _ = b.coda.aggiungi(voce(3, byte: 10, creatoIl: orologioProva, utente: utenteProva))
        _ = b.coda.applica(.annullato(nil), a: uuid(3))
        orologioProva = t0
        _ = b.coda.aggiungi(voce(1, byte: 100, creatoIl: t0, utente: utenteProva))
        b.trasporto.nonRispondeATaskVivi = true
    }
    lento.motore.avvia()
    lento.attendi()
    verificaTutto("senza risposta del sistema l'avvio non è completato: la pulizia non è girata, nessuna riga del motore", [lento.voce(3) != nil, lento.eventi("caricamenti-nativi-motore").count], [true, 0])
    lento.avanza(14)
    verificaTutto("a 14 secondi ancora no", [lento.voce(3) != nil, lento.eventi("caricamenti-nativi-motore").count], [true, 0])
    lento.avanza(1)
    verificaTutto("a 15 secondi l'avvio si completa da solo: la pulizia è girata (la terminale vecchia è tolta) e il motore dichiara le voci vive", [lento.voce(3) == nil, lento.eventi("caricamenti-nativi-motore").map { $0.messaggio }],
                  [true, ["caricamenti-nativi-motore: urlsession avvio"]])
    lento.trasporto.rispondiATaskViviInSospeso()
    lento.attendi()
    verificaUguali("la risposta tardiva del sistema non rifà l'avvio (una riga sola)", lento.eventi("caricamenti-nativi-motore").count, 1)

    sezione("Motore — l'app torna in primo piano PRIMA che il sistema abbia risposto a `getAllTasks`: la ripresa aspetta la fine dell'avvio, e poi avviene")
    let presto = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        b.coda.carica()
        var v = voce(2, byte: 100, creatoIl: t0, utente: utenteProva)
        v.urlScadeIl = t0.addingTimeInterval(7200)
        _ = b.coda.aggiungi(v)
        scrivi(b.radice.appendingPathComponent(v.file), byte: 100)
        _ = b.coda.applica(.trasferimentoAvviato, a: uuid(2))
        _ = b.coda.applica(.inAttesa(.server), a: uuid(2))
        b.coda.aggiorna(uuid(2)) { $0.prossimoTentativoIl = t0.addingTimeInterval(3600) }
        b.segreti.semina(uuid(2), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(2), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        b.trasporto.nonRispondeATaskVivi = true
    }
    presto.motore.avvia()
    presto.attendi()
    presto.motore.riprendiInPrimoPiano()
    presto.attendi()
    verificaUguali("(setup) col sistema che non ha ancora risposto la ripresa aspetta: nessun task", presto.trasporto.numeroCreati, 0)
    presto.trasporto.nonRispondeATaskVivi = false
    presto.trasporto.rispondiATaskViviInSospeso()
    presto.attendi()
    verificaTutto("risposto il sistema l'avvio si completa e la ripresa rinviata avviene: la voce in attesa riparte SUBITO, con UN task",
                  [presto.trasporto.numeroCreati, presto.stato(2), presto.trasporto.richiesta(0).nonPrima == nil], [1, KVStatoCaricamento.inInvio, true])

    sezione("Motore — l'avvio ripetuto è inerte (un solo avvio per processo)")
    let b4 = bancoConUnPassato()
    let chiamateTaskVivi = b4.trasporto.chiamateTaskVivi
    b4.motore.avvia()
    b4.attendi()
    verificaTutto("un secondo avvia() non rifà niente", [b4.trasporto.chiamateTaskVivi, b4.eventi("caricamenti-nativi-motore").count], [chiamateTaskVivi, 1])
}

// MARK: - Una coda che non si legge

func provaMotoreCodaIllegibile() {
    sezione("Motore — coda che non si legge all'avvio (dati protetti): accoda rifiuta, si riprova alla riapertura; dopo tre tentativi col telefono sbloccato è guasta")
    if getuid() == 0 {
        print("  (prova saltata: eseguita come root, i permessi non bloccano la lettura)")
        return
    }
    let banco = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        let scrittrice = KVCodaCaricamenti(cartella: b.radice, orologio: { orologioProva })
        scrittrice.carica()
        var v = voce(1, byte: 100, creatoIl: t0, utente: utenteProva)
        v.urlScadeIl = t0.addingTimeInterval(7200)
        _ = scrittrice.aggiungi(v)
        scrivi(b.radice.appendingPathComponent(v.file), byte: 100)
        b.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        // una voce terminale di otto giorni fa e dei segreti senza voce: la pulizia dell'avvio li toglierebbe, se potesse girare
        orologioProva = t0.addingTimeInterval(-8 * 86400)
        _ = scrittrice.aggiungi(voce(3, byte: 10, creatoIl: orologioProva, utente: utenteProva))
        _ = scrittrice.applica(.annullato(nil), a: uuid(3))
        orologioProva = t0
        b.segreti.semina(uuid(8), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(8), contentType: "video/mp4", urlRinnovo: urlRinnovoProva))
        try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: scrittrice.urlFileCoda.path)
    }
    banco.motore.avvia()
    banco.attendi()
    verifica("(setup) la coda non è pronta", !banco.coda.pronta)
    let richiesta = banco.richiesta(2)
    verificaUguali("accoda con la coda illeggibile: INTERNO", banco.motore.accoda(richiesta), .rifiutato(.interno))
    banco.attendi()
    verifica("… e non ha toccato niente: il preparato è in scelti/, nessun segreto nuovo, nessun task", esiste(banco.scelto("e2")) && !banco.segreti.contiene(uuid(2)) && banco.trasporto.numeroCreati == 0)
    verificaUguali("… e nessuna riga di log (la coda illeggibile è un «non ancora», non un guasto)", banco.eventi("coda-nativa-corrotta").count, 0)
    try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: banco.coda.urlFileCoda.path)
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verifica("tornati i dati protetti la coda si carica alla prima riapertura", banco.coda.pronta)
    verificaTutto("… la voce 1 si ritrova e riparte (un task)", [banco.stato(1), banco.trasporto.numeroCreati], [KVStatoCaricamento.inInvio, 1])
    verificaTutto("… e la pulizia, che all'avvio non era potuta girare, è girata adesso: la terminale di otto giorni fa è tolta, i segreti senza voce pure, la copia e i segreti della voce viva restano",
                  [banco.voce(3) == nil, banco.segreti.contiene(uuid(8)), esiste(banco.copia(1)), banco.segreti.contiene(uuid(1))], [true, false, true, true])

    sezione("Motore — la coda resta illeggibile a telefono sbloccato: dopo 3 tentativi si tratta da corrotta (coda-nativa-corrotta) e si riparte")
    let b2 = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        let scrittrice = KVCodaCaricamenti(cartella: b.radice, orologio: { orologioProva })
        scrittrice.carica()
        var v = voce(1, byte: 100, creatoIl: t0, utente: utenteProva)
        v.urlScadeIl = t0.addingTimeInterval(7200)
        _ = scrittrice.aggiungi(v)
        scrivi(b.radice.appendingPathComponent(v.file), byte: 100)
        try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: scrittrice.urlFileCoda.path)
    }
    b2.motore.avvia()
    b2.attendi()
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verifica("primo tentativo con l'app in primo piano: ancora non pronta, e il file non si butta", !b2.coda.pronta && nomiIn(b2.radice).filter { $0.hasPrefix("coda.corrotta-") }.isEmpty)
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verifica("secondo tentativo: ancora non pronta", !b2.coda.pronta)
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verifica("terzo tentativo: la coda si tratta da corrotta e si riparte, pronta", b2.coda.pronta && b2.coda.tutte().isEmpty)
    verificaUguali("… il file è rimasto da parte per l'analisi", nomiIn(b2.radice).filter { $0.hasPrefix("coda.corrotta-") }.count, 1)
    verificaTutto("… e un log coda-nativa-corrotta (error) col file orfano", [b2.eventi("coda-nativa-corrotta").count, campi(b2.eventi("coda-nativa-corrotta").first)["file_orfani"]], [1, num(1)])
    verificaUguali("… livello error", b2.eventi("coda-nativa-corrotta").first?.livello, .error)
    verificaUguali("… e ora accoda funziona", { () -> Bool in if case .accodato = b2.accoda(2) { return true }; return false }(), true)

    sezione("Motore — i tentativi di lettura si contano solo con l'app in primo piano: in background la coda illeggibile non diventa mai «corrotta»")
    let b3 = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        let scrittrice = KVCodaCaricamenti(cartella: b.radice, orologio: { orologioProva })
        scrittrice.carica()
        _ = scrittrice.aggiungi(voce(1, byte: 100, creatoIl: t0, utente: utenteProva))
        try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: scrittrice.urlFileCoda.path)
    }
    b3.motore.avvia()
    b3.attendi()
    for _ in 0..<6 { _ = b3.motore.accoda(b3.richiesta(2)); b3.attendi() }
    verificaTutto("sei tentativi di accoda ad app NON in primo piano: la coda non si butta", [b3.coda.pronta, nomiIn(b3.radice).filter { $0.hasPrefix("coda.corrotta-") }.count], [false, 0])

    sezione("Motore — il registro dei log si rilegge al rientro in primo piano anche se la coda non si legge ancora (i suoi eventi vecchi tornano, non si perdono)")
    let b0 = BancoMotore()
    b0.accoda(1)
    verificaUguali("(setup) un evento già nel giornale su disco", b0.messaggi, [messaggio("video-nativo-accodato", job: 1)])
    let fileRegistro = b0.radice.appendingPathComponent(KVRegistroNativo.nomeFile)
    try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: fileRegistro.path)
    try! FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: b0.coda.urlFileCoda.path)
    let b4 = BancoMotore(avvia: false, inPrimoPiano: false, cartella: b0.radice)
    b4.motore.avvia()
    b4.attendi()
    verificaTutto("(setup) coda e giornale non si leggono (dati protetti): la coda non è pronta, e nel registro ancora niente dell'evento vecchio", [b4.coda.pronta, b4.messaggi], [false, [String]()])
    try! FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: fileRegistro.path)
    b4.motore.riprendiInPrimoPiano()
    b4.attendi()
    verificaTutto("tornato leggibile il SOLO giornale, al rientro in primo piano si rilegge: l'evento vecchio c'è, e la coda (ancora illeggibile) non si butta",
                  [b4.messaggi, b4.coda.pronta], [[messaggio("video-nativo-accodato", job: 1)], false])
    try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: b0.coda.urlFileCoda.path)
}

// MARK: - Rifiuti dell'accodamento

func provaMotoreAccodamentoRifiuti() {
    sezione("Motore — accoda rifiuta ciò che non va, SENZA toccare niente: host non ammessi, parametri, preparato assente o di un altro peso")
    func senzaTracce(_ banco: BancoMotore, preparato: String? = "e1") -> Bool {
        let nessunaVoce = banco.coda.tutte().isEmpty && banco.segreti.numero == 0 && banco.trasporto.numeroCreati == 0 && banco.messaggi.isEmpty
        let sorgenteIntatta = preparato.map { esiste(banco.scelto($0)) } ?? true
        return nessunaVoce && sorgenteIntatta && !esiste(banco.copia(1))
    }
    func rifiuta(_ nome: String, _ atteso: KVRifiutoAccodamento, ambiente: KVAmbienteBuild = .release, preparato: Bool = true, _ modifica: (inout KVRichiestaAccodamento) -> Void) {
        let banco = BancoMotore(ambiente: ambiente)
        var r = banco.richiesta(1, preparato: preparato)
        modifica(&r)
        let esito = banco.motore.accoda(r)
        banco.attendi()
        verificaUguali("\(nome): \(atteso.rawValue)", esito, .rifiutato(atteso))
        verifica("… e non è cambiato niente (nessuna voce, nessun segreto, nessun task, nessun log, preparato intatto)", senzaTracce(banco, preparato: preparato ? "e1" : nil))
    }
    rifiuta("PUT verso un host che non è Supabase", .hostNonAmmesso) { $0.urlPut = "https://evil.example.com/storage/x" }
    rifiuta("PUT verso l'host dell'applicazione", .hostNonAmmesso) { $0.urlPut = "https://app.kidville.it/x" }
    rifiuta("PUT in chiaro (http)", .hostNonAmmesso) { $0.urlPut = "http://abcdefghij.supabase.co/x" }
    rifiuta("PUT con credenziali nell'URL", .hostNonAmmesso) { $0.urlPut = "https://abcdefghij.supabase.co@evil.com/x" }
    rifiuta("PUT verso localhost in Release", .hostNonAmmesso) { $0.urlPut = "http://localhost:4310/put/x" }
    rifiuta("rinnovo verso un altro host", .hostNonAmmesso) { $0.urlRinnovo = "https://evil.example.com/api/video-uploads/rinnovo" }
    rifiuta("rinnovo verso Supabase", .hostNonAmmesso) { $0.urlRinnovo = "https://abcdefghij.supabase.co/x" }
    rifiuta("registro verso un altro host", .hostNonAmmesso) { $0.urlRegistro = "https://evil.example.com/api/logs" }
    rifiuta("registro in chiaro", .hostNonAmmesso) { $0.urlRegistro = "http://app.kidville.it/api/logs" }
    rifiuta("peso dichiarato nullo", .parametriNonValidi) { $0.byteAttesi = 0 }
    rifiuta("token vuoto", .parametriNonValidi) { $0.token = "" }
    rifiuta("token con un a capo (finirebbe in un'intestazione)", .parametriNonValidi) { $0.token = "kvr_a\r\nx-upsert: true" }
    rifiuta("content-type che non è un MIME", .parametriNonValidi) { $0.contentType = "boh" }
    rifiuta("content-type con lo spazio finale (che il server rifiuta)", .parametriNonValidi) { $0.contentType = "video/mp4 " }
    rifiuta("scadenza del token illeggibile", .parametriNonValidi) { $0.scadenzaToken = "tra poco" }
    rifiuta("scadenza dell'URL illeggibile", .parametriNonValidi) { $0.scadenzaUrl = "domani" }
    rifiuta("preparato assente (nessuna sorgente)", .elementoAssente, preparato: false) { _ in }
    rifiuta("preparato che non esiste più sul disco", .elementoAssente) { $0.sorgente = $0.sorgente?.deletingLastPathComponent().appendingPathComponent("sparito.mov") }
    rifiuta("preparato di un peso diverso da quello dichiarato", .elementoDiverso) { $0.byteAttesi = 1001 }

    sezione("Motore — Debug: gli host di sviluppo si ammettono (il banco di prova di C1/E1), in Release no")
    let dbg = BancoMotore(ambiente: .debug)
    var r = dbg.richiesta(1)
    r.urlPut = "http://localhost:4310/put/x"
    r.urlRinnovo = "http://localhost:3101/api/video-uploads/rinnovo"
    r.urlRegistro = "http://10.0.2.2:3101/api/logs"
    verificaUguali("accoda con host di sviluppo in Debug", { () -> Bool in if case .accodato = dbg.motore.accoda(r) { return true }; return false }(), true)
    dbg.attendi()
    verificaUguali("… la destinazione dei log è quella del banco di prova", dbg.registro.stato().destinazione?.host, "10.0.2.2")
    verificaUguali("… il task parte sull'URL di sviluppo", dbg.trasporto.richiesta(0).url.absoluteString, "http://localhost:4310/put/x")
    verificaUguali("… e i segreti hanno l'indirizzo di rinnovo di sviluppo", dbg.segreti.segreti(uuid(1))?.urlRinnovo, "http://localhost:3101/api/video-uploads/rinnovo")
    let rel = BancoMotore(ambiente: .release)
    verificaUguali("gli stessi indirizzi in Release: host non ammesso", rel.motore.accoda({ var q = rel.richiesta(1); q.urlPut = r.urlPut; q.urlRinnovo = r.urlRinnovo; q.urlRegistro = r.urlRegistro; return q }()), .rifiutato(.hostNonAmmesso))

    sezione("Motore — accoda prima di avvia(), o con la coda non pronta, non fa niente di strano")
    let prima = BancoMotore(avvia: false)
    verificaUguali("accoda prima di avvia(): INTERNO", prima.motore.accoda(prima.richiesta(1)), .rifiutato(.interno))
    verifica("… e il preparato è intatto", esiste(prima.scelto("e1")))
}

func provaMotoreAccodamentoRipetuto() {
    sezione("Motore — un reinvio dello stesso video (stesso job) dopo un annullamento o un fallimento RIPARTE: la voce terminale si sostituisce")
    let banco = BancoMotore()
    banco.accoda(1, byte: 1000)
    _ = banco.motore.annulla(job: uuid(1))
    banco.attendi()
    verificaUguali("(setup) annullata", banco.stato(1), .annullato)
    let esito = banco.accoda(1, byte: 1500, token: tokenB, firma: "n")
    verificaUguali("accoda sullo stesso job: accodato (non «già in coda»)", { () -> Bool in if case .accodato = esito { return true }; return false }(), true)
    verificaTutto("… la voce è una sola, in-invio, col peso nuovo, un ciclo", [banco.coda.tutte().count, banco.voce(1)?.byte, banco.voce(1)?.tentativi], [1, 1500, 1])
    verificaUguali("… senza il codice dell'annullamento", banco.voce(1)?.codice, nil)
    verificaTutto("… un secondo task, verso l'URL nuovo", [banco.trasporto.numeroCreati, banco.trasporto.richiesta(1).url.absoluteString], [2, urlPutProva(1, "n")])
    verificaUguali("… coi segreti nuovi", banco.segreti.segreti(uuid(1))?.token, tokenB)
    verificaUguali("… la copia nuova (1500 byte)", (try? FileManager.default.attributesOfItem(atPath: banco.copia(1).path))?[.size] as? Int, 1500)
    verificaUguali("… e due righe `accodato`", banco.eventi("video-nativo-accodato").count, 2)
    banco.completa(banco.trasporto.id(1), putRiuscita())
    verificaUguali("… e può arrivare", banco.stato(1), .inviato)

    let b2 = BancoMotore()
    b2.accoda(1)
    b2.completa(b2.trasporto.id(0), putRifiutata(413, errore: nil))
    verificaUguali("(setup) fallita TROPPO_GRANDE", b2.stato(1), .fallito)
    b2.accoda(1)
    verificaTutto("dopo un fallimento il reinvio riparte", [b2.stato(1), b2.voce(1)?.codice, b2.trasporto.numeroCreati], [KVStatoCaricamento.inInvio, nil, 2])

    sezione("Motore — un'apertura ripetuta porta anche la destinazione dei log che il JS ha oggi (in Debug può cambiare, e il registro la segue)")
    let dbg = BancoMotore(ambiente: .debug)
    dbg.accoda(1)
    verificaUguali("(setup) la destinazione è quella del sito", dbg.registro.stato().destinazione?.host, "app.kidville.it")
    var conAltroRegistro = dbg.richiesta(1, token: tokenB, firma: "b")
    conAltroRegistro.urlRegistro = "http://10.0.2.2:3101/api/logs"
    _ = dbg.motore.accoda(conAltroRegistro)
    dbg.attendi()
    verificaUguali("dopo l'apertura ripetuta la destinazione è quella nuova", dbg.registro.stato().destinazione?.host, "10.0.2.2")

    sezione("Motore — un reinvio mentre il rinnovo del tentativo di prima è ancora in volo: la voce nuova parte subito da sola, e la risposta di quel rinnovo (di un'altra vita dello stesso job) si butta")
    let bn = BancoMotore()
    bn.accoda(1)
    orologioProva = t0.addingTimeInterval(700)
    bn.completa(bn.trasporto.id(0), putTransitoria(503))
    verificaTutto("(setup) l'URL è vecchio: il rinnovo è in volo, e il task con l'attesa di 30 s non c'è ancora", [bn.rinnovo.senzaRisposta, bn.trasporto.numeroCreati], [1, 1])
    _ = bn.motore.annulla(job: uuid(1))
    bn.attendi()
    bn.accoda(1, token: tokenB, firma: "n")
    verificaTutto("il reinvio non aspetta quel rinnovo: parte subito col suo URL fresco (in-invio, un task senza attesa)",
                  [bn.stato(1), bn.trasporto.numeroCreati, bn.trasporto.richiesta(1).url.absoluteString, bn.trasporto.richiesta(1).nonPrima == nil], [KVStatoCaricamento.inInvio, 2, urlPutProva(1, "n"), true])
    bn.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "z"), scadeIl: orologioProva.addingTimeInterval(48 * 3600)))
    verificaTutto("la risposta del rinnovo di prima NON tocca la voce nuova: nessun secondo task, i segreti sono quelli del reinvio, nessun rinnovo contato",
                  [bn.trasporto.numeroCreati, bn.segreti.segreti(uuid(1))?.urlPut, bn.voce(1)?.rinnovi], [2, urlPutProva(1, "n"), 0])

    // Lo stesso, se la voce vecchia è stata anche dimenticata dalla schermata: la risposta tardiva non deve fare un secondo task alla voce nuova.
    let bd = BancoMotore()
    bd.accoda(1)
    bd.completa(bd.trasporto.id(0), putRifiutata(403, errore: nil))
    _ = bd.motore.annulla(job: uuid(1))
    bd.attendi()
    _ = bd.motore.dimentica([uuid(1)])
    bd.accoda(1, token: tokenB, firma: "n")
    verificaTutto("(setup) annullata, dimenticata e rimandata: la voce nuova ha il suo task, e il rinnovo di prima è ancora senza risposta", [bd.stato(1), bd.trasporto.numeroCreati, bd.rinnovo.senzaRisposta], [KVStatoCaricamento.inInvio, 2, 1])
    bd.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "z"), scadeIl: orologioProva.addingTimeInterval(48 * 3600)))
    verificaTutto("la risposta tardiva non fa un secondo task alla voce nuova (un video non si carica due volte)", [bd.trasporto.numeroCreati, bd.trasporto.identificativiVivi.count], [2, 1])

    // E se la voce vecchia si è chiusa perché ne è arrivato il successo (un task del passato), il reinvio non aspetta il rinnovo che era in volo.
    let bs = BancoMotore()
    bs.accoda(1)
    bs.completa(bs.trasporto.id(0), putRifiutata(403, errore: nil))
    bs.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: 7, putRiuscita(), byteInviati: 1000)
    bs.attendi()
    verificaUguali("(setup) il successo del passato chiude la voce mentre il rinnovo è in volo", bs.stato(1), .inviato)
    bs.accoda(1, token: tokenB, firma: "n")
    verificaTutto("il reinvio parte subito, senza aspettare quel rinnovo: in-invio con un task nuovo", [bs.stato(1), bs.trasporto.numeroCreati], [KVStatoCaricamento.inInvio, 2])

    sezione("Motore — un'apertura RIPETUTA con la voce viva (token ruotato): `giaInCoda`, segreti e scadenze nuovi, niente task né righe in più")
    let b3 = BancoMotore()
    b3.accoda(1, token: tokenA, firma: "a")
    b3.trasporto.avanzamento(b3.trasporto.id(0), byte: 100)
    b3.attendi()
    var r = b3.richiesta(1, token: tokenB, firma: "b")
    r.scadenzaToken = iso(t0.addingTimeInterval(50 * 3600))
    r.scadenzaUrl = iso(t0.addingTimeInterval(7000))
    r.testi = KVTestiNotifiche(titolo: "Kidville", invio: "Sending", attesaRete: "Waiting for network", pausa: "Paused")
    let emessiPrima = b3.emessi.count
    let esito3 = b3.motore.accoda(r)
    b3.attendi()
    verificaUguali("l'apertura ripetuta avvisa il JS (una voce con le scadenze nuove)", b3.emessi.count, emessiPrima + 1)
    if case .giaInCoda(let v) = esito3 { verificaUguali("giaInCoda restituisce lo stato di adesso (in-invio)", v.stato, .inInvio) } else { verifica("giaInCoda", false, "\(esito3)") }
    verificaTutto("i segreti hanno il token e l'URL nuovi", [b3.segreti.segreti(uuid(1))?.token, b3.segreti.segreti(uuid(1))?.urlPut], [tokenB, urlPutProva(1, "b")])
    verificaTutto("la scadenza del token e quella dell'URL sono quelle nuove", [b3.voce(1)?.tokenScadeIl, b3.voce(1)?.urlScadeIl], [t0.addingTimeInterval(50 * 3600), t0.addingTimeInterval(7000)])
    verificaUguali("i testi delle notifiche sono quelli nuovi (inglese)", b3.coda.testi.attesaRete, "Waiting for network")
    verificaTutto("nessun task in più, una sola riga `accodato`, e la sorgente ripetuta si è tolta", [b3.trasporto.numeroCreati, b3.eventi("video-nativo-accodato").count, esiste(b3.scelto("e1")) ? 1 : 0], [1, 1, 0])
    verificaUguali("i byte spediti non si perdono (l'invio continua)", b3.motore.elenco(perUtente: uuid(utenteProva)).first?["byteInviati"] as? NSNumber, NSNumber(value: 100))

    sezione("Motore — un'apertura ripetuta con la voce in attesa e SENZA task (rinnovo fallito): riparte subito, con la firma NUOVA (niente rinnovo in più)")
    let b4 = BancoMotore()
    b4.accoda(1)
    b4.completa(b4.trasporto.id(0), putRifiutata(403, errore: nil))
    b4.rispondiRinnovo(rinnovoErroreServer)
    verificaTutto("(setup) in attesa come FIRMA_RIFIUTATA, senza task, un solo rinnovo (fallito)", [b4.stato(1), b4.voce(1)?.codice, b4.trasporto.numeroCreati, b4.rinnovo.numeroChiamate, b4.rinnovo.senzaRisposta],
                  ["inAttesa", "firmaRifiutata", 1, 1, 0])
    b4.accoda(1, token: tokenB, firma: "q")
    verificaTutto("accoda ripetuto: l'URL che arriva con l'apertura è nuovo, quindi la PUT riparte SUBITO su quello, senza un secondo rinnovo",
                  [b4.stato(1), b4.rinnovo.numeroChiamate, b4.trasporto.numeroCreati, b4.trasporto.richiesta(1).url.absoluteString], ["inInvio", 1, 2, urlPutProva(1, "q")])
    verificaUguali("… e i segreti hanno il token nuovo", b4.segreti.segreti(uuid(1))?.token, tokenB)
    // con la voce in attesa e l'URL vecchio (la nuova apertura non dà una scadenza): il rinnovo riparte, col token nuovo
    let b6 = BancoMotore()
    b6.accoda(1)
    b6.completa(b6.trasporto.id(0), putRifiutata(403, errore: nil))
    b6.rispondiRinnovo(rinnovoErroreServer)
    var senzaScadenza = b6.richiesta(1, token: tokenB, firma: "q")
    senzaScadenza.scadenzaUrl = nil
    _ = b6.motore.accoda(senzaScadenza)
    b6.attendi()
    verificaTutto("senza la scadenza dell'URL nuovo (non si sa quanto vale) si rinnova SUBITO, col token nuovo", [b6.rinnovo.numeroChiamate, b6.rinnovo.chiamate.last?.token, b6.trasporto.numeroCreati], [2, tokenB, 1])
    // con la voce viva e il task differito già nel sistema: nessun nuovo giro
    let b5 = BancoMotore()
    b5.accoda(1)
    b5.completa(b5.trasporto.id(0), putTransitoria(503))
    b5.accoda(1, token: tokenB, firma: "q")
    verificaTutto("con un task differito già nel sistema l'apertura ripetuta non ne crea un altro, e non tocca la sua attesa (partirà a t0+30)", [b5.trasporto.numeroCreati, b5.voce(1)?.prossimoTentativoIl],
                  [2, t0.addingTimeInterval(30)])
}

func provaMotoreRipristini() {
    sezione("Motore — se qualcosa non riesce DOPO un passo, si disfa il passo prima: nessuna voce senza copia, nessuna copia senza voce")
    // segreti che non si salvano: niente da disfare
    let b1 = BancoMotore()
    b1.segreti.fallisciSalva = true
    verificaUguali("segreti non salvabili: INTERNO", b1.motore.accoda(b1.richiesta(1)), .rifiutato(.interno))
    b1.attendi()
    verifica("… nessuna voce, nessun task, preparato intatto, nessuna copia", b1.coda.tutte().isEmpty && b1.trasporto.numeroCreati == 0 && esiste(b1.scelto("e1")) && !esiste(b1.copia(1)))
    // la coda non scrive: i segreti già salvati si tolgono
    let b2 = BancoMotore()
    bloccaLaScrittura(b2.coda.urlFileCoda)
    verificaUguali("coda che non scrive: INTERNO", b2.motore.accoda(b2.richiesta(1)), .rifiutato(.interno))
    b2.attendi()
    verifica("… i segreti salvati prima sono stati TOLTI (non restano credenziali senza una voce)", !b2.segreti.contiene(uuid(1)) && b2.segreti.cancellazioni.contains(uuid(1)))
    verifica("… il preparato è intatto in scelti/, nessuna copia in file/, nessuna voce, nessun task", esiste(b2.scelto("e1")) && !esiste(b2.copia(1)) && b2.coda.tutte().isEmpty && b2.trasporto.numeroCreati == 0)
    verificaUguali("… nessuna riga `accodato` (non è accodato niente)", b2.eventi("video-nativo-accodato").count, 0)
    sbloccaLaScrittura(b2.coda.urlFileCoda)
    verificaUguali("sbloccata la scrittura, lo stesso accoda riesce", { () -> Bool in if case .accodato = b2.accoda(1) { return true }; return false }(), true)

    if getuid() != 0 {
        // la copia non si sposta: la voce già scritta si toglie
        let b3 = BancoMotore()
        try! FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: b3.radice.appendingPathComponent("file").path)
        verificaUguali("copia che non si sposta (cartella file/ non scrivibile): INTERNO", b3.motore.accoda(b3.richiesta(1)), .rifiutato(.interno))
        b3.attendi()
        try! FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: b3.radice.appendingPathComponent("file").path)
        verificaUguali("… la voce già scritta è stata TOLTA (rimuoviVoce)", b3.coda.tutte().count, 0)
        verifica("… e anche dal DISCO: una nuova istanza non la trova", { () -> Bool in
            let nuova = KVCodaCaricamenti(cartella: b3.radice, orologio: { orologioProva })
            _ = nuova.carica()
            return nuova.tutte().isEmpty
        }())
        verifica("… i segreti sono tolti, il preparato è intatto, nessun task", !b3.segreti.contiene(uuid(1)) && esiste(b3.scelto("e1")) && b3.trasporto.numeroCreati == 0)
        verificaUguali("… e lo stesso accoda ora riesce", { () -> Bool in if case .accodato = b3.accoda(1) { return true }; return false }(), true)
    } else {
        print("  (prova della copia che non si sposta saltata: eseguita come root)")
    }

    sezione("Motore — un trasporto che non riesce a creare il task: la voce si chiude `fallito` INTERNO, con copia e segreti cancellati")
    let b4 = BancoMotore()
    b4.trasporto.rifiutaAvvio = true
    b4.accoda(1)
    verificaTutto("fallita INTERNO", [b4.stato(1), b4.voce(1)?.codice], [KVStatoCaricamento.fallito, KVCodiceCaricamento.interno])
    verifica("… copia e segreti cancellati", !esiste(b4.copia(1)) && !b4.segreti.contiene(uuid(1)))
    verificaTutto("… log fallito INTERNO sull'operazione put", [b4.eventi("video-nativo-fallito").first?.messaggio, campi(b4.eventi("video-nativo-fallito").first)["operazione"]],
                   [messaggio("video-nativo-fallito", job: 1, "INTERNO"), tes("put")])
}

func provaMotoreTerminaleSalvaPrima() {
    sezione("Motore — lo stato terminale si scrive PRIMA di cancellare copia e segreti; se la scrittura fallisce restano (la pulizia ripassa)")
    let banco = BancoMotore()
    banco.accoda(1)
    bloccaLaScrittura(banco.coda.urlFileCoda)
    banco.completa(banco.trasporto.id(0), putRiuscita())
    verificaUguali("PUT riuscita con la scrittura della coda fallita: la voce è inviata in memoria", banco.stato(1), .inviato)
    verifica("… ma la COPIA c'è ancora (se il processo muore ora la voce su disco è viva e il video non è «assente»)", esiste(banco.copia(1)))
    verifica("… e i SEGRETI ci sono ancora (servirebbero a un rinnovo alla riapertura)", banco.segreti.contiene(uuid(1)))
    verificaUguali("… il log `inviato` si scrive lo stesso (il registro è un altro file)", banco.eventi("video-nativo-inviato").count, 1)
    let b2 = BancoMotore()
    b2.accoda(1)
    bloccaLaScrittura(b2.coda.urlFileCoda)
    b2.completa(b2.trasporto.id(0), putRifiutata(413, errore: nil))
    verificaTutto("lo stesso per un fallimento (TROPPO_GRANDE): fallita in memoria", [b2.stato(1), b2.voce(1)?.codice], [KVStatoCaricamento.fallito, KVCodiceCaricamento.troppoGrande])
    verifica("… copia e segreti restano", esiste(b2.copia(1)) && b2.segreti.contiene(uuid(1)))
    let b3 = BancoMotore()
    b3.accoda(1)
    bloccaLaScrittura(b3.coda.urlFileCoda)
    _ = b3.motore.annulla(job: uuid(1))
    b3.attendi()
    verifica("e per un annullamento dal JS: annullata in memoria, ma copia e segreti restano", b3.stato(1) == .annullato && esiste(b3.copia(1)) && b3.segreti.contiene(uuid(1)))
    // scrittura sbloccata: il prossimo giro di pulizia le toglie
    sbloccaLaScrittura(b3.coda.urlFileCoda)
    verificaUguali("(a scrittura tornata la voce terminale si scrive col prossimo cambiamento, e poi i residui li prende la pulizia)", b3.stato(1), .annullato)

    sezione("Motore — la pulizia dell'avvio che chiude una voce a token scaduto ma NON riesce a scrivere: i segreti restano")
    let b4 = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        b.coda.carica()
        var v = voce(1, byte: 100, creatoIl: t0, tokenScadeIl: t0.addingTimeInterval(100), utente: utenteProva)
        v.urlScadeIl = t0.addingTimeInterval(7200)
        _ = b.coda.aggiungi(v)
        scrivi(b.radice.appendingPathComponent(v.file), byte: 100)
        _ = b.coda.applica(.trasferimentoAvviato, a: uuid(1))
        b.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        b.segreti.semina(uuid(8), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(8), contentType: "video/mp4", urlRinnovo: urlRinnovoProva))
        bloccaLaScrittura(b.coda.urlFileCoda)
        orologioProva = t0.addingTimeInterval(200)
    }
    b4.motore.avvia()
    b4.attendi()
    verificaTutto("la voce è chiusa TOKEN_SCADUTO in memoria", [b4.stato(1), b4.voce(1)?.codice], [KVStatoCaricamento.fallito, KVCodiceCaricamento.tokenScaduto])
    verifica("… i segreti NON si toccano (lo stato non è su disco), e nemmeno quelli «senza voce» (la pulizia non ha potuto guardare)", b4.segreti.contiene(uuid(1)) && b4.segreti.contiene(uuid(8)))
    verifica("… e la copia c'è ancora", esiste(b4.copia(1)))
}

// MARK: - Il registro

func provaMotoreRegistro() {
    sezione("Motore — il registro: destinazione di produzione fin dall'avvio (Release), svuotamento all'avvio e al rientro, un lotto ogni 10 secondi")
    let rel = BancoMotore(avvia: false, inPrimoPiano: false) { b in
        b.registro.registraNotificaNonAutorizzata() // un log nato prima di ogni accodaVideo: l'installazione nuova non ha ancora una destinazione
    }
    verificaUguali("(setup) prima dell'avvio nessuna destinazione", rel.registro.stato().destinazione, nil)
    rel.motore.avvia()
    rel.attendi()
    verificaUguali("avvia() in Release imposta la destinazione di produzione", rel.registro.stato().destinazione?.absoluteString, urlRegistroProva)
    verificaTutto("… e svuota subito il registro: il log nato prima parte (senza identità: nessun utente noto)", [rel.trasportoLog.richieste.count, rel.trasportoLog.richieste.first?.url.absoluteString, rel.trasportoLog.richieste.first?.utenteId],
                   [1, urlRegistroProva, nil])
    rel.motore.riprendiInPrimoPiano()
    rel.attendi()
    verificaUguali("al rientro in primo piano prova a svuotare ma è troppo presto (10 s dall'ultimo invio): nessuna richiesta in più", rel.trasportoLog.richieste.count, 1)
    verificaUguali("… e lo riprogramma", rel.pianificatore.pendenti >= 1, true)
    rel.avanza(10.2)
    verificaUguali("passati i 10 secondi lo svuotamento riprogrammato parte", rel.trasportoLog.richieste.count, 2)

    let dbg = BancoMotore(ambiente: .debug, avvia: false, inPrimoPiano: false) { b in b.registro.registraNotificaNonAutorizzata() }
    dbg.motore.avvia()
    dbg.attendi()
    verificaTutto("in Debug la destinazione NON è quella di produzione: nessuna richiesta, nessuna destinazione", [dbg.trasportoLog.richieste.count, dbg.registro.stato().destinazione == nil ? 1 : 0], [0, 1])

    sezione("Motore — il registro dei log non si riempie di un video senza intoppi: al più 4 righe (§8.1)")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.completa(banco.trasporto.id(0), putRiuscita())
    verifica("accodato + inviato: \(banco.messaggi.count) righe", banco.messaggi.count <= 4)
    verificaUguali("un lotto verso il sito (una sola richiesta: i due eventi sono dello stesso utente)", banco.trasportoLog.richieste.count, 1)
    verificaTutto("… col corpo {eventi, piattaforma} e due eventi", [banco.trasportoLog.eventi(0).count, banco.trasportoLog.corpo(0)["piattaforma"] as? String], [2, "ios"])
    verificaUguali("… ogni evento col nome `caricamento-nativo`", Set(banco.trasportoLog.eventi(0).compactMap { $0["evento"] as? String }), ["caricamento-nativo"])
    let tuttoIlTesto = banco.registro.stato().eventi.flatMap { e in [e.messaggio] + e.campi.values.compactMap { v -> String? in if case .testo(let t) = v { return t }; return nil } }
    verifica("nessun nome del file, URL, token, host dello Storage nei log di questa corsa", tuttoIlTesto.allSatisfy { !$0.contains("Gita") && !$0.contains("supabase") && !$0.contains("kvr_") && !$0.contains("://") && !$0.contains(".mov") })
    verifica("… né le chiavi di `campi` fuori elenco", banco.registro.stato().eventi.allSatisfy { Set($0.campi.keys).isSubset(of: Set(KVChiaveCampo.allCases.map { $0.rawValue })) })
}

// MARK: - Verso il JavaScript

func provaMotoreVersoIlJS() {
    sezione("Motore — all'ascoltatore (il JS) arriva ogni cambiamento di stato, e l'avanzamento a un ritmo ragionevole (≤ 1 ogni 0,5 s, o 1%)")
    let banco = BancoMotore()
    banco.accoda(1, byte: 1000)
    let idTask = banco.trasporto.id(0)
    banco.azzeraEmessi()
    func avanza(_ secondi: TimeInterval, _ byte: Int64) {
        orologioProva = t0.addingTimeInterval(secondi)
        banco.trasporto.avanzamento(idTask, byte: byte)
        banco.attendi()
    }
    avanza(1.0, 20)
    avanza(1.2, 40)
    avanza(1.6, 45)
    avanza(2.2, 47)
    avanza(5.0, 48)
    verificaUguali("cinque avanzamenti: ne passano tre (il primo, quello dopo mezzo secondo e +1%, quello dopo 3 s)", banco.emessi.map { $0.byteInviati }, [20, 45, 48])
    verificaUguali("… tutti con la voce in-invio", Set(banco.emessi.map { $0.voce.stato }), [.inInvio])
    verifica("… e la voce non cambia su disco per un avanzamento (nessuna scrittura per byte)", { () -> Bool in
        let ril = KVCodaCaricamenti(cartella: banco.radice, orologio: { orologioProva })
        _ = ril.carica()
        return ril.voce(uuid(1))?.stato == .inInvio
    }())

    sezione("Motore — i primi byte di un task differito (la voce passa a in-invio) sono già un avanzamento: il ritmo parte da lì e il prossimo aspetta mezzo secondo")
    let bd = BancoMotore()
    bd.accoda(1, byte: 1000)
    bd.completa(bd.trasporto.id(0), putTransitoria(503))
    let differito = bd.trasporto.ultimoId
    bd.azzeraEmessi()
    orologioProva = t0.addingTimeInterval(40)
    bd.trasporto.avanzamento(differito, byte: 20)
    bd.attendi()
    orologioProva = t0.addingTimeInterval(40.2)
    bd.trasporto.avanzamento(differito, byte: 600)
    bd.attendi()
    verificaUguali("i primi byte passano (con la voce in-invio); 0,2 s dopo un salto del 58% NON passa un altro avanzamento", bd.emessi.map { "\($0.voce.stato) \($0.byteInviati)" }, ["inInvio 20"])

    sezione("Motore — `elenco`: le voci di quell'utente, per data, nella forma del ponte, coi byte spediti; un altro utente non vede le altre")
    let b2 = BancoMotore()
    b2.accoda(1, byte: 1000)
    orologioProva = t0.addingTimeInterval(10)
    b2.accoda(2, byte: 2000)
    var altro = b2.richiesta(3, byte: 500)
    altro.utenteId = uuid(9)
    _ = b2.motore.accoda(altro)
    b2.attendi()
    b2.trasporto.avanzamento(b2.trasporto.id(0), byte: 300)
    b2.attendi()
    let elenco = b2.motore.elenco(perUtente: uuid(utenteProva))
    verificaUguali("due voci per l'utente 7, per data di creazione", elenco.map { $0["jobId"] as? String }, [uuid(1).uuidString.lowercased(), uuid(2).uuidString.lowercased()])
    verificaUguali("… coi quattordici campi del ponte", Set(elenco.first?.keys.map { $0 } ?? []), Set(["jobId", "intentId", "utenteId", "scuolaId", "nome", "mime", "stato", "byteInviati", "byteTotali", "tentativi", "rinnovi", "codice", "creatoIl", "aggiornatoIl"]))
    verificaUguali("… i byte spediti della prima sono quelli dell'ultimo avanzamento", elenco.first?["byteInviati"] as? NSNumber, NSNumber(value: 300))
    verificaUguali("… e la seconda non ne ha ancora", elenco.last?["byteInviati"] as? NSNumber, NSNumber(value: 0))
    verificaUguali("l'altro utente vede solo la sua", b2.motore.elenco(perUtente: uuid(9)).map { $0["jobId"] as? String }, [uuid(3).uuidString.lowercased()])
    verificaUguali("un utente senza voci: elenco vuoto", b2.motore.elenco(perUtente: uuid(55)).count, 0)

    sezione("Motore — `dimentica`: toglie solo le terminali indicate, e il motore non conserva più niente di quei job")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.accoda(2)
    b3.completa(b3.trasporto.id(0), putRiuscita())
    verificaUguali("dimentica: la terminale (1) sì, la viva (2) no, quella che non c'è (9) neanche", b3.motore.dimentica([uuid(1), uuid(2), uuid(9)]), 1)
    verificaUguali("… resta la viva", b3.coda.tutte().map { $0.jobId }, [uuid(2)])
}

// MARK: - Segreti che non si leggono

func provaMotoreSegretiNonDisponibili() {
    sezione("Motore — il Portachiavi non risponde (telefono riavviato e non ancora sbloccato): la voce aspetta, NON si chiude")
    let banco = BancoMotore()
    banco.segreti.leggiNonDisponibile = true
    banco.accoda(1)
    verificaTutto("niente task, e la voce aspetta come in-attesa(INTERNO) 60 secondi", [banco.trasporto.numeroCreati, banco.stato(1), banco.voce(1)?.codice, banco.voce(1)?.prossimoTentativoIl],
                   [0, KVStatoCaricamento.inAttesa, KVCodiceCaricamento.interno, t0.addingTimeInterval(60)])
    banco.avanza(60)
    verificaTutto("a 60 secondi ancora non disponibile: aspetta ancora, nessun fallimento", [banco.stato(1), banco.trasporto.numeroCreati], [KVStatoCaricamento.inAttesa, 0])
    banco.segreti.leggiNonDisponibile = false
    banco.avanza(60)
    verificaTutto("sbloccato: il task parte", [banco.trasporto.numeroCreati, banco.stato(1)], [1, KVStatoCaricamento.inInvio])
    verificaUguali("… e nessun log di fallimento (non è un ritento: nessuna PUT è fallita)", banco.messaggi, [messaggio("video-nativo-accodato", job: 1)])

    sezione("Motore — i segreti spariti (e non «non disponibili»): la voce si chiude `fallito` INTERNO, con la copia cancellata")
    let b2 = BancoMotore()
    b2.accoda(1)
    b2.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    _ = b2.segreti.elimina(uuid(1))
    b2.completa(b2.trasporto.id(0), putTransitoria(503))
    verificaTutto("al giro dopo i segreti non ci sono più: fallita INTERNO", [b2.stato(1), b2.voce(1)?.codice], [KVStatoCaricamento.fallito, KVCodiceCaricamento.interno])
    verifica("… copia cancellata", !esiste(b2.copia(1)))

    sezione("Motore — il nome d'errore di una PUT rifiutata è del rinnovo che ne è la CONSEGUENZA: se la causa si perde (Portachiavi non disponibile) il rinnovo dopo non lo porta")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.segreti.leggiNonDisponibile = true
    b3.completa(b3.trasporto.id(0), putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 4000))
    verificaTutto("la PUT è rifiutata e il Portachiavi non risponde: la voce aspetta come INTERNO (il codice che portava la causa si perde), senza rinnovo",
                  [b3.stato(1), b3.voce(1)?.codice, b3.rinnovo.numeroChiamate], [KVStatoCaricamento.inAttesa, KVCodiceCaricamento.interno, 0])
    b3.segreti.leggiNonDisponibile = false
    b3.avanza(60)
    verificaUguali("sbloccato: il giro dopo rinnova (l'URL rifiutato era stato azzerato)", b3.rinnovo.numeroChiamate, 1)
    b3.rispondiRinnovo(rinnovoDaCaricare(url: urlPutProva(1, "b"), scadeIl: t0.addingTimeInterval(48 * 3600)))
    let rinnovoLog = b3.eventi("video-nativo-rinnovo").first
    verificaTutto("il rinnovo riesce e si logga `da-caricare`, ma SENZA il nome d'errore della PUT di prima: non ne è più la conseguenza dichiarata",
                  [rinnovoLog?.messaggio, campi(rinnovoLog)["error_code"] == nil], [messaggio("video-nativo-rinnovo", job: 1, "da-caricare"), true])
}

// MARK: - Task di altri giri

func provaMotoreTaskDiAltriGiri() {
    sezione("Motore — il completamento di un task che non è quello corrente: conta solo se è un successo; un fallimento si ignora")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.motore.notificaSeFermo()
    banco.attendi()
    banco.completa(banco.trasporto.id(0), putSenzaRete())
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    let corrente = banco.trasporto.ultimoId
    verificaTutto("(setup) il task corrente è il terzo", [banco.trasporto.numeroCreati, banco.stato(1)], [3, KVStatoCaricamento.inInvio])
    banco.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: 7, putTransitoria(503), byteInviati: 0)
    banco.attendi()
    verificaTutto("un fallimento di un task vecchio non tocca la voce, che continua col task corrente", [banco.stato(1), banco.trasporto.ultimoId, banco.eventi("video-nativo-ritento").count], [KVStatoCaricamento.inInvio, corrente, 1])
    banco.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: 7, putRiuscita(), byteInviati: 1000)
    banco.attendi()
    verificaUguali("un successo di un task vecchio vale: la voce è inviata", banco.stato(1), .inviato)
    verificaUguali("… e il task corrente (ormai inutile) è stato fermato", banco.trasporto.annullati.contains(corrente), true)
    verifica("… copia e segreti cancellati", !esiste(banco.copia(1)) && !banco.segreti.contiene(uuid(1)))
    banco.completa(corrente, KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)))
    verificaUguali("il completamento (cancellato) del task fermato non cambia niente", banco.stato(1), .inviato)

    sezione("Motore — il task fermato per ricrearlo in primo piano: se la ricreazione aspetta un rinnovo, il suo completamento (cancellato) non fa ripartire un transitorio")
    let b3 = BancoMotore()
    b3.accoda(1)
    b3.motore.notificaSeFermo()
    b3.attendi()
    b3.completa(b3.trasporto.id(0), putSenzaRete())
    let delBackground = b3.trasporto.id(1)
    orologioProva = t0.addingTimeInterval(700) // all'apertura l'URL è vecchio: la ricreazione deve passare dal rinnovo
    b3.motore.riprendiInPrimoPiano()
    b3.attendi()
    verificaTutto("(setup) il task di background è fermato e la ricreazione aspetta il rinnovo", [b3.trasporto.annullati.contains(delBackground), b3.rinnovo.senzaRisposta, b3.trasporto.numeroCreati, b3.stato(1)], [true, 1, 2, "inInvio"])
    let ritentiPrima = b3.eventi("video-nativo-ritento").count
    b3.completa(delBackground, KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)))
    verificaTutto("il completamento (cancellato) del task fermato NON è un transitorio: nessun ritento, la voce resta com'era e il rinnovo in volo non si tocca",
                  [b3.eventi("video-nativo-ritento").count, b3.stato(1), b3.rinnovo.senzaRisposta], [ritentiPrima, "inInvio", 1])

    sezione("Motore — il completamento di un task di cui il motore non sa niente (rilancio in background): si applica alla voce")
    let b2 = BancoMotore()
    b2.accoda(1)
    let id = b2.trasporto.id(0)
    // «Il processo è morto»: un nuovo motore sulla stessa cartella. Il sistema gli consegna l'esito alla creazione della sessione.
    let nuovo = BancoMotore(inPrimoPiano: false, cartella: b2.radice, prepara: { b in
        b.segreti.semina(uuid(1), b2.segreti.segreti(uuid(1))!)
        b.trasporto.primaDiRispondere = { [unowned b] in
            b.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: id, putRiuscita(durata: 12), byteInviati: 1000)
        }
    })
    verificaUguali("il nuovo processo applica l'esito di un task che non ha creato: inviato", nuovo.stato(1), .inviato)
    verificaTutto("… con UN log, la durata dalla sessione (12 s) e `in_background` (l'app non era in primo piano)",
                  [nuovo.eventi("video-nativo-inviato").count, campi(nuovo.eventi("video-nativo-inviato").first)["ms"], campi(nuovo.eventi("video-nativo-inviato").first)["in_background"]],
                  [1, num(12000), boo(true)])
    verificaTutto("… e senza un task nuovo (il video è arrivato)", [nuovo.trasporto.numeroCreati, esiste(nuovo.copia(1)) ? 1 : 0, nuovo.segreti.contiene(uuid(1)) ? 1 : 0], [0, 0, 0])

    sezione("Motore — l'avanzamento di un task che non è quello corrente, o che il motore ha già fermato, non cambia i byte della voce")
    let b4 = BancoMotore()
    b4.accoda(1)
    func byteSpediti(_ banco: BancoMotore) -> NSNumber? {
        return banco.motore.elenco(perUtente: uuid(utenteProva)).first?["byteInviati"] as? NSNumber
    }
    let corrente4 = b4.trasporto.id(0)
    b4.trasporto.avanzamento(corrente4, byte: 300)
    b4.attendi()
    verificaUguali("(setup) l'avanzamento del task corrente si registra: 300 byte", byteSpediti(b4), NSNumber(value: 300))
    b4.motore.trasporto(avanzamentoDi: uuid(1), task: 999, byteInviati: 900)
    b4.attendi()
    verificaUguali("l'avanzamento di un task che NON è il corrente (un giro vecchio, un'altra vita) non cambia i byte: restano 300", byteSpediti(b4), NSNumber(value: 300))
    b4.trasporto.avanzamento(corrente4, byte: 400)
    b4.attendi()
    verificaUguali("… e quello del task corrente continua a contare: 400", byteSpediti(b4), NSNumber(value: 400))
    b4.motore.annulla(job: uuid(1))
    b4.attendi()
    b4.motore.trasporto(avanzamentoDi: uuid(1), task: corrente4, byteInviati: 800)
    b4.attendi()
    verificaUguali("l'avanzamento tardivo di un task che il motore ha FERMATO (annullamento) non cambia i byte della voce: restano 400", byteSpediti(b4), NSNumber(value: 400))

    sezione("Motore — un successo arrivato dal passato chiude la voce che aspettava, e il suo timer di risveglio con lei")
    let b5 = BancoMotore()
    b5.accoda(1)
    b5.completa(b5.trasporto.id(0), putRifiutata(403, errore: nil))
    b5.rispondiRinnovo(rinnovoErroreServer)
    verificaTutto("(setup) la voce aspetta il rinnovo che è fallito, senza task, col suo timer di risveglio", [b5.stato(1), b5.trasporto.numeroCreati, b5.pianificatore.pendenti], [KVStatoCaricamento.inAttesa, 1, 1])
    b5.trasporto.completaDiUnaVitaPrecedente(job: uuid(1), task: 7, putRiuscita(), byteInviati: 1000)
    b5.attendi()
    verificaTutto("il successo di un task vecchio: la voce è inviata, e non resta nessun timer che la risvegli", [b5.stato(1), b5.pianificatore.pendenti], [KVStatoCaricamento.inviato, 0])
}

// MARK: - La pulizia che chiude una voce con un task vivo

func provaMotorePulizieConUnTaskVivo() {
    sezione("Motore — la pulizia dell'avvio chiude una voce scaduta che ha ancora un task vivo: lo ferma, avvisa il JS, e un reinvio dello stesso job riparte")
    let banco = BancoMotore(avvia: true, inPrimoPiano: false) { b in
        b.coda.carica()
        orologioProva = t0.addingTimeInterval(200)
        var scaduta = voce(1, byte: 1000, creatoIl: t0, tokenScadeIl: t0.addingTimeInterval(100), utente: utenteProva)
        scaduta.urlScadeIl = t0.addingTimeInterval(7200)
        _ = b.coda.aggiungi(scaduta)
        scrivi(b.radice.appendingPathComponent(scaduta.file), byte: 1000)
        _ = b.coda.applica(.trasferimentoAvviato, a: uuid(1))
        b.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        b.trasporto.extraVivi = [KVTaskVivo(job: uuid(1), identificativo: 55, byteInviati: 300)]
        // Una voce ancora IN CODA (il processo è morto fra la creazione del task e il passo di stato) con il suo task: l'avvio la adotta e la porta in invio.
        var incoda = voce(2, byte: 500, creatoIl: t0, utente: utenteProva)
        incoda.urlScadeIl = t0.addingTimeInterval(7200)
        _ = b.coda.aggiungi(incoda)
        scrivi(b.radice.appendingPathComponent(incoda.file), byte: 500)
        b.segreti.semina(uuid(2), KVSegretiVoce(token: tokenB, urlPut: urlPutProva(2), contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
        b.trasporto.extraVivi.append(KVTaskVivo(job: uuid(2), identificativo: 56, byteInviati: 10))
    }
    verificaTutto("la voce scaduta (1) è chiusa dalla pulizia: fallita TOKEN_SCADUTO, copia e segreti cancellati", [banco.stato(1), banco.voce(1)?.codice, esiste(banco.copia(1)) ? 1 : 0, banco.segreti.contiene(uuid(1)) ? 1 : 0],
                  [KVStatoCaricamento.fallito, KVCodiceCaricamento.tokenScaduto, 0, 0])
    verificaUguali("… il task che il sistema aveva ancora per lei (55) è stato fermato, e quello della voce viva (56) no", banco.trasporto.annullati, [55])
    verificaTutto("… il JS ne è avvisato: l'ultimo avviso per la 1 è `fallito`", [banco.emessi.last(where: { $0.voce.jobId == uuid(1) })?.voce.stato], [KVStatoCaricamento.fallito])
    verificaTutto("la voce ancora in coda (2) con un task vivo è stata adottata: ora è in-invio, coi 10 byte del task, senza un task nuovo", [banco.stato(2), banco.motore.elenco(perUtente: uuid(utenteProva)).first(where: { ($0["jobId"] as? String) == uuid(2).uuidString.lowercased() })?["byteInviati"] as? NSNumber, banco.trasporto.numeroCreati],
                  [KVStatoCaricamento.inInvio, NSNumber(value: 10), 0])
    verificaTutto("… e il JS ne è avvisato: l'ultimo avviso per la 2 è in-invio", [banco.emessi.last(where: { $0.voce.jobId == uuid(2) })?.voce.stato], [KVStatoCaricamento.inInvio])
    let esito = banco.accoda(1, byte: 1000, token: tokenB, firma: "n")
    verificaUguali("un reinvio dello stesso job (token nuovo): accodato", { () -> Bool in if case .accodato = esito { return true }; return false }(), true)
    verificaTutto("… e parte davvero: UN task nuovo, in-invio (la voce vecchia non ha lasciato in memoria un task che lo blocchi)", [banco.trasporto.numeroCreati, banco.stato(1)], [1, KVStatoCaricamento.inInvio])
}

// MARK: - La riconciliazione al rientro in primo piano

func provaMotoreRiconciliazioneInPrimoPiano() {
    sezione("Motore — un task che il sistema non elenca più, e di cui non è arrivato nessun esito: al rientro in primo piano la voce riparte invece di restare appesa")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.trasporto.perdi(banco.trasporto.id(0))
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    verificaTutto("la voce non aspetta più un task che non c'è: se ne crea uno nuovo (due in tutto), e la voce è in-invio", [banco.trasporto.numeroCreati, banco.stato(1)], [2, KVStatoCaricamento.inInvio])

    sezione("Motore — il rientro in primo piano con un rinnovo già in volo non ne avvia un secondo")
    let bf = BancoMotore()
    bf.accoda(1)
    bf.completa(bf.trasporto.id(0), putRifiutata(403, errore: nil))
    verificaUguali("(setup) il rinnovo è in volo e non ha risposto", bf.rinnovo.senzaRisposta, 1)
    bf.motore.riprendiInPrimoPiano()
    bf.attendi()
    verificaTutto("al rientro in primo piano il rinnovo è ancora UNO, e nessun task nuovo (aspetta la sua risposta)", [bf.rinnovo.numeroChiamate, bf.trasporto.numeroCreati], [1, 1])

    sezione("Motore — i byte spediti non tornano indietro per uno snapshot del sistema più vecchio di ciò che il motore sa")
    let b2 = BancoMotore()
    b2.accoda(1)
    let id = b2.trasporto.id(0)
    b2.trasporto.avanzamento(id, byte: 500)
    b2.attendi()
    b2.trasporto.impostaByteSpediti(id, 300)
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verificaUguali("il motore sapeva di 500 byte, `getAllTasks` ne dice 300: restano 500", b2.motore.elenco(perUtente: uuid(utenteProva)).first?["byteInviati"] as? NSNumber, NSNumber(value: 500))
    b2.trasporto.impostaByteSpediti(id, 800)
    b2.motore.riprendiInPrimoPiano()
    b2.attendi()
    verificaUguali("… e se il sistema ne dice di più (800) si prendono quelli", b2.motore.elenco(perUtente: uuid(utenteProva)).first?["byteInviati"] as? NSNumber, NSNumber(value: 800))
}

// MARK: - Gli indirizzi dentro i segreti

func provaMotoreIndirizziNeiSegreti() {
    sezione("Motore — un indirizzo che non passa più la politica degli host, trovato nel Portachiavi: la voce si chiude INTERNO, senza spedire né rinnovare verso un posto sconosciuto")
    let banco = BancoMotore()
    banco.accoda(1)
    banco.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: urlPutProva(1), contentType: "video/quicktime", urlRinnovo: "https://evil.example.com/api/video-uploads/rinnovo"))
    banco.completa(banco.trasporto.id(0), putRifiutata(403, errore: nil))
    verificaTutto("PUT rifiutata, e l'indirizzo del rinnovo nei segreti è di un altro sito: fallita INTERNO, nessuna chiamata di rinnovo", [banco.stato(1), banco.voce(1)?.codice, banco.rinnovo.numeroChiamate],
                  [KVStatoCaricamento.fallito, KVCodiceCaricamento.interno, 0])
    verificaUguali("… copia e segreti cancellati", [esiste(banco.copia(1)), banco.segreti.contiene(uuid(1))], [false, false])

    let b2 = BancoMotore()
    b2.accoda(1)
    b2.segreti.semina(uuid(1), KVSegretiVoce(token: tokenA, urlPut: "http://evil.example.com/storage/x", contentType: "video/quicktime", urlRinnovo: urlRinnovoProva))
    b2.completa(b2.trasporto.id(0), putTransitoria(503))
    verificaTutto("503, e l'URL della PUT nei segreti è di un altro sito (e in chiaro): fallita INTERNO, nessun task nuovo", [b2.stato(1), b2.voce(1)?.codice, b2.trasporto.numeroCreati],
                  [KVStatoCaricamento.fallito, KVCodiceCaricamento.interno, 1])
    verificaUguali("… copia e segreti cancellati", [esiste(b2.copia(1)), b2.segreti.contiene(uuid(1))], [false, false])

    let b3 = BancoMotore()
    b3.trasporto.rifiutaAvvio = true
    b3.accoda(1)
    verificaTutto("il sistema non accetta di creare il task: la voce si chiude INTERNO, con copia e segreti cancellati", [b3.stato(1), b3.voce(1)?.codice, esiste(b3.copia(1)), b3.segreti.contiene(uuid(1))],
                  [KVStatoCaricamento.fallito, KVCodiceCaricamento.interno, false, false])
}

// MARK: - Sequenze casuali di eventi
//
// Gli scenari sopra sono copioni: ognuno prova una cosa che qualcuno ha pensato. Qui si fa il contrario: si butta sul motore una sequenza CASUALE di ciò
// che può succedere in una giornata vera — video che arrivano e si ripetono, task che finiscono in tutti i modi, rinnovi che rispondono in tutti i modi,
// il tempo che passa (anche oltre le 48 ore del token), la rete che va e viene, l'app che va in background e torna, l'insegnante che annulla, il
// sistema che risveglia l'app per gli eventi della sessione, il processo che muore e riparte (aperto dall'utente o rilanciato in background) — e dopo
// OGNI passo si guarda che le cose che non possono mai non valere (`controllaLeInvarianti`) valgano. Il seme è fisso: la stessa sequenza a ogni giro, e un
// seme che fallisce si riprova da solo (la traccia degli ultimi eventi sta nel messaggio). Fra i difetti che ha trovato: una voce portata a `in-invio`
// dalla riconciliazione senza che il JS lo sapesse.

/// Un generatore di numeri a seme fisso (SplitMix64): la stessa sequenza a ogni giro, e un seme che fallisce si riprova da solo.
private struct GeneratoreASeme: RandomNumberGenerator {
    var stato: UInt64
    /// Il seme si moltiplica per una costante DIVERSA dall'incremento: con la stessa, il seme `s + 1` darebbe la sequenza di `s` spostata di un passo.
    init(seme: UInt64) { stato = seme &* 0xD1B5_4A32_D192_ED03 &+ 0x2545_F491_4F6C_DD1D }
    mutating func next() -> UInt64 {
        stato &+= 0x9E37_79B9_7F4A_7C15
        var z = stato
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Quante volte il sistema ha avuto il «completamento» di ciascun `ricollega` (deve essere UNA, mai di più).
private final class RichiamiDellaSessione {
    var conteggi: [Int] = []
    func nuovo() -> Int { conteggi.append(0); return conteggi.count - 1 }
    func scattato(_ i: Int) { conteggi[i] += 1 }
}

/// Il token del job `n` (1…4): una lettera sola ripetuta, per risalire dal token al job; `ruotato` ne dà un altro dello stesso job.
private func tokenDelJob(_ n: Int, ruotato: Bool = false) -> String {
    let lettera = Character(UnicodeScalar(UInt8((ruotato ? 102 : 97) + n - 1)))
    return "kvr_" + String(repeating: lettera, count: 24)
}

private func jobDelToken(_ token: String) -> Int {
    guard let codice = token.dropFirst(4).unicodeScalars.first?.value else { return 0 }
    return Int(codice >= 102 ? codice - 102 : codice - 97) + 1
}

/// Sopra questo numero di eventi nel giornale dei log (tetto 200) si sono forse già scartati i più vecchi, e il conto delle righe non si fa.
private let eventiDelGiornalePerIlConto = 180

/// Le cose che devono valere dopo OGNI passo, qualunque cosa sia successa prima. Restituisce la prima che non vale.
///
/// Per ogni job: terminale ⇒ né copia, né segreti, né task, né rinnovo in volo; viva ⇒ copia e segreti, al più un task e un rinnovo in volo, e un modo di
/// andare avanti (un task, un rinnovo, un timer, o l'attesa della rete/della riapertura). In tutto: un segreto e una copia per ogni voce viva, e nel
/// giornale dei log una chiusura per ogni `accodato`. Al JS è arrivato l'ultimo stato.
///
/// - `appessePermesse`: dopo un rilancio in background il motore NON crea task finché l'app non torna in primo piano (§5.3), quindi una voce senza
///   task né rinnovo è lecita fino ad allora.
/// - `rinnoviObsoleti`: le chiamate di rinnovo (per indice) che erano in volo quando la loro voce si è chiusa: la loro risposta, se mai arriva, il motore la
///   butta, e non contano come «rinnovo in volo» di una voce rimandata dopo.
/// - `noto`: com'erano le voci quando il JS si è agganciato (dopo un riavvio legge l'`elenco`): da lì in poi ogni cambiamento deve essergli arrivato.
private func controllaLeInvarianti(_ banco: BancoMotore, job: [Int], inPrimoPiano: Bool, appessePermesse: Bool = false,
                                   noto: [Int: String] = [:], rinnoviObsoleti: Set<Int> = []) -> String? {
    let vivi = banco.trasporto.vivi
    let rinnoviInVolo = banco.rinnovo.inAttesaDiRisposta
    // Un segreto e una copia per ogni voce VIVA, e niente di più: nessuna credenziale né video che nessuna voce reclami.
    let vive = job.filter { !(banco.voce($0)?.stato.eTerminale ?? true) }.count
    if banco.segreti.numero != vive { return "ci sono \(banco.segreti.numero) segreti nel Portachiavi e \(vive) voci vive" }
    let copieInGiro = nomiIn(banco.radice.appendingPathComponent("file")).filter { !$0.hasPrefix(".") }.count
    if copieInGiro != vive { return "ci sono \(copieInGiro) copie di video in file/ e \(vive) voci vive" }
    // Il giornale dei log: ogni video preso in carico (`accodato`) si chiude UNA volta (inviato, fallito o annullato). Se il giornale ha già scartato
    // eventi (tetto di 200) il conto non si può fare.
    let statoRegistro = banco.registro.stato()
    let giornaleIntero = statoRegistro.scartati == 0 && statoRegistro.eventi.count < eventiDelGiornalePerIlConto
    for n in job where giornaleIntero {
        let id = uuid(n).uuidString.lowercased()
        func quanti(_ slug: String) -> Int { statoRegistro.eventi.filter { $0.messaggio.hasPrefix("\(slug): job=\(id)") }.count }
        let presi = quanti("video-nativo-accodato")
        let chiusi = quanti("video-nativo-inviato") + quanti("video-nativo-fallito") + quanti("video-nativo-annullato")
        let attesi = (banco.voce(n).map { $0.stato.eTerminale ? 0 : 1 } ?? 0) + chiusi
        if presi != attesi { return "job \(n): \(presi) righe `accodato` e \(chiusi) di chiusura, con la voce \(banco.voce(n).map { "\($0.stato)" } ?? "assente"): il giornale non torna" }
    }
    for n in job {
        guard let v = banco.voce(n) else { continue }
        let copia = esiste(banco.copia(n))
        let segreti = banco.segreti.contiene(uuid(n))
        let task = vivi.filter { $0.value.job == uuid(n) }.count + banco.trasporto.extraVivi.filter { $0.job == uuid(n) }.count
        let rinnovo = rinnoviInVolo.filter { jobDelToken($0.token) == n && !rinnoviObsoleti.contains($0.indice) }.count
        if v.stato.eTerminale {
            if copia { return "job \(n) terminale (\(v.stato)) ma la copia del video c'è ancora" }
            if segreti { return "job \(n) terminale (\(v.stato)) ma i segreti sono ancora nel Portachiavi" }
            if task > 0 { return "job \(n) terminale (\(v.stato)) ma ha ancora \(task) task vivi" }
            if rinnovo > 0 && v.stato != .annullato && v.stato != .fallito && v.stato != .inviato { return "job \(n): rinnovo in volo su una voce terminale" }
        } else {
            if !copia { return "job \(n) viva (\(v.stato)) ma la copia del video non c'è" }
            if !segreti { return "job \(n) viva (\(v.stato)) ma i segreti non ci sono" }
            if task > 1 { return "job \(n) ha \(task) task vivi insieme" }
            if rinnovo > 1 { return "job \(n) ha \(rinnovo) rinnovi in volo insieme" }
            if v.stato == .inInvio && task == 0 && rinnovo == 0 && !appessePermesse { return "job \(n) è in-invio ma non ha né un task né un rinnovo in volo: è appesa" }
            if v.stato == .inCoda && task == 0 && rinnovo == 0 && !appessePermesse { return "job \(n) è rimasta in-coda senza un task né un rinnovo in volo" }
            if v.stato == .inAttesa && task == 0 && rinnovo == 0 && banco.pianificatore.pendenti == 0 && v.codice != .rete && !appessePermesse
                && !(v.codice == .chiusuraForzata && !inPrimoPiano) {
                return "job \(n) aspetta (\(String(describing: v.codice))) ma non ha un task, né un rinnovo in volo, né un timer che la risvegli: è appesa"
            }
        }
        if let ultimo = banco.emessi.last(where: { $0.voce.jobId == uuid(n) }) {
            if ultimo.voce.stato != v.stato || ultimo.voce.codice != v.codice {
                return "job \(n): al JS risulta \(ultimo.voce.stato)/\(String(describing: ultimo.voce.codice)) e invece è \(v.stato)/\(String(describing: v.codice))"
            }
        } else if let visto = noto[n] {
            if visto != "\(v.stato) \(String(describing: v.codice))" { return "job \(n): al JS risultava \(visto) e invece è \(v.stato)/\(String(describing: v.codice))" }
        } else {
            return "job \(n): esiste ma al JS non è mai arrivato niente"
        }
    }
    return nil
}

/// Una sequenza: `passi` eventi scelti a caso (e gli stessi per lo stesso seme), con le invarianti controllate dopo ognuno; poi si porta tutto a
/// regime — rete, primo piano, rinnovi che riescono, task che finiscono, timer che scattano — e ogni voce deve essere arrivata in fondo.
private func eseguiUnaSequenza(seme: UInt64, passi: Int) -> (descrizione: String, traccia: String)? {
    var g = GeneratoreASeme(seme: seme)
    var banco = BancoMotore()
    var traccia: [String] = []
    var job: [Int] = []
    var inPrimoPiano = true
    var appessePermesse = false
    var noto: [Int: String] = [:]
    var reteNota: Bool?
    var generazione = 1
    var richiami = RichiamiDellaSessione()
    var rinnoviObsoleti = Set<Int>()
    var annullamentiConsegnati = Set<Int>()
    func scelto<T>(_ elementi: [T]) -> T? { elementi.isEmpty ? nil : elementi[Int(g.next() % UInt64(elementi.count))] }
    func esito(_ descrizione: String) -> (descrizione: String, traccia: String) {
        return (descrizione, traccia.suffix(14).joined(separator: " · "))
    }
    func risposta(_ dado: Int) -> (nome: String, risposta: KVRispostaPut) {
        switch dado {
        case 0..<30: return ("2xx", putRiuscita())
        case 30..<45: return ("503", putTransitoria(503))
        case 45..<50: return ("429", putTransitoria(429, retryAfter: "90"))
        case 50..<60: return ("403", putRifiutata(403, errore: nil))
        case 60..<70: return ("InvalidJWT", putRifiutata(400, errore: "InvalidJWT", completo: true, durata: 7500))
        case 70..<82: return ("senza rete", putSenzaRete())
        case 82..<88: return ("chiusura forzata", KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled), motivoAnnullamento: NSURLErrorCancelledReasonUserForceQuitApplication))
        case 88..<92: return ("cancellato", KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled), motivoAnnullamento: NSURLErrorCancelledReasonBackgroundUpdatesDisabled))
        case 92..<95: return ("413", putRifiutata(413, errore: nil))
        default: return ("Duplicate", putRifiutata(400, errore: "Duplicate", completo: false, durata: 0))
        }
    }
    func rispostaRinnovo(_ dado: Int, job n: Int, passo: Int) -> (nome: String, esito: KVEsitoRinnovoRete) {
        switch dado {
        case 0..<50: return ("da-caricare", rinnovoDaCaricare(url: urlPutProva(n, "s\(passo)"), scadeIl: orologioProva.addingTimeInterval(48 * 3600)))
        case 50..<58: return ("arrivato", rinnovoArrivato)
        case 58..<63: return ("annullato", rinnovoAnnullato)
        case 63..<70: return ("404", rinnovoNonTrovato)
        case 70..<78: return ("429", rinnovoLimitato("120"))
        case 78..<88: return ("503", rinnovoErroreServer)
        default: return ("senza rete", rinnovoSenzaRete)
        }
    }

    for passo in 1...passi {
        let dado = Int(g.next() % 100)
        let secondoDado = Int(g.next() % 100)
        switch dado {
        case 0..<11: // un video che arriva, o la stessa apertura che si ripete (token ruotato), o un reinvio
            if job.count < 4 && secondoDado < 55 {
                let n = job.count + 1
                job.append(n)
                traccia.append("accoda \(n)")
                banco.accoda(n, byte: 1000, token: tokenDelJob(n), firma: "a\(passo)")
            } else if let n = scelto(job) {
                traccia.append("riaccoda \(n)")
                banco.accoda(n, byte: 1000, token: tokenDelJob(n, ruotato: secondoDado % 2 == 0), firma: "r\(passo)")
            }
        case 11..<30: // un task finisce (uno di questo processo, o uno che il sistema aveva ancora dal processo di prima)
            let propri = banco.trasporto.identificativiVivi.map { ($0, UUID?.none) }
            let ereditati = banco.trasporto.extraVivi.map { ($0.identificativo, UUID?.some($0.job)) }
            if let (id, delPassato) = scelto(propri + ereditati) {
                let r = risposta(secondoDado)
                traccia.append("task \(id) → \(r.nome)\(delPassato == nil ? "" : " (del processo di prima)")")
                if let j = delPassato {
                    banco.trasporto.extraVivi.removeAll { $0.identificativo == id }
                    banco.trasporto.completaDiUnaVitaPrecedente(job: j, task: id, r.risposta, byteInviati: Int64(secondoDado * 10))
                    banco.attendi()
                } else {
                    banco.completa(id, r.risposta, byteInviati: Int64(secondoDado * 10))
                }
            }
        case 30..<44: // un rinnovo risponde
            if let c = scelto(banco.rinnovo.inAttesaDiRisposta) {
                let r = rispostaRinnovo(secondoDado, job: jobDelToken(c.token), passo: passo)
                traccia.append("rinnovo di \(jobDelToken(c.token)) → \(r.nome)")
                banco.rinnovo.rispondi(c.indice, r.esito)
                banco.attendi()
            }
        case 44..<58: // passa il tempo
            let secondi: [TimeInterval] = [1, 20, 31, 61, 130, 301, 601, 901, 1800]
            let s = secondoDado % 40 == 0 ? 60_000 : secondi[secondoDado % secondi.count]
            traccia.append("passano \(Int(s)) s")
            banco.avanza(s)
        case 58..<65: // la rete
            let c = secondoDado % 2 == 0
            traccia.append(c ? "rete torna" : "rete cade")
            reteNota = c
            banco.rete.imposta(c)
            banco.attendi()
        case 65..<72: // l'app va in background o torna
            if secondoDado % 2 == 0 {
                traccia.append("background")
                banco.motore.notificaSeFermo()
                inPrimoPiano = false
            } else {
                traccia.append("primo piano")
                banco.motore.riprendiInPrimoPiano()
                inPrimoPiano = true
                appessePermesse = false
            }
            banco.attendi()
        case 72..<77: // l'insegnante annulla
            if let n = scelto(job) {
                traccia.append("annulla \(n)")
                _ = banco.motore.annulla(job: uuid(n))
                banco.attendi()
            }
        case 77..<90: // il trasferimento avanza
            if let id = scelto(banco.trasporto.identificativiVivi) {
                traccia.append("byte sul task \(id)")
                banco.trasporto.avanzamento(id, byte: Int64(1 + secondoDado * 9))
                banco.attendi()
            }
        case 90..<92: // il sistema risveglia l'app per gli eventi della sessione
            let i = richiami.nuovo()
            traccia.append("ricollega #\(i)")
            let contatore = richiami
            banco.motore.ricollega("it.kidville.app.caricamenti") { contatore.scattato(i) }
            banco.attendi()
            banco.giraIlMain()
        case 92..<94: // il sistema ha consegnato tutti gli eventi
            traccia.append("eventi consegnati")
            banco.trasporto.consegnaEventi()
            banco.attendi()
            banco.giraIlMain()
        case 99..<100: // arriva, in ritardo, il completamento «annullato» di un task che il motore aveva fermato
            if let id = scelto(banco.trasporto.annullati.filter { !annullamentiConsegnati.contains($0) }) {
                annullamentiConsegnati.insert(id)
                traccia.append("arriva l'annullamento del task \(id)")
                banco.completa(id, KVRispostaPut(errore: KVErroreSistema(dominio: .url, codice: NSURLErrorCancelled)))
            }
        case 98..<99: // il Portachiavi smette di rispondere (telefono bloccato dopo un riavvio) o torna a farlo
            banco.segreti.leggiNonDisponibile.toggle()
            traccia.append(banco.segreti.leggiNonDisponibile ? "il Portachiavi non risponde" : "il Portachiavi torna")
            banco.attendi()
        case 97..<98: // la schermata toglie dalla lista una voce finita
            if let n = scelto(job.filter { banco.voce($0)?.stato.eTerminale ?? false }) {
                traccia.append("dimentica \(n)")
                _ = banco.motore.dimentica([uuid(n)])
                banco.attendi()
            }
        case 94..<97: // il processo muore e ne parte uno nuovo, in primo piano o rilanciato dal sistema in background
            let inBackground = secondoDado % 2 == 0
            traccia.append(inBackground ? "il processo muore, rilancio in background" : "il processo muore, riapertura in primo piano")
            banco.attendi()
            var segretiRimasti: [(UUID, KVSegretiVoce)] = []
            for n in job { if let s = banco.segreti.segreti(uuid(n)) { segretiRimasti.append((uuid(n), s)) } }
            let tasksRimasti = banco.trasporto.vivi.map { KVTaskVivo(job: $0.value.job, identificativo: $0.key, byteInviati: 0) } + banco.trasporto.extraVivi
            let adesso = orologioProva
            generazione += 1
            let numeroGenerazione = generazione
            let portachiaviMuto = banco.segreti.leggiNonDisponibile
            banco = BancoMotore(inBackground: inBackground, avvia: true, inPrimoPiano: !inBackground, cartella: banco.radice) { b in
                orologioProva = adesso
                b.segreti.leggiNonDisponibile = portachiaviMuto
                for (j, s) in segretiRimasti { b.segreti.semina(j, s) }
                b.trasporto.extraVivi = tasksRimasti
                b.trasporto.impostaProssimoId(1000 * numeroGenerazione)
            }
            if let c = reteNota { banco.rete.imposta(c); banco.attendi() }
            inPrimoPiano = !inBackground
            appessePermesse = inBackground
            richiami = RichiamiDellaSessione()
            rinnoviObsoleti = []
            annullamentiConsegnati = []
            noto = [:]
            for n in job { if let v = banco.voce(n) { noto[n] = "\(v.stato) \(String(describing: v.codice))" } }
        default:
            banco.attendi()
        }
        for n in job where banco.voce(n)?.stato.eTerminale ?? true {
            for c in banco.rinnovo.inAttesaDiRisposta where jobDelToken(c.token) == n { rinnoviObsoleti.insert(c.indice) }
        }
        if let problema = controllaLeInvarianti(banco, job: job, inPrimoPiano: inPrimoPiano, appessePermesse: appessePermesse, noto: noto, rinnoviObsoleti: rinnoviObsoleti) {
            return esito("dopo «\(traccia.last ?? "")»: \(problema)")
        }
        if let doppio = richiami.conteggi.firstIndex(where: { $0 > 1 }) { return esito("dopo «\(traccia.last ?? "")»: il completamento del `ricollega` #\(doppio) è scattato \(richiami.conteggi[doppio]) volte") }
    }

    // A regime: tutto va bene da adesso in poi, e ogni voce deve arrivare in fondo.
    traccia.append("— a regime —")
    banco.segreti.leggiNonDisponibile = false
    banco.rete.imposta(true)
    banco.attendi()
    banco.motore.riprendiInPrimoPiano()
    banco.attendi()
    inPrimoPiano = true
    appessePermesse = false
    for giro in 0..<60 {
        var fatto = false
        for c in banco.rinnovo.inAttesaDiRisposta {
            banco.rinnovo.rispondi(c.indice, rinnovoDaCaricare(url: urlPutProva(jobDelToken(c.token), "q\(giro)"), scadeIl: orologioProva.addingTimeInterval(48 * 3600)))
            banco.attendi()
            fatto = true
        }
        for id in banco.trasporto.identificativiVivi {
            banco.completa(id, putRiuscita(), byteInviati: 1000)
            fatto = true
        }
        for ereditato in banco.trasporto.extraVivi {
            banco.trasporto.extraVivi.removeAll { $0.identificativo == ereditato.identificativo }
            banco.trasporto.completaDiUnaVitaPrecedente(job: ereditato.job, task: ereditato.identificativo, putRiuscita(), byteInviati: 1000)
            banco.attendi()
            fatto = true
        }
        for n in job where banco.voce(n)?.stato.eTerminale ?? true {
            for c in banco.rinnovo.inAttesaDiRisposta where jobDelToken(c.token) == n { rinnoviObsoleti.insert(c.indice) }
        }
        if let problema = controllaLeInvarianti(banco, job: job, inPrimoPiano: inPrimoPiano, noto: noto, rinnoviObsoleti: rinnoviObsoleti) { return esito("a regime, giro \(giro): \(problema)") }
        if !fatto { banco.avanza(600) }
        if job.allSatisfy({ banco.voce($0)?.stato.eTerminale ?? true }) { break }
    }
    banco.avanza(60)
    banco.giraIlMain()
    if let mai = richiami.conteggi.firstIndex(where: { $0 != 1 }) { return esito("a regime il completamento del `ricollega` #\(mai) è scattato \(richiami.conteggi[mai]) volte invece di una") }
    if banco.lavoro.aperti != 0 { return esito("a regime restano \(banco.lavoro.aperti) lavori in background aperti") }
    if let nonFinita = job.first(where: { !(banco.voce($0)?.stato.eTerminale ?? true) }) {
        let v = banco.voce(nonFinita)
        return esito("a regime la voce \(nonFinita) non arriva in fondo: \(String(describing: v?.stato)) \(String(describing: v?.codice)), task vivi \(banco.trasporto.identificativiVivi.count + banco.trasporto.extraVivi.count), rinnovi in volo \(banco.rinnovo.senzaRisposta), timer \(banco.pianificatore.pendenti)")
    }
    return nil
}

func provaMotoreASequenze() {
    let semi = Int(ProcessInfo.processInfo.environment["KV_SEMI"] ?? "") ?? 80
    let passi = Int(ProcessInfo.processInfo.environment["KV_PASSI"] ?? "") ?? 60
    let primoSeme = Int(ProcessInfo.processInfo.environment["KV_SEME_DA"] ?? "") ?? 1
    sezione("Motore — \(semi) sequenze casuali di \(passi) eventi (semi fissi): niente appeso, copia e segreti seguono lo stato, il JS sa sempre com'è, e a regime tutto arriva in fondo")
    for seme in primoSeme..<(primoSeme + semi) {
        let problema = eseguiUnaSequenza(seme: UInt64(seme), passi: passi)
        verifica("seme \(seme)", problema == nil, problema.map { "\($0.descrizione)\n         ultimi eventi: \($0.traccia)" } ?? "")
    }
}
