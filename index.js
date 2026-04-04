import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PABAU_API_KEY = process.env.PABAU_API_KEY;
const PABAU_BASE = `https://api.oauth.pabau.com/${PABAU_API_KEY}`;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const HUMAN_PHONE = process.env.HUMAN_PHONE;

const conversations = new Map();

const SYSTEM_PROMPT = `You are a friendly and professional virtual receptionist for our medical clinic.
You communicate in the same language the patient uses.
You can help patients with:
- Booking new appointments
- Checking appointment availability
- Cancelling or modifying existing appointments
- Answering general questions about clinic hours and services
Clinic hours: Monday to Friday 9:00 AM - 6:00 PM, Saturday 9:00 AM - 2:00 PM.
When booking, always collect: full name, phone, desired service, preferred date and time.
If the patient has an urgent concern or you cannot resolve their issue, use the escalate_to_human tool.`;

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
      Fname: parts[0], Lname: parts.slice(1).join(" ") || "", Mobile: phone,
    });
  } catch (e) { console.error("Pabau client error:", e); return null; }
}

const TOOLS = [
  {
    name: "check_availability",
    description: "Check available appointment slots for a given date",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "Date in YYYY-MM-DD format" } },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description: "Book an appointment for a patient in Pabau",
    input_schema: {
      type: "object",
      properties: {
        patient_name: { type: "string" },
        patient_phone: { type: "string" },
        service: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
      },
      required: ["patient_name", "patient_phone", "service", "date", "time"],
    },
  },
  {
    name: "cancel_appointment",
    description: "Cancel an existing appointment by patient phone",
    input_schema: {
      type: "object",
      properties: {
        patient_phone: { type: "string" },
        appointment_id: { type: "string" },
      },
      required: ["patient_phone"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Transfer conversation to a human staff member",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        patient_name: { type: "string" },
      },
      required: ["reason"],
    },
  },
];

async function executeTool(name, input) {
  if (name === "check_availability") {
    const data = await pabauGet(`appointments?date=${input.date}`);
    return { date: input.date, appointments: data.appointments || [] };
  }
  if (name === "book_appointment") {
    const client = await findOrCreateClient({ name: input.patient_name, phone: input.patient_phone });
    if (!client) return { success: false, error: "Could not find or create patient" };
    const appt = await pabauPost("appointments/create", {
      client_id: client.id, service: input.service,
      start_date: input.date, start_time: input.time, notes: "Booked via WhatsApp",
    });
    return { success: true, appointment: appt };
  }
  if (name === "cancel_appointment") {
    if (input.appointment_id) {
      await pabauPost(`appointments/${input.appointment_id}/update`, { appointment_status: "Cancelled" });
      return { success: true, message: "Appointment cancelled" };
    }
    const data = await pabauGet(`appointments?mobile=${input.patient_phone}`);
    return { success: true, upcoming: data.appointments };
  }
  if (name === "escalate_to_human") {
    if (HUMAN_PHONE) {
      await sendWhatsAppMessage(HUMAN_PHONE,
        `🚨 Patient needs help\nReason: ${input.reason}\nPatient: ${input.patient_name || "Unknown"}`);
    }
    return { success: true, message: "Staff has been notified and will contact you shortly." };
  }
  return { error: "Unknown tool" };
}

async function sendWhatsAppMessage(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
  });
}

async function runAgent(from, userText) {
  if (!conversations.has(from)) conversations.set(from, []);
  const history = conversations.get(from);
  history.push({ role: "user", content: userText });
  if (history.length > 20) history.splice(0, history.length - 20);

  let response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages: history,
  });

  while (response.stop_reason === "tool_use") {
    history.push({ role: "assistant", content: response.content });
    const toolResults = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        console.log(`[Tool] ${block.name}`, block.input);
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    history.push({ role: "user", content: toolResults });
    response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1024,
      system: SYSTEM_PROMPT, tools: TOOLS, messages: history,
    });
  }

  const replyText = response.content.find((b) => b.type === "text")?.text || "Sorry, I could not process your request.";
  history.push({ role: "assistant", content: replyText });
  return replyText;
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else { res.sendStatus(403); }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== "text") return;
    const from = message.from;
    const text = message.text.body;
    console.log(`[IN] ${from}: ${text}`);
    const reply = await runAgent(from, text);
    console.log(`[OUT] ${from}: ${reply}`);
    await sendWhatsAppMessage(from, reply);
  } catch (err) { console.error("Webhook error:", err); }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "WhatsApp Clinic Agent" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
