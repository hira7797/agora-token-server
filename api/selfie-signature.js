const crypto = require('crypto');
const admin = require('firebase-admin');

// Requires FIREBASE_SERVICE_ACCOUNT_JSON (server-only), and Cloudinary env variables.
if (!admin.apps.length) {
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))});
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({error: 'Method not allowed'});
  try {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({error: 'Authentication required'});
    const decoded = await admin.auth().verifyIdToken(match[1], true);
    const uid = decoded.uid;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(uid)) return res.status(400).json({error: 'Invalid user'});
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    if (!apiKey || !apiSecret || !cloudName) return res.status(503).json({error: 'Server not configured'});
    const timestamp = Math.floor(Date.now()/1000);
    // Folder is created by the SERVER; caller cannot select another user's folder.
    const folder = `salam_match/private_verifications/${uid}`;
    const params = {folder, timestamp, type: 'authenticated'};
    const toSign = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
    const signature = crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
    return res.status(200).json({cloudName, apiKey, folder, timestamp, signature});
  } catch (err) {
    return res.status(401).json({error: 'Invalid login or server authentication configuration'});
  }
};
