const crypto = require("crypto");

module.exports = function handler(req, res) {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(500).json({
        error: "Cloudinary server config missing"
      });
    }

    const folder = req.query.folder || "salam_match/media";
    const resourceType = req.query.resourceType || "image";
    const timestamp = Math.floor(Date.now() / 1000);

    const paramsToSign = {
      folder,
      timestamp
    };

    const stringToSign = Object.keys(paramsToSign)
      .sort()
      .map((key) => `${key}=${paramsToSign[key]}`)
      .join("&");

    const signature = crypto
      .createHash("sha1")
      .update(stringToSign + apiSecret)
      .digest("hex");

    return res.status(200).json({
      cloudName,
      apiKey,
      timestamp,
      signature,
      folder,
      resourceType
    });
  } catch (error) {
    return res.status(500).json({
      error: "Cloudinary signature generation failed"
    });
  }
};
