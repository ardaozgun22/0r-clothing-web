const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sharp = require('sharp');
const imagejs = require('image-js');
const fs = require('fs');
const FormData = require('form-data');
const https = require('https');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process'); // FFMPEG'i çalıştırmak için gerekli
const ffmpegPath = require('ffmpeg-static');
const app = express();
const port = process.env.PORT || 3000;
const keepAliveAgent = new https.Agent({ keepAlive: true });
const FM_API = 'https://api.fivemanage.com/api/image';
const FM_TOKEN = '6FoGZragkiFx39QqDIySQvFkQCz43Xul';

app.use(cors());
app.use(express.json());

const processImage = async (imageUrl, res) => {
    try {
        // Fetch and process image
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        const image = await imagejs.Image.load(buffer);

        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                const [r, g, b] = image.getPixelXY(x, y);
                if (g > r + b) {
                    image.setPixelXY(x, y, [255, 255, 255, 0]);
                }
            }
        }

        // Save processed image as PNG
        const outputFilename = `processed_${uuidv4()}.png`;
        const pngFilePath = path.join(__dirname, 'uploads', outputFilename);
        await image.save(pngFilePath);

        // Convert PNG to WebP using ffmpeg
        const webpFilePath = path.join(__dirname, 'uploads', `processed_${uuidv4()}.webp`);
        const ffmpegCommand = `${ffmpegPath} -y -i ${pngFilePath} ${webpFilePath}`;
        
        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`FFMPEG Error: ${error.message}`);
                    return reject(new Error('Failed to create WebP'));
                }
                resolve();
            });
        });

        // Remove temporary PNG file after WebP is created
        fs.unlinkSync(pngFilePath);

        // Upload the WebP file
        const form = new FormData();
        form.append('image', fs.createReadStream(webpFilePath));
        form.append("metadata", JSON.stringify({
            name: `processed_${uuidv4()}.webp`,
            description: 'Processed WebP image'
        }));

        const uploadResponse = await axios.post('https://api.fivemanage.com/api/image', form, {
            headers: {
                ...form.getHeaders(),
                Authorization: '6FoGZragkiFx39QqDIySQvFkQCz43Xul'
            }
        });

        // Clean up the WebP file
        fs.unlinkSync(webpFilePath);

        // Send response
        if (uploadResponse && uploadResponse.data && uploadResponse.data.url) {
            res.json({
                url: uploadResponse.data.url,
                id: uploadResponse.data.id
            });
        } else {
            console.error("Unexpected response structure:", uploadResponse.data);
            res.status(500).send("Unexpected response structure");
        }
    } catch (error) {
        console.error("Error processing image:", error.message);
        res.status(500).send("Error processing image: " + error.message);
    }
};

const deleteImage = async (imgId, res) => {
    try {
        const response = await axios.delete(`https://api.fivemanage.com/api/image/delete/${imgId}`, {
            headers: {
                Authorization: '6FoGZragkiFx39QqDIySQvFkQCz43Xul'
            }
        });

        if (response.status === 200) {
            res.json({ message: 'Image deleted successfully' });
        } else {
            console.error("Unexpected response structure:", response.data);
            res.status(500).send("Unexpected response structure");
        }
    } catch (error) {
        console.error("Error deleting image:", error.message);
        res.status(500).send("Error deleting image: " + error.message);
    }
};

app.post('/process-image', async (req, res) => {
    const { imageUrl, fileName } = req.body;
    // console.log("Arg 1: " + imageUrl + ", Arg 2: " + fileName)
    if (!imageUrl) {
        return res.status(400).send("Image URL is required");
    }

    await processImage(imageUrl, res);
});

app.post('/delete-image', async (req, res) => {
    const { imgId } = req.body;
    if (!imgId) {
        return res.status(400).send("Image ID is required");
    }

    await deleteImage(imgId, res);
});

function applyGreenScreenAlpha(data, width, height, bias = 20) {
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    // çok agresifse bias'ı yükseltin, sızıntı varsa sat/val kontrolü ekleyin
    if (g > r + b + bias) {
      data[idx + 3] = 0; // alpha = 0 => şeffaf
    }
  }
}

const processImageCloth = async (imageUrl, fileName, res) => {
  try {
    console.log("🟢 processImageCloth called with:", { imageUrl, fileName });

    // 0) Basit validasyonlar
    if (fileName.startsWith("_male") || fileName.startsWith("_female")) {
      console.log("🔴 Invalid fileName starting with _male or _female");
      return res.status(222).json({ error: "Invalid fileName: '_male' and '_female' prefixes are not allowed." });
    }
    if (fileName.includes("tbx_xxx") || imageUrl.includes("tbx_xxx")) {
      console.log("🔴 Invalid fileName (url) contains tbx_xxx");
      return res.status(400).send("Invalid fileName (url) contains tbx_xxx");
    }

    // 1) Görseli çek
    const { data: arr } = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
    const inputBuffer = Buffer.from(arr);

    // 2) Auto-orientation + boyutları al
    let s = sharp(inputBuffer).rotate(); // EXIF’e göre düzeltir
    const meta = await s.metadata();

    if (!meta.width || !meta.height) {
      throw new Error('Invalid image metadata');
    }

    // 3) Crop: soldan width/4.5 kadar kırpıp kare benzeri bir alan almak
    const left = Math.floor(meta.width / 4.5);
    const squareWidth = Math.min(meta.height, meta.width - left);
    s = s.extract({
      left: Math.max(0, left),
      top: 0,
      width: Math.max(1, squareWidth),
      height: meta.height
    });

    // 4) Ham RGBA veriyi al (çok hızlı) + alpha hesapla (JS’te tek döngü)
    const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

    applyGreenScreenAlpha(data, info.width, info.height, /* bias */ 25);

    // 5) RGBA raw -> WebP (tamamen memory’de, disk yok)
    const webpBuffer = await sharp(data, { raw: info })
      .webp({ lossless: true }) // isterseniz { quality: 90 } gibi ayarlarla hız-kalite dengesi
      .toBuffer();

    // 6) Upload (buffer olarak, dosya yok)
    const form = new FormData();
    const outName = `processed_${uuidv4()}.webp`;

    form.append('filename', fileName);
    form.append('image', webpBuffer, {
      filename: outName,
      contentType: 'image/webp'
    });
    form.append("metadata", JSON.stringify({
      name: outName,
      description: 'Processed WebP image'
    }));

    console.log("🟢 Uploading to fivemanage.com...");
    const uploadResponse = await axios.post(FM_API, form, {
      headers: {
        ...form.getHeaders(),
        Authorization: FM_TOKEN
      },
      httpAgent: keepAliveAgent,
      timeout: 20000,
      maxBodyLength: Infinity
    });

    console.log("🟢 Upload completed");

    // 7) Cevap
    const { data: up } = uploadResponse || {};
    if (up && up.url) {
      console.log("🟢 Final response being sent with URL and ID");
      return res.json({ url: up.url, id: up.id });
    } else {
      console.error("🔴 Unexpected upload response structure:", up);
      return res.status(500).send("Unexpected response structure");
    }

  } catch (error) {
    console.error("🔴 Error processing image:", error.message);
    return res.status(500).send("Error processing image: " + error.message);
  }
};

app.post('/process-image-cloth', async (req, res) => {
  console.log("🔵 POST /process-image-cloth endpoint hit");
  const { imageUrl, fileName } = req.body;
  console.log("🟠 Request body:", req.body);

  if (!imageUrl) return res.status(400).send("Image URL is required");
  if (!fileName) return res.status(400).send("File name is required");
  if (fileName.includes("tbx_xxx") || imageUrl.includes("tbx_xxx")) {
    return res.status(400).send("Invalid fileName (url) contains tbx_xxx");
  }

  try {
    await processImageCloth(imageUrl, fileName, res);
  } catch (error) {
    console.error("🔴 Error in processImageCloth:", error.message);
    return res.status(500).send("Internal server error");
  }
});

app.listen(port, () => {
    console.log(`Server is running at ${port}`);
});
