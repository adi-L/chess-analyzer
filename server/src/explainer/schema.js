import { z } from 'zod';

export const ExplanationSchema = z.object({
  ply: z.number().int().nonnegative(),
  teachMove: z.string().min(2),
  whatWentWrong: z.string().min(1).max(400),
  whyBetter: z.string().min(1).max(600),
  // Verified against a live call: without a ceiling the model writes a
  // paragraph here. Exceeding it fails validation and triggers the retry.
  pattern: z.string().min(1).max(40),
});

export const ExplanationsSchema = z.array(ExplanationSchema);

/**
 * Pull a JSON array out of a model response. There is no output-format
 * guarantee on this path, so the text may be fenced, prefixed with prose,
 * or both.
 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseExplanations(text) {
  const raw = extractJsonBlock(text);
  if (raw === null) return { ok: false, error: 'no JSON array found in response' };
  const result = ExplanationsSchema.safeParse(raw);
  if (!result.success) {
    const error = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    return { ok: false, error };
  }
  return { ok: true, data: result.data };
}
