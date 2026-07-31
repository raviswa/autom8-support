'use strict';

const express = require('express');
const router = express.Router();
const {
  getSupabaseAdmin,
  authenticateToken,
  attachOutletContext,
  requireSupportAdmin,
  isValidInternalSecret,
  extractInternalSecret,
} = require('../middleware/auth');
const { classifyWithGroq, CATEGORIES } = require('../helpers/supportTriage');
const { notifyWhatsApp, notifyAdminEscalation } = require('../helpers/notify');

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function createTicketFromPayload(payload) {
  const triage = await classifyWithGroq(payload.message);
  const category = payload.category && CATEGORIES.includes(payload.category)
    ? payload.category
    : triage.category;

  const row = {
    restaurant_id: payload.restaurant_id || null,
    user_id: payload.user_id || null,
    customer_phone: payload.customer_phone || null,
    source: payload.source || 'dashboard',
    category,
    message: payload.message,
    ai_category: triage.category,
    confidence_score: triage.confidence_score,
    ai_response: triage.response_or_null,
    resolution_type: triage.resolution_type,
    summary: triage.summary,
    status: triage.resolution_type === 'auto_resolved' ? 'closed' : 'open',
  };

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('support_tickets')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;

  if (data.resolution_type === 'auto_resolved' && data.ai_response && data.customer_phone) {
    await notifyWhatsApp({
      to: data.customer_phone,
      message: data.ai_response,
      restaurantId: data.restaurant_id,
    });
  }

  if (data.resolution_type === 'escalated') {
    await notifyAdminEscalation(data);
  }

  return data;
}

/**
 * POST /tickets
 * - Dashboard: Bearer JWT + { message, category?, restaurant_id?, source: 'dashboard' }
 * - WhatsApp ingest: x-internal-secret + { message, customer_phone, restaurant_id?, source: 'whatsapp' }
 */
router.post('/', (req, res) => {
  const internal = isValidInternalSecret(extractInternalSecret(req));
  const waIngest = internal && (req.body?.source === 'whatsapp' || req.body?.customer_phone);

  if (waIngest) {
    (async () => {
      try {
        const message = String(req.body?.message || '').trim();
        if (!message) return res.status(400).json({ error: 'message is required' });
        const ticket = await createTicketFromPayload({
          message,
          customer_phone: String(req.body.customer_phone || '').replace(/\D/g, '') || null,
          restaurant_id: req.body.restaurant_id || null,
          source: 'whatsapp',
          category: req.body.category || null,
          user_id: null,
        });
        return res.status(201).json({ ticket });
      } catch (err) {
        console.error('[POST /tickets whatsapp]', err.message);
        return res.status(500).json({ error: err.message || 'Failed to create ticket' });
      }
    })();
    return;
  }

  authenticateToken(req, res, () => {
    attachOutletContext(req, res, async () => {
      try {
        const message = String(req.body?.message || '').trim();
        if (!message) return res.status(400).json({ error: 'message is required' });

        const restaurantId = req.body?.restaurant_id || req.restaurant_id || null;
        if (!restaurantId) {
          return res.status(400).json({ error: 'restaurant_id is required (select an outlet)' });
        }

        const ticket = await createTicketFromPayload({
          message,
          category: req.body.category || null,
          restaurant_id: restaurantId,
          user_id: req.user.sub,
          customer_phone: null,
          source: req.body.source || 'dashboard',
        });

        return res.status(201).json({
          ticket,
          confirmation: ticket.resolution_type === 'auto_resolved'
            ? ticket.ai_response
            : "We've got it — you'll hear back shortly.",
        });
      } catch (err) {
        console.error('[POST /tickets]', err.message);
        return res.status(500).json({ error: err.message || 'Failed to create ticket' });
      }
    });
  });
});

router.get('/', authenticateToken, requireSupportAdmin, async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 50, 1, 200);
    const offset = clampInt(req.query.offset, 0, 0, 100000);
    const admin = getSupabaseAdmin();
    let q = admin.from('support_tickets').select('*', { count: 'exact' });

    if (String(req.query.queue || '') === 'actionable') {
      q = q.eq('resolution_type', 'escalated').eq('status', 'open');
    } else {
      if (req.query.status) q = q.eq('status', req.query.status);
      if (req.query.resolution_type) q = q.eq('resolution_type', req.query.resolution_type);
    }
    if (req.query.category) q = q.eq('category', req.query.category);
    if (req.query.restaurant_id) q = q.eq('restaurant_id', req.query.restaurant_id);

    q = q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;
    return res.json({ tickets: data || [], count: count ?? (data || []).length, limit, offset });
  } catch (err) {
    console.error('[GET /tickets]', err.message);
    return res.status(500).json({ error: err.message || 'Failed to list tickets' });
  }
});

router.get('/:id', authenticateToken, requireSupportAdmin, async (req, res) => {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Ticket not found' });
    return res.json({ ticket: data });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to load ticket' });
  }
});

router.patch('/:id', authenticateToken, requireSupportAdmin, async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.resolution_type !== undefined) updates.resolution_type = req.body.resolution_type;
    if (req.body.notes !== undefined) updates.notes = req.body.notes;
    if (req.body.assigned_to !== undefined) updates.assigned_to = req.body.assigned_to;
    if (req.body.status !== undefined) updates.status = req.body.status;
    if (req.body.category !== undefined) updates.category = req.body.category;

    const { data, error } = await getSupabaseAdmin()
      .from('support_tickets')
      .update(updates)
      .eq('id', req.params.id)
      .select('*')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Ticket not found' });
    return res.json({ ticket: data });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to update ticket' });
  }
});

module.exports = router;
