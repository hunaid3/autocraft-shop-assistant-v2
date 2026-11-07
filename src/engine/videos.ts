/**
 * How-to videos. The onboarding clip (intro + sign-up) is sent as a real WhatsApp video on the welcome card;
 * every other chapter is a YouTube link. All addresses live in platform_settings.how_to_videos, so a link
 * can be added or swapped with one SQL update, no release.
 */
import type { Tx } from '../db/tenantTx.js';
import type { Reply } from './router.js';

export const CHAPTERS: Record<number, { title: string; secs: number }> = {
  0: { title: 'Intro', secs: 13 },
  1: { title: 'Sign up', secs: 38 },
  2: { title: 'Your first bill', secs: 40 },
  3: { title: 'Quotes', secs: 29 },
  4: { title: 'Buying stock', secs: 37 },
  5: { title: 'Stock out and returns', secs: 20 },
  6: { title: 'Ask anything, and expenses', secs: 23 },
  7: { title: 'Staff', secs: 29 },
  8: { title: 'Your dashboard', secs: 48 },
  9: { title: 'Credits and recharge', secs: 34 },
  10: { title: 'More shops and help', secs: 27 }
};

export interface VideoSettings { onboarding?: string | null; chapters?: Record<string, string | null>; full?: string | null }

export async function videoSettings(tx: Tx): Promise<VideoSettings> {
  const { rows: [r] } = await tx.query("select value from platform_settings where key = 'how_to_videos'");
  return (r?.value ?? {}) as VideoSettings;
}

const isUrl = (u: unknown): u is string => typeof u === 'string' && /^https:\/\/\S+$/.test(u);

/** The video for the welcome card, if one is set. */
export async function onboardingVideo(tx: Tx): Promise<string | null> {
  const v = await videoSettings(tx);
  return isUrl(v.onboarding) ? v.onboarding : null;
}

/** A one-tap "watch" card for a chapter, or nothing when that chapter has no link yet. */
export async function chapterCard(tx: Tx, n: number, lead?: string): Promise<Reply[]> {
  const v = await videoSettings(tx);
  const url = v.chapters?.[String(n)];
  const c = CHAPTERS[n];
  if (!isUrl(url) || !c) return [];
  return [{ kind: 'link', text: lead ?? `🎬 *${c.title}*: a ${c.secs}-second video showing how it works.`, button: '▶️ Watch now', url }];
}

/** The list of chapters that have a link (WhatsApp lists hold up to 10 rows). */
export async function videosMenu(tx: Tx): Promise<Reply[]> {
  const v = await videoSettings(tx);
  const rows = Object.entries(CHAPTERS)
    .filter(([n]) => Number(n) >= 1 && isUrl(v.chapters?.[n]))
    .slice(0, 10)
    .map(([n, c]) => ({ id: `VIDEO:${n}`, title: `${n}. ${c.title}`.slice(0, 24), description: `${c.secs} seconds` }));
  if (!rows.length) return [{ kind: 'text', text: '🎬 How-to videos are coming soon. Meanwhile, tap *Menu* for examples of everything you can do.' }];
  const full = isUrl(v.full) ? `\n\nThe whole guide in one video: ${v.full}` : '';
  return [{ kind: 'list', text: '🎬 *How-to videos*\n\nShort videos, one for each thing you can do. Pick one to watch.' + full, button: '🎬 Videos', sectionTitle: 'Chapters', rows }];
}

/** Which chapter explains each help topic. */
export const TOPIC_CHAPTER: Record<string, number> = { bills: 2, purchases: 4, stockout: 5, questions: 6, staff: 7, shop: 8, credits: 9, support: 10 };
