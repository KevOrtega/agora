// Typed, validated settings. Pure: no env vars, files or database access.
// A future admin store / DB source feeds `loadSettings` with a plain object.

export type SettingRule =
  | "positive_integer" // integer >= 1 (minutes and counts)
  | "non_negative_number" // finite number >= 0 (ranking weights)
  | "fraction" // finite number, 0 <= n <= 1
  | "non_negative_integer"; // integer >= 0 (minor currency units)

export type SettingStatus =
  | "decided" // decided by the owner (see `decision`)
  | "provisional_pending_owner" // provisional default, pending owner
  | "admin_loaded"; // no default; the admin must load it

export interface SettingDefinition {
  readonly rule: SettingRule;
  readonly status: SettingStatus;
  /** Absent for admin-loaded parameters: they never get an invented default. */
  readonly default?: number;
  /** Decision reference for owner-decided defaults. */
  readonly decision?: string;
}

export const SETTING_DEFINITIONS = {
  // Decided by the owner (configurable).
  inquiry_window_minutes: { rule: "positive_integer", status: "decided", default: 15, decision: "D29" },
  price_change_timeout_minutes: { rule: "positive_integer", status: "decided", default: 120, decision: "D33" },
  delivery_reminder_interval_minutes: { rule: "positive_integer", status: "decided", default: 20, decision: "D34" },
  // Provisional, pending owner (RF-25). They do not block.
  delivery_reminder_max_count: { rule: "positive_integer", status: "provisional_pending_owner", default: 6 },
  cancellation_followup_retry_minutes: { rule: "positive_integer", status: "provisional_pending_owner", default: 30 },
  cancellation_followup_max_attempts: { rule: "positive_integer", status: "provisional_pending_owner", default: 8 },
  // Ranking weights (D55): admin-loaded, NO default.
  weight_price: { rule: "non_negative_number", status: "admin_loaded" },
  weight_reputation: { rule: "non_negative_number", status: "admin_loaded" },
  weight_availability: { rule: "non_negative_number", status: "admin_loaded" },
  weight_response_time: { rule: "non_negative_number", status: "admin_loaded" },
  // Commission (D54): admin-loaded, NO default.
  commission_rate: { rule: "fraction", status: "admin_loaded" }, // fraction of product subtotal
  commission_min_amount: { rule: "non_negative_integer", status: "admin_loaded" }, // minor units (centavos)
} as const satisfies Record<string, SettingDefinition>;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

type DefaultedKey = {
  [K in SettingKey]: (typeof SETTING_DEFINITIONS)[K] extends { default: number } ? K : never;
}[SettingKey];
export type AdminLoadedKey = Exclude<SettingKey, DefaultedKey>;

export const RANKING_WEIGHT_KEYS = [
  "weight_price",
  "weight_reputation",
  "weight_availability",
  "weight_response_time",
] as const satisfies readonly AdminLoadedKey[];

export const COMMISSION_KEYS = ["commission_rate", "commission_min_amount"] as const satisfies readonly AdminLoadedKey[];

export type Settings = Readonly<
  { [K in DefaultedKey]: number } & { [K in AdminLoadedKey]?: number } & {
    /** Admin-loaded parameters that have not been set yet (never filled in). */
    missing: readonly AdminLoadedKey[];
  }
>;

export type RankingWeights = Readonly<Record<(typeof RANKING_WEIGHT_KEYS)[number], number>>;
export type CommissionSettings = Readonly<Record<(typeof COMMISSION_KEYS)[number], number>>;

export interface SettingIssue {
  key: string;
  receivedType: string;
  rule: string;
}

const RULE_TEXT: Record<SettingRule | "unknown_key", string> = {
  positive_integer: "must be an integer >= 1",
  non_negative_number: "must be a finite number >= 0",
  fraction: "must be a finite number between 0 and 1 inclusive",
  non_negative_integer: "must be an integer >= 0 (minor currency units)",
  unknown_key: "unknown setting key",
};

export class SettingsValidationError extends Error {
  readonly issues: readonly SettingIssue[];
  constructor(issues: readonly SettingIssue[]) {
    super(
      "Invalid settings: " +
        issues.map((i) => `${i.key} (received ${i.receivedType}): ${i.rule}`).join("; "),
    );
    this.name = "SettingsValidationError";
    this.issues = issues;
  }
}

export class MissingSettingsError extends Error {
  readonly missingKeys: readonly AdminLoadedKey[];
  constructor(missingKeys: readonly AdminLoadedKey[]) {
    super(`Settings not loaded by the admin yet: ${missingKeys.join(", ")}`);
    this.name = "MissingSettingsError";
    this.missingKeys = missingKeys;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return typeof value;
}

function isValid(rule: SettingRule, value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  switch (rule) {
    case "positive_integer":
      return Number.isInteger(value) && value >= 1;
    case "non_negative_integer":
      return Number.isInteger(value) && value >= 0;
    case "non_negative_number":
      return value >= 0;
    case "fraction":
      return value >= 0 && value <= 1;
  }
}

/** Builds settings from a plain object of overrides. Does not mutate the input. */
export function loadSettings(input: Record<string, unknown> = {}): Settings {
  const issues: SettingIssue[] = [];
  const result: Record<string, unknown> = {};
  const missing: AdminLoadedKey[] = [];

  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(SETTING_DEFINITIONS, key)) {
      issues.push({ key, receivedType: typeOf(input[key]), rule: RULE_TEXT.unknown_key });
    }
  }

  for (const key of SETTING_KEYS) {
    const def: SettingDefinition = SETTING_DEFINITIONS[key];
    if (Object.hasOwn(input, key) && input[key] !== undefined) {
      const value = input[key];
      if (isValid(def.rule, value)) result[key] = value;
      else issues.push({ key, receivedType: typeOf(value), rule: RULE_TEXT[def.rule] });
    } else if (def.default !== undefined) {
      result[key] = def.default;
    } else {
      missing.push(key as AdminLoadedKey);
    }
  }

  if (issues.length > 0) throw new SettingsValidationError(issues);
  result.missing = Object.freeze(missing);
  return Object.freeze(result) as Settings;
}

function requireKeys<K extends AdminLoadedKey>(settings: Settings, keys: readonly K[]): Record<K, number> {
  const absent = keys.filter((k) => settings[k] === undefined);
  if (absent.length > 0) throw new MissingSettingsError(absent);
  return Object.freeze(Object.fromEntries(keys.map((k) => [k, settings[k]]))) as Record<K, number>;
}

export function requireRankingWeights(settings: Settings): RankingWeights {
  return requireKeys(settings, RANKING_WEIGHT_KEYS);
}

export function requireCommissionSettings(settings: Settings): CommissionSettings {
  return requireKeys(settings, COMMISSION_KEYS);
}
