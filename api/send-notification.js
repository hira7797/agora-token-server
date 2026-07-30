const admin = require("firebase-admin");

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (!raw) return null;
  const json = Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json);
}

if (!admin.apps.length) {
  const serviceAccount = getServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST required" });
    }

    if (!admin.apps.length) {
      return res.status(500).json({ error: "Firebase Admin config missing" });
    }

    const { token, title, body, type, chatId, senderUid, targetScreen } = req.body || {};
    if (!token || !title || !body) {
      return res.status(400).json({ error: "token, title and body are required" });
    }

    const notificationType = String(type || "new_message");
    const message = {
      token,
      notification: { title, body },
      data: {
        title: String(title),
        body: String(body),
        type: notificationType,
        chatId: String(chatId || ""),
        senderUid: String(senderUid || ""),
        targetScreen: String(targetScreen || "")
      },
      android: {
        priority: "high",
        notification: {
          channelId: notificationType.includes("call") ? "calls" : "messages",
          sound: "default"
        }
      }
    };

    const id = await admin.messaging().send(message);
    return res.status(200).json({ ok: true, messageId: id });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Notification failed" });
  }
};
