const sharp = require("sharp");
const axios = require("axios");

/**
 * Downloads image as Buffer
 */
async function downloadImage(url) {
    const { data } = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
            "User-Agent": "Mozilla/5.0"
        }
    });

    return Buffer.from(data);
}

/**
 * Creates a numbered collage.
 * @param {string[]} imageUrls
 * @returns {Buffer}
 */
async function createCollage(imageUrls) {

    const cellSize = 500;
    const padding = 20;
    const labelHeight = 70;

    const cols = 2;
    const rows = Math.ceil(imageUrls.length / cols);

    const width =
        cols * cellSize +
        (cols + 1) * padding;

    const height =
        rows * (cellSize + labelHeight) +
        (rows + 1) * padding;

    const canvas = sharp({
        create: {
            width,
            height,
            channels: 3,
            background: {
                r: 255,
                g: 255,
                b: 255
            }
        }
    });

    const composites = [];

    for (let i = 0; i < imageUrls.length; i++) {

        const row = Math.floor(i / cols);
        const col = i % cols;

        const left =
            padding + col * (cellSize + padding);

        const top =
            padding + row * (cellSize + labelHeight + padding);

        try {

            const imgBuffer = await downloadImage(imageUrls[i]);

            const resized = await sharp(imgBuffer)
                .resize(cellSize, cellSize, {
                    fit: "contain",
                    background: {
                        r: 245,
                        g: 245,
                        b: 245
                    }
                })
                .png()
                .toBuffer();

            composites.push({
                input: resized,
                left,
                top
            });

            const svg = Buffer.from(`
            <svg width="${cellSize}" height="${labelHeight}">
                <rect width="100%" height="100%" fill="white"/>
                <text
                    x="50%"
                    y="45"
                    text-anchor="middle"
                    font-size="42"
                    font-family="Arial"
                    font-weight="bold"
                    fill="black">
                    ${i + 1}
                </text>
            </svg>
            `);

            composites.push({
                input: svg,
                left,
                top: top + cellSize
            });

        } catch (err) {
            console.log(err.message);
        }
    }

    return await canvas
        .composite(composites)
        .jpeg({ quality: 95 })
        .toBuffer();
}

module.exports = createCollage;