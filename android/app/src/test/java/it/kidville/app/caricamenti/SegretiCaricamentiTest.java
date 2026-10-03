package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SegretiCaricamenti.Lettura;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * I segreti dei caricamenti (spec §2.2, §4.6, §9; compito A2): token e URL firmato cifrati in `segreti/<jobId>.bin`, MAI nel JSON della
 * coda. Il cifrario è quello software dei test, con lo stesso formato di quello del Keystore: si prova tutto tranne la chiave
 * dell'AndroidKeyStore, che esiste solo su un telefono.
 */
public class SegretiCaricamentiTest {

    @Rule
    public TemporaryFolder temporanea = new TemporaryFolder();

    private File cartella;
    private CodaCaricamenti coda;
    private CifrarioSoftware cifrario;
    private SegretiCaricamenti segreti;

    private static final String TOKEN = "kvr_" + "A".repeat(43);
    private static final String URL_PUT = "https://abcdwxyz.supabase.co/storage/v1/object/upload/sign/video_processing/x/y.mp4?token=eyJhbGciOiJIUzI1NiJ9.segretissimo.firma";
    private static final String URL_RINNOVO = "https://app.kidville.it/api/video-uploads/rinnovo";
    private static final String URL_REGISTRO = "https://app.kidville.it/api/logs";

    @Before
    public void preparaIBanco() throws IOException {
        cartella = temporanea.newFolder("caricamenti");
        coda = new CodaCaricamenti(cartella, () -> 1_790_000_000_000L);
        cifrario = new CifrarioSoftware();
        segreti = new SegretiCaricamenti(coda, cifrario);
    }

    private static String id(int n) {
        return String.format(Locale.ROOT, "%08x-1111-4111-8111-%012x", n, n);
    }

    private static Segreti esempio() {
        return new Segreti(TOKEN, URL_PUT, "video/mp4", URL_RINNOVO, URL_REGISTRO);
    }

    private File file(String job) {
        return coda.fileSegreto(job);
    }

    private static boolean contiene(byte[] pagliaio, String ago) {
        return new String(pagliaio, StandardCharsets.ISO_8859_1).contains(ago);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL GIRO COMPLETO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void salvaELeggeIlGiroCompleto() throws Exception {
        segreti.salva(id(1), esempio());
        Lettura l = segreti.leggi(id(1));
        assertSame(Esito.OK, l.esito);
        assertEquals(TOKEN, l.segreti.token);
        assertEquals(URL_PUT, l.segreti.urlPut);
        assertEquals("video/mp4", l.segreti.contentType);
        assertEquals(URL_RINNOVO, l.segreti.urlRinnovo);
        assertEquals(URL_REGISTRO, l.segreti.urlRegistro);
        assertEquals("il cifrario è stato usato davvero", 1, cifrario.cifrature);
        assertEquals(1, cifrario.decifrature);
    }

    @Test
    public void ilFileStaNelPercorsoCheLaCodaEIlCleanupConoscono() throws Exception {
        segreti.salva(id(1), esempio());
        File atteso = new File(cartella, "segreti/" + id(1) + ".bin");
        assertEquals(atteso, file(id(1)));
        assertTrue(atteso.isFile());
    }

    @Test
    public void ilFileNonContieneNeIlTokenNeLUrlNeIlContentTypeInChiaro() throws Exception {
        segreti.salva(id(1), esempio());
        byte[] grezzo = Files.readAllBytes(file(id(1)).toPath());
        for (String segreto : new String[]{TOKEN, "kvr_", "eyJhbGci", "segretissimo", "supabase", "storage/v1", "app.kidville.it", "video/mp4", "token", "urlPut"}) {
            assertFalse("«" + segreto + "» in chiaro nel file", contiene(grezzo, segreto));
        }
        assertEquals("il primo byte è la versione del formato", SegretiCaricamenti.VERSIONE_FILE, grezzo[0]);
    }

    @Test
    public void duePrimeCifrateDellStessoContenutoSonoDiverse() throws Exception {
        // L'IV è casuale a ogni cifratura: lo stesso contenuto non produce mai lo stesso file (e un IV riusato con GCM è un disastro).
        segreti.salva(id(1), esempio());
        byte[] primo = Files.readAllBytes(file(id(1)).toPath());
        segreti.salva(id(1), esempio());
        byte[] secondo = Files.readAllBytes(file(id(1)).toPath());
        assertFalse(Arrays.equals(primo, secondo));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * ASSENTE, ILLEGGIBILE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void senzaFileLaLetturaDiceAssenteENonLancia() {
        Lettura l = segreti.leggi(id(1));
        assertSame(Esito.ASSENTE, l.esito);
        assertNull(l.segreti);
    }

    @Test
    public void unByteToccatoRendeIlFileIlleggibile() throws Exception {
        segreti.salva(id(1), esempio());
        byte[] dati = Files.readAllBytes(file(id(1)).toPath());
        for (int posizione : new int[]{1, 2, 5, dati.length / 2, dati.length - 1}) {
            byte[] toccati = dati.clone();
            toccati[posizione] ^= 0x01;
            Files.write(file(id(1)).toPath(), toccati);
            assertSame("byte " + posizione + " toccato", Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
        }
    }

    @Test
    public void unFileTroncatoOVuotoOConUnaVersioneSconosciutaEIlleggibile() throws Exception {
        segreti.salva(id(1), esempio());
        byte[] dati = Files.readAllBytes(file(id(1)).toPath());
        Files.write(file(id(1)).toPath(), Arrays.copyOf(dati, dati.length - 5));
        assertSame("troncato", Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
        Files.write(file(id(1)).toPath(), new byte[0]);
        assertSame("vuoto", Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
        Files.write(file(id(1)).toPath(), new byte[]{1});
        assertSame("un byte solo", Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
        byte[] altraVersione = dati.clone();
        altraVersione[0] = (byte) (SegretiCaricamenti.VERSIONE_FILE + 1);
        Files.write(file(id(1)).toPath(), altraVersione);
        assertSame("versione sconosciuta", Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
    }

    @Test
    public void unFileCopiatoNelPercorsoDiUnAltroJobNonSiDecifra() throws Exception {
        // I dati associati sono il jobId: il tag GCM autentica anche quello. Copiare il segreto di un job nel percorso di un altro non serve.
        segreti.salva(id(1), esempio());
        File altro = file(id(2));
        altro.getParentFile().mkdirs();
        Files.copy(file(id(1)).toPath(), altro.toPath());
        assertSame(Esito.ILLEGGIBILE, segreti.leggi(id(2)).esito);
        assertSame("l'originale resta leggibile", Esito.OK, segreti.leggi(id(1)).esito);
    }

    @Test
    public void unContenutoCifratoBeneMaConUnaFormaSbagliataEIlleggibile() throws Exception {
        // Un blocco autentico ma il cui contenuto non è il JSON dei cinque campi: mai un `Segreti` con un campo nullo.
        for (String chiaro : new String[]{"non json", "[]", "{}", "{\"token\":\"x\"}", "{\"token\":1,\"urlPut\":\"a\",\"contentType\":\"b\",\"urlRinnovo\":\"c\",\"urlRegistro\":\"d\"}",
                "{\"token\":\"\",\"urlPut\":\"a\",\"contentType\":\"b\",\"urlRinnovo\":\"c\",\"urlRegistro\":\"d\"}",
                "{\"token\":null,\"urlPut\":\"a\",\"contentType\":\"b\",\"urlRinnovo\":\"c\",\"urlRegistro\":\"d\"}"}) {
            byte[] cifrato = cifrario.cifra(chiaro.getBytes(StandardCharsets.UTF_8), SegretiCaricamenti.datiAssociati(id(1)));
            byte[] file = new byte[cifrato.length + 1];
            file[0] = (byte) SegretiCaricamenti.VERSIONE_FILE;
            System.arraycopy(cifrato, 0, file, 1, cifrato.length);
            File destinazione = this.file(id(1));
            destinazione.getParentFile().mkdirs();
            Files.write(destinazione.toPath(), file);
            Lettura l = segreti.leggi(id(1));
            assertSame("«" + chiaro + "»", Esito.ILLEGGIBILE, l.esito);
            assertNull(l.segreti);
        }
    }

    @Test
    public void unCifrarioCheNonRiesceADecifrareDaIlleggibileENonLancia() throws Exception {
        segreti.salva(id(1), esempio());
        SegretiCaricamenti conUnaChiaveDiversa = new SegretiCaricamenti(coda, new CifrarioSoftware());
        assertSame("un'altra chiave (il Keystore ripulito)", Esito.ILLEGGIBILE, conUnaChiaveDiversa.leggi(id(1)).esito);
        SegretiCaricamenti cheLancia = new SegretiCaricamenti(coda, new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) {
                throw new IllegalStateException("boom");
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws GeneralSecurityException {
                throw new IllegalStateException("boom");
            }
        });
        assertSame("anche un'eccezione imprevista è «illeggibile», non un crash", Esito.ILLEGGIBILE, cheLancia.leggi(id(1)).esito);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * SOSTITUZIONE, AGGIORNAMENTO, CANCELLAZIONE
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void salvareDiNuovoSostituisceIlFileConIlTokenRuotato() throws Exception {
        segreti.salva(id(1), esempio());
        String tokenNuovo = "kvr_" + "B".repeat(43);
        segreti.salva(id(1), new Segreti(tokenNuovo, URL_PUT + "2", "video/mp4", URL_RINNOVO, URL_REGISTRO));
        Lettura l = segreti.leggi(id(1));
        assertEquals(tokenNuovo, l.segreti.token);
        assertEquals(URL_PUT + "2", l.segreti.urlPut);
    }

    @Test
    public void aggiornaCambiaSoloCioCheLaModificaCambiaEPreservaIlTokenCheNelFrattempoELaRuotato() throws Exception {
        segreti.salva(id(1), esempio());
        String tokenRuotato = "kvr_" + "C".repeat(43);
        // La modifica vede i segreti LETTI sotto lo stesso blocco: se il token è cambiato fra la lettura dell'esecutore e la scrittura,
        // non si riporta indietro. (Qui lo si cambia prima di `aggiorna`, che rilegge.)
        segreti.salva(id(1), new Segreti(tokenRuotato, URL_PUT, "video/mp4", URL_RINNOVO, URL_REGISTRO));
        Lettura l = segreti.aggiorna(id(1), s -> s.conUrlPut("https://x.supabase.co/nuovo", "video/quicktime"));
        assertSame(Esito.OK, l.esito);
        Lettura riletta = segreti.leggi(id(1));
        assertEquals("il token ruotato resta", tokenRuotato, riletta.segreti.token);
        assertEquals("https://x.supabase.co/nuovo", riletta.segreti.urlPut);
        assertEquals("video/quicktime", riletta.segreti.contentType);
        assertEquals(URL_RINNOVO, riletta.segreti.urlRinnovo);
        assertEquals(URL_REGISTRO, riletta.segreti.urlRegistro);
    }

    @Test
    public void aggiornaSenzaFileOConUnFileIlleggibileNonScriveNiente() throws Exception {
        AtomicInteger chiamate = new AtomicInteger();
        Lettura assente = segreti.aggiorna(id(1), s -> {
            chiamate.incrementAndGet();
            return s;
        });
        assertSame(Esito.ASSENTE, assente.esito);
        assertFalse(file(id(1)).exists());
        file(id(2)).getParentFile().mkdirs();
        Files.write(file(id(2)).toPath(), new byte[]{1, 2, 3, 4});
        assertSame(Esito.ILLEGGIBILE, segreti.aggiorna(id(2), s -> {
            chiamate.incrementAndGet();
            return s;
        }).esito);
        assertEquals("la modifica non gira su ciò che non si legge", 0, chiamate.get());
        assertArrayEquals("e il file illeggibile non è stato toccato", new byte[]{1, 2, 3, 4}, Files.readAllBytes(file(id(2)).toPath()));
    }

    @Test
    public void cancellaTogliIlFileEIResiduiDiUnaScritturaInterrotta() throws Exception {
        segreti.salva(id(1), esempio());
        File principale = file(id(1));
        File nuovo = new File(principale.getPath() + ".new");
        File vecchio = new File(principale.getPath() + ".bak");
        assertTrue(nuovo.createNewFile());
        assertTrue(vecchio.createNewFile());
        assertTrue(segreti.cancella(id(1)));
        assertFalse(principale.exists());
        assertFalse(nuovo.exists());
        assertFalse(vecchio.exists());
        assertSame(Esito.ASSENTE, segreti.leggi(id(1)).esito);
        assertTrue("cancellare ciò che non c'è non è un errore", segreti.cancella(id(1)));
    }

    @Test
    public void cancellareUnJobNonTocaIlSegretoDiUnAltro() throws Exception {
        segreti.salva(id(1), esempio());
        segreti.salva(id(2), esempio());
        segreti.cancella(id(1));
        assertSame(Esito.OK, segreti.leggi(id(2)).esito);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * FORMA, GUASTI, CONCORRENZA
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unJobIdCheNonEUnUuidNonSiTrasformaInUnPercorso() {
        for (String ostile : new String[]{"../../x", "a/b", "", "UUID-MAIUSCOLO", "00000001-1111-4111-8111-00000000000G"}) {
            try {
                segreti.leggi(ostile);
                fail("«" + ostile + "» non doveva passare");
            } catch (IllegalArgumentException atteso) {
                // rifiutato
            }
        }
    }

    @Test
    public void unSegretoNonPuoEssereVuotoNeNullo() {
        for (Object[] riga : new Object[][]{{null, URL_PUT, "a", "b", "c"}, {"t", "", "a", "b", "c"}, {"t", URL_PUT, null, "b", "c"},
                {"t", URL_PUT, "a", "", "c"}, {"t", URL_PUT, "a", "b", null}}) {
            try {
                new Segreti((String) riga[0], (String) riga[1], (String) riga[2], (String) riga[3], (String) riga[4]);
                fail("un campo vuoto non doveva passare");
            } catch (IllegalArgumentException atteso) {
                // rifiutato
            }
        }
    }

    @Test
    public void iSegretiNonSiStampanoMai() {
        assertFalse(esempio().toString().contains("kvr_"));
        assertFalse(esempio().toString().contains("supabase"));
    }

    @Test
    public void ilFallimentoDelCifrarioEUnaIoExceptionSenzaNessunSegretoNelMessaggio() {
        SegretiCaricamenti cheLancia = new SegretiCaricamenti(coda, new SegretiCaricamenti.Cifrario() {
            @Override
            public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException {
                throw new GeneralSecurityException(new String(chiaro, StandardCharsets.UTF_8));
            }

            @Override
            public byte[] decifra(byte[] cifrato, byte[] datiAssociati) {
                return cifrato;
            }
        });
        try {
            cheLancia.salva(id(1), esempio());
            fail("doveva lanciare");
        } catch (IOException atteso) {
            assertFalse("il messaggio non porta il contenuto", atteso.getMessage().contains("kvr_"));
            assertFalse(atteso.getMessage().contains("supabase"));
        }
        assertFalse("e non resta un file a metà", file(id(1)).exists());
    }

    @Test
    public void unaScritturaCheSulTelefonoNonRinominaNonVieneDichiarataRiuscita() throws Exception {
        // `AtomicFile.finishWrite` sul telefono non lancia se la rinomina fallisce: la verifica dice che il segreto NON è stato salvato, e
        // `salva` lancia invece di restituire come se niente fosse. Si inietta un AtomicFile che si comporta come quello del telefono.
        AtomicFileCheNonTrasloca nonTrasloca = new AtomicFileCheNonTrasloca(file(id(1)), false);
        SegretiCaricamenti conDiscoCheNonRinomina = new SegretiCaricamenti(coda, cifrario, base -> nonTrasloca);
        try {
            conDiscoCheNonRinomina.salva(id(1), esempio());
            fail("un salvataggio che non è arrivato sul disco non può restituire come se niente fosse");
        } catch (IOException atteso) {
            assertEquals("la rinomina è stata tentata e saltata", 1, nonTrasloca.rinominePerse);
        }
        assertFalse("il file dei segreti non esiste: la voce non ne ha", file(id(1)).exists());
        assertSame(Esito.ASSENTE, segreti.leggi(id(1)).esito);
        // Un salvataggio che sovrascrive un file buono con uno che non si rinomina lascia intatto quello buono.
        segreti.salva(id(1), esempio());
        try {
            conDiscoCheNonRinomina.salva(id(1), new Segreti("kvr_" + "Q".repeat(43), URL_PUT, "video/mp4", URL_RINNOVO, URL_REGISTRO));
            fail("anche la sostituzione deve dire che non è riuscita");
        } catch (IOException atteso) {
            // non salvato
        }
        assertEquals("il token di prima è ancora quello vero", TOKEN, segreti.leggi(id(1)).segreti.token);
    }

    @Test(timeout = 30_000)
    public void piuThreadCheAggiornanoLoStessoSegretoNonSiPestanoIPiedi() throws Exception {
        segreti.salva(id(1), esempio());
        int thread = 6;
        int giri = 30;
        CountDownLatch via = new CountDownLatch(1);
        CountDownLatch finiti = new CountDownLatch(thread);
        AtomicInteger errori = new AtomicInteger();
        for (int t = 0; t < thread; t++) {
            final int numero = t;
            new Thread(() -> {
                try {
                    via.await();
                    for (int g = 0; g < giri; g++) {
                        // Metà dei thread cambia l'URL (come l'esecutore), l'altra metà il token (come `accodaVideo`).
                        if (numero % 2 == 0) {
                            segreti.aggiorna(id(1), s -> s.conUrlPut("https://a.supabase.co/" + System.nanoTime(), "video/mp4"));
                        } else {
                            Lettura attuale = segreti.leggi(id(1));
                            if (attuale.esito == Esito.OK) {
                                segreti.salva(id(1), new Segreti("kvr_" + "Z".repeat(43), attuale.segreti.urlPut, "video/mp4", URL_RINNOVO, URL_REGISTRO));
                            }
                        }
                        if (segreti.leggi(id(1)).esito != Esito.OK) errori.incrementAndGet();
                    }
                } catch (Exception guasto) {
                    errori.incrementAndGet();
                } finally {
                    finiti.countDown();
                }
            }).start();
        }
        via.countDown();
        assertTrue(finiti.await(25, TimeUnit.SECONDS));
        assertEquals("ogni lettura, in ogni momento, trova un file integro", 0, errori.get());
        assertNotEquals(Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2b: «NON SI LEGGE ADESSO» NON È «PERSO» (secondario n. 79 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Un `AtomicFile` che legge come il vero, tranne quando `guasto` (o `guastoImprevisto`) non è nullo: allora `readFully` lancia quello. */
    private static final class FileCheSiRompeInLettura extends androidx.core.util.AtomicFile {
        volatile IOException guasto;
        volatile RuntimeException guastoImprevisto;

        FileCheSiRompeInLettura(File base) {
            super(base);
        }

        @Override
        public byte[] readFully() throws IOException {
            if (guastoImprevisto != null) throw guastoImprevisto;
            if (guasto != null) throw guasto;
            return super.readFully();
        }
    }

    /** Un cifrario che decifra come quello software, tranne quando `guasto` non è nullo; e dice lui quali guasti sono passeggeri. */
    private static final class CifrarioCheSiRompe implements SegretiCaricamenti.Cifrario {
        final CifrarioSoftware vero;
        volatile Exception guasto;
        volatile boolean passeggero;

        CifrarioCheSiRompe(CifrarioSoftware vero) {
            this.vero = vero;
        }

        @Override
        public byte[] cifra(byte[] chiaro, byte[] datiAssociati) throws GeneralSecurityException, IOException {
            return vero.cifra(chiaro, datiAssociati);
        }

        @Override
        public byte[] decifra(byte[] cifrato, byte[] datiAssociati) throws GeneralSecurityException, IOException {
            Exception g = guasto;
            if (g instanceof GeneralSecurityException) throw (GeneralSecurityException) g;
            if (g instanceof IOException) throw (IOException) g;
            if (g instanceof RuntimeException) throw (RuntimeException) g;
            return vero.decifra(cifrato, datiAssociati);
        }

        @Override
        public boolean guastoTransitorio(Throwable g) {
            return passeggero || SegretiCaricamenti.Cifrario.super.guastoTransitorio(g);
        }
    }

    @Test
    public void unErroreDiLetturaDelDiscoNonEUnSegretoPersoMaUnaLetturaNonRiuscitaAdesso() throws Exception {
        segreti.salva(id(1), esempio());
        byte[] prima = Files.readAllBytes(file(id(1)).toPath());
        SegretiCaricamenti lettore = new SegretiCaricamenti(coda, cifrario, base -> {
            FileCheSiRompeInLettura rotto = new FileCheSiRompeInLettura(base);
            rotto.guasto = new IOException("Input/output error");
            return rotto;
        });

        Lettura l = lettore.leggi(id(1));

        assertSame("un errore di I/O è passeggero: non «illeggibile»", Esito.NON_LEGGIBILE_ORA, l.esito);
        assertNull(l.segreti);
        assertTrue("il file c'è ancora", file(id(1)).exists());
        assertArrayEquals("e non è stato toccato", prima, Files.readAllBytes(file(id(1)).toPath()));
        assertSame("passato il guasto, si legge", Esito.OK, segreti.leggi(id(1)).esito);
    }

    @Test
    public void unaEccezioneImprevistaNellaLetturaDelFileEDefinitivaNonUnaRipresa() throws Exception {
        segreti.salva(id(1), esempio());
        SegretiCaricamenti conUnBug = new SegretiCaricamenti(coda, cifrario, base -> {
            FileCheSiRompeInLettura f = new FileCheSiRompeInLettura(base);
            f.guastoImprevisto = new IllegalStateException("bug");
            return f;
        });
        assertSame("un'eccezione che non è di I/O non passa riprovando", Esito.ILLEGGIBILE, conUnBug.leggi(id(1)).esito);
    }

    @Test
    public void unaAperturaFallitaConIlFilePresenteNonEUnFileSparito() throws Exception {
        segreti.salva(id(1), esempio());
        // `FileInputStream` lancia «file non trovato» per OGNI apertura fallita (troppi file aperti, permessi): col file presente non è «sparito».
        SegretiCaricamenti nonApribile = new SegretiCaricamenti(coda, cifrario, base -> {
            FileCheSiRompeInLettura f = new FileCheSiRompeInLettura(base);
            f.guasto = new java.io.FileNotFoundException("open failed: EMFILE (Too many open files)");
            return f;
        });
        assertSame("presente ma non apribile: passeggero", Esito.NON_LEGGIBILE_ORA, nonApribile.leggi(id(1)).esito);
        // Lo stesso guasto con il file DAVVERO assente è «assente»: definitivo.
        assertTrue(file(id(1)).delete());
        assertSame("sparito: assente", Esito.ASSENTE, nonApribile.leggi(id(1)).esito);
        assertSame("e col lettore normale, lo stesso", Esito.ASSENTE, segreti.leggi(id(1)).esito);
    }

    @Test
    public void unGuastoCheIlCifrarioDichiaraPasseggeroEUnaLetturaNonRiuscitaAdessoEUnoCheNonLoEIlleggibile() throws Exception {
        CifrarioCheSiRompe cheSiRompe = new CifrarioCheSiRompe(cifrario);
        SegretiCaricamenti s = new SegretiCaricamenti(coda, cheSiRompe);
        s.salva(id(1), esempio());

        cheSiRompe.guasto = new GeneralSecurityException("Keystore occupato");
        cheSiRompe.passeggero = true;
        assertSame("un guasto che il cifrario dice passeggero", Esito.NON_LEGGIBILE_ORA, s.leggi(id(1)).esito);

        cheSiRompe.passeggero = false;
        assertSame("lo stesso guasto, se il cifrario non lo dice passeggero, è definitivo", Esito.ILLEGGIBILE, s.leggi(id(1)).esito);

        cheSiRompe.guasto = new IOException("archivio delle chiavi non aperto");
        assertSame("un IOException è passeggero per ogni cifrario (regola predefinita)", Esito.NON_LEGGIBILE_ORA, s.leggi(id(1)).esito);

        cheSiRompe.guasto = new javax.crypto.AEADBadTagException("contenuto toccato");
        assertSame("contenuto toccato o chiave diversa: definitivo", Esito.ILLEGGIBILE, s.leggi(id(1)).esito);

        cheSiRompe.guasto = null;
        assertSame("e passato il guasto il segreto c'era tutto il tempo", Esito.OK, s.leggi(id(1)).esito);
    }

    @Test
    public void unFileConLaVersioneSbagliataOTroncatoRestaIlleggibileAncheSeIlCifrarioDiceChePassa() throws Exception {
        CifrarioCheSiRompe cheSiRompe = new CifrarioCheSiRompe(cifrario);
        cheSiRompe.passeggero = true;
        SegretiCaricamenti s = new SegretiCaricamenti(coda, cheSiRompe);
        s.salva(id(1), esempio());
        byte[] dati = Files.readAllBytes(file(id(1)).toPath());
        byte[] altraVersione = dati.clone();
        altraVersione[0] = (byte) (SegretiCaricamenti.VERSIONE_FILE + 1);
        Files.write(file(id(1)).toPath(), altraVersione);
        assertSame("la forma sbagliata non si risolve riprovando", Esito.ILLEGGIBILE, s.leggi(id(1)).esito);
        Files.write(file(id(1)).toPath(), new byte[]{1});
        assertSame(Esito.ILLEGGIBILE, s.leggi(id(1)).esito);
    }

    @Test
    public void aggiornaSuUnaLetturaNonRiuscitaAdessoNonScriveNienteELaRestituisce() throws Exception {
        segreti.salva(id(1), esempio());
        byte[] prima = Files.readAllBytes(file(id(1)).toPath());
        SegretiCaricamenti lettore = new SegretiCaricamenti(coda, cifrario, base -> {
            FileCheSiRompeInLettura rotto = new FileCheSiRompeInLettura(base);
            rotto.guasto = new IOException("Input/output error");
            return rotto;
        });
        AtomicInteger chiamate = new AtomicInteger();
        Lettura l = lettore.aggiorna(id(1), x -> {
            chiamate.incrementAndGet();
            return x;
        });
        assertSame(Esito.NON_LEGGIBILE_ORA, l.esito);
        assertEquals("la modifica non gira su ciò che non si legge", 0, chiamate.get());
        assertArrayEquals("e il file non è stato riscritto", prima, Files.readAllBytes(file(id(1)).toPath()));
    }

    @Test
    public void iCriteriDelKeystoreSeparanoIlPasseggeroDalDefinitivoEIlDefinitivoVince() {
        java.util.function.Function<Throwable, Boolean> nessunVerdetto = c -> null;
        // Passeggeri: l'operazione del provider non è riuscita; un errore di I/O (l'archivio delle chiavi non si apre).
        assertTrue("ProviderException", SegretiCaricamenti.CifrarioKeystore.eTransitorio(new java.security.ProviderException("Keystore operation failed"), 0, nessunVerdetto));
        assertTrue("IOException", SegretiCaricamenti.CifrarioKeystore.eTransitorio(new IOException("archivio non aperto"), 0, nessunVerdetto));
        assertTrue("un ProviderException dentro un altro guasto", SegretiCaricamenti.CifrarioKeystore.eTransitorio(
                new GeneralSecurityException("incapsulato", new java.security.ProviderException("operazione")), 0, nessunVerdetto));
        // Definitivi: il contenuto è stato toccato, la chiave non c'è più o non si recupera, la misura è sbagliata.
        for (Throwable definitivo : new Throwable[]{new GeneralSecurityException("generico"), new javax.crypto.AEADBadTagException("tag"),
                new javax.crypto.BadPaddingException("padding"), new javax.crypto.IllegalBlockSizeException("misura"),
                new java.security.UnrecoverableKeyException("chiave"), new android.security.keystore.KeyPermanentlyInvalidatedException(),
                new IllegalStateException("sconosciuto")}) {
            assertFalse(definitivo.getClass().getSimpleName(), SegretiCaricamenti.CifrarioKeystore.eTransitorio(definitivo, 0, nessunVerdetto));
        }
        // Il definitivo VINCE su un passeggero nella stessa catena, in qualunque ordine: anche quando sta IN CIMA e il passeggero sotto.
        javax.crypto.AEADBadTagException tagInCima = new javax.crypto.AEADBadTagException("tag");
        tagInCima.initCause(new java.security.ProviderException("operazione"));
        assertFalse("un contenuto toccato con sotto un ProviderException", SegretiCaricamenti.CifrarioKeystore.eTransitorio(tagInCima, 0, nessunVerdetto));
        assertFalse("una chiave invalidata con sotto un ProviderException", SegretiCaricamenti.CifrarioKeystore.eTransitorio(
                new android.security.keystore.KeyPermanentlyInvalidatedException("chiave", new java.security.ProviderException("operazione")), 0, nessunVerdetto));
        java.security.UnrecoverableKeyException nonRecuperabileInCima = new java.security.UnrecoverableKeyException("chiave");
        nonRecuperabileInCima.initCause(new IOException("archivio"));
        assertFalse("una chiave non recuperabile con sotto un errore di I/O", SegretiCaricamenti.CifrarioKeystore.eTransitorio(nonRecuperabileInCima, 0, nessunVerdetto));
        assertFalse("ProviderException causato da una chiave invalidata", SegretiCaricamenti.CifrarioKeystore.eTransitorio(
                new java.security.ProviderException("operazione", new android.security.keystore.KeyPermanentlyInvalidatedException()), 0, nessunVerdetto));
        assertFalse("IOException causato da un contenuto toccato", SegretiCaricamenti.CifrarioKeystore.eTransitorio(
                new IOException("lettura", new javax.crypto.AEADBadTagException("tag")), 0, nessunVerdetto));
        assertFalse("un definitivo in fondo a una catena con un passeggero in cima", SegretiCaricamenti.CifrarioKeystore.eTransitorio(
                new java.security.ProviderException("a", new IllegalStateException("b", new java.security.UnrecoverableKeyException("c"))), 0, nessunVerdetto));
    }

    @Test
    public void daApi33IlVerdettoDelSistemaDecideEVaIlSuoNoAncheSottoUnProviderException() {
        final RuntimeException conVerdettoSi = new RuntimeException("sistema: passeggero");
        final RuntimeException conVerdettoNo = new RuntimeException("sistema: definitivo");
        java.util.function.Function<Throwable, Boolean> verdetto = c -> c == conVerdettoSi ? Boolean.TRUE : c == conVerdettoNo ? Boolean.FALSE : null;
        assertTrue("il sistema dice «passeggero»", SegretiCaricamenti.CifrarioKeystore.eTransitorio(new GeneralSecurityException("x", conVerdettoSi), 33, verdetto));
        assertFalse("il sistema dice «definitivo»: vale anche con un ProviderException sopra",
                SegretiCaricamenti.CifrarioKeystore.eTransitorio(new java.security.ProviderException("operazione", conVerdettoNo), 33, verdetto));
        assertTrue("senza verdetto del sistema si ripiega sulla regola dei tipi",
                SegretiCaricamenti.CifrarioKeystore.eTransitorio(new java.security.ProviderException("operazione"), 33, verdetto));
        assertTrue("prima di API 33 il verdetto non si chiede nemmeno: vale la regola dei tipi",
                SegretiCaricamenti.CifrarioKeystore.eTransitorio(new java.security.ProviderException("operazione", conVerdettoNo), 32, verdetto));
    }

    @Test
    public void laCatenaDelleCauseNonFaGirareAVuotoSeSiMordeLaCoda() {
        Throwable circolare = new IllegalStateException("circolare") {
            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        };
        assertFalse("termina, e senza un passeggero in catena è definitivo",
                SegretiCaricamenti.CifrarioKeystore.eTransitorio(circolare, 33, c -> null));
    }

    @Test
    public void ilCifrarioDelKeystoreUsaDavveroLaRegolaDeiTipi() {
        SegretiCaricamenti.Cifrario keystore = new SegretiCaricamenti.CifrarioKeystore();
        assertTrue("un ProviderException è passeggero, e non lo dice il predefinito del contratto (che conosce solo l'I/O)",
                keystore.guastoTransitorio(new java.security.ProviderException("Keystore operation failed")));
        assertFalse(keystore.guastoTransitorio(new javax.crypto.AEADBadTagException("tag")));
    }

    @Test
    public void ilPredefinitoDelContrattoRiconosceSoloLErroreDiIo() {
        SegretiCaricamenti.Cifrario predefinito = new CifrarioSoftware();
        assertTrue(predefinito.guastoTransitorio(new IOException("x")));
        assertFalse(predefinito.guastoTransitorio(new java.security.ProviderException("x")));
        assertFalse(predefinito.guastoTransitorio(new GeneralSecurityException("x")));
    }

    @Test
    public void unaLetturaCheNonRiesceSiDiceInLogcatConLaSolaClasseSenzaCheIlMessaggioNeVadaFuori() throws Exception {
        segreti.salva(id(1), esempio());
        final java.util.List<String> righe;
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            SegretiCaricamenti passeggero = new SegretiCaricamenti(coda, cifrario, base -> {
                FileCheSiRompeInLettura rotto = new FileCheSiRompeInLettura(base);
                rotto.guasto = new IOException("/data/user/0/it.kidville.app/no_backup/caricamenti/segreti/privato");
                return rotto;
            });
            assertSame(Esito.NON_LEGGIBILE_ORA, passeggero.leggi(id(1)).esito);
            byte[] dati = Files.readAllBytes(file(id(1)).toPath());
            dati[dati.length - 1] ^= 1;
            Files.write(file(id(1)).toPath(), dati);
            assertSame(Esito.ILLEGGIBILE, segreti.leggi(id(1)).esito);
            righe = new java.util.ArrayList<>(logcat.righe);
        }
        assertEquals(2, righe.size());
        assertTrue(righe.get(0), righe.get(0).startsWith("I KidvilleCaricamenti file dei segreti non letto (IOException): passeggero"));
        assertTrue(righe.get(1), righe.get(1).startsWith("W KidvilleCaricamenti segreti non decifrabili (AEADBadTagException): definitivo"));
        for (String riga : righe) assertFalse("niente percorso né messaggio d'eccezione: " + riga, riga.contains("/data/") || riga.contains("privato"));
    }
}
