// ═══════════════════════════════════════════════════════════════
// Fapshi – Paiement d'Abonnement (SCAN&TCHOP)
// ═══════════════════════════════════════════════════════════════

// ── POST /api/create-subscription-checkout ────────────────────────────
// Cette route génère le lien de paiement et enregistre l'intention dans Firebase
app.post('/api/create-subscription-checkout', async (req, res) => {
  const { planName, restoId, amount, phone, redirectUrl } = req.body;

  if (!planName || !restoId || !amount || !redirectUrl) {
    return res.status(400).json({ success: false, error: 'Données manquantes.' });
  }

  // Utilisation des variables d'environnement configurées sur Vercel
  const API_USER = process.env.FAPSHI_API_USER;
  const API_KEY  = process.env.FAPSHI_API_KEY; 

  if (!API_USER || !API_KEY) {
    return res.status(500).json({ success: false, error: 'Configuration Fapshi incomplète.' });
  }

  // L'URL secrète que Fapshi appellera une fois que l'utilisateur a payé
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

    // On stocke la transaction "EN ATTENTE" dans Firestore pour savoir quel resto a payé quoi
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
    console.error('Erreur initialisation abonnement Fapshi:', err);
    return res.status(500).json({ success: false, error: 'Erreur serveur interne.' });
  }
});

// ── POST /api/fapshi-subscription-webhook ─────────────────────────────
// C'est Fapshi qui appelle cette route en secret pour valider le paiement
app.post('/api/fapshi-subscription-webhook', async (req, res) => {
  const { status, amount, transId } = req.body;

  if (status !== 'SUCCESSFUL') return res.status(200).json({ message: 'Statut ignoré.' });
  if (!transId) return res.status(400).json({ error: 'Données invalides.' });

  const transRef = db.collection('subscriptionTransactions').doc(transId);

  try {
    const transDoc = await transRef.get();
    if (!transDoc.exists) return res.status(200).json({ message: 'Transaction inconnue.' });

    const transData = transDoc.data();
    if (transData.status === 'CONFIRMED') return res.status(200).json({ message: 'Déjà confirmée.' });

    const restoId = transData.restoId;
    const planName = transData.planName;

    // 1. On confirme la transaction
    await transRef.update({
      status: 'CONFIRMED',
      dateConfirmed: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2. LA MAGIE OPÈRE ICI : On met à jour l'abonnement du restaurant
    if (restoId && planName) {
      await db.collection('restaurants').doc(restoId).update({
        abonnement: planName
      });
    }

    return res.status(200).json({ message: 'Abonnement activé avec succès.' });
  } catch (err) {
    console.error('Erreur Webhook Abonnement:', err);
    return res.status(500).json({ error: 'Erreur webhook.' });
  }
});
