'use strict';

/**
 * Groq triage for owner/manager support messages.
 * Known-answer library intentionally empty until ~15–20 real tickets exist.
 */

const CATEGORIES = [
  'catalog_sync',
  'payment_failure',
  'kds_printer',
  'subscription_billing',
  'menu_setup',
  'other',
];

const ALWAYS_ESCALATE = new Set(['subscription_billing', 'payment_failure']);

/** Fill after real tickets — map category → canned answer string. */
const KNOWN_ANSWERS = {
  // catalog_sync: '',
  // payment_failure: '',
  // kds_printer: '',
  // subscription_billing: '',
  // menu_setup: '',
  // other: '',
};

const SYSTEM_PROMPT = `You are Munafe's support triage assistant for restaurant owners/managers using the platform.

Classify the incoming message into exactly one category:
catalog_sync | payment_failure | kds_printer | subscription_billing | menu_setup | other

Known answers (respond directly, do NOT escalate, only if the question clearly matches):
[intentionally empty — fill in after the first 15-20 real tickets are logged]

Rules:
- If confidence >= 0.75 AND the category has a known answer above, respond directly,
  adapted to their specific wording. Set resolution_type = auto_resolved.
- Otherwise, do NOT guess. Set resolution_type = escalated, write a one-line summary,
  leave response_or_null as null.
- Never auto-resolve subscription_billing or payment_failure regardless of confidence
  — always escalate those two categories to a human.

Output strict JSON only: { "category", "confidence_score", "response_or_null", "resolution_type", "summary" }
summary must be a one-line description of what they are asking.`;

function normalizeResult(raw) {
  const category = CATEGORIES.includes(raw?.category) ? raw.category : 'other';
  let confidence = Number(raw?.confidence_score);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  let resolution = raw?.resolution_type === 'auto_resolved' ? 'auto_resolved' : 'escalated';
  let response = raw?.response_or_null != null ? String(raw.response_or_null).trim() : null;
  if (response === '') response = null;

  const known = KNOWN_ANSWERS[category];
  const hasKnown = typeof known === 'string' && known.trim().length > 0;

  // Enforce policy regardless of model output
  if (ALWAYS_ESCALATE.has(category) || !hasKnown || confidence < 0.75 || !response) {
    resolution = 'escalated';
    response = null;
  } else {
    resolution = 'auto_resolved';
  }

  const summary = String(raw?.summary || '').trim()
    || String(raw?.response_or_null || '').trim().slice(0, 160)
    || 'Support request';

  return {
    category,
    confidence_score: confidence,
    response_or_null: response,
    resolution_type: resolution,
    summary,
  };
}

async function classifyWithGroq(message) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return normalizeResult({
      category: 'other',
      confidence_score: 0,
      response_or_null: null,
      resolution_type: 'escalated',
      summary: String(message || '').slice(0, 120) || 'Support request (no Groq key)',
    });
  }

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(message || '').slice(0, 4000) },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('[supportTriage] Groq error', res.status, errText.slice(0, 300));
    return normalizeResult({
      category: 'other',
      confidence_score: 0,
      resolution_type: 'escalated',
      summary: String(message || '').slice(0, 120) || 'Support request (triage failed)',
    });
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }
  return normalizeResult(parsed);
}

module.exports = {
  CATEGORIES,
  KNOWN_ANSWERS,
  classifyWithGroq,
  normalizeResult,
};
