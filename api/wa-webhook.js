// ---- Status handler: logs statuses and replies with buttons under the image ----
async function handleStatuses(envelope) {
  const entries = Array.isArray(envelope?.entry) ? envelope.entry : [];
  let sawStatuses = false;
  let sawMessages = false;

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      const statuses = value?.statuses;
      const messages = value?.messages;

      if (Array.isArray(messages) && messages.length) sawMessages = true;

      if (Array.isArray(statuses) && statuses.length) {
        sawStatuses = true;

        for (const s of statuses) {
          // 1) Always log the status
          await recordEvent(supabaseAdmin, {
            wa_message_id: s.id,               // message id that this status refers to
            from_wa: s.recipient_id || null,
            event_type: `status:${s.status}`,
            raw: s,
          });

          // 2) When the image is sent/delivered, reply with buttons under it (once)
          if ((s.status === 'sent' || s.status === 'delivered') && s.id) {
            const { data: d } = await supabaseAdmin
              .from('draft_posts')
              .select('id, from_wa, preview_buttons_sent_at')
              .eq('preview_message_id', s.id)
              .single();

            if (d && !d.preview_buttons_sent_at && d.from_wa && PHONE_ID && TOKEN) {
              const buttonsPayload = {
                messaging_product: 'whatsapp',
                to: d.from_wa,
                type: 'interactive',
                context: { message_id: s.id }, // reply to the image → renders beneath it
                interactive: {
                  type: 'button',
                  body: { text: 'Approve this post, or request edits.' },
                  action: {
                    buttons: [
                      { type: 'reply', reply: { id: `approve:${d.id}`,      title: 'Approve ✅' } },
                      { type: 'reply', reply: { id: `request_edit:${d.id}`, title: 'Request edit ✍️' } },
                    ],
                  },
                },
              };

              try {
                await fetch(`https://graph.facebook.com/v20.0/${PHONE_ID}/messages`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${TOKEN}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify(buttonsPayload),
                });

                await supabaseAdmin
                  .from('draft_posts')
                  .update({ preview_buttons_sent_at: new Date().toISOString() })
                  .eq('id', d.id);
              } catch (e) {
                console.error('send buttons failed:', e?.message || e);
              }
            }
          }
        }
      }
    }
  }

  // Return true if the webhook contained ONLY statuses (no inbound messages)
  return sawStatuses && !sawMessages;
}
