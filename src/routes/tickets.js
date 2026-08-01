'use strict';

const express = require('express');
const multer = require('multer');
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
const {
  MAX_FILES,
  MAX_BYTES,
  ALLOWED,
  uploadTicketImages,
  withSignedAttachmentUrls,
} = require('../helpers/attachments');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      return cb(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'));
    }
    cb(null, true);
  },
});

function clampInt(v, fallback, min, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseFilesError(err) {
  if (!err) return null;
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return 'Each image must be 5 MB or smaller';
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return `Maximum ${MAX_FILES} images allowed`;
    }
    return err.message;
  }
  return err.message || 'Upload failed';
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
    attachments: [],
    status: triage.resolution_type === 'auto_resolved' ? 'closed' : 'open',
  };

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('support_tickets')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;

  let ticket = data;

  if (payload.files?.length) {
    try {
      const attachments = await uploadTicketImages({
        restaurantId: ticket.restaurant_id,
        ticketId: ticket.id,
        files: payload.files,
      });
      if (attachments.length) {
        const { data: updated, error: upErr } = await admin
          .from('support_tickets')
          .update({ attachments, updated_at: new Date().toISOString() })
          .eq('id', ticket.id)
          .select('*')
          .single();
        if (upErr) throw upErr;
        ticket = updated;
      }
    } catch (uploadErr) {
      console.error('[tickets] attachment upload', uploadErr.message);
      // Ticket already created — surface soft failure on response
      ticket = { ...ticket, _attachment_error: uploadErr.message };
    }
  }

  if (ticket.resolution_type === 'auto_resolved' && ticket.ai_response && ticket.customer_phone) {
    await notifyWhatsApp({
      to: ticket.customer_phone,
      message: ticket.ai_response,
      restaurantId: ticket.restaurant_id,
    });
  }

  if (ticket.resolution_type === 'escalated') {
    await notifyAdminEscalation(ticket);
  }

  return ticket;
}

/**
 * POST /tickets
 * JSON or multipart (fields + images[]).
 */
router.post('/', (req, res) => {
  upload.array('images', MAX_FILES)(req, res, (uploadErr) => {
    const fileErr = parseFilesError(uploadErr);
    if (fileErr) return res.status(400).json({ error: fileErr });

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
            files: req.files || [],
          });
          return res.status(201).json({ ticket: await withSignedAttachmentUrls(ticket) });
        } catch (err) {
          console.error('[POST /tickets whatsapp]', err.message);
          return res.status(err.status || 500).json({ error: err.message || 'Failed to create ticket' });
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
            files: req.files || [],
          });

          const signed = await withSignedAttachmentUrls(ticket);
          return res.status(201).json({
            ticket: signed,
            confirmation: ticket.resolution_type === 'auto_resolved'
              ? ticket.ai_response
              : "We've got it — you'll hear back shortly.",
            attachment_error: ticket._attachment_error || undefined,
          });
        } catch (err) {
          console.error('[POST /tickets]', err.message);
          return res.status(err.status || 500).json({ error: err.message || 'Failed to create ticket' });
        }
      });
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
    const tickets = await Promise.all((data || []).map((t) => withSignedAttachmentUrls(t)));
    return res.json({ tickets, count: count ?? tickets.length, limit, offset });
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
    return res.json({ ticket: await withSignedAttachmentUrls(data) });
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
    return res.json({ ticket: await withSignedAttachmentUrls(data) });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to update ticket' });
  }
});

module.exports = router;
