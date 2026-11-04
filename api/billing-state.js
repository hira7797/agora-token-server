'use strict';

const { app, error } = require('./_lib/admin');
const { requireUser } = require('./_lib/payment-security');

function safeNonNegativeInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function normalizeTier(value) {
  const tier = String(value || '').trim().toLowerCase();
  return tier === 'basic' || tier === 'advanced' ? tier : 'free';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { uid } = await requireUser(req);

    const firebase = app();
    const db = firebase.firestore();

    const entitlementRef = db
      .collection('billing_entitlements')
      .doc(uid);

    const walletRef = db
      .collection('billing_wallets')
      .doc(uid);

    const [entitlementSnap, walletSnap] = await Promise.all([
      entitlementRef.get(),
      walletRef.get(),
    ]);

    const entitlement = entitlementSnap.exists
      ? (entitlementSnap.data() || {})
      : {};

    // ---------------------------------------------------------
    // FREE STARTER CREDITS
    // New account gets these credits only once:
    // 10 Message Requests
    // 3 Boosts
    // ---------------------------------------------------------
    if (!walletSnap.exists) {
      const starterGrantedAt = Date.now();

      await db.runTransaction(async (tx) => {
        const freshWallet = await tx.get(walletRef);

        // Important:
        // Only create the starter wallet if it still does not exist.
        // This prevents duplicate credits from refresh/login/reinstall.
        if (!freshWallet.exists) {
          tx.create(walletRef, {
            messageRequestCredits: 10,
            boostCredits: 3,

            starterGrantApplied: true,
            starterGrantVersion: 1,
            starterGrantedAt: starterGrantedAt,

            updatedAt: starterGrantedAt,
          });
        }
      });
    }

    // Read wallet again after possible starter-wallet creation.
    const walletAfterInit = await walletRef.get();

    const wallet = walletAfterInit.exists
      ? (walletAfterInit.data() || {})
      : {};

    const now = Date.now();

    const rawTier = normalizeTier(entitlement.goldTier);

    const subscriptionStatus = String(
      entitlement.subscriptionStatus || ''
    )
      .trim()
      .toLowerCase();

    const subscriptionExpiresAt = Number(
      entitlement.subscriptionExpiresAt || 0
    );

    const hasValidExpiry =
      Number.isFinite(subscriptionExpiresAt) &&
      subscriptionExpiresAt > now;

    const activeSubscription =
      subscriptionStatus === 'active' &&
      hasValidExpiry &&
      rawTier !== 'free';

    const goldTier = activeSubscription
      ? rawTier
      : 'free';

    return res.status(200).json({
      ok: true,

      billing: {
        goldTier,

        isPremium: goldTier !== 'free',

        subscriptionStatus: activeSubscription
          ? 'active'
          : 'inactive',

        subscriptionProductId: activeSubscription
          ? String(entitlement.subscriptionProductId || '')
          : '',

        subscriptionExpiresAt: activeSubscription
          ? subscriptionExpiresAt
          : 0,

        messageRequestCredits:
          safeNonNegativeInteger(
            wallet.messageRequestCredits
          ),

        boostCredits:
          safeNonNegativeInteger(
            wallet.boostCredits
          ),
      },

      serverTime: now,
    });
  } catch (err) {
    return error(res, err);
  }
};
