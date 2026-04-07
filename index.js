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

  const response = await genAI.models.generateContent({
    model: "gemini-2.0-flash",
    contents: history,
    config: { systemInstruction: SYSTEM_PROMPT },
  });

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
