const { RtcTokenBuilder, RtcRole } = require("agora-token");

module.exports = function handler(req, res) {
  try {
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    const channelName = req.query.channelName;
    const uid = Number(req.query.uid);

    if (!appId || !appCertificate) {
      return res.status(500).json({
        error: "Agora server config missing"
      });
    }

    if (!channelName || !uid || uid <= 0) {
      return res.status(400).json({
        error: "channelName and numeric uid are required"
      });
    }

    const role = RtcRole.PUBLISHER;
    const expireSeconds = 3600;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpireTime = currentTimestamp + expireSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role,
      privilegeExpireTime
    );

    return res.status(200).json({
      token,
      channelName,
      uid,
      expiresIn: expireSeconds
    });
  } catch (error) {
    return res.status(500).json({
      error: "Token generation failed"
    });
  }
};
