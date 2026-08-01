'use strict';

/**
 * Call autom8-backend POST /api/internal/notify/whatsapp
 * Reuses backend sendWhatsAppMessage — do not duplicate Graph API here.
 */

async function notifyWhatsApp({ to, message, restaurantId = null }) {
  const base = String(process.env.AUTOM8_API_BASE || '').replace(/\/$/, '');
  const secret = process.env.AUTOM8_KDS_SECRET;
  if (!base || !secret) {
    console.warn('[notifyWhatsApp] AUTOM8_API_BASE or AUTOM8_KDS_SECRET missing — skip send');
    return false;
  }
  try {
    const res = await fetch(`${base}/api/internal/notify/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': secret,
      },
      body: JSON.stringify({
        to,
        message,
        restaurant_id: restaurantId || undefined,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[notifyWhatsApp] failed', res.status, err.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[notifyWhatsApp]', err.message);
    return false;
  }
}

async function notifyAdminEscalation(ticket) {
  const phone = String(process.env.SUPPORT_ADMIN_WHATSAPP || '').replace(/\D/g, '');
  if (!phone) {
    console.warn('[notifyAdminEscalation] SUPPORT_ADMIN_WHATSAPP not set');
    return false;
  }
  const appBase = String(process.env.ADMIN_APP_BASE || 'https://app.autom8.works').replace(/\/$/, '');
  // Admin UI for now is served from this service; link can also be app path later.
  const supportBase = String(process.env.SUPPORT_PUBLIC_URL || process.env.ADMIN_APP_BASE || appBase).replace(/\/$/, '');
  const link = `${supportBase}/admin#ticket=${ticket.id}`;
  const summary = ticket.summary || ticket.message?.slice(0, 140) || 'New support ticket';
  const nAttach = Array.isArray(ticket.attachments) ? ticket.attachments.length : 0;
  const text = [
    '🚨 Support escalated',
    `Category: ${ticket.ai_category || ticket.category || 'other'}`,
    `Outlet: ${ticket.restaurant_id || '—'}`,
    summary,
    nAttach ? `Attachments: ${nAttach} image(s)` : null,
    link,
  ].filter(Boolean).join('\n');
  return notifyWhatsApp({ to: phone, message: text, restaurantId: null });
}

module.exports = { notifyWhatsApp, notifyAdminEscalation };
