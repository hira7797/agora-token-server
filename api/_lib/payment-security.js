'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');
const { app } = require('./admin');

const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const DEFAULT_PACKAGE_NAME = 'com.aistudio.salammatch.qywmxt';

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function requireUser(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) throw httpError(401, 'Login required');
  const decoded = await app().auth().verifyIdToken(header.slice(7), true);
  return { uid: decoded.uid, decoded };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeTokenFingerprint(token) {
  return tokenHash(token).slice(0, 16);
}

function parseServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!raw) throw httpError(503, 'Server credentials not configured');
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (_) {
    throw httpError(503, 'Server credentials are invalid');
  }
}

async function androidPublisherClient() {
  if (process.env.PLAY_BILLING_ENABLED !== 'true') {
    throw httpError(503, 'Play billing verification is not enabled yet');
  }
  const credentials = parseServiceAccount();
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [ANDROID_PUBLISHER_SCOPE] });
  return auth.getClient();
}

function packageName() {
  return process.env.ANDROID_PACKAGE_NAME || DEFAULT_PACKAGE_NAME;
}

function encode(value) { return encodeURIComponent(value); }

async function verifySubscriptionWithGoogle(authClient, productId, purchaseToken) {
  const pkg = packageName();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encode(pkg)}/purchases/subscriptionsv2/tokens/${encode(purchaseToken)}`;
  const response = await authClient.request({ url, method: 'GET' });
  const data = response.data || {};

  if (data.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE') {
    throw httpError(409, `Subscription is not active (${data.subscriptionState || 'unknown'})`);
  }

  const lineItems = Array.isArray(data.lineItems) ? data.lineItems : [];
  const matched = lineItems.find(x => x && x.productId === productId);
  if (!matched) throw httpError(409, 'Verified subscription does not match requested product');

  const expiryTime = matched.expiryTime || null;
  if (!expiryTime || Number.isNaN(Date.parse(expiryTime))) {
    throw httpError(409, 'Verified subscription expiry is missing');
  }

  return {
    orderId: matched.latestSuccessfulOrderId || data.latestOrderId || null,
    expiryTime,
    linkedPurchaseToken: data.linkedPurchaseToken || null,
    acknowledgementState: data.acknowledgementState || null,
  };
}

async function verifyConsumableWithGoogle(authClient, productId, purchaseToken) {
  const pkg = packageName();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encode(pkg)}/purchases/productsv2/tokens/${encode(purchaseToken)}`;
  const response = await authClient.request({ url, method: 'GET' });
  const data = response.data || {};

  const state = data.purchaseStateContext && data.purchaseStateContext.purchaseState;
  if (state !== 'PURCHASED') throw httpError(409, `Purchase is not completed (${state || 'unknown'})`);

  const lineItems = Array.isArray(data.productLineItem) ? data.productLineItem : [];
  const matched = lineItems.find(x => x && x.productId === productId);
  if (!matched) throw httpError(409, 'Verified purchase does not match requested product');

  return {
    orderId: data.orderId || null,
    acknowledgementState: data.acknowledgementState || null,
    consumptionState: matched.productOfferDetails && matched.productOfferDetails.consumptionState || null,
  };
}

async function consumeProduct(authClient, productId, purchaseToken) {
  const pkg = packageName();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encode(pkg)}/purchases/products/${encode(productId)}/tokens/${encode(purchaseToken)}:consume`;
  await authClient.request({ url, method: 'POST', data: {} });
}

async function acknowledgeSubscription(authClient, productId, purchaseToken) {
  const pkg = packageName();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encode(pkg)}/purchases/subscriptions/${encode(productId)}/tokens/${encode(purchaseToken)}:acknowledge`;
  await authClient.request({ url, method: 'POST', data: {} });
}

module.exports = {
  httpError,
  requireUser,
  tokenHash,
  safeTokenFingerprint,
  androidPublisherClient,
  verifySubscriptionWithGoogle,
  verifyConsumableWithGoogle,
  consumeProduct,
  acknowledgeSubscription,
};
