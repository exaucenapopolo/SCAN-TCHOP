const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ==========================================
// 1. INITIALISATION SÉCURISÉE DE FIREBASE
// ==========================================
if (!admin.apps.length) {
    // Si la variable d'environnement principale est définie sur Vercel
    if (process.env.FIREBASE_PROJECT_ID) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                // Cette astuce nettoie les sauts de ligne pour que la clé soit valide
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            })
        });
    } else {
        // Option de secours pour les tests locaux
        admin.initializeApp({
            credential: admin.credential.applicationDefault()
        });
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
  const { planName, restoId, amount, phone, redirectUrl } = req.body;

  if (!planName || !restoId || !amount || !redirectUrl) {
    return res.status(400).json({ success: false, error: 'Données manquantes.' });
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
    description: `Abonnement Pack ${planName} pour le restaurant`,
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

    if (!checkoutUrl) return res.status(502).json({ success: false, error: 'URL manquante.' });

    const transDocId = fapshiTransId || db.collection('subscriptionTransactions').doc().id;
    await db.collection('subscriptionTransactions').doc(transDocId).set({
      fapshiTransId: fapshiTransId,
      restoId: restoId,
      planName: planName,
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

    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    const transData = transDoc.data();
    if (transData.restoId && transData.planName) {
      await db.collection('restaurants').doc(transData.restoId).update({
        abonnement: transData.planName
      });
    }
    return res.status(200).json({ message: 'Abonnement activé.' });
  } catch (err) {
    console.error('Erreur Webhook:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});

module.exports = app;
