const cloudinary = require('cloudinary').v2;
const { requireAdmin, error } = require('./_lib/admin');
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const { firebase } = await requireAdmin(req);
    const uid = typeof req.query.uid === 'string' ? req.query.uid : '';
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) return res.status(400).json({ error: 'Invalid UID' });
    const snapshot = await firebase.firestore().collection('verification_requests').doc(uid).get();
    if (!snapshot.exists) return res.status(404).json({ error: 'Request not found' });
    const d = snapshot.data();
    const publicId = d.selfieVerificationPublicId;
    if (typeof publicId !== 'string' || !publicId.startsWith('salam_match/private_verifications/')) {
      return res.status(400).json({ error: 'Private verification selfie missing' });
    }
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
      throw new Error('Cloudinary environment configuration missing');
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });
    // Signed time-limited URL; never reveal long-term credentials to browser.
    const url = cloudinary.utils.private_download_url(publicId, 'jpg', {
      type: 'authenticated', resource_type: 'image', expires_at: Math.floor(Date.now() / 1000) + 120
    });
    return res.status(200).json({ url });
  } catch (err) { error(res, err); }
};
