const { requireAdmin, error } = require('./_lib/admin');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { firebase, uid: reviewerUid } = await requireAdmin(req);
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { uid, decision } = body;
    if (typeof uid !== 'string' || !/^[A-Za-z0-9_-]{6,128}$/.test(uid) || !['verified','rejected'].includes(decision))
      return res.status(400).json({ error: 'Invalid review request' });
    const reason = decision === 'rejected' ? String(body.reason || '').trim().slice(0, 300) : '';
    if (decision === 'rejected' && !reason) return res.status(400).json({ error: 'Rejection reason required' });
    const db = firebase.firestore();
    const requestRef = db.collection('verification_requests').doc(uid);
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async tx => {
      const requestSnap = await tx.get(requestRef);
      const userSnap = await tx.get(userRef);
      if (!requestSnap.exists || !userSnap.exists) throw Object.assign(new Error('User or request missing'), {status:404});
      const d = requestSnap.data();
      if (d.status !== 'pending') throw Object.assign(new Error('Request already reviewed'), {status:409});
      const reviewedAt = Date.now();
      tx.update(requestRef, { status: decision, reviewedAt, reviewedByUid: reviewerUid, rejectionReason: reason });
      tx.update(userRef, {
        selfieVerificationStatus: decision, isVerified: decision === 'verified',
        selfieVerificationReviewedAt: reviewedAt, selfieVerificationRejectionReason: reason
      });
    });
    return res.status(200).json({ ok: true, status: decision });
  } catch (err) { error(res, err); }
};
