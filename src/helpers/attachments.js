'use strict';

const path = require('path');
const crypto = require('crypto');
const { getSupabaseAdmin } = require('../middleware/auth');

const BUCKET = process.env.SUPPORT_STORAGE_BUCKET || 'support-attachments';
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function extForMime(mime) {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'bin';
  }
}

/**
 * Upload multer memory files to Supabase Storage.
 * @returns {Promise<Array<{ path: string, name: string, mime: string, size: number }>>}
 */
async function uploadTicketImages({ restaurantId, ticketId, files }) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return [];

  if (list.length > MAX_FILES) {
    throw Object.assign(new Error(`Maximum ${MAX_FILES} images allowed`), { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const out = [];

  for (const file of list) {
    const mime = String(file.mimetype || '');
    if (!ALLOWED.has(mime)) {
      throw Object.assign(new Error('Only JPEG, PNG, WebP, or GIF images are allowed'), { status: 400 });
    }
    if ((file.size || 0) > MAX_BYTES) {
      throw Object.assign(new Error('Each image must be 5 MB or smaller'), { status: 400 });
    }

    const safeName = path.basename(String(file.originalname || 'image')).replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120);
    const objectPath = [
      String(restaurantId || 'unknown'),
      String(ticketId),
      `${crypto.randomUUID()}.${extForMime(mime)}`,
    ].join('/');

    const { error } = await admin.storage
      .from(BUCKET)
      .upload(objectPath, file.buffer, {
        contentType: mime,
        upsert: false,
      });
    if (error) throw error;

    out.push({
      path: objectPath,
      name: safeName || objectPath.split('/').pop(),
      mime,
      size: file.size || file.buffer?.length || 0,
    });
  }

  return out;
}

/** Attach short-lived signed URLs for admin UI. */
async function withSignedAttachmentUrls(ticket, expiresIn = 3600) {
  if (!ticket) return ticket;
  const attachments = Array.isArray(ticket.attachments) ? ticket.attachments : [];
  if (!attachments.length) return { ...ticket, attachments: [] };

  const admin = getSupabaseAdmin();
  const signed = await Promise.all(attachments.map(async (att) => {
    if (!att?.path) return { ...att, url: null };
    const { data, error } = await admin.storage
      .from(BUCKET)
      .createSignedUrl(att.path, expiresIn);
    if (error) {
      console.warn('[attachments] signed URL failed', att.path, error.message);
      return { ...att, url: null };
    }
    return { ...att, url: data?.signedUrl || null };
  }));

  return { ...ticket, attachments: signed };
}

module.exports = {
  BUCKET,
  MAX_FILES,
  MAX_BYTES,
  ALLOWED,
  uploadTicketImages,
  withSignedAttachmentUrls,
};
