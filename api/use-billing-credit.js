'use strict';

const crypto = require('crypto');
const { app, error } = require('./_lib/admin');
const { httpError, requireUser } = require('./_lib/payment-security');

const BOOST_DURATION_MS = 60 * 60 * 1000;

function safeOperationId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9._:-]{16,128}$/.test(id)) throw httpError(400, 'Invalid operationId');
  return id;
}

function safeCreditType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (type !== 'message_request' && type !== 'boost') throw httpError(400, 'Unknown credit type');
  return type;
}

function safeUid(value) {
  const uid = String(value || '').trim();
  if (!uid || uid.length > 128 || !/^[A-Za-z0-9:_-]+$/.test(uid)) throw httpError(400, 'Invalid receiverUid');
  return uid;
}

function safeMessage(value) {
  const text = String(value || '').trim().slice(0, 300);
  if (!text) throw httpError(400, 'Message is required');
  return text;
}

function ledgerId(uid, operationId, creditType) {
  return crypto.createHash('sha256').update(`${uid}:${creditType}:${operationId}`, 'utf8').digest('hex');
}

function deterministicChatId(uid1, uid2) {
  return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { uid } = await requireUser(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const creditType = safeCreditType(body.creditType);
    const operationId = safeOperationId(body.operationId);

    const receiverUid = creditType === 'message_request' ? safeUid(body.receiverUid) : '';
    const messageText = creditType === 'message_request' ? safeMessage(body.messageText) : '';
    if (receiverUid && receiverUid === uid) throw httpError(400, 'Cannot send a request to yourself');

    const firebase = app();
    const db = firebase.firestore();

    const walletRef = db.collection('billing_wallets').doc(uid);
    const ledgerRef = db.collection('billing_credit_ledger').doc(ledgerId(uid, operationId, creditType));
    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async tx => {
      const existingLedger = await tx.get(ledgerRef);
      if (existingLedger.exists) {
        const data = existingLedger.data() || {};
        if (data.uid !== uid) throw httpError(409, 'Operation already belongs to another account');
        return {
          duplicate: true,
          creditType: data.creditType || creditType,
          remainingCredits: Number(data.remainingCredits || 0),
          boostExpiresAt: Number(data.boostExpiresAt || 0),
          createdAt: Number(data.createdAt || 0),
        };
      }

      let chatRef = null;
      let existingChat = null;

      if (creditType === 'message_request') {
        const likeRef = db.collection('likes').doc(`${uid}_${receiverUid}`);
        chatRef = db.collection('chats').doc(deterministicChatId(uid, receiverUid));

        const [likeSnap, chatSnap] = await Promise.all([tx.get(likeRef), tx.get(chatRef)]);
        if (!likeSnap.exists) throw httpError(409, 'Like this profile before sending a message request');

        existingChat = chatSnap.exists ? (chatSnap.data() || {}) : null;
        if (existingChat) {
          const status = String(existingChat.status || '').toLowerCase();
          const sameDirection =
            String(existingChat.createdByUid || existingChat.senderUid || '') === uid &&
            String(existingChat.receiverUid || '') === receiverUid;

          if (status === 'request' && sameDirection && existingChat.requestRejected !== true) {
            const walletSnap = await tx.get(walletRef);
            const wallet = walletSnap.exists ? (walletSnap.data() || {}) : {};
            return {
              duplicate: true,
              creditType,
              remainingCredits: Math.max(0, Math.floor(Number(wallet.messageRequestCredits || 0))),
              boostExpiresAt: 0,
              createdAt: Number(existingChat.createdAt || existingChat.lastMessageTime || Date.now()),
            };
          }

          if (
            status === 'active' ||
            existingChat.requestAccepted === true ||
            existingChat.isMutualMatch === true
          ) throw httpError(409, 'Chat is already active');

          if (
            status === 'rejected' ||
            status === 'unmatched' ||
            status === 'blocked' ||
            existingChat.requestRejected === true
          ) throw httpError(409, 'A new message request is not allowed for this chat');
        }
      }

      const walletSnap = await tx.get(walletRef);
      const wallet = walletSnap.exists ? (walletSnap.data() || {}) : {};
      const fieldName = creditType === 'message_request' ? 'messageRequestCredits' : 'boostCredits';
      const currentCredits = Math.max(0, Math.floor(Number(wallet[fieldName] || 0)));
      if (currentCredits < 1) {
        throw httpError(409, creditType === 'message_request'
          ? 'No message-request credits available'
          : 'No boost credits available');
      }

      let userSnap = null;
      if (creditType === 'boost') userSnap = await tx.get(userRef);

      const remainingCredits = currentCredits - 1;
      const now = Date.now();

      tx.set(walletRef, { [fieldName]: remainingCredits, updatedAt: now }, { merge: true });

      let boostExpiresAt = 0;
      if (creditType === 'boost') {
        const user = userSnap && userSnap.exists ? (userSnap.data() || {}) : {};
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
      } else {
        tx.set(chatRef, {
          chatId: chatRef.id,
          participantUids: [uid, receiverUid],
          createdByUid: uid,
          senderUid: uid,
          receiverUid,
          createdAt: now,
          updatedAt: now,
          lastMessage: messageText,
          lastMessageTime: now,
          status: 'request',
          requestAccepted: false,
          requestRejected: false,
          isMutualMatch: false,
          requestType: 'one_message_request',
        }, { merge: true });
      }

      tx.create(ledgerRef, {
        uid,
        operationId,
        creditType,
        amount: 1,
        remainingCredits,
        receiverUid: receiverUid || null,
        boostExpiresAt,
        createdAt: now,
        status: 'consumed',
      });

      return { duplicate: false, creditType, remainingCredits, boostExpiresAt, createdAt: now };
    });

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    return error(res, err);
  }
};
