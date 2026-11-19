// Parses and validates the multipart body of POST /api/post.

import { weightedLength } from "../public/counter.js";
import { ValidationError } from "./errors";
import type { OutgoingPost } from "./x";

export const MAX_POSTS = 25;
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Detects JPEG, PNG or WebP from the first bytes. Returns null for anything else. */
export function sniffImageType(head: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return "image/png";
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && // RIFF
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 // WEBP
  ) return "image/webp";
  return null;
}

export async function parsePostForm(form: FormData, maxChars: number): Promise<OutgoingPost[]> {
  let meta: unknown;
  try {
    meta = JSON.parse(String(form.get("posts") ?? ""));
  } catch {
    throw new ValidationError("Something's off with that request. Try again.");
  }
  if (!Array.isArray(meta) || meta.length < 1 || meta.length > MAX_POSTS) {
    throw new ValidationError(`A thread can have 1 to ${MAX_POSTS} posts.`);
  }

  const out: OutgoingPost[] = [];
  for (let i = 0; i < meta.length; i++) {
    const p = meta[i] as { text?: unknown; images?: unknown };
    const text = typeof p?.text === "string" ? p.text : "";
    const count = Number(p?.images ?? 0);
    const label = meta.length > 1 ? `Post ${i + 1}` : "This post";

    if (!Number.isInteger(count) || count < 0 || count > MAX_IMAGES) {
      throw new ValidationError(`${label} can have at most ${MAX_IMAGES} images.`);
    }
    if (!text.trim() && count === 0) throw new ValidationError(`${label} is empty.`);
    if (weightedLength(text) > maxChars) throw new ValidationError(`${label} is too long.`);

    const images: Blob[] = [];
    for (let j = 0; j < count; j++) {
      const f = form.get(`image_${i}_${j}`);
      if (!f || typeof f === "string") throw new ValidationError(`An image for ${label.toLowerCase()} is missing.`);
      const file = f as unknown as Blob;
      if (file.size > MAX_IMAGE_BYTES) throw new ValidationError("Images must be 5 MB or smaller.");
      const type = sniffImageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()));
      if (!type) throw new ValidationError("Images must be JPEG, PNG or WebP.");
      images.push(new Blob([file], { type }));
    }
    out.push({ text, images });
  }
  return out;
}
