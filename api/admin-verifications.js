const { requireAdmin, error } = require('./_lib/admin');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { firebase } = await requireAdmin(req);
    // Bounded three-status list, sorted client-side; a composite index is not needed.
    const snapshot = await firebase.firestore().collection('verification_requests')
      .where('status', 'in', ['pending', 'verified', 'rejected']).limit(300).get();
    const requests = snapshot.docs.map(doc => {
      const d = doc.data();
      return {
        uid: doc.id,
        displayName: String(d.displayName || d.name || 'Unnamed user').slice(0, 100),
        submittedAt: typeof d.submittedAt === 'number' ? d.submittedAt : null,
        profileImageUrl: typeof d.profileImageUrl === 'string' && /^https:\/\//.test(d.profileImageUrl) ? d.profileImageUrl : null,
        hasSelfie: Boolean(d.selfieVerificationPublicId),
        status: ['pending','verified','rejected'].includes(d.status) ? d.status : 'pending',
        reviewedAt: typeof d.reviewedAt === 'number' ? d.reviewedAt : null,
        rejectionReason: typeof d.rejectionReason === 'string' ? d.rejectionReason.slice(0,300) : ''
      };
    });
    requests.sort((a,b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    res.status(200).json({ requests });
  } catch (err) { error(res, err); }
};
