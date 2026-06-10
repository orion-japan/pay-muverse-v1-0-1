import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SOFIA_TIKTOK_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SOFIA_TIKTOK_SUPABASE_ANON_KEY;

if (!supabaseUrl) {
  throw new Error("NEXT_PUBLIC_SOFIA_TIKTOK_SUPABASE_URL is not set");
}

if (!supabaseAnonKey) {
  throw new Error("NEXT_PUBLIC_SOFIA_TIKTOK_SUPABASE_ANON_KEY is not set");
}

export const sofiaTikTokSupabase = createClient(
  supabaseUrl,
  supabaseAnonKey
);

export type TikTokMarketResearch = {
  id: string;
  category: string | null;
  keyword: string | null;
  account_name: string | null;
  account_url: string | null;
  video_url: string;
  video_title: string | null;
  hook_text: string | null;
  caption_text: string | null;
  views_count: number | null;
  likes_count: number | null;
  comments_count: number | null;
  shares_count: number | null;
  saves_count: number | null;
  followers_count: number | null;
  top_comment: string | null;
  reaction_words: string | null;
  resonance_words: string | null;
  why_known_score: number | null;
  resonance_score: number | null;
  save_intent_score: number | null;
  sofia_note: string | null;
  status: string | null;
  created_at: string | null;
  updated_at: string | null;
};
