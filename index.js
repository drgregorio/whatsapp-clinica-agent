import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const PABAU_API_KEY = process.env.PABAU_API_KEY;
const PABAU_BASE = `https://api.oauth.pabau.com/${PABAU_API_KEY}`;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const HUMAN_PHONE = process.env.HUMAN_PHONE;

const conversations = new Map();

const SYSTEM_PROMPT = `You are the virtual receptionist for Dr. Gregorio De Carvalho, a specialist in aesthetic medicine working across two clinics in London.

Always communicate in the same language the patient uses (English or Spanish).

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
Injectables & Contouring:
- Wrinkle-Relaxing Injections (Botox / Botulinum Toxin Type A)
- Calf Reduction (Botox to slim and contour calves)
- Shoulder Contour / Trap Tox
- Mini Thread Lift (minimally invasive skin lifting)
- Dermal Fillers - Hyaluronic Acid (face, hands, neck, decollete)
- Hyperhidrosis / Excessive Sweating treatment
- Filler Dissolving (Hyaluronidase)
- Fat-Dissolving Injections (chin, jawline, abdomen, flanks, bra rolls)
Facial Aesthetics:
- Lip Enhancement & Definition
- Cheek & Jawline Contouring
- Non-Surgical Rhinoplasty
- Under-Eye / Tear Trough Treatment
- Brow Lift
- Neck & Decollete Rejuvenation
Skin Treatments:
- Profhilo (skin remodelling biostimulator)
- Polynucleotides / PDRN (advanced skin regeneration)
- Skin Boosters, Chemical Peels, Microneedling

CLINIC 2: ICE HEALTH CRYOTHERAPY (Private Consultation)
Address: 237 Kensington High St, London W8 6SA
Dr. Gregorio holds private aesthetic consultations here.
Hours: Monday-Friday 9:30 AM - 7:00 PM, Saturday 9:30 AM - 4:00 PM, Sunday Closed
Patients can book with Dr. Gregorio here for the same Vitalumina aesthetic treatments.

HOW TO BOOK:
Collect: full name, phone number, treatment/concern, preferred location and date/time.
Location options: Cornhill (primary), Chelsea Bridge, Harley St, or Kensington/Ice Health.
Online booking also at vitalumina.co.uk

GUIDELINES:
- Be warm, professional and elegant
- For pricing: explain that prices vary and a consultation is needed for exact quotes
- Never give specific medical advice - always recommend a consultation with Dr. Gregorio
- For urgent or complex queries escalate to human`;

async function pabauGet(path) {
  const res = await fetch(`${PABAU_BASE}/${path}`);
  return res.json();
}

async function pabauPost(path, body) {
  const res = await fetch(`${PABAU_BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function findOrCreateClient({ name, phone }) {
  try {
    const search = await pabauGet(`clients?mobile=${phone}`);
    if (search.clients?.length) return search.clients[0];
    const parts = name.trim().split(" ");
    return await pabauPost("clients/create", {
      Fname: parts[0],
      Lname: parts.slice(1).join(" ") || "",
      Mobile: phone,
    });
  } catch (e) {
    console.error("Pabau client error:", e);
    return null;
  }
}

const TOOLS = [
  {
    name: "check_availability",
    description: "Check available appointment slots for a given date",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" }
      },
      required: ["date"]
    }
  },
  {
    name: "book_appointment",
    description: "Book an appointment for a patient with Dr. Gregorio",
    parameters: {
      type: "object",
      properties: {
        patient_name: { type: "string" },
        patient_phone: { type: "string" },
        service: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        location: { type: "string", description: "Preferred clinic: Cornhill, Chelsea Bridge, Harley St, or Kensington/Ice Health" }
      },
      required: ["patient_name", "patient_phone", "service", "date", "time"]
    }
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment",
    parameters: {
      type: "object",
      properties: {
        patient_phone: { type: "string" },
        appointment_id: { type: "string" }
      },
      required: ["patient_phone"]
    }
  },
  {
    name: "escalate_to_human",
    description: "Transfer conversation to Dr. Gregorio or clinic staff",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        patient_name: { type: "string" }
      },
      required: ["reason"]
    }
  },
];

async function executeTool(name, args) {
  if (name === "check_availability") {
    const data = await pabauGet(`appointments?date=${args.date}`);
    return { date: args.date, appointments: data.appointments || [] };
  }
  if (name === "book_appointment") {
    const client = await findOrCreateClient({ name: args.patient_name, phone: args.patient_phone });
    if (!client) return { success: false, error: "Could not find or create patient" };
    const appt = await pabauPost("appointments/create", {
      client_id: client.id,
      service: args.service,
      start_date: args.date,
      start_time: args.time,
      notes: `Booked via WhatsApp. Location: ${args.location || "TBC"}`,
    });
    return { success: true, appointment: appt };
  }
  if (name === "cancel_appointment") {
    if (args.appointment_id) {
      await pabauPost(`appointments/${args.appointment_id}/update`, { appointment_status: "Cancelled" });
      return { success: true, message: "Appointment cancelled" };
    }
    const data = await pabauGet(`appointments?mobile=${args.patient_phone}`);
    return { success: true, upcoming: data.appointments };
  }
  if (name === "escalate_to_human") {
    if (HUMAN_PHONE) {
      await sendWhatsAppMessage(HUMAN_PHONE, `Dr. Gregorio - Patient query\nReason: ${args.reason}\nPatient: ${args.patient_name || "Unknown"}`);
    }
    return { success: true, message: "Our team has been notified and will be in touch shortly." };
  }
  return { error: "Unknown tool" };
}

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
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
}

async function runAgent(from, userText) {
  if (!conversations.has(from)) conversations.set(from, []);
  const history = conversations.get(from);

  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: TOOLS }],
  });

  const chat = model.startChat({ history });
  let result = await chat.sendMessage(userText);
  let response = result.response;

  while (response.functionCalls && response.functionCalls().length > 0) {
    const calls = response.functionCalls();
    const toolResults = [];
    for (const call of calls) {
      const output = await executeTool(call.name, call.args);
      toolResults.push({
        functionResponse: {
          name: call.name,
          response: output,
        },
      });
    }
    result = await chat.sendMessage(toolResults);
    response = result.response;
  }

  const replyText = response.text() || "I'm sorry, please visit vitalumina.co.uk";

  // Update history for next turn
  const updatedHistory = await chat.getHistory();
  if (updatedHistory.length > 20) updatedHistory.splice(0, updatedHistory.length - 20);
  conversations.set(from, updatedHistory);

  return replyText;
}

app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === VERIFY_TOKEN) res.status(200).send(challenge);
  else res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return;
    const reply = await runAgent(message.from, message.text.body);
    await sendWhatsAppMessage(message.from, reply);
  } catch (err) {
    console.error("Webhook error:", err);
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "Dr. Gregorio - Vitalumina & Ice Health Receptionist" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
