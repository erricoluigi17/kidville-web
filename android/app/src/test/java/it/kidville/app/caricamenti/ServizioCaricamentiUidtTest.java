package it.kidville.app.caricamenti;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

import android.app.job.JobParameters;
import android.app.job.JobService;

import it.kidville.app.caricamenti.EsecutoreCoda.EsitoCiclo;

import org.junit.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.List;

/**
 * Il guscio UIDT (spec §6.2; compito A2b, secondari n. 76 e n. 88 della PR 3): ciò che si può provare sulla JVM senza un telefono. Il
 * servizio si istanzia (i metodi di Android che non tocca restano finti) e il corpo del suo thread è una funzione statica: quello che
 * decide se `jobFinished` chiede la riprogrammazione, e come si comporta con la fermata e con un ciclo precedente che sta ancora uscendo.
 */
public class ServizioCaricamentiUidtTest {

    private static boolean giro(CicloDelGuscio.MotoreDelGuscio motore, ServizioCaricamentiUidt.Esecuzione esecuzione) {
        return ServizioCaricamentiUidt.eseguiIlGiro(motore, null, esecuzione, ms -> {
        });
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 76: IL RIAVVIO CHE ARRIVA MENTRE IL CICLO PRECEDENTE STA USCENDO
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void unRiavvioCheTrovaIlCicloPrecedenteAncoraAttivoLoAspettaERiparteSenzaChiudereIlJobSenzaLavoro() {
        int[] chiamate = {0};
        // Il ciclo vecchio finisce di uscire alla terza richiesta: da lì il job nuovo fa il lavoro rimasto e lo porta a termine.
        CicloDelGuscio.MotoreDelGuscio motore = (p, tetto) -> ++chiamate[0] < 3 ? EsitoCiclo.GIA_ATTIVO : EsitoCiclo.FINITO;
        boolean riprogramma = giro(motore, new ServizioCaricamentiUidt.Esecuzione());
        assertEquals("il motore è stato richiamato finché l'altro non ha finito", 3, chiamate[0]);
        assertFalse("il lavoro è stato fatto: `jobFinished(params, false)`", riprogramma);
    }

    @Test
    public void seIlCicloPrecedenteNonFiniscePiuIlJobChiedeAlSistemaDiRichiamarlo() {
        CicloDelGuscio.MotoreDelGuscio sempreAttivo = (p, tetto) -> EsitoCiclo.GIA_ATTIVO;
        // Prima di questa correzione `riprogramma = (esito == RIPROVA)` era falso, e il job si chiudeva lasciando le voci senza nessun guscio.
        assertTrue("`jobFinished(params, true)`: le voci vive non restano senza nessuno", giro(sempreAttivo, new ServizioCaricamentiUidt.Esecuzione()));
    }

    @Test
    public void unaReteMancataOltreIlTettoChiedeLaRiprogrammazioneEUnCicloFinitoOInterrottoNo() {
        assertTrue("RIPROVA", giro((p, t) -> EsitoCiclo.RIPROVA, new ServizioCaricamentiUidt.Esecuzione()));
        assertFalse("FINITO", giro((p, t) -> EsitoCiclo.FINITO, new ServizioCaricamentiUidt.Esecuzione()));
        assertFalse("INTERROTTO: lo ha fermato il sistema, che lo riprogramma da sé", giro((p, t) -> EsitoCiclo.INTERROTTO, new ServizioCaricamentiUidt.Esecuzione()));
    }

    @Test
    public void unGuastoDelCicloValeRiprogrammaEsiDiceConLaSolaClasse() {
        try (RigheDiLogcat righe = new RigheDiLogcat()) {
            boolean riprogramma = giro((p, t) -> {
                throw new IllegalStateException("bug con /un/percorso/privato");
            }, new ServizioCaricamentiUidt.Esecuzione());
            assertTrue("le voci stanno su disco: si riprogramma", riprogramma);
            assertEquals(java.util.Arrays.asList("E KidvilleCaricamenti ciclo del job interrotto da un guasto (IllegalStateException)"), righe.righe);
        }
    }

    @Test
    public void unJobGiaFermatoNonFaPartireIlCiclo() {
        ServizioCaricamentiUidt.Esecuzione fermata = new ServizioCaricamentiUidt.Esecuzione();
        fermata.ferma();
        int[] chiamate = {0};
        boolean riprogramma = giro((p, t) -> {
            chiamate[0]++;
            return EsitoCiclo.FINITO;
        }, fermata);
        assertEquals(0, chiamate[0]);
        assertFalse("lo riprogramma il sistema (onStopJob ha detto `true`)", riprogramma);
    }

    @Test
    public void laFermataVaPerEsecuzioneENonPerIstanzaUnThreadVecchioNonVedeIlJobNuovo() {
        ServizioCaricamentiUidt servizio = new ServizioCaricamentiUidt();
        ServizioCaricamentiUidt.Esecuzione prima = servizio.nuovaEsecuzione();
        servizio.fermaLEsecuzioneCorrente();                              // onStopJob
        assertTrue("l'esecuzione fermata lo sa", prima.fermata());

        ServizioCaricamentiUidt.Esecuzione dopo = servizio.nuovaEsecuzione();   // il sistema riavvia il job (onStartJob)
        assertNotSame(prima, dopo);
        assertFalse("il job nuovo non eredita la fermata del vecchio", dopo.fermata());
        assertTrue("e il vecchio thread, che esce in ritardo, continua a vedersi fermato: prima il campo dell'istanza era già tornato falso",
                prima.fermata());

        servizio.fermaLEsecuzioneCorrente();                              // il sistema ferma il job nuovo
        assertTrue(dopo.fermata());
    }

    @Test
    public void fermareSenzaNessunaEsecuzioneNonLanciaNiente() {
        new ServizioCaricamentiUidt().fermaLEsecuzioneCorrente();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * N. 88: `onNetworkChanged` SU API 34+
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void ilServizioSovrascriveOnNetworkChangedEUnCambioDiReteNonFaCadereNienteEDiceUnaRigaInfoSenzaDati() throws Exception {
        Method metodo = ServizioCaricamentiUidt.class.getDeclaredMethod("onNetworkChanged", JobParameters.class);
        assertNotNull(metodo);
        assertTrue("pubblico, come nella classe di base", Modifier.isPublic(metodo.getModifiers()));
        assertEquals("lo dichiara questa classe, non l'eredita da JobService", ServizioCaricamentiUidt.class, metodo.getDeclaringClass());
        assertNotNull("e sovrascrive quello di JobService (da API 34)", JobService.class.getMethod("onNetworkChanged", JobParameters.class));

        try (RigheDiLogcat righe = new RigheDiLogcat()) {
            new ServizioCaricamentiUidt().onNetworkChanged(null);
            new ServizioCaricamentiUidt().onNetworkChanged(null);
            assertEquals("una riga `info` a ogni cambio, senza dati", java.util.Arrays.asList(
                    "I KidvilleCaricamenti rete del job cambiata: il trasferimento prosegue sulla rete predefinita",
                    "I KidvilleCaricamenti rete del job cambiata: il trasferimento prosegue sulla rete predefinita"), righe.righe);
        }
    }

    @Test
    public void ilServizioNonCambiaIlComportamentoDelJobSeLaReteCambia() {
        // Non ferma niente: dopo un cambio di rete la fermata non è alzata e una nuova esecuzione parte normale.
        ServizioCaricamentiUidt servizio = new ServizioCaricamentiUidt();
        ServizioCaricamentiUidt.Esecuzione esecuzione = servizio.nuovaEsecuzione();
        servizio.onNetworkChanged(null);
        assertFalse("un cambio di rete non è una fermata", esecuzione.fermata());
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CABLAGGIO DEL SERVIZIO (`onStartJob` e `onStopJob` non si eseguono sulla JVM: si prova che il codice chiami ciò che deve)
     * ──────────────────────────────────────────────────────────────────────────── */

    @Test
    public void onStartJobAprePerPrimaUnaEsecuzioneNuovaEFaGirareIlCicloDalCorpoProvato() throws Exception {
        String codice = SorgentiDiProva.codiceSenzaCommenti("ServizioCaricamentiUidt");
        String corpo = SorgentiDiProva.corpoDi(codice, "public boolean onStartJob(final JobParameters parametri)");
        assertTrue("ogni avvio comincia una esecuzione sua (la fermata è per esecuzione, n. 76)", corpo.contains("nuovaEsecuzione()"));
        assertTrue("e il thread passa dal corpo provato (aspetta un ciclo che sta uscendo)", corpo.contains("eseguiIlGiro(motore::eseguiSuGuscio, presentazione, esecuzione, Thread::sleep)"));
        assertTrue("`jobFinished` riceve ciò che il corpo ha deciso", corpo.contains("jobFinished(parametri, riprogramma)"));
        assertFalse("nessun campo condiviso dell'istanza che un riavvio possa riazzerare sotto un thread vecchio", codice.contains("boolean fermato"));
    }

    @Test
    public void onStopJobAlzaLaBandieraDellEsecuzioneCorrenteEFermaIlMotoreERiprogramma() throws Exception {
        String corpo = SorgentiDiProva.corpoDi(SorgentiDiProva.codiceSenzaCommenti("ServizioCaricamentiUidt"), "public boolean onStopJob(JobParameters parametri)");
        assertTrue(corpo.contains("fermaLEsecuzioneCorrente()"));
        assertTrue("la PUT in volo si interrompe", corpo.contains("fermaIlGuscio()"));
        assertTrue("restituisce `true`: il sistema riprogramma il job", corpo.contains("return true;"));
    }
}
