package it.kidville.app.caricamenti;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import it.kidville.app.caricamenti.SegretiCaricamenti.CifrarioKeystore.Verdetto;
import it.kidville.app.caricamenti.SegretiCaricamenti.Esito;
import it.kidville.app.caricamenti.SegretiCaricamenti.Lettura;
import it.kidville.app.caricamenti.SegretiCaricamenti.Segreti;

import android.security.keystore.KeyPermanentlyInvalidatedException;

import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.Key;
import java.security.KeyStoreSpi;
import java.security.Provider;
import java.security.Security;
import java.security.UnrecoverableKeyException;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Date;
import java.util.Enumeration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import javax.crypto.AEADBadTagException;
import javax.crypto.BadPaddingException;
import javax.crypto.IllegalBlockSizeException;
import javax.crypto.SecretKey;

/**
 * I segreti dei caricamenti (spec §2.2, §4.6, §9; compito A2): token e URL firmato cifrati in `segreti/<jobId>.bin`, MAI nel JSON della
 * coda. Il cifrario è quello software dei test, con lo stesso formato di quello del Keystore: si prova tutto tranne la chiave
 * dell'AndroidKeyStore, che esiste solo su un telefono. Del cifrario di produzione si prova ciò che non dipende dal sistema: le regole pure
 * (`eTransitorio`, `eDaEliminare`, con `sdk` e verdetto iniettati) e, con un AndroidKeyStore FINTO registrato come provider di sicurezza
 * (compito A2d), il cablaggio di `chiave(boolean)`: che cosa si elimina, quando, con quale alias. Non si prova sulla JVM `VerdettoApi33`, che
 * traduce una `android.security.KeyStoreException` (che qui non si può costruire) nelle due risposte del verdetto, e nemmeno `Build.VERSION.SDK_INT`,
 * che sulla JVM vale 0.
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
        Function<Throwable, Verdetto> nessunVerdetto = c -> null;
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
        Function<Throwable, Verdetto> verdetto = c -> c == conVerdettoSi ? new Verdetto(true, false) : c == conVerdettoNo ? new Verdetto(false, false) : null;
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

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2c: IL VERDETTO DEL SISTEMA VINCE SUI CONTENITORI, E LA CHIAVE NON SI ELIMINA PER UN GUASTO CHE PASSA
     * (secondari n. 153 e n. 154 della PR 3)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Un guasto che porta un verdetto del SISTEMA: sta al posto di una `android.security.KeyStoreException`, che sulla JVM non si può costruire
     * (il suo unico costruttore, nello stub di android.jar, è di pacchetto). Le due risposte, `isTransientFailure()` e `isSystemError()`, sono i
     * due booleani del {@link Verdetto} che porta; il verdetto si inietta, come negli altri test.
     */
    private abstract static class GuastoConVerdetto extends RuntimeException {
        final Verdetto verdetto;

        GuastoConVerdetto(String messaggio, boolean passeggero, boolean erroreDiSistema) {
            super(messaggio);
            this.verdetto = new Verdetto(passeggero, erroreDiSistema);
        }
    }

    /** Il sistema dice «passeggero» e basta: `isTransientFailure()` vero, `isSystemError()` falso. */
    private static final class VerdettoSi extends GuastoConVerdetto {
        VerdettoSi() {
            super("sistema: passeggero", true, false);
        }
    }

    /** Il sistema dice «della chiave»: né passeggero né di sistema (una chiave corrotta). */
    private static final class VerdettoNo extends GuastoConVerdetto {
        VerdettoNo() {
            super("sistema: definitivo", false, false);
        }
    }

    /**
     * Il sistema dice «errore di sistema» e NON «passeggero»: `isSystemError()` vero, `isTransientFailure()` FALSO. È SYSTEM_ERROR, ciò che esce da
     * `getKeyEntry` dopo una connessione persa col demone (KeyStore2.java:122-124, KeyStoreException.java:666-668).
     */
    private static final class VerdettoSistema extends GuastoConVerdetto {
        VerdettoSistema() {
            super("sistema: errore di sistema", false, true);
        }
    }

    /** Il sistema dice tutte e due le cose: è la forma di quasi ogni guasto passeggero di AOSP (KM_ERROR_SECURE_HW_BUSY, OUT_OF_KEYS_*...). */
    private static final class VerdettoSistemaPasseggero extends GuastoConVerdetto {
        VerdettoSistemaPasseggero() {
            super("sistema: errore di sistema passeggero", true, true);
        }
    }

    /** Il verdetto iniettato: legge i finti qui sopra e, per tutto il resto, non ha niente da dire (come `VerdettoApi33.su`). */
    private static final Function<Throwable, Verdetto> VERDETTO_DEL_SISTEMA =
            causa -> causa instanceof GuastoConVerdetto ? ((GuastoConVerdetto) causa).verdetto : null;

    /** `guasto` con `causa` sotto: i tipi della JCA non hanno tutti un costruttore con la causa (IllegalBlockSizeException, UnrecoverableKeyException). */
    private static <T extends Throwable> T conCausa(T guasto, Throwable causa) {
        guasto.initCause(causa);
        return guasto;
    }

    private static boolean transitorio(Throwable guasto, int sdk) {
        return SegretiCaricamenti.CifrarioKeystore.eTransitorio(guasto, sdk, VERDETTO_DEL_SISTEMA);
    }

    private static boolean daEliminare(boolean perCifrare, Throwable guasto, int sdk) {
        return SegretiCaricamenti.CifrarioKeystore.eDaEliminare(perCifrare, guasto, sdk, VERDETTO_DEL_SISTEMA);
    }

    /** `n` strati di `RuntimeException` sopra `fondo`: `fondo` sta alla profondità `n` della catena (la radice è la 0). */
    private static Throwable stratiSopra(Throwable fondo, int n) {
        Throwable catena = fondo;
        for (int i = 0; i < n; i++) catena = conCausa(new RuntimeException("strato " + i), catena);
        return catena;
    }

    // ── 153: da API 33 il verdetto del sistema decide anche sotto i tipi che avvolgono ogni errore del Keystore ──

    @Test
    public void daApi33IlVerdettoDelSistemaVinceAncheSottoIllegalBlockSizeException() {
        // keystore2 avvolge in IllegalBlockSizeException OGNI errore di doFinal/updateAAD (operazione potata, servizio occupato, connessione
        // persa): se il sistema dice «passeggero» lo è, qualunque sia il tipo che lo avvolge.
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("sdk " + sdk + ": passeggero sotto un IllegalBlockSizeException",
                    transitorio(conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoSi()), sdk));
            assertFalse("sdk " + sdk + ": il «no» del sistema vale lo stesso",
                    transitorio(conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoNo()), sdk));
            assertTrue("sdk " + sdk + ": in qualunque ordine, anche col verdetto SOPRA il contenitore",
                    transitorio(conCausa(new VerdettoSi(), new IllegalBlockSizeException("doFinal")), sdk));
            assertFalse("sdk " + sdk + ": senza un verdetto in catena resta definitivo, come prima",
                    transitorio(new IllegalBlockSizeException("misura"), sdk));
        }
    }

    @Test
    public void daApi33IlVerdettoDelSistemaVinceAncheSottoUnrecoverableKeyException() {
        // `getKey` avvolge in UnrecoverableKeyException ogni errore di getKeyEntry diverso da KEY_NOT_FOUND e KEY_PERMANENTLY_INVALIDATED,
        // SYSTEM_ERROR dopo una connessione persa col demone compreso.
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("sdk " + sdk + ": passeggero sotto un UnrecoverableKeyException",
                    transitorio(conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), new VerdettoSi()), sdk));
            assertFalse("sdk " + sdk + ": il «no» del sistema vale lo stesso",
                    transitorio(conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), new VerdettoNo()), sdk));
            assertTrue("sdk " + sdk + ": in qualunque ordine, anche col verdetto SOPRA il contenitore",
                    transitorio(conCausa(new VerdettoSi(), new UnrecoverableKeyException("avvolto")), sdk));
            assertFalse("sdk " + sdk + ": l'invalidazione permanente arriva col solo messaggio, senza causa: resta definitiva",
                    transitorio(new UnrecoverableKeyException("User changed or deleted their auth credentials"), sdk));
        }
    }

    @Test
    public void daApi33IlVerdettoDelSistemaDecideAncheSottoInvalidKeyException() {
        // All'init il guasto passeggero arriva come InvalidKeyException «Keystore operation failed». Il tipo NON è fra i definitivi, e non
        // deve diventarlo: la sua figlia KeyPermanentlyInvalidatedException sì (prova più sotto), lui no.
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("sdk " + sdk + ": passeggero sotto un InvalidKeyException",
                    transitorio(conCausa(new InvalidKeyException("Keystore operation failed"), new VerdettoSi()), sdk));
            assertFalse("sdk " + sdk + ": il «no» del sistema vale lo stesso",
                    transitorio(conCausa(new InvalidKeyException("Keystore operation failed"), new VerdettoNo()), sdk));
            assertFalse("sdk " + sdk + ": senza un verdetto nessuno dice che passa",
                    transitorio(new InvalidKeyException("Keystore operation failed"), sdk));
        }
    }

    @Test
    public void daApi33UnErroreDiSistemaValeComePasseggeroAncheSeIlSistemaNonLoDiceTransitorio() {
        // SYSTEM_ERROR dopo una connessione persa col demone: `isSystemError()` vero e `isTransientFailure()` FALSO (KeyStoreException.java:666-668).
        // `getKey` lo avvolge in un UnrecoverableKeyException (AndroidKeyStoreProvider.java:414-417): la voce aspetta, non si chiude INTERNO per un
        // demone che si sta riavviando. Un errore di sistema non è un guasto della chiave.
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("sdk " + sdk + ": da solo", transitorio(new VerdettoSistema(), sdk));
            assertTrue("sdk " + sdk + ": sotto un UnrecoverableKeyException, il caso vero di getKey",
                    transitorio(conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), new VerdettoSistema()), sdk));
            assertTrue("sdk " + sdk + ": sotto un IllegalBlockSizeException, doFinal e updateAAD",
                    transitorio(conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoSistema()), sdk));
            assertTrue("sdk " + sdk + ": sotto un InvalidKeyException, l'init",
                    transitorio(conCausa(new InvalidKeyException("Keystore operation failed"), new VerdettoSistema()), sdk));
            assertTrue("sdk " + sdk + ": con altri strati in mezzo",
                    transitorio(conCausa(new UnrecoverableKeyException("avvolge"), stratiSopra(new VerdettoSistema(), 3)), sdk));
            assertTrue("sdk " + sdk + ": col verdetto SOPRA il contenitore",
                    transitorio(conCausa(new VerdettoSistema(), new UnrecoverableKeyException("avvolto")), sdk));
            assertTrue("sdk " + sdk + ": di sistema e passeggero insieme",
                    transitorio(conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSistemaPasseggero()), sdk));
            assertFalse("sdk " + sdk + ": controllo, né di sistema né passeggero è un guasto della chiave: definitivo",
                    transitorio(conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoNo()), sdk));
        }
    }

    @Test
    public void unErroreDiSistemaSenzaUnaKeyStoreExceptionInCatenaNonCambiaLaRegolaDeiTipi() {
        // Il verdetto c'è solo se nella catena c'è una KeyStoreException: un UnrecoverableKeyException senza causa resta definitivo (è come
        // arriva l'invalidazione permanente, AndroidKeyStoreSpi.java:126-127), e prima di API 33 il verdetto non esiste.
        for (int sdk : new int[]{33, 34, 36}) {
            assertFalse("sdk " + sdk, transitorio(new UnrecoverableKeyException("User changed or deleted their auth credentials"), sdk));
        }
        for (int sdk : new int[]{24, 29, 32}) {
            assertFalse("sdk " + sdk + ": il verdetto non c'è", transitorio(conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSistema()), sdk));
            assertFalse("sdk " + sdk + ": nemmeno sopra un IllegalBlockSizeException",
                    transitorio(conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoSistema()), sdk));
        }
    }

    /** Un definitivo che nessun verdetto riabilita: da qualunque lato della catena, e con un contenitore in mezzo, qualunque cosa dica il sistema. */
    private static void unDefinitivoNonSiRiabilita(java.util.function.Supplier<Throwable> definitivo) {
        List<java.util.function.Supplier<Throwable>> verdetti = Arrays.asList(VerdettoSi::new, VerdettoSistema::new, VerdettoSistemaPasseggero::new);
        for (java.util.function.Supplier<Throwable> verdetto : verdetti) {
            String chi = verdetto.get().getClass().getSimpleName();
            for (int sdk : new int[]{33, 34, 36}) {
                assertFalse("verdetto SOTTO, " + chi + ", sdk " + sdk, transitorio(conCausa(definitivo.get(), verdetto.get()), sdk));
                assertFalse("verdetto SOPRA, " + chi + ", sdk " + sdk, transitorio(conCausa(verdetto.get(), definitivo.get()), sdk));
                assertFalse("con un contenitore in mezzo, " + chi + ", sdk " + sdk,
                        transitorio(conCausa(verdetto.get(), conCausa(new IllegalBlockSizeException("doFinal"), definitivo.get())), sdk));
            }
        }
    }

    @Test
    public void unaChiaveInvalidataRestaDefinitivaAncheSeIlSistemaDiceChePassa() {
        // La figlia di InvalidKeyException: il tipo-padre lascia decidere il verdetto, lei no. (Lo stub di android.jar scarta messaggio e causa
        // dei costruttori: la causa si mette con `conCausa`, che sullo stub funziona.)
        unDefinitivoNonSiRiabilita(KeyPermanentlyInvalidatedException::new);
    }

    @Test
    public void unContenutoToccatoRestaDefinitivoAncheSeIlSistemaDiceChePassa() {
        unDefinitivoNonSiRiabilita(() -> new AEADBadTagException("tag"));
    }

    @Test
    public void unPaddingSbagliatoOUnaAltraChiaveRestaDefinitivoAncheSeIlSistemaDiceChePassa() {
        unDefinitivoNonSiRiabilita(() -> new BadPaddingException("padding"));
    }

    @Test
    public void unContenitoreSenzaVerdettoRestaDefinitivoAncheSeNellaCatenaCEUnPasseggero() {
        // Da API 33, senza un verdetto, la regola dei tipi (I/O, ProviderException) NON riabilita un contenitore definitivo: come prima.
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("controllo: un ProviderException da solo è passeggero", transitorio(new java.security.ProviderException("operazione"), sdk));
            assertFalse("ProviderException sopra un IllegalBlockSizeException",
                    transitorio(conCausa(new java.security.ProviderException("operazione"), new IllegalBlockSizeException("doFinal")), sdk));
            assertFalse("IllegalBlockSizeException sopra un ProviderException",
                    transitorio(conCausa(new IllegalBlockSizeException("doFinal"), new java.security.ProviderException("operazione")), sdk));
            assertFalse("IOException sopra un UnrecoverableKeyException",
                    transitorio(conCausa(new IOException("archivio"), new UnrecoverableKeyException("chiave")), sdk));
            assertFalse("UnrecoverableKeyException sopra un IOException",
                    transitorio(conCausa(new UnrecoverableKeyException("chiave"), new IOException("archivio")), sdk));
        }
    }

    @Test
    public void primaDiApi33IContenitoriRestanoDefinitiviEIlVerdettoNonSiChiedeNemmeno() {
        // «Sulle API 24-32 non cambia niente»: un IllegalBlockSizeException o un UnrecoverableKeyException vale «definitivo» senza appello, e il
        // verdetto del sistema non si chiede (su quei livelli `KeyStoreException#isTransientFailure` e `#isSystemError` non esistono nemmeno).
        final AtomicInteger richieste = new AtomicInteger();
        final Function<Throwable, Verdetto> contaLeRichieste = causa -> {
            richieste.incrementAndGet();
            return VERDETTO_DEL_SISTEMA.apply(causa);
        };
        for (int sdk : new int[]{24, 29, 32}) {
            for (Throwable guasto : new Throwable[]{conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoSi()),
                    conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSi()), conCausa(new InvalidKeyException("init"), new VerdettoSi()),
                    conCausa(new VerdettoSi(), new IllegalBlockSizeException("doFinal")),
                    conCausa(new IllegalBlockSizeException("doFinal"), new VerdettoSistema()),
                    conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSistema()),
                    conCausa(new VerdettoSistema(), new UnrecoverableKeyException("chiave"))}) {
                assertFalse("sdk " + sdk + ": " + guasto.getClass().getSimpleName(),
                        SegretiCaricamenti.CifrarioKeystore.eTransitorio(guasto, sdk, contaLeRichieste));
            }
        }
        assertEquals("prima di API 33 il verdetto non si chiede", 0, richieste.get());
    }

    // ── 154: la chiave si elimina solo per cifrare un segreto nuovo E per un guasto DELLA CHIAVE (né passeggero né di sistema) ──

    @Test
    public void duranteUnaDecifraturaLaChiaveNonSiEliminaMaiSuNessunLivelloENessunVerdetto() {
        Throwable[] guasti = {
                new UnrecoverableKeyException("invalidata: arriva col solo messaggio, senza causa"),
                conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoNo()),
                conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSi()),
                conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSistema()),
                conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSistemaPasseggero())};
        for (int sdk : new int[]{24, 28, 32, 33, 34, 36}) {
            for (Throwable guasto : guasti) {
                assertFalse("decifrando MAI: sdk " + sdk + ", causa " + DiagnosticaLocale.classe(guasto.getCause()), daEliminare(false, guasto, sdk));
            }
        }
    }

    @Test
    public void perCifrareDaApi33UnVerdettoPasseggeroSalvaLaChiave() {
        for (int sdk : new int[]{33, 34, 36}) {
            assertFalse("sdk " + sdk, daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSi()), sdk));
            assertFalse("sdk " + sdk + ": anche con altri strati in mezzo",
                    daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), stratiSopra(new VerdettoSi(), 3)), sdk));
        }
    }

    @Test
    public void perCifrareDaApi33UnErroreDiSistemaSalvaLaChiaveAncheSeNonEPasseggero() {
        // SYSTEM_ERROR dopo una connessione persa col demone: `isSystemError()` vero, `isTransientFailure()` FALSO. Una chiave nuova non lo risolve
        // (KeyStoreException.java:366-373), e eliminare la vecchia renderebbe illeggibili i segreti di tutte le voci vive.
        for (int sdk : new int[]{33, 34, 36}) {
            assertFalse("sdk " + sdk,
                    daEliminare(true, conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), new VerdettoSistema()), sdk));
            assertFalse("sdk " + sdk + ": anche con altri strati in mezzo",
                    daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), stratiSopra(new VerdettoSistema(), 3)), sdk));
            assertFalse("sdk " + sdk + ": di sistema e passeggero insieme",
                    daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoSistemaPasseggero()), sdk));
        }
    }

    @Test
    public void perCifrareDaApi33UnVerdettoDefinitivoOLAssenzaDiVerdettoEliminanoLaChiave() {
        for (int sdk : new int[]{33, 34, 36}) {
            assertTrue("sdk " + sdk + ": il sistema dice «della chiave», né passeggero né di sistema",
                    daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoNo()), sdk));
            assertTrue("sdk " + sdk + ": nessun verdetto, l'invalidazione permanente arriva col solo messaggio, senza causa",
                    daEliminare(true, new UnrecoverableKeyException("invalidata"), sdk));
            assertTrue("sdk " + sdk + ": una causa che non è una KeyStoreException non è un verdetto",
                    daEliminare(true, conCausa(new UnrecoverableKeyException("avvolge"), new IOException("archivio")), sdk));
        }
    }

    @Test
    public void ilVerdettoDelSistemaDiceDellaChiaveSoloQuandoNonESistemaENonEPasseggero() {
        // Le quattro combinazioni delle due risposte: solo «né passeggero né di sistema» è un guasto della chiave.
        assertTrue("né l'uno né l'altro", new Verdetto(false, false).eDellaChiave());
        assertFalse("passeggero", new Verdetto(true, false).eDellaChiave());
        assertFalse("di sistema", new Verdetto(false, true).eDellaChiave());
        assertFalse("di sistema e passeggero", new Verdetto(true, true).eDellaChiave());
    }

    @Test
    public void perCifrarePrimaDiApi33LaChiaveSiEliminaSempreEIlVerdettoNonSiChiedeNemmeno() {
        // API 24-32: il sistema non dà un verdetto, e vale il comportamento di sempre (si elimina e si ricrea), anche se la catena porta un
        // «passeggero» o un «errore di sistema» che da API 33 la salverebbero.
        final AtomicInteger richieste = new AtomicInteger();
        final Function<Throwable, Verdetto> contaLeRichieste = causa -> {
            richieste.incrementAndGet();
            return VERDETTO_DEL_SISTEMA.apply(causa);
        };
        for (int sdk : new int[]{24, 26, 29, 30, 32}) {
            for (Throwable guasto : new Throwable[]{new UnrecoverableKeyException("chiave"),
                    conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSi()), conCausa(new UnrecoverableKeyException("chiave"), new VerdettoNo()),
                    conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSistema())}) {
                assertTrue("sdk " + sdk + ", causa " + DiagnosticaLocale.classe(guasto.getCause()),
                        SegretiCaricamenti.CifrarioKeystore.eDaEliminare(true, guasto, sdk, contaLeRichieste));
            }
        }
        assertEquals("prima di API 33 il verdetto non si chiede", 0, richieste.get());
    }

    // ── La catena delle cause: il tetto di profondità e i cicli ──

    @Test(timeout = 10_000)
    public void ilVerdettoSiCercaFinoAlTettoDiProfonditaENonGiraAVuotoSeSiMordeLaCoda() {
        UnrecoverableKeyException circolare = new UnrecoverableKeyException("circolare") {
            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        };
        assertTrue("termina, e senza un verdetto in catena il guasto è permanente: si elimina", daEliminare(true, circolare, 33));
        assertNull(SegretiCaricamenti.CifrarioKeystore.verdettoNellaCatena(circolare, VERDETTO_DEL_SISTEMA));

        int tetto = SegretiCaricamenti.CifrarioKeystore.PROFONDITA_MASSIMA_DELLE_CAUSE;
        // La profondità 0 è la radice: con un tetto di N si vedono le cause 0..N-1, e quella di indice N-1 è l'ultima.
        VerdettoSi fondo = new VerdettoSi();
        Throwable ultimaVista = stratiSopra(fondo, tetto - 1);
        Throwable primaNonVista = stratiSopra(new VerdettoSi(), tetto);
        assertSame("il verdetto è quello della causa trovata", fondo.verdetto,
                SegretiCaricamenti.CifrarioKeystore.verdettoNellaCatena(ultimaVista, VERDETTO_DEL_SISTEMA));
        assertNull("oltre il tetto non si guarda", SegretiCaricamenti.CifrarioKeystore.verdettoNellaCatena(primaNonVista, VERDETTO_DEL_SISTEMA));
        assertFalse("l'ultima causa vista salva la chiave", daEliminare(true, ultimaVista, 34));
        assertTrue("la prima non vista no: nessun verdetto, guasto permanente", daEliminare(true, primaNonVista, 34));
        assertTrue("anche il verdetto di eTransitorio arriva fino all'ultima causa vista", transitorio(ultimaVista, 34));
        assertFalse("e non oltre", transitorio(primaNonVista, 34));
        // Lo stesso per la regola dei tipi: un errore di I/O all'ultima causa vista è un passeggero, uno più sotto no.
        assertTrue(transitorio(stratiSopra(new IOException("archivio"), tetto - 1), 34));
        assertFalse(transitorio(stratiSopra(new IOException("archivio"), tetto), 34));
    }

    // ── La reazione a una chiave inutilizzabile: decisione, riga di avviso, rilancio ──

    /** Un'eliminazione finta: conta le volte, e può fallire come `KeyStore.deleteEntry`. */
    private static final class EliminazioneFinta implements SegretiCaricamenti.CifrarioKeystore.Eliminazione {
        int volte = 0;
        GeneralSecurityException guasto;

        @Override
        public void esegui() throws GeneralSecurityException {
            volte++;
            if (guasto != null) throw guasto;
        }
    }

    /** Lancia `trattaLaChiaveInutilizzabile` e restituisce le righe che ha scritto in logcat; se il guasto esce, lo mette in `uscito[0]`. */
    private static List<String> trattaERaccogli(UnrecoverableKeyException guasto, boolean perCifrare, int sdk, EliminazioneFinta elimina, Throwable[] uscito) {
        try (RigheDiLogcat logcat = new RigheDiLogcat()) {
            try {
                SegretiCaricamenti.CifrarioKeystore.trattaLaChiaveInutilizzabile(guasto, perCifrare, sdk, VERDETTO_DEL_SISTEMA, elimina);
            } catch (Throwable rilanciato) {
                uscito[0] = rilanciato;
            }
            return new ArrayList<>(logcat.righe);
        }
    }

    @Test
    public void unaChiaveInutilizzabileInLetturaSiRilanciaTaleEQualeSenzaEliminarlaMaiEConUnaRigaDiAvviso() {
        // In lettura la chiave non si elimina MAI, su nessun livello e con nessun verdetto: né se il sistema dice «della chiave», né se non dice
        // niente (l'invalidazione permanente arriva senza causa), né se dice «passeggero» o «di sistema». Sono i guasti PERMANENTI a provare la
        // regola della lettura: un «passeggero» o un «di sistema» salverebbero la chiave anche senza.
        for (int sdk : new int[]{24, 30, 32, 33, 34}) {
            for (Throwable causa : new Throwable[]{null, new VerdettoNo(), new VerdettoSi(), new VerdettoSistema(), new VerdettoSistemaPasseggero()}) {
                UnrecoverableKeyException guasto = new UnrecoverableKeyException("Failed to obtain information about key");
                if (causa != null) guasto.initCause(causa);
                EliminazioneFinta elimina = new EliminazioneFinta();
                Throwable[] uscito = new Throwable[1];

                List<String> righe = trattaERaccogli(guasto, false, sdk, elimina, uscito);

                String caso = "sdk " + sdk + ", causa " + DiagnosticaLocale.classe(causa);
                assertSame(caso + ": tale e quale, a decidere è chi chiama (`guastoTransitorio`)", guasto, uscito[0]);
                assertEquals(caso + ": la chiave non si tocca", 0, elimina.volte);
                assertEquals(caso + ": una riga sola", 1, righe.size());
                assertEquals(caso, "W KidvilleCaricamenti chiave dei segreti non utilizzabile in lettura (UnrecoverableKeyException, causa: "
                        + DiagnosticaLocale.classe(causa) + ", API " + sdk + "): non si elimina, il guasto torna a chi chiama", righe.get(0));
            }
        }
    }

    @Test
    public void unaChiaveInutilizzabileInScritturaConUnGuastoPasseggeroSiRilanciaSenzaEliminarlaEConUnaRigaDiAvviso() {
        UnrecoverableKeyException guasto = conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), new VerdettoSi());
        EliminazioneFinta elimina = new EliminazioneFinta();
        Throwable[] uscito = new Throwable[1];

        List<String> righe = trattaERaccogli(guasto, true, 33, elimina, uscito);

        assertSame("il guasto passeggero esce tale e quale: niente chiave nuova sullo stesso alias", guasto, uscito[0]);
        assertEquals("la chiave non si tocca", 0, elimina.volte);
        assertEquals("una riga sola", 1, righe.size());
        assertTrue(righe.get(0), righe.get(0).startsWith(
                "W KidvilleCaricamenti chiave dei segreti non utilizzabile in scrittura (UnrecoverableKeyException, causa: VerdettoSi, API 33): non si elimina"));
    }

    @Test
    public void unaChiaveInutilizzabileInScritturaConUnErroreDiSistemaSiRilanciaSenzaEliminarlaEConUnaRigaDiAvviso() {
        // SYSTEM_ERROR dopo una connessione persa col demone: di sistema, NON passeggero. Un errore di sistema si rilancia senza eliminare.
        for (int sdk : new int[]{33, 34, 36}) {
            for (GuastoConVerdetto sistema : new GuastoConVerdetto[]{new VerdettoSistema(), new VerdettoSistemaPasseggero()}) {
                UnrecoverableKeyException guasto = conCausa(new UnrecoverableKeyException("Failed to obtain information about key"), sistema);
                EliminazioneFinta elimina = new EliminazioneFinta();
                Throwable[] uscito = new Throwable[1];

                List<String> righe = trattaERaccogli(guasto, true, sdk, elimina, uscito);

                String caso = "sdk " + sdk + ", " + DiagnosticaLocale.classe(sistema);
                assertSame(caso + ": esce tale e quale: niente chiave nuova sullo stesso alias", guasto, uscito[0]);
                assertEquals(caso + ": la chiave non si tocca", 0, elimina.volte);
                assertEquals(caso + ": una riga sola", 1, righe.size());
                assertEquals(caso, "W KidvilleCaricamenti chiave dei segreti non utilizzabile in scrittura (UnrecoverableKeyException, causa: "
                        + DiagnosticaLocale.classe(sistema) + ", API " + sdk + "): non si elimina, il guasto torna a chi chiama", righe.get(0));
            }
        }
    }

    @Test
    public void unaChiaveInutilizzabileInScritturaConUnGuastoPermanenteSiEliminaEConUnaRigaDiAvviso() {
        for (UnrecoverableKeyException guasto : new UnrecoverableKeyException[]{conCausa(new UnrecoverableKeyException("avvolge"), new VerdettoNo()),
                new UnrecoverableKeyException("User changed or deleted their auth credentials")}) {
            EliminazioneFinta elimina = new EliminazioneFinta();
            Throwable[] uscito = new Throwable[1];

            List<String> righe = trattaERaccogli(guasto, true, 35, elimina, uscito);

            assertNull("eliminata la chiave si prosegue: nessun guasto esce", uscito[0]);
            assertEquals("la chiave si elimina, una volta", 1, elimina.volte);
            assertEquals("una riga sola", 1, righe.size());
            assertTrue(righe.get(0), righe.get(0).startsWith("W KidvilleCaricamenti chiave dei segreti non utilizzabile in scrittura (UnrecoverableKeyException, causa: "));
            assertTrue(righe.get(0), righe.get(0).contains(", API 35): guasto permanente, si prova a eliminare la chiave e a crearne una nuova"));
            assertFalse("la riga è scritta PRIMA dell'eliminazione: non afferma che la chiave si elimina", righe.get(0).contains("si elimina la chiave"));
        }
    }

    @Test
    public void suApi24Fino32UnaChiaveInutilizzabileInScritturaSiEliminaAncheSeLaCatenaPortaUnPasseggero() {
        UnrecoverableKeyException guasto = conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSi());
        EliminazioneFinta elimina = new EliminazioneFinta();
        Throwable[] uscito = new Throwable[1];

        List<String> righe = trattaERaccogli(guasto, true, 32, elimina, uscito);

        assertNull(uscito[0]);
        assertEquals("il sistema non dà un verdetto su questi livelli: come sempre, si elimina", 1, elimina.volte);
        assertEquals(1, righe.size());
        assertTrue(righe.get(0), righe.get(0).contains(", API 32): guasto permanente, si prova a eliminare la chiave e a crearne una nuova"));
    }

    @Test
    public void suApi24Fino32UnaChiaveInutilizzabileInScritturaSiEliminaAncheSeLaCatenaPortaUnErroreDiSistema() {
        // Su questi livelli `KeyStoreException#isSystemError` non esiste: il verdetto non si chiede, e si elimina come sempre.
        UnrecoverableKeyException guasto = conCausa(new UnrecoverableKeyException("chiave"), new VerdettoSistema());
        EliminazioneFinta elimina = new EliminazioneFinta();
        Throwable[] uscito = new Throwable[1];

        trattaERaccogli(guasto, true, 32, elimina, uscito);

        assertNull(uscito[0]);
        assertEquals(1, elimina.volte);
    }

    @Test
    public void lEliminazioneCheNonRiesceFaUscireIlSuoGuastoDopoLaRigaDiAvviso() {
        UnrecoverableKeyException guasto = new UnrecoverableKeyException("chiave");
        EliminazioneFinta elimina = new EliminazioneFinta();
        elimina.guasto = new java.security.KeyStoreException("eliminazione non riuscita");
        Throwable[] uscito = new Throwable[1];

        List<String> righe = trattaERaccogli(guasto, true, 34, elimina, uscito);

        assertSame("il guasto dell'eliminazione esce, non si inghiotte", elimina.guasto, uscito[0]);
        assertEquals("ci si è provato una volta sola", 1, elimina.volte);
        assertEquals("e la riga che dice perché c'è, scritta PRIMA del tentativo", 1, righe.size());
        assertTrue("la riga dice che ci si PROVA e che i segreti diventano illeggibili solo SE riesce: l'eliminazione è fallita, e non ha detto il falso",
                righe.get(0).contains("si prova a eliminare la chiave") && righe.get(0).contains("se riesce, i segreti già salvati diventano illeggibili"));
        assertFalse("e non afferma che la chiave si elimina", righe.get(0).contains("si elimina la chiave"));
    }

    @Test
    public void laRigaDiAvvisoDellaChiaveNonPortaMaiAliasPercorsoNeMessaggioNeIdentificativi() {
        String messaggio = "kvr_" + "A".repeat(43) + " /data/user/0/it.kidville.app/no_backup/caricamenti/segreti/privato " + SegretiCaricamenti.ALIAS_CHIAVE;
        List<String> tutte = new ArrayList<>();
        for (boolean perCifrare : new boolean[]{false, true}) {
            for (Throwable causa : new Throwable[]{new VerdettoSi(), new VerdettoNo(), new VerdettoSistema(), new RuntimeException(messaggio), null}) {
                UnrecoverableKeyException guasto = new UnrecoverableKeyException(messaggio);
                if (causa != null) guasto.initCause(causa);
                tutte.addAll(trattaERaccogli(guasto, perCifrare, 34, new EliminazioneFinta(), new Throwable[1]));
            }
        }
        assertEquals("due fasi per cinque cause, una riga ciascuna", 10, tutte.size());
        for (String riga : tutte) {
            assertTrue(riga, riga.startsWith("W KidvilleCaricamenti chiave dei segreti non utilizzabile in "));
            assertFalse("niente messaggio d'eccezione: " + riga, riga.contains("kvr_") || riga.contains("privato") || riga.contains("/data/") || riga.contains("sistema:"));
            assertFalse("niente alias: " + riga, riga.contains(SegretiCaricamenti.ALIAS_CHIAVE) || riga.contains("alias"));
        }
    }

    // ── `cifra` e `decifra` di produzione: a che cosa serve la chiave che chiedono ──

    private static SecretKey chiaveSoftware() throws Exception {
        javax.crypto.KeyGenerator generatore = javax.crypto.KeyGenerator.getInstance("AES");
        generatore.init(256);
        return generatore.generateKey();
    }

    @Test
    public void cifraChiedeLaChiavePerCifrareEDecifraPerDecifrareEIlBloccoHaLaFormaDiProduzione() throws Exception {
        final SecretKey chiave = chiaveSoftware();
        final List<Boolean> richieste = new ArrayList<>();
        SegretiCaricamenti.CifrarioKeystore keystore = new SegretiCaricamenti.CifrarioKeystore(perCifrare -> {
            richieste.add(perCifrare);
            return chiave;
        });
        byte[] dati = SegretiCaricamenti.datiAssociati(id(1));
        byte[] chiaro = "un segreto qualunque".getBytes(StandardCharsets.UTF_8);

        byte[] cifrato = keystore.cifra(chiaro, dati);

        assertEquals("cifrando, la chiave serve per cifrare (e, se inutilizzabile, può essere eliminata)", Arrays.asList(Boolean.TRUE), richieste);
        assertEquals("[lunghezza dell'IV: 1 byte][IV di 12][testo cifrato + tag di 16]", 1 + 12 + chiaro.length + 16, cifrato.length);
        assertEquals(12, cifrato[0]);
        assertArrayEquals("il giro torna", chiaro, keystore.decifra(cifrato, dati));
        assertEquals("decifrando, la chiave serve per decifrare: MAI eliminabile", Arrays.asList(Boolean.TRUE, Boolean.FALSE), richieste);
    }

    @Test
    public void salvaChiedeLaChiavePerCifrareELeggiPerDecifrareAncheDallaClasseDeiSegreti() throws Exception {
        final SecretKey chiave = chiaveSoftware();
        final List<Boolean> richieste = new ArrayList<>();
        SegretiCaricamenti diProva = new SegretiCaricamenti(coda, new SegretiCaricamenti.CifrarioKeystore(perCifrare -> {
            richieste.add(perCifrare);
            return chiave;
        }));

        diProva.salva(id(1), esempio());
        assertEquals(Arrays.asList(Boolean.TRUE), richieste);
        Lettura l = diProva.leggi(id(1));

        assertSame(Esito.OK, l.esito);
        assertEquals(TOKEN, l.segreti.token);
        assertEquals("leggere decifra, e decifrare non può eliminare la chiave", Arrays.asList(Boolean.TRUE, Boolean.FALSE), richieste);
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * COMPITO A2d: IL KEYSTORE IRRAGGIUNGIBILE È UN GUASTO CHE PASSA, E IL CABLAGGIO DELLA CHIAVE È PROVATO CON UN ANDROIDKEYSTORE FINTO
     * (seguito dei secondari n. 153 e n. 154, critico di A2c)
     * ──────────────────────────────────────────────────────────────────────────── */

    // ── L'IllegalStateException nuda di KeyStore2.getService (KeyStore2.java:148-157) ──

    /** Il messaggio vero di AOSP (KeyStore2.java:154-156): nel sorgente va a capo, ma è una frase sola. */
    private static final String KEYSTORE_ASSENTE = "Could not connect to Keystore service. Keystore may have crashed or not been initialized";

    @Test
    public void unIllegalStateExceptionDelKeystoreIrraggiungibileEPasseggeraSuTuttiILivelliDiApi() {
        for (int sdk : new int[]{0, 24, 29, 32, 33, 34, 36}) {
            assertTrue("sdk " + sdk, transitorio(new IllegalStateException(KEYSTORE_ASSENTE), sdk));
            assertTrue("sdk " + sdk + ": sotto un altro guasto",
                    transitorio(conCausa(new GeneralSecurityException("avvolge"), new IllegalStateException(KEYSTORE_ASSENTE)), sdk));
            assertTrue("sdk " + sdk + ": sopra un altro guasto",
                    transitorio(conCausa(new IllegalStateException(KEYSTORE_ASSENTE), new RuntimeException("sotto")), sdk));
            assertTrue("sdk " + sdk + ": con altri strati sopra", transitorio(stratiSopra(new IllegalStateException(KEYSTORE_ASSENTE), 3), sdk));
        }
    }

    @Test
    public void ilMessaggioDelKeystoreIrraggiungibileSiRiconoscePiccoleVariazioniIncluse() {
        for (String variante : new String[]{KEYSTORE_ASSENTE, KEYSTORE_ASSENTE.toUpperCase(Locale.ROOT), KEYSTORE_ASSENTE.toLowerCase(Locale.ROOT),
                "Could not connect to Keystore service", "could not connect to the KeyStore service", "Cannot connect to Keystore daemon",
                "Unable to connect to keystore", "  Could   not\nconnect to\tKeystore service  "}) {
            assertTrue("«" + variante + "»", SegretiCaricamenti.CifrarioKeystore.eKeystoreIrraggiungibile(new IllegalStateException(variante)));
        }
    }

    @Test
    public void unIllegalStateExceptionQualunqueRestaDefinitivaESoloQuellaDelKeystoreIrraggiungibilePassa() {
        for (int sdk : new int[]{0, 24, 33, 36}) {
            for (String altro : new String[]{null, "", "boom", "sconosciuto", "Cipher not initialized", "Could not connect to database",
                    "Keystore operation failed", "connect", "keystore"}) {
                assertFalse("sdk " + sdk + ", «" + altro + "»", transitorio(new IllegalStateException(altro), sdk));
            }
            // Il TIPO conta: lo stesso testo in un'eccezione di un altro tipo non è «il servizio non c'è».
            assertFalse("sdk " + sdk + ": RuntimeException", transitorio(new RuntimeException(KEYSTORE_ASSENTE), sdk));
            assertFalse("sdk " + sdk + ": GeneralSecurityException", transitorio(new GeneralSecurityException(KEYSTORE_ASSENTE), sdk));
            assertFalse("sdk " + sdk + ": UnsupportedOperationException", transitorio(new UnsupportedOperationException(KEYSTORE_ASSENTE), sdk));
        }
        assertFalse("nessuna causa", SegretiCaricamenti.CifrarioKeystore.eKeystoreIrraggiungibile(null));
    }

    @Test
    public void unDefinitivoInCatenaVinceSulKeystoreIrraggiungibile() {
        for (int sdk : new int[]{0, 24, 33, 36}) {
            assertFalse("sdk " + sdk + ": contenuto toccato sopra",
                    transitorio(conCausa(new BadPaddingException("tag"), new IllegalStateException(KEYSTORE_ASSENTE)), sdk));
            assertFalse("sdk " + sdk + ": chiave invalidata sotto",
                    transitorio(conCausa(new IllegalStateException(KEYSTORE_ASSENTE), new KeyPermanentlyInvalidatedException()), sdk));
        }
    }

    @Test
    public void daApi33SeIlSistemaHaDettoLaSuaDecideLuiAncheConUnKeystoreIrraggiungibileInCatena() {
        for (int sdk : new int[]{33, 34, 36}) {
            assertFalse("sdk " + sdk + ": «della chiave» vale anche con il servizio irraggiungibile in catena",
                    transitorio(conCausa(new IllegalStateException(KEYSTORE_ASSENTE), new VerdettoNo()), sdk));
        }
        assertTrue("prima di API 33 non c'è verdetto: vale la regola del servizio irraggiungibile",
                transitorio(conCausa(new IllegalStateException(KEYSTORE_ASSENTE), new VerdettoNo()), 32));
    }

    @Test
    public void unKeystoreIrraggiungibileNonRendeIlleggibiliISegretiLaVoceAspetta() throws Exception {
        final SecretKey chiave = chiaveSoftware();
        final AtomicBoolean servizioGiu = new AtomicBoolean();
        SegretiCaricamenti s = new SegretiCaricamenti(coda, new SegretiCaricamenti.CifrarioKeystore(perCifrare -> {
            if (servizioGiu.get()) throw new IllegalStateException(KEYSTORE_ASSENTE);
            return chiave;
        }));
        s.salva(id(1), esempio());
        byte[] prima = Files.readAllBytes(file(id(1)).toPath());

        servizioGiu.set(true);
        Lettura l = s.leggi(id(1));

        assertSame("il servizio non risponde: la voce aspetta, i segreti non sono persi", Esito.NON_LEGGIBILE_ORA, l.esito);
        assertNull(l.segreti);
        assertArrayEquals("e il file non è stato toccato", prima, Files.readAllBytes(file(id(1)).toPath()));
        servizioGiu.set(false);
        Lettura dopo = s.leggi(id(1));
        assertSame("tornato il servizio, i segreti ci sono tutti", Esito.OK, dopo.esito);
        assertEquals(TOKEN, dopo.segreti.token);
    }

    // ── Il cablaggio di `chiave(boolean)`, col codice di produzione vero e un AndroidKeyStore finto ──

    /** Il nome con cui l'AndroidKeyStore si presenta a `KeyStore.getInstance`. */
    private static final String NOME_ANDROID_KEYSTORE = "AndroidKeyStore";

    /**
     * Un archivio delle chiavi che fa le veci dell'«AndroidKeyStore» sulla JVM, dove non esiste: `engineGetKey` lancia sempre `guasto` (un
     * `UnrecoverableKeyException`, come `getKey` quando il sistema non restituisce la chiave) e `engineDeleteEntry` registra gli alias. È per
     * questo che la prova passa dal metodo `chiave(boolean)` VERO, e non da un fornitore finto della chiave (`FornitoreDellaChiave`): chi lo
     * cabla male (la chiave che si elimina leggendo, quella che non si elimina scrivendo, l'alias sbagliato) fa diventare rossa la prova.
     */
    private static final class ArchivioChiaviFinto extends KeyStoreSpi {
        final List<String> aliasLetti = Collections.synchronizedList(new ArrayList<>());
        final List<String> aliasEliminati = Collections.synchronizedList(new ArrayList<>());
        final UnrecoverableKeyException guasto = new UnrecoverableKeyException("Failed to obtain information about key");

        @Override
        public Key engineGetKey(String alias, char[] password) throws UnrecoverableKeyException {
            aliasLetti.add(alias);
            throw guasto;
        }

        @Override
        public void engineDeleteEntry(String alias) {
            aliasEliminati.add(alias);
        }

        @Override
        public void engineLoad(InputStream stream, char[] password) {
            // niente da caricare: `keystore.load(null)` deve solo riuscire
        }

        // Il resto non serve a `chiave(boolean)`.

        @Override
        public Certificate[] engineGetCertificateChain(String alias) {
            return null;
        }

        @Override
        public Certificate engineGetCertificate(String alias) {
            return null;
        }

        @Override
        public Date engineGetCreationDate(String alias) {
            return null;
        }

        @Override
        public void engineSetKeyEntry(String alias, Key key, char[] password, Certificate[] chain) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineSetKeyEntry(String alias, byte[] key, Certificate[] chain) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void engineSetCertificateEntry(String alias, Certificate cert) {
            throw new UnsupportedOperationException();
        }

        @Override
        public Enumeration<String> engineAliases() {
            return Collections.emptyEnumeration();
        }

        @Override
        public boolean engineContainsAlias(String alias) {
            return false;
        }

        @Override
        public int engineSize() {
            return 0;
        }

        @Override
        public boolean engineIsKeyEntry(String alias) {
            return false;
        }

        @Override
        public boolean engineIsCertificateEntry(String alias) {
            return false;
        }

        @Override
        public String engineGetCertificateAlias(Certificate cert) {
            return null;
        }

        @Override
        public void engineStore(OutputStream stream, char[] password) {
            throw new UnsupportedOperationException();
        }
    }

    /** Il provider di sicurezza che mette l'archivio finto sotto il nome «AndroidKeyStore»: `KeyStore.getInstance("AndroidKeyStore")` trova lui. */
    private static final class ProviderFinto extends Provider {
        ProviderFinto(ArchivioChiaviFinto archivio) {
            // La versione è un `double` (deprecato dal JDK 9): è il solo costruttore che la compilazione dei test di Gradle risolve, quello
            // con la stringa dà «String cannot be converted to double» (provato: `--release 8`, e `-source 8` con la bootclasspath di Android).
            super(NOME_ANDROID_KEYSTORE, 1.0, "archivio delle chiavi finto, solo per le prove sulla JVM");
            putService(new Provider.Service(this, "KeyStore", NOME_ANDROID_KEYSTORE, ArchivioChiaviFinto.class.getName(), null, null) {
                @Override
                public Object newInstance(Object parametro) {
                    return archivio;
                }
            });
        }
    }

    /** Installa l'AndroidKeyStore finto per la durata di un blocco `try` e lo toglie sempre, anche se la prova cade a metà. */
    private static final class AndroidKeyStoreFinto implements AutoCloseable {
        final ArchivioChiaviFinto archivio = new ArchivioChiaviFinto();

        AndroidKeyStoreFinto() {
            // Il codice di produzione legge `Build.VERSION.SDK_INT`, che sulla JVM vale 0: le prove di cablaggio contano su questo (sotto API 33 si
            // elimina come sempre, e le righe dicono «API 0»). Se un giorno non fosse più così, qui si dice perché cadono.
            assertEquals("le prove di cablaggio presuppongono Build.VERSION.SDK_INT = 0, come sulla JVM", 0, android.os.Build.VERSION.SDK_INT);
            Security.removeProvider(NOME_ANDROID_KEYSTORE); // un residuo di una prova caduta a metà
            assertNotEquals("il provider finto non si è installato", -1, Security.addProvider(new ProviderFinto(archivio)));
        }

        @Override
        public void close() {
            Security.removeProvider(NOME_ANDROID_KEYSTORE);
        }
    }

    @After
    public void ilProviderFintoNonRestaInstallato() {
        Security.removeProvider(NOME_ANDROID_KEYSTORE);
    }

    /** Un blocco della FORMA di `cifra` (`[12][IV di 12][testo + tag]`): `decifra` lo accetta fino alla chiave, che è ciò che qui si prova. */
    private static byte[] bloccoDiForma() {
        byte[] blocco = new byte[1 + 12 + 16 + 1];
        blocco[0] = 12;
        return blocco;
    }

    @Test
    public void inDecifraturaUnaChiaveInutilizzabileNonSiEliminaMaiELaRilanciaTaleEQuale() throws Exception {
        try (AndroidKeyStoreFinto finto = new AndroidKeyStoreFinto(); RigheDiLogcat logcat = new RigheDiLogcat()) {
            SegretiCaricamenti.CifrarioKeystore keystore = new SegretiCaricamenti.CifrarioKeystore();

            try {
                keystore.decifra(bloccoDiForma(), SegretiCaricamenti.datiAssociati(id(1)));
                fail("la chiave non si recupera: decifrare doveva lanciare");
            } catch (UnrecoverableKeyException rilanciato) {
                assertSame("tale e quale: a decidere è chi chiama (`guastoTransitorio`)", finto.archivio.guasto, rilanciato);
            }

            assertEquals("si è chiesta la chiave giusta, una volta", Arrays.asList(SegretiCaricamenti.ALIAS_CHIAVE), finto.archivio.aliasLetti);
            assertEquals("in lettura la chiave NON si elimina: distruggerebbe i segreti di tutte le voci vive", 0, finto.archivio.aliasEliminati.size());
            assertEquals("una riga sola", 1, logcat.righe.size());
            assertEquals("W KidvilleCaricamenti chiave dei segreti non utilizzabile in lettura (UnrecoverableKeyException, causa: senza causa, API 0): "
                    + "non si elimina, il guasto torna a chi chiama", logcat.righe.get(0));
        }
        assertNull("il provider finto è stato tolto", Security.getProvider(NOME_ANDROID_KEYSTORE));
    }

    @Test
    public void inCifraturaUnaChiaveInutilizzabileSiEliminaUnaVoltaEPoiSiPassaAllaChiaveNuova() throws Exception {
        try (AndroidKeyStoreFinto finto = new AndroidKeyStoreFinto(); RigheDiLogcat logcat = new RigheDiLogcat()) {
            SegretiCaricamenti.CifrarioKeystore keystore = new SegretiCaricamenti.CifrarioKeystore();
            Throwable uscito = null;

            try {
                keystore.cifra("un segreto qualunque".getBytes(StandardCharsets.UTF_8), SegretiCaricamenti.datiAssociati(id(1)));
                fail("la chiave nuova non si può generare sulla JVM (l'archivio finto non sa farlo): cifrare doveva lanciare");
            } catch (GeneralSecurityException | RuntimeException dopoLEliminazione) {
                uscito = dopoLEliminazione;
            }

            assertEquals("si è chiesta la chiave giusta, una volta", Arrays.asList(SegretiCaricamenti.ALIAS_CHIAVE), finto.archivio.aliasLetti);
            assertEquals("scrivendo, la chiave inutilizzabile si elimina: una volta, con l'alias giusto",
                    Arrays.asList(SegretiCaricamenti.ALIAS_CHIAVE), finto.archivio.aliasEliminati);
            assertNotSame("ciò che esce non è più il guasto di `getKey`: eliminata la chiave si è passati a generare quella nuova",
                    finto.archivio.guasto, uscito);
            assertFalse("e non è un UnrecoverableKeyException: la chiave vecchia non c'è più", uscito instanceof UnrecoverableKeyException);
            assertEquals("una riga sola, scritta prima dell'eliminazione", 1, logcat.righe.size());
            assertTrue(logcat.righe.get(0), logcat.righe.get(0).startsWith("W KidvilleCaricamenti chiave dei segreti non utilizzabile in scrittura "
                    + "(UnrecoverableKeyException, causa: senza causa, API 0): guasto permanente, si prova a eliminare la chiave"));
        }
        assertNull("il provider finto è stato tolto", Security.getProvider(NOME_ANDROID_KEYSTORE));
    }

    @Test
    public void lAliasDellaChiaveEQuelloDelCifrarioInLetturaEInEliminazione() throws Exception {
        try (AndroidKeyStoreFinto finto = new AndroidKeyStoreFinto()) {
            SegretiCaricamenti.CifrarioKeystore conAliasSuo = new SegretiCaricamenti.CifrarioKeystore("alias-di-prova");
            try {
                conAliasSuo.decifra(bloccoDiForma(), SegretiCaricamenti.datiAssociati(id(1)));
                fail("doveva lanciare");
            } catch (UnrecoverableKeyException atteso) {
                // rilanciato
            }
            try {
                conAliasSuo.cifra(new byte[]{1, 2, 3}, SegretiCaricamenti.datiAssociati(id(1)));
                fail("doveva lanciare");
            } catch (GeneralSecurityException | RuntimeException atteso) {
                // la chiave nuova non si genera sulla JVM
            }
            assertEquals("l'alias chiesto è quello del cifrario, in lettura e in scrittura", Arrays.asList("alias-di-prova", "alias-di-prova"),
                    finto.archivio.aliasLetti);
            assertEquals("e quello eliminato anche", Arrays.asList("alias-di-prova"), finto.archivio.aliasEliminati);
        }
    }

    @Test
    public void laClasseDeiSegretiConLaChiaveDiProduzioneLeggendoNonEliminaESalvandoElimina() throws Exception {
        segreti.salva(id(1), esempio()); // scritto col cifrario software: il blocco ha la stessa forma di quello del Keystore
        byte[] prima = Files.readAllBytes(file(id(1)).toPath());
        try (AndroidKeyStoreFinto finto = new AndroidKeyStoreFinto(); RigheDiLogcat logcat = new RigheDiLogcat()) {
            SegretiCaricamenti diProduzione = SegretiCaricamenti.diProduzione(coda);

            Lettura l = diProduzione.leggi(id(1));

            assertSame("sulla JVM (API 0) un UnrecoverableKeyException è un contenitore definitivo, e senza chiave il segreto non si legge", Esito.ILLEGGIBILE,
                    l.esito);
            assertEquals("ma leggere non elimina la chiave", 0, finto.archivio.aliasEliminati.size());
            assertArrayEquals("e il file non è stato toccato", prima, Files.readAllBytes(file(id(1)).toPath()));

            try {
                diProduzione.salva(id(2), esempio());
                fail("con una chiave inutilizzabile e senza poterne generare una nuova, salvare doveva lanciare");
            } catch (IOException atteso) {
                assertFalse("il messaggio non porta il contenuto", atteso.getMessage().contains("kvr_"));
            }

            assertEquals("scrivere, con una chiave inutilizzabile, la elimina: una volta", 1, finto.archivio.aliasEliminati.size());
            assertFalse("e non resta un file a metà", file(id(2)).exists());
            assertTrue("e c'è una riga di avviso per ciascuna delle due reazioni alla chiave", logcat.conta("chiave dei segreti non utilizzabile in lettura") == 1
                    && logcat.conta("chiave dei segreti non utilizzabile in scrittura") == 1);
        }
    }
}
