const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// 1. INITIALISATION SÉCURISÉE DE FIREBASE
// ==========================================
if (!admin.apps.length) {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        try {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log("Firebase initialisé avec succès sur Vercel !");
        } catch (error) {
            console.error("Erreur lors de la lecture du fichier JSON Firebase :", error);
        }
    } else {
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
        console.log("Firebase initialisé en local.");
    }
}

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

// ==========================================
// 2. ROUTE : INITIALISATION DU PAIEMENT
// ==========================================
app.post('/api/create-subscription-checkout', async (req, res) => {
  // Nous récupérons maintenant la "duration" (durée) envoyée par le HTML
  const { planName, restoId, amount, phone, redirectUrl, duration } = req.body;

  if (!planName || !restoId || !amount || !redirectUrl || !duration) {
    return res.status(400).json({ success: false, error: 'Données manquantes. Veuillez vérifier votre sélection.' });
  }

  const API_USER = process.env.FAPSHI_API_USER;
  const API_KEY = process.env.FAPSHI_API_KEY;

  if (!API_USER || !API_KEY) {
    return res.status(500).json({ success: false, error: 'Configuration Fapshi incomplète.' });
  }

  const webhookBase = process.env.BACKEND_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const webhookUrl = `${webhookBase}/api/fapshi-subscription-webhook`;

  const payload = {
    amount: Number(amount),
    currency: 'XAF',
    description: `Abonnement Pack ${planName} (${duration}) pour le restaurant`,
    redirect_url: redirectUrl,
    webhook_url: webhookUrl,
    phone: phone || ''
  };

  try {
    const fapshiRes = await fetch('https://live.fapshi.com/initiate-pay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apiuser': API_USER,
        'apikey': API_KEY
      },
      body: JSON.stringify(payload)
    });

    const respJson = await fapshiRes.json();
    if (!fapshiRes.ok) {
      return res.status(fapshiRes.status).json({ success: false, error: respJson.message || respJson.error });
    }

    const checkoutUrl = respJson.url || respJson.link;
    const fapshiTransId = respJson.transId;

    if (!checkoutUrl) return res.status(502).json({ success: false, error: 'URL de paiement manquante.' });

    // On enregistre la transaction dans Firebase en attendant la confirmation
    const transDocId = fapshiTransId || db.collection('subscriptionTransactions').doc().id;
    await db.collection('subscriptionTransactions').doc(transDocId).set({
      fapshiTransId: fapshiTransId,
      restoId: restoId,
      planName: planName,
      duration: duration, // On sauvegarde la durée pour le webhook
      amount: Number(amount),
      status: 'PENDING',
      dateInitiated: admin.firestore.FieldValue.serverTimestamp(),
      checkoutUrl
    });

    return res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error('Erreur initialisation:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur interne.' });
  }
});

// ==========================================
// 3. ROUTE : WEBHOOK DE CONFIRMATION FAPSHI
// ==========================================
app.post('/api/fapshi-subscription-webhook', async (req, res) => {
  const { status, transId } = req.body;

  if (status !== 'SUCCESSFUL') return res.status(200).json({ message: 'Statut ignoré.' });
  if (!transId) return res.status(400).json({ error: 'Données invalides.' });

  const transRef = db.collection('subscriptionTransactions').doc(transId);

  try {
    const transDoc = await transRef.get();
    if (!transDoc.exists) return res.status(200).json({ message: 'Transaction inconnue.' });

    const transData = transDoc.data();

    // Si la transaction a déjà été traitée, on s'arrête
    if (transData.status === 'CONFIRMED') {
      return res.status(200).json({ message: 'Transaction déjà confirmée.' });
    }

    // 1. Marquer la transaction comme confirmée
    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. Calculer la date d'expiration en fonction de la durée choisie
    let dateExpiration = null; // Par défaut null (pour les accès à vie)
    let statutExpirationText = "Illimité"; 

    if (transData.duration !== 'A_vie' && transData.duration !== 'Cle_en_main') {
      // C'est un abonnement mensuel (1, 3, 6, ou 12 mois)
      const monthsToAdd = parseInt(transData.duration) || 1;
      const now = new Date();
      now.setMonth(now.getMonth() + monthsToAdd);
      dateExpiration = admin.firestore.Timestamp.fromDate(now);
      statutExpirationText = `${monthsToAdd} mois`;
    }

    // 3. Mettre à jour le document de l'utilisateur (restaurant) avec toutes les informations
    if (transData.restoId && transData.planName) {
      await db.collection('restaurants').doc(transData.restoId).update({
        abonnement: transData.planName,
        dureeAbonnement: statutExpirationText, // Ex: "3 mois", "Illimité"
        dateDernierPaiement: admin.firestore.FieldValue.serverTimestamp(),
        dateExpirationAbonnement: dateExpiration, // Timestamp précis ou null si à vie
        montantDernierPaiement: transData.amount
      });
    }

    return res.status(200).json({ message: 'Abonnement activé avec succès.' });
  } catch (err) {
    console.error('Erreur Webhook:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});

module.exports = app;
