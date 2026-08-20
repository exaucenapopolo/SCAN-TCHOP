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
// 2. ROUTE : INITIALISATION DU PAIEMENT (ABONNEMENT)
// ==========================================
app.post('/api/create-subscription-checkout', async (req, res) => {
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

    const transDocId = fapshiTransId || db.collection('subscriptionTransactions').doc().id;
    await db.collection('subscriptionTransactions').doc(transDocId).set({
      fapshiTransId: fapshiTransId,
      restoId: restoId,
      planName: planName,
      duration: duration,
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
// 3. ROUTE : WEBHOOK DE CONFIRMATION FAPSHI (ABONNEMENT)
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

    if (transData.status === 'CONFIRMED') {
      return res.status(200).json({ message: 'Transaction déjà confirmée.' });
    }

    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    let dateExpiration = null; 
    let statutExpirationText = "Illimité"; 

    if (transData.duration !== 'A_vie' && transData.duration !== 'Cle_en_main') {
      const monthsToAdd = parseInt(transData.duration) || 1;
      const now = new Date();
      now.setMonth(now.getMonth() + monthsToAdd);
      dateExpiration = admin.firestore.Timestamp.fromDate(now);
      statutExpirationText = `${monthsToAdd} mois`;
    }

    if (transData.restoId && transData.planName) {
      await db.collection('restaurants').doc(transData.restoId).update({
        abonnement: transData.planName,
        dureeAbonnement: statutExpirationText,
        dateDernierPaiement: admin.firestore.FieldValue.serverTimestamp(),
        dateExpirationAbonnement: dateExpiration,
        montantDernierPaiement: transData.amount
      });
    }

    return res.status(200).json({ message: 'Abonnement activé avec succès.' });
  } catch (err) {
    console.error('Erreur Webhook:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});


// ==========================================
// 4. ROUTE : INITIALISATION DU PAIEMENT (COMMANDE DE PLAT)
// ==========================================
app.post('/api/create-order-checkout', async (req, res) => {
  const { restoId, platId, nomPlat, amount, phone, redirectUrl, qty, isSplit, splitCount, orderId } = req.body;

  if (!restoId || !platId || !amount || !redirectUrl || !orderId) {
    return res.status(400).json({ success: false, error: 'Données de commande manquantes (orderId requis).' });
  }

  const API_USER = process.env.FAPSHI_API_USER;
  const API_KEY = process.env.FAPSHI_API_KEY;

  if (!API_USER || !API_KEY) {
    return res.status(500).json({ success: false, error: 'Configuration Fapshi incomplète.' });
  }

  const webhookBase = process.env.BACKEND_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const webhookUrl = `${webhookBase}/api/fapshi-order-webhook`;

  const description = isSplit 
    ? `Paiement partagé (1/${splitCount}) pour ${qty}x ${nomPlat}` 
    : `Commande de ${qty}x ${nomPlat}`;

  const payload = {
    amount: Number(amount),
    currency: 'XAF',
    description: description,
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

    const transDocId = fapshiTransId || db.collection('orderTransactions').doc().id;
    await db.collection('orderTransactions').doc(transDocId).set({
      fapshiTransId: fapshiTransId,
      orderId: orderId, // lien vers la commande
      restoId: restoId,
      platId: platId,
      nomPlat: nomPlat,
      qty: qty,
      isSplit: isSplit,
      splitCount: splitCount,
      amount: Number(amount),
      status: 'PENDING',
      dateInitiated: admin.firestore.FieldValue.serverTimestamp(),
      checkoutUrl
    });

    return res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error('Erreur initialisation commande:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur interne.' });
  }
});

// ==========================================
// 5. ROUTE : WEBHOOK DE CONFIRMATION (COMMANDE DE PLAT)
// ==========================================
app.post('/api/fapshi-order-webhook', async (req, res) => {
  const { status, transId } = req.body;

  if (status !== 'SUCCESSFUL') {
    // Si le statut n'est pas SUCCESSFUL, on pourrait mettre à jour la transaction en échec
    // mais on ne fait rien pour l'instant
    return res.status(200).json({ message: 'Statut ignoré.' });
  }
  if (!transId) return res.status(400).json({ error: 'Données invalides.' });

  const transRef = db.collection('orderTransactions').doc(transId);

  try {
    const transDoc = await transRef.get();
    if (!transDoc.exists) return res.status(200).json({ message: 'Transaction inconnue.' });

    const transData = transDoc.data();

    if (transData.status === 'CONFIRMED') {
      return res.status(200).json({ message: 'Commande déjà confirmée.' });
    }

    // Mettre à jour la transaction
    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Mettre à jour la commande dans la collection 'orders'
    const orderId = transData.orderId;
    if (orderId) {
      await db.collection('orders').doc(orderId).update({
        paymentConfirmed: true,
        fapshiTransId: transId,
        paymentStatus: 'PAID'
      });
    }

    // Optionnel : enregistrer dans 'commandes' pour historique
    await db.collection('commandes').add({
      restoId: transData.restoId,
      platId: transData.platId,
      nomPlat: transData.nomPlat,
      quantite: transData.qty,
      montantPaye: transData.amount,
      partage: transData.isSplit,
      nombrePersonnes: transData.splitCount,
      dateCommande: admin.firestore.FieldValue.serverTimestamp(),
      fapshiTransId: transId,
      statut: 'Payée'
    });

    return res.status(200).json({ message: 'Commande validée avec succès.' });
  } catch (err) {
    console.error('Erreur Webhook commande:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});

// ==========================================
// 6. ROUTE : INITIALISATION DU PAIEMENT (POURBOIRE)
// ==========================================
app.post('/api/create-tip-checkout', async (req, res) => {
  const { restoId, orderId, amount, phone, redirectUrl } = req.body;

  if (!restoId || !orderId || !amount || !redirectUrl) {
    return res.status(400).json({ success: false, error: 'Données de pourboire manquantes.' });
  }

  const API_USER = process.env.FAPSHI_API_USER;
  const API_KEY = process.env.FAPSHI_API_KEY;

  if (!API_USER || !API_KEY) {
    return res.status(500).json({ success: false, error: 'Configuration Fapshi incomplète.' });
  }

  const webhookBase = process.env.BACKEND_URL || `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const webhookUrl = `${webhookBase}/api/fapshi-tip-webhook`;

  const payload = {
    amount: Number(amount),
    currency: 'XAF',
    description: `Pourboire pour la commande ${orderId}`,
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

    const transDocId = fapshiTransId || db.collection('tipTransactions').doc().id;
    await db.collection('tipTransactions').doc(transDocId).set({
      fapshiTransId: fapshiTransId,
      restoId: restoId,
      orderId: orderId,
      amount: Number(amount),
      status: 'PENDING',
      dateInitiated: admin.firestore.FieldValue.serverTimestamp(),
      checkoutUrl
    });

    return res.json({ success: true, checkoutUrl });
  } catch (err) {
    console.error('Erreur initialisation pourboire:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur interne.' });
  }
});

// ==========================================
// 7. ROUTE : WEBHOOK DE CONFIRMATION (POURBOIRE)
// ==========================================
app.post('/api/fapshi-tip-webhook', async (req, res) => {
  const { status, transId } = req.body;

  if (status !== 'SUCCESSFUL') return res.status(200).json({ message: 'Statut ignoré.' });
  if (!transId) return res.status(400).json({ error: 'Données invalides.' });

  const transRef = db.collection('tipTransactions').doc(transId);

  try {
    const transDoc = await transRef.get();
    if (!transDoc.exists) return res.status(200).json({ message: 'Transaction inconnue.' });

    const transData = transDoc.data();

    if (transData.status === 'CONFIRMED') {
      return res.status(200).json({ message: 'Pourboire déjà confirmé.' });
    }

    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Enregistrer le pourboire
    await db.collection('tips').add({
      restoId: transData.restoId,
      orderId: transData.orderId,
      amount: transData.amount,
      date: admin.firestore.FieldValue.serverTimestamp(),
      fapshiTransId: transId,
      statut: 'payé'
    });

    return res.status(200).json({ message: 'Pourboire validé avec succès.' });
  } catch (err) {
    console.error('Erreur Webhook pourboire:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});

// ==========================================
// 8. NOUVELLE ROUTE : VÉRIFIER LE STATUT D'UNE TRANSACTION FAPSHI
// ==========================================
app.get('/api/check-payment-status/:transId', async (req, res) => {
  const { transId } = req.params;

  if (!transId) {
    return res.status(400).json({ success: false, error: 'transId requis.' });
  }

  const API_USER = process.env.FAPSHI_API_USER;
  const API_KEY = process.env.FAPSHI_API_KEY;

  if (!API_USER || !API_KEY) {
    return res.status(500).json({ success: false, error: 'Configuration Fapshi incomplète.' });
  }

  try {
    // Appel à l'API Fapshi pour obtenir le statut de la transaction
    const fapshiRes = await fetch(`https://live.fapshi.com/transaction-status/${transId}`, {
      method: 'GET',
      headers: {
        'apiuser': API_USER,
        'apikey': API_KEY
      }
    });

    if (!fapshiRes.ok) {
      const errorText = await fapshiRes.text();
      return res.status(fapshiRes.status).json({ success: false, error: errorText });
    }

    const data = await fapshiRes.json();
    // On s'attend à ce que Fapshi renvoie un champ 'status' ou 'transactionStatus'
    const status = data.status || data.transactionStatus || data.state || 'UNKNOWN';
    
    // Normaliser le statut
    const isSuccessful = ['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'TERMINE', 'EFFECTUE', 'PAID', 'CONFIRMED'].some(s => 
      status.toUpperCase().includes(s)
    );

    return res.json({ success: true, status, isSuccessful });
  } catch (error) {
    console.error('Erreur vérification statut Fapshi:', error);
    return res.status(500).json({ success: false, error: 'Erreur serveur interne.' });
  }
});

module.exports = app;