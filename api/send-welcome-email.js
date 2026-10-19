// Welcome email for a newly created Google account only.
// Set RESEND_API_KEY and SHAADI360_FROM_EMAIL in Vercel environment variables.
const crypto = require('crypto');
const https = require('https');
const { app } = require('./_lib/admin');
const DELIVERY_COLLECTION = 'welcome_email_deliveries';
const NEW_ACCOUNT_WINDOW_MS = 30 * 60 * 1000;
const CLAIM_EXPIRES_MS = 5 * 60 * 1000;

function sendJson(res, status, data) { return res.status(status).json(data); }
function postResend(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, response => {
      let text = '';
      response.on('data', chunk => { if (text.length < 16384) text += chunk.toString(); });
      response.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(text); } catch (_) {}
        if (response.statusCode >= 200 && response.statusCode < 300 && parsed.id) resolve(parsed.id);
        else reject(new Error(`Mail provider returned HTTP ${response.statusCode}`));
      });
    });
    request.on('timeout', () => request.destroy(new Error('Mail provider timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return sendJson(res, 401, { error: 'Login required' });
  try {
    const firebase = app();
    const decoded = await firebase.auth().verifyIdToken(header.slice(7), true);
    const uid = decoded.uid;
    const authUser = await firebase.auth().getUser(uid);
    const creationTime = Date.parse(authUser.metadata.creationTime);
    const age = Date.now() - creationTime;
    if (!Number.isFinite(age) || age < -60_000 || age > NEW_ACCOUNT_WINDOW_MS) {
      return sendJson(res, 403, { error: 'Welcome email only available shortly after signup' });
    }
    // A first-time Google registration, not an email/password signup.
    if (!authUser.providerData.some(p => p.providerId === 'google.com') || !authUser.email || authUser.emailVerified !== true) {
      return sendJson(res, 403, { error: 'Verified Google account required' });
    }
    const profile = await firebase.firestore().collection('users').doc(uid).get();
    if (!profile.exists) return sendJson(res, 409, { error: 'Profile has not been created yet' });
    if (!process.env.RESEND_API_KEY || !process.env.SHAADI360_FROM_EMAIL) {
      return sendJson(res, 503, { error: 'Welcome email sender not configured' });
    }

    const ref = firebase.firestore().collection(DELIVERY_COLLECTION).doc(uid);
    const claimId = crypto.randomUUID();
    const now = Date.now();
    const claimed = await firebase.firestore().runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (snap.exists) {
        const data = snap.data() || {};
        if (data.status === 'sent') return 'sent';
        if (data.status === 'sending' && Number(data.claimExpiresAt || 0) > now) return 'busy';
      }
      tx.set(ref, { status: 'sending', claimId, claimExpiresAt: now + CLAIM_EXPIRES_MS, updatedAt: now });
      return 'claimed';
    });
    if (claimed === 'sent') return sendJson(res, 200, { status: 'already_sent' });
    if (claimed === 'busy') return sendJson(res, 202, { status: 'in_progress' });

    // Only fixed, server-generated content. Never accept email recipient or body from Android.
    const email = authUser.email;
    const subject = 'Welcome to Shaadi 360 — Your Journey Begins!';
    const text = `Assalamu Alaikum,\n\nCongratulations! Your Shaadi 360 account has been successfully created.\n\nWelcome to the Shaadi 360 family! We are delighted to have you join our community and begin your journey toward finding a meaningful and blessed marriage.\n\nWe sincerely pray that Allah (SWT) blesses you with a loving, caring, understanding, and righteous life partner who brings happiness, peace, and barakah into your life.\n\nMay Allah guide you toward what is best for you, make your journey easy, and bless you with a beautiful and successful marriage. Ameen.\n\nYour journey to finding your perfect match begins here!\n\nThank you for choosing Shaadi 360.\n\nBest regards,\nTeam Shaadi 360`;
    try {
      const providerMessageId = await postResend(process.env.RESEND_API_KEY, {
        from: process.env.SHAADI360_FROM_EMAIL,
        to: [email], subject, text,
      });
      await ref.update({ status: 'sent', providerMessageId, sentAt: Date.now(), claimExpiresAt: 0 });
      return sendJson(res, 200, { status: 'sent' });
    } catch (err) {
      // Retrying is safe for most failures; uncertain timeouts can exceptionally cause duplicate mail.
      const latest = await ref.get();
      if (latest.exists && latest.data().claimId === claimId && latest.data().status === 'sending') {
        await ref.update({ status: 'failed', claimExpiresAt: 0, updatedAt: Date.now() });
      }
      console.error('Welcome email provider error:', err.message);
      return sendJson(res, 502, { error: 'Email service unavailable' });
    }
  } catch (err) {
    console.error('Welcome email error:', err.message);
    return sendJson(res, 500, { error: 'Could not process welcome email' });
  }
};
