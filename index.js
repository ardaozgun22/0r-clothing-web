const express = require('express');
const cors = require('cors');
const axios = require('axios');
const imagejs = require('image-js');
const fs = require('fs');
const FormData = require('form-data');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process'); // FFMPEG'i çalıştırmak için gerekli
const ffmpegPath = 'C:/ffmpeg/bin/ffmpeg';
const app = express();
const port = process.env.PORT || 3000;
const ip = '91.151.94.25'; // Tüm IP adreslerini dinler

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

const processImageCloth = async (imageUrl, fileName, res) => {
    try {
        console.log("🟢 processImageCloth called with:", { imageUrl, fileName });

        // 1. Resmi çekiyoruz
        const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        console.log("🟢 Image fetched from URL successfully");

        const buffer = Buffer.from(response.data, 'binary');
        const image = await imagejs.Image.load(buffer);
        console.log("🟢 Image loaded into image-js successfully");

        // 2. Crop işlemi
        const croppedImage = image.crop({ x: image.width / 4.5, width: image.height });
        console.log("🟢 Image cropped successfully");

        image.data = croppedImage.data;
        image.width = croppedImage.width;
        image.height = croppedImage.height;

        // 3. Arka plan temizleme
        for (let x = 0; x < image.width; x++) {
            for (let y = 0; y < image.height; y++) {
                const [r, g, b] = image.getPixelXY(x, y);
                if (g > r + b) {
                    image.setPixelXY(x, y, [255, 255, 255, 0]);
                }
            }
        }
        console.log("🟢 Background processed successfully");

        // 4. PNG olarak kaydetme
        const tempPngPath = path.join('/tmp', `processed_${uuidv4()}.png`);
        const webpFilePath = path.join('/tmp', `processed_${uuidv4()}.webp`);

        const outputBuffer = await image.toBuffer('image/png');
        fs.writeFileSync(tempPngPath, outputBuffer);
        console.log("🟢 PNG file saved to:", tempPngPath);

        // 5. PNG'yi WebP'ye dönüştürme
        const ffmpegCommand = `${ffmpegPath} -y -i ${tempPngPath} -loop 0 ${webpFilePath}`;
        console.log("🟢 Running ffmpeg command:", ffmpegCommand);

        await new Promise((resolve, reject) => {
            exec(ffmpegCommand, (error, stdout, stderr) => {
                if (error) {
                    console.error(`🔴 FFMPEG Error: ${error.message}`);
                    return reject(new Error('Failed to create WebP'));
                }
                console.log("🟢 WebP file created successfully:", webpFilePath);
                resolve();
            });
        });

        // 6. Geçici PNG dosyasını sil
        fs.unlinkSync(tempPngPath);
        console.log("🟢 Temp PNG file deleted");

        // 7. WebP'yi fivemanage.com'a upload etme
        if (fileName.startsWith("_male") || fileName.startsWith("_female")) {
            console.log("🔴 Invalid fileName starting with _male or _female");
            return res.status(222).json({ error: "Invalid fileName: '_male' and '_female' prefixes are not allowed." });
        }

        const form = new FormData();
        form.append('filename', fileName);
        form.append('image', fs.createReadStream(webpFilePath));
        form.append("metadata", JSON.stringify({
            name: `processed_${uuidv4()}.webp`,
            description: 'Processed WebP image'
        }));

        console.log("🟢 Uploading to fivemanage.com...");
        const uploadResponse = await axios.post('https://api.fivemanage.com/api/image', form, {
            headers: {
                ...form.getHeaders(),
                Authorization: '6FoGZragkiFx39QqDIySQvFkQCz43Xul'
            }
        });

        console.log("🟢 Upload completed");

        // 8. WebP dosyasını sil
        fs.unlinkSync(webpFilePath);
        console.log("🟢 Temp WebP file deleted");

        // 9. API cevabını gönder
        if (uploadResponse && uploadResponse.data && uploadResponse.data.url) {
            console.log("🟢 Final response being sent with URL and ID");
            res.json({
                url: uploadResponse.data.url,
                id: uploadResponse.data.id
            });
        } else {
            console.error("🔴 Unexpected upload response structure:", uploadResponse.data);
            res.status(500).send("Unexpected response structure");
        }
    } catch (error) {
        console.error("🔴 Error processing image:", error.message);
        res.status(500).send("Error processing image: " + error.message);
    }
};

app.post('/process-image-cloth', async (req, res) => {
    const { imageUrl, fileName } = req.body;
    // console.log("Arg 1: " + imageUrl + ", Arg 2: " + fileName)
    if (!imageUrl) {
        return res.status(400).send("Image URL is required");
    }
    if (!fileName) {
        return res.status(400).send("File name is required");
    }

    await processImageCloth(imageUrl, fileName, res);
});

app.listen(port, () => {
    console.log(`Server is running at http://${ip}:${port}`);
});
