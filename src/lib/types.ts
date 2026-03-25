/**
 * Valid ACT type codes (27 ACT subtypes)
 */
export type ACTCode =
  | 'SVA' | 'SVB' | 'SVC' | 'SVD' | 'SVE' | 'SVF' | 'SVG'
  | 'VLA' | 'VLB' | 'VLC' | 'VLD' | 'VLE' | 'VLF'
  | 'SPA' | 'SPB' | 'SPC' | 'SPD' | 'SPE' | 'SPF' | 'SPG'
  | 'DCA' | 'DCB' | 'DCC' | 'DCD' | 'DCE' | 'DCF' | 'DCG';

/**
 * Consciousness level from 1 (absent) to 6 (full)
 */
export type ConsciousnessLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * User profile
 */
export interface Profile {
  id: string;
  email: string;
  display_name: string | null;
  role: 'admin' | 'member';
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * ACT diagnosis result
 */
export interface DiagnosisResult {
  id: string;
  user_id: string;
  type_code: ACTCode;
  consciousness_level: ConsciousnessLevel;
  subtype: string | null;
  scores_json: Record<string, any> | null;
  answers_json: Record<string, any> | null;
  created_at: string;
}

/**
 * Chat session for diagnosis discussion
 */
export interface ChatSession {
  id: string;
  user_id: string;
  diagnosis_result_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Chat message in a session
 */
export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: string;
}

/**
 * Global site settings
 */
export interface SiteSettings {
  id: number;
  bot_enabled: boolean;
  maintenance_mode: boolean;
  updated_at: string;
  updated_by: string | null;
}

/**
 * Choice for a consciousness level question
 */
export interface CLChoice {
  text: string;
  score: number; // -2, -1, 0, 1
  isHighLevel?: boolean;
  isLevel4Check?: boolean;
  isLevel5Check?: boolean;
  isLevel6Check?: boolean;
  isLevel4Requirement?: string;
  isLevel5Requirement?: string;
}

/**
 * Consciousness level question
 */
export interface CLQuestion {
  id: number;
  text: string;
  supplement?: string;
  choices: CLChoice[];
}

/**
 * Choice for a personality question with scoring
 */
export interface PersonalityChoice {
  text: string;
  scores: Record<string, number>;
}

/**
 * Personality type question
 */
export interface PersonalityQuestion {
  id: number;
  text: string;
  choices: PersonalityChoice[];
}
