export interface User {
  id: string;
  name: string;
  email: string;
  role: "owner" | "participant";
  age: number | null;
  country: string | null;
  balance: number;
  csrf?: string;
}
export interface Option {
  id: string;
  text: string;
  image?: string | null;
  position: number;
}
export interface Count {
  id: string;
  text: string;
  position: number;
  count: number;
  percent: number;
}
export interface Fact {
  version?: number;
  metric: string;
  unit: string;
  start_date: string;
  end_date: string;
  is_rate: boolean;
  values: { option_id: string; value: number; denominator?: number | null }[];
}
export interface Study {
  id: string;
  title: string;
  question: string;
  status: "draft" | "moderating" | "open" | "closed";
  version: number;
  quota: number | null;
  age_min: number | null;
  age_max: number | null;
  country: string;
  options: Option[];
  count?: number;
  created_at: number;
  deadline?: number;
  closed_at?: number;
  complete?: boolean;
  moderation_reason?: string;
  my_answer: {
    personal_id: string;
    prediction_id: string;
    accepted_at: number;
  } | null;
  points?: { base?: number; bonus?: number };
  personal?: Count[];
  predictions?: Count[];
  personal_leaders?: string[];
  prediction_leaders?: string[];
  comparison?: { code: string; label: string; fact: Fact | null };
}
export interface Notice {
  id: string;
  kind: string;
  study_id: string | null;
  title: string;
  body: string;
  created_at: number;
  read_at: number | null;
}
export interface Reward {
  id: string;
  title: string;
  description: string;
  cost: number;
  channel: "wheel" | "guaranteed";
  stock: number;
  is_demo: boolean;
  active: boolean;
}
export interface Claim {
  id: string;
  title: string;
  description: string;
  code: string;
  is_demo: boolean;
  created_at: number;
}
export interface Rewards {
  rewards: Reward[];
  balance: number;
  wheel: {
    cost: number;
    available: boolean;
    prize: Reward | null;
    sectors: { label: string; weight: number }[];
    demo_economy: boolean;
  };
}
export interface SpendResult {
  operation_id: string;
  request_key: string;
  kind: string;
  cost: number;
  balance: number;
  sector: number;
  won: boolean;
  claim: Claim | null;
}
export interface Device {
  id: string;
  name: string;
  created_at: number;
  expires_at: number;
  last_seen: number | null;
  revoked_at: number | null;
}
export interface Config {
  demo: boolean;
  demo_accounts: { email: string; name: string; role: string }[];
}
export interface History {
  kind: string;
  amount: number;
  title: string;
  study_id: string | null;
  created_at: number;
}
export interface Metrics {
  studies: {
    id: string;
    title: string;
    quota: number;
    starts: number;
    pairs: number;
    t50_seconds: number | null;
  }[];
  starts: number;
  pairs: number;
  completion_percent: number | null;
  agreement_percent: number | null;
  comparable: number;
  ties: number;
  missing: number;
}
