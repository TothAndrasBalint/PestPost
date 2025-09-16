// lib/wa.js
const PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const GRAPH_VER = process.env.WA_GRAPH_VER || "v20.0";
const BASE = `https://graph.facebook.com/${GRAPH_VER}/${PHONE_NUMBER_ID}/messages`;

async function send(payload) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`WA send HTTP ${res.status} — ${t}`);
  }
  return res.json();
}

export async function sendText({ to, body }) {
  return send({ messaging_product: "whatsapp", to, type: "text", text: { body } });
}

export async function sendImage({ to, imageUrl, caption }) {
  return send({
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link: imageUrl, caption },
  });
}

// Buttons (non-template) cannot include media in the same message.
// We send media first, then a button message asking for approval.
export async function sendApproveButtons({ to, draftId, bodyText = "Approve this post?" }) {
  return send({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: [
          { type: "reply", reply: { id: `approve:${draftId}`, title: "Approve ✅" } },
          { type: "reply", reply: { id: `request_edit:${draftId}`, title: "Request edit ✍️" } },
        ],
      },
    },
  });
}
