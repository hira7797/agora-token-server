'use strict';

const { app, error } = require('./_lib/admin');
const { classifyProduct } = require('./_lib/payment-catalog');
const {
  httpError,
  requireUser,
  tokenHash,
  safeTokenFingerprint,
  androidPublisherClient,
  verifySubscriptionWithGoogle,
  verifyConsumableWithGoogle,
  consumeProduct,
  acknowledgeSubscription,
} = require('./_lib/payment-security');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid } = await requireUser(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const productId = String(body.productId || '').trim();
    const purchaseToken = String(body.purchaseToken || '').trim();

    const product = classifyProduct(productId);
    if (!product) throw httpError(400, 'Unknown product');
    if (!purchaseToken || purchaseToken.length < 16 || purchaseToken.length > 4096) {
      throw httpError(400, 'Invalid purchase token');
    }

    const fingerprint = safeTokenFingerprint(purchaseToken);
    const ledgerId = tokenHash(purchaseToken);
    const firebase = app();
    const db = firebase.firestore();
    const ledgerRef = db.collection('play_purchase_ledger').doc(ledgerId);

    // Fast duplicate/replay check. The transaction below repeats this check atomically.
    const existing = await ledgerRef.get();
    if (existing.exists) {
      const data = existing.data() || {};
      if (data.uid !== uid) throw httpError(409, 'Purchase token already belongs to another account');
      return res.status(200).json({
        ok: true,
        duplicate: true,
        productId: data.productId,
        status: data.status || 'granted',
        tokenFingerprint: fingerprint,
      });
    }

    const authClient = await androidPublisherClient();
    const verified = product.type === 'subscription'
      ? await verifySubscriptionWithGoogle(authClient, productId, purchaseToken)
      : await verifyConsumableWithGoogle(authClient, productId, purchaseToken);

    const now = Date.now();
    await db.runTransaction(async tx => {
      const again = await tx.get(ledgerRef);
      if (again.exists) {
        const d = again.data() || {};
        if (d.uid !== uid) throw httpError(409, 'Purchase token already belongs to another account');
        return;
      }

      const ledger = {
        uid,
        productId,
        productType: product.type,
        tokenHash: ledgerId,
        tokenFingerprint: fingerprint,
        orderId: verified.orderId || null,
        status: 'granted_pending_play_finalize',
        verifiedAt: now,
        createdAt: now,
      };

      if (product.type === 'subscription') {
        const entitlementRef = db.collection('billing_entitlements').doc(uid);
        const expiresAt = Date.parse(verified.expiryTime);
        tx.set(entitlementRef, {
          goldTier: product.tier,
          subscriptionProductId: productId,
          subscriptionStatus: 'active',
          subscriptionExpiresAt: expiresAt,
          source: 'google_play',
          updatedAt: now,
        }, { merge: true });
        ledger.subscriptionExpiresAt = expiresAt;
      } else {
        const walletRef = db.collection('billing_wallets').doc(uid);
        tx.set(walletRef, {
          messageRequestCredits: firebase.firestore.FieldValue.increment(product.messageRequestCredits || 0),
          boostCredits: firebase.firestore.FieldValue.increment(product.boostCredits || 0),
          updatedAt: now,
        }, { merge: true });
        ledger.messageRequestCreditsGranted = product.messageRequestCredits || 0;
        ledger.boostCreditsGranted = product.boostCredits || 0;
      }

      tx.create(ledgerRef, ledger);
    });

    // Finalize with Play only AFTER the server-side grant transaction succeeds.
    try {
      if (product.type === 'subscription') {
        await acknowledgeSubscription(authClient, productId, purchaseToken);
      } else {
        await consumeProduct(authClient, productId, purchaseToken);
      }
      await ledgerRef.set({ status: 'finalized', finalizedAt: Date.now() }, { merge: true });
    } catch (finalizeErr) {
      console.error('Play finalize failed for token fingerprint', fingerprint, finalizeErr.message);
      // Entitlement/credits are already idempotently granted. Keep status pending for later retry tooling.
    }

    return res.status(200).json({
      ok: true,
      duplicate: false,
      productId,
      productType: product.type,
      tokenFingerprint: fingerprint,
      status: 'verified',
    });
  } catch (err) {
    return error(res, err);
  }
};
