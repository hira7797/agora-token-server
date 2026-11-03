'use strict';

const crypto = require('crypto');
const { app, error } = require('./_lib/admin');
const { httpError, requireUser } = require('./_lib/payment-security');

const BOOST_DURATION_MS = 60 * 60 * 1000;

function safeOperationId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(id)) {
    throw httpError(400, 'Invalid operationId');
  }
  return id;
}

function safeCreditType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type !== 'message_request' && type !== 'boost') {
    throw httpError(400, 'Unknown credit type');
  }
  return type;
}

function ledgerId(uid, operationId, creditType) {
  return crypto
    .createHash('sha256')
    .update(`${uid}:${creditType}:${operationId}`, 'utf8')
    .digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { uid } = await requireUser(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const creditType = safeCreditType(body.creditType);
    const operationId = safeOperationId(body.operationId);

    const firebase = app();
    const db = firebase.firestore();

    const walletRef = db.collection('billing_wallets').doc(uid);
    const ledgerRef = db.collection('billing_credit_ledger')
      .doc(ledgerId(uid, operationId, creditType));
    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async tx => {
      const existing = await tx.get(ledgerRef);
      if (existing.exists) {
        const data = existing.data() || {};
        if (data.uid !== uid) throw httpError(409, 'Operation already belongs to another account');
        return {
          duplicate: true,
          creditType: data.creditType || creditType,
          remainingCredits: Number(data.remainingCredits || 0),
          boostExpiresAt: Number(data.boostExpiresAt || 0),
        };
      }

      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.exists ? (walletSnap.data() || {}) : {};

      const fieldName = creditType === 'message_request'
        ? 'messageRequestCredits'
        : 'boostCredits';

      const currentCredits = Math.max(0, Math.floor(Number(wallet[fieldName] || 0)));
      if (currentCredits < 1) {
        throw httpError(409, creditType === 'message_request'
          ? 'No message-request credits available'
          : 'No boost credits available');
      }

      const remainingCredits = currentCredits - 1;
      const now = Date.now();

      tx.set(walletRef, {
        [fieldName]: remainingCredits,
        updatedAt: now,
      }, { merge: true });

      let boostExpiresAt = 0;

      if (creditType === 'boost') {
        const userSnap = await tx.get(userRef);
        const user = userSnap.exists ? (userSnap.data() || {}) : {};
        const currentExpiry = Number(user.boostExpiresAt || 0);
        const boostStart = Math.max(now, Number.isFinite(currentExpiry) ? currentExpiry : 0);
        boostExpiresAt = boostStart + BOOST_DURATION_MS;

        tx.set(userRef, {
          boostActive: true,
          lastBoostTime: now,
          boostExpiresAt,
          boostCount: firebase.firestore.FieldValue.increment(1),
          updatedDate: now,
        }, { merge: true });
      }

      tx.create(ledgerRef, {
        uid,
        operationId,
        creditType,
        amount: 1,
        remainingCredits,
        boostExpiresAt,
        createdAt: now,
        status: 'consumed',
      });

      return {
        duplicate: false,
        creditType,
        remainingCredits,
        boostExpiresAt,
      };
    });

    return res.status(200).json({
      ok: true,
      ...result,
    });
  } catch (err) {
    return error(res, err);
  }
};
