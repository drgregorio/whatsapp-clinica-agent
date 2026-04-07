import express from "express";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(express.json());

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const HUMAN_PHONE = process.env.HUMAN_PHONE;

const conversations = new Map();

// Model fallback chain: try in order, skip on 503
const MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
];

const SYSTEM_PROMPT = `You are the virtual receptionist for Dr. Gregorio De Carvalho, a specialist in aesthetic medicine working across two clinics in London. Always communicate in the same language the patient uses (English or Spanish).

CLINIC 1: VITALUMINA
Website: vitalumina.co.uk
Doctor-led advanced aesthetic medicine. Natural, personalised results.
Dr. Gregorio De Carvalho - 12+ years in aesthetic medicine.
Philosophy: natural-looking results, never the overfilled look.

VITALUMINA LOCATIONS:
- PRIMARY: Dr Gregorio Aesthetic @ L&Y Dental Clinic, 36-38 Cornhill, London EC3V 3ND
- ALSO: Chelsea Bridge Clinic, 368 Queenstown Rd, London SW11 8NN
- ALSO: Rejuva-London, 15 Harley St, London W1G 9QQ

VITALUMINA TREATMENTS:
Injectables: Botox, Dermal Fillers, Profhilo, Polynucleotides, Lip Enhancement, Cheek Contouring, Non-Surgical Rhinoplasty, Under-Eye Treatment, Fat Dissolving, Hyperhidrosis, Filler Dissolving
Skin: Chemical Peels, Microneedling, Skin Boosters

CLINIC 2: ICE HEALTH CRYOTHERAPY
Address: 237 Kensington High St, London W8 6SA
Hours: Mon-Fri 9:30AM-7PM, Sat 9:30AM-4PM, Sun Closed

HOW TO BOOK: Collect full name, phone number, treatment/concern, preferred location and date/time.
Online booking also at vitalumina.co.uk

GUIDELINES:
- Be warm, professional and elegant
- For pricing: explain prices vary and a consultation is needed
- Never give specific medical advice
- For urgent queries escalate to human`;

async function generateWithFallback(contents) {
  let lastError;
  for (const model of MODELS) {
    const maxRetries = model === MODELS[0] ? 3 : 1;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[AI] Trying model: ${model} (attempt ${attempt})`);
        const response = await genAI.models.generateContent({
          model,
          contents,
          config: { systemInstruction: SYSTEM_PROMPT },
        });
        console.log(`[AI] Success with model: ${model}`);
        return response;
      } catch (err) {
        const status = err?.status || err?.error?.code;
        const isRetryable = status === 503 || status === 429 || (err.message && err.message.includes('UNAVAILABLE'));
        console.log(`[AI] ${model} attempt ${attempt} failed: status=${status} retryable=${isRetryable}`);
        lastError = err;
        if (!isRetryable) throw err;
        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt - 1);
          console.log(`[AI] Waiting ${delay}ms before retry...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    console.log(`[AI] All retries exhausted for ${model}, trying next model...`);
  }
  throw lastError;
}

async function sendWhatsAppMessage(to, text) {
  console.log(`[SEND] Sending to ${to}: ${text.substring(0, 80)}`);
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });
  const data = await res.json();
  console.log(`[SEND] Status: ${res.status}`, JSON.stringify(data));
  return data;
}

async function runAgent(from, userText) {
  console.log(`[AGENT] From ${from}: "${userText}"`);
  if (!conversations.has(from)) conversations.set(from, []);
  const history = conversations.get(from);
  history.push({ role: "user", parts: [{ text: userText }] });
  const response = await generateWithFallback(history);
  const replyText = response.text || "I'm sorry, please visit vitalumina.co.uk or call us.";
  console.log(`[AGENT] Reply: "${replyText.substring(0, 100)}"`);
  history.push({ role: "model", parts: [{ text: replyText }] });
  if (history.length > 20) history.splice(0, history.length - 20);
  conversations.set(from, history);
  return replyText;
}

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  console.log(`[WEBHOOK] GET mode=${mode} token=${token}`);
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log(`[WEBHOOK] Verified`);
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  console.log(`[WEBHOOK] POST received`);
  console.log(`[WEBHOOK] Body: ${JSON.stringify(req.body).substring(0, 500)}`);
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") {
      console.log(`[WEBHOOK] No text message found`);
      return;
    }
    const from = message.from;
    const text = message.text.body;
    console.log(`[WEBHOOK] Processing from ${from}: "${text}"`);
    const reply = await runAgent(from, text);
    await sendWhatsAppMessage(from, reply);
    console.log(`[WEBHOOK] Done`);
  } catch (err) {
    console.error("[WEBHOOK] Error:", err);
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "Vitalumina WhatsApp Agent" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
