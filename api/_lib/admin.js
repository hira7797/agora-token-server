const admin = require('firebase-admin');
function app() {
  if (!admin.apps.length) {
    const value = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
    if (!value) throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 missing');
    const serviceAccount = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
}
async function requireAdmin(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Login required'), { status: 401 });
  const firebase = app();
  const decoded = await firebase.auth().verifyIdToken(header.slice(7), true);
  const allowlist = (process.env.SHAADI360_ADMIN_UIDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!allowlist.includes(decoded.uid)) throw Object.assign(new Error('Not an authorized admin'), { status: 403 });
  return { firebase, uid: decoded.uid };
}
function error(res, err) {
  console.error('Admin API error:', err.message);
  return res.status(err.status || 500).json({ error: err.status ? err.message : 'Server error' });
}
module.exports = { app, requireAdmin, error };
