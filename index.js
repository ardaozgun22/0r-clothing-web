require('events').EventEmitter.defaultMaxListeners = 50;

const express = require("express");
const axios = require("axios");
const FormData = require("form-data");
const cors = require("cors");
const http = require("http");
const https = require("https");

const app = express();

// NUI'dan büyük base64 gelebilir:
app.use(express.json({ limit: "25mb" }));
app.use(cors({ origin: "*", methods: ["POST", "OPTIONS"] }));

// ---- CONFIG ----
const FM_API   = 'https://api.fivemanage.com/api/image';
const FM_TOKEN = '8jvCYfiGhbHAZhbqcnEv2YQsCv23qx78';

// keep-alive agent (isteğe bağlı ama yararlı)
const keepAliveAgent = new https.Agent({ keepAlive: true });

// yardımcılar
function bufferFromDataUrl(dataUrlOrBase64) {
  const s = String(dataUrlOrBase64 || "");
  const comma = s.indexOf(",");
  const b64 = comma > -1 ? s.slice(comma + 1) : s;
  return Buffer.from(b64, "base64");
}

async function getBufferFromUrl(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
    validateStatus: () => true,
  });
  if (resp.status >= 200 && resp.status < 300) {
    return Buffer.from(resp.data);
  }
  throw new Error(`GET ${url} failed with ${resp.status}`);
}

async function uploadToFM(webpBuffer, fileName, fieldName = "file", token) {
  const form = new FormData();
  // çoğu durumda filename alanı opsiyonel ama eklemekte sakınca yok
  form.append("filename", fileName);
  form.append(fieldName, webpBuffer, {
    filename: `${fileName}.webp`,
    contentType: "image/webp",
  });

  const { data, status } = await axios.post(FM_API, form, {
    headers: {
      ...form.getHeaders(),
      Authorization: token || FM_TOKEN, // ÖNEMLİ: Bearer YOK
    },
    timeout: 20000,
    maxBodyLength: Infinity,
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: keepAliveAgent,
    validateStatus: () => true,
  });

  return { data, status };
}

// ---- ONLY UPLOAD ENDPOINT ----
app.post("/process-image-cloth", async (req, res) => {
  try {
    const { imageBase64, imageUrl, fileName, token } = req.body || {};
    if (!fileName) return res.status(400).send("File name is required");
    if (!imageBase64 && !imageUrl) {
      return res.status(400).send("Provide imageBase64 or imageUrl");
    }
    if ((imageUrl && imageUrl.includes("tbx_xxx")) || fileName.includes("tbx_xxx")) {
      return res.status(400).send("Invalid fileName/url");
    }
    // 1) Girdi -> Buffer
    let buf;
    if (imageBase64) buf = bufferFromDataUrl(imageBase64);
    else buf = await getBufferFromUrl(imageUrl);

    // 2) Fivemanage'e yükle (önce 'file', 400 olursa 'image')
    let up = await uploadToFM(buf, fileName, "file", token);
    if (up.status === 400) {
      console.log("ℹ️ 400 geldi, 'image' alanıyla tekrar deniyorum…");
      up = await uploadToFM(buf, fileName, "image", token);
    }

    if (up.status >= 200 && up.status < 300 && up.data) {
      // fmapi v2 image response genelde { data: { url, id }, ... } şeklinde
      const url = up?.data?.data?.url || up?.data?.url;
      const id  = up?.data?.data?.id  || up?.data?.id;
      if (url) {
        return res.json({ url, id });
      }
      return res.status(502).send("Unexpected FM response");
    }

    console.error("FM upload failed:", up.status, up.data);
    return res.status(up.status || 500).send("FM upload failed");
  } catch (err) {
    console.error("Upload proxy error:", err?.message || err);
    return res.status(500).send("Internal server error");
  }
});

// (opsiyonel) health
app.get("/health", (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Proxy listening on ${port}`));
