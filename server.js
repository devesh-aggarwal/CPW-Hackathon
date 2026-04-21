import express from "express";
import multer from "multer";
import heicConvert from "heic-convert";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;
const FORVO_KEY = process.env.FORVO_KEY;
const ELEVENLABS_KEY = process.env.ELEVENLABS_KEY;
const ELEVENLABS_VOICE = process.env.ELEVENLABS_VOICE || "21m00Tcm4TlvDq8ikWAM";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!FORVO_KEY) {
  console.warn("FORVO_KEY env var not set — /api/pronounce will return 500.");
}
if (!ELEVENLABS_KEY) {
  console.warn("ELEVENLABS_KEY env var not set — TTS fallback disabled.");
}
if (!ANTHROPIC_API_KEY) {
  console.warn("ANTHROPIC_API_KEY env var not set — /api/scan will return 500.");
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/pronounce", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "missing name" });
  if (!FORVO_KEY) return res.status(500).json({ error: "server missing FORVO_KEY" });

  const base = `https://apifree.forvo.com/key/${encodeURIComponent(FORVO_KEY)}/format/json`;
  const pronUrl = `${base}/action/word-pronunciations/word/${encodeURIComponent(name)}/order/rate-desc/limit/5`;
  const phonUrl = `${base}/action/word-phonetics/word/${encodeURIComponent(name)}`;

  try {
    const [pronR, phonR] = await Promise.all([fetch(pronUrl), fetch(phonUrl)]);
    if (!pronR.ok) return res.status(502).json({ error: `forvo ${pronR.status}` });
    const pronData = await pronR.json().catch(() => ({}));
    const phonData = phonR.ok ? await phonR.json().catch(() => ({})) : {};

    const items = (pronData.items || []).map((i) => ({
      username: i.username,
      country: i.country,
      rate: i.rate,
      mp3: i.pathmp3,
      ogg: i.pathogg,
    }));
    const phonetics = (phonData.items || []).map((p) => ({
      alphabet: p.alphabet,
      transcription: p.transcription,
    }));
    const ttsUrl =
      items.length === 0 && ELEVENLABS_KEY
        ? `/api/tts?name=${encodeURIComponent(name)}`
        : null;
    res.json({ items, phonetics, ttsUrl });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/tts", async (req, res) => {
  const name = (req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "missing name" });
  if (!ELEVENLABS_KEY) return res.status(500).json({ error: "server missing ELEVENLABS_KEY" });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE)}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: name,
        model_id: "eleven_multilingual_v2",
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ error: `elevenlabs ${r.status}: ${body}` });
    }
    res.setHeader("content-type", "audio/mpeg");
    res.setHeader("cache-control", "public, max-age=3600");
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/api/scan", upload.single("image"), async (req, res) => {
  if (!anthropic) return res.status(500).json({ error: "server missing ANTHROPIC_API_KEY" });
  if (!req.file) return res.status(400).json({ error: "missing image" });

  try {
    let buffer = req.file.buffer;
    let mediaType = req.file.mimetype || "image/jpeg";
    const name = (req.file.originalname || "").toLowerCase();

    if (mediaType.includes("heic") || mediaType.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif")) {
      const jpeg = await heicConvert({ buffer, format: "JPEG", quality: 0.9 });
      buffer = Buffer.from(jpeg);
      mediaType = "image/jpeg";
    }

    if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) {
      return res.status(400).json({ error: `unsupported image type: ${mediaType}` });
    }

    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: buffer.toString("base64") },
            },
            {
              type: "text",
              text: 'This is a photo of a nametag or similar. Extract only the person\'s name — no titles, no labels like "HELLO my name is", no extra commentary. If no name is visible, reply exactly "NONE". Respond with just the name on one line.',
            },
          ],
        },
      ],
    });

    const text = msg.content.find((c) => c.type === "text")?.text?.trim() || "";
    if (!text || text.toUpperCase() === "NONE") {
      return res.json({ name: null });
    }
    res.json({ name: text.split("\n")[0].trim() });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
