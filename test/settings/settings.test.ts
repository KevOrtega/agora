import { describe, expect, it } from "vitest";
import {
  COMMISSION_KEYS,
  MissingSettingsError,
  RANKING_WEIGHT_KEYS,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  SettingsValidationError,
  loadSettings,
  requireCommissionSettings,
  requireRankingWeights,
} from "../../src/modules/settings/index.js";

const DEFAULTED = [
  "inquiry_window_minutes",
  "price_change_timeout_minutes",
  "delivery_reminder_interval_minutes",
  "delivery_reminder_max_count",
  "cancellation_followup_retry_minutes",
  "cancellation_followup_max_attempts",
] as const;
const ADMIN = [...RANKING_WEIGHT_KEYS, ...COMMISSION_KEYS];
// Arbitrary test values, not business values.
const ADMIN_TEST_VALUES = {
  weight_price: 1,
  weight_reputation: 2,
  weight_availability: 3,
  weight_response_time: 4,
  commission_rate: 0.5,
  commission_min_amount: 7,
};

describe("defaults", () => {
  // covers AC1, AC3 (missing reported)
  it("empty input yields exactly the six defaults and lists the admin keys as missing", () => {
    const s = loadSettings({});
    expect(s).toEqual({
      inquiry_window_minutes: 15,
      price_change_timeout_minutes: 120,
      delivery_reminder_interval_minutes: 20,
      delivery_reminder_max_count: 6,
      cancellation_followup_retry_minutes: 30,
      cancellation_followup_max_attempts: 8,
      missing: ADMIN,
    });
    for (const k of ADMIN) expect(k in s).toBe(false);
    expect(SETTING_KEYS).toHaveLength(12);
  });
});

describe("provisional marking", () => {
  // covers AC2
  it("marks exactly the three provisional defaults and the decided ones with decisions", () => {
    const provisional = SETTING_KEYS.filter((k) => SETTING_DEFINITIONS[k].status === "provisional_pending_owner");
    expect(provisional.sort()).toEqual(
      ["cancellation_followup_max_attempts", "cancellation_followup_retry_minutes", "delivery_reminder_max_count"].sort(),
    );
    const decided = SETTING_DEFINITIONS;
    expect(decided.inquiry_window_minutes).toMatchObject({ status: "decided", decision: "D29" });
    expect(decided.price_change_timeout_minutes).toMatchObject({ status: "decided", decision: "D33" });
    expect(decided.delivery_reminder_interval_minutes).toMatchObject({ status: "decided", decision: "D34" });
  });
});

describe("no invented values", () => {
  // covers AC3, QA rule: no hard-coded business values
  it("admin parameters have no default in the definition table", () => {
    for (const k of ADMIN) {
      expect("default" in SETTING_DEFINITIONS[k]).toBe(false);
      expect(SETTING_DEFINITIONS[k].status).toBe("admin_loaded");
    }
    const withDefault = SETTING_KEYS.filter((k) => "default" in SETTING_DEFINITIONS[k]);
    expect([...withDefault].sort()).toEqual([...DEFAULTED].sort());
  });

  it("require helpers throw naming the missing keys", () => {
    const s = loadSettings({ weight_price: 1, commission_rate: 0.1 });
    expect(() => requireRankingWeights(s)).toThrow(MissingSettingsError);
    try {
      requireRankingWeights(s);
    } catch (e) {
      expect((e as MissingSettingsError).missingKeys).toEqual([
        "weight_reputation",
        "weight_availability",
        "weight_response_time",
      ]);
      expect((e as Error).message).toContain("weight_reputation");
    }
    expect(() => requireCommissionSettings(s)).toThrow(/commission_min_amount/);
  });

  it("require helpers return values when all are provided", () => {
    const s = loadSettings(ADMIN_TEST_VALUES);
    expect(s.missing).toEqual([]);
    expect(requireRankingWeights(s)).toEqual({
      weight_price: 1,
      weight_reputation: 2,
      weight_availability: 3,
      weight_response_time: 4,
    });
    expect(requireCommissionSettings(s)).toEqual({ commission_rate: 0.5, commission_min_amount: 7 });
  });
});

describe("validation", () => {
  // covers AC3 validation rules
  const cases: [string, string, unknown][] = [
    ["inquiry_window_minutes", "zero", 0],
    ["inquiry_window_minutes", "negative", -1],
    ["price_change_timeout_minutes", "non-integer", 1.5],
    ["delivery_reminder_max_count", "zero", 0],
    ["cancellation_followup_max_attempts", "non-integer", 2.5],
    ["cancellation_followup_retry_minutes", "string", "10"],
    ["delivery_reminder_interval_minutes", "null", null],
    ["delivery_reminder_interval_minutes", "NaN", NaN],
    ["weight_price", "negative", -0.1],
    ["weight_reputation", "NaN", NaN],
    ["weight_availability", "Infinity", Infinity],
    ["weight_response_time", "string", "1"],
    ["commission_rate", "below 0", -0.01],
    ["commission_rate", "above 1", 1.01],
    ["commission_rate", "Infinity", Infinity],
    ["commission_rate", "null", null],
    ["commission_min_amount", "non-integer", 1.5],
    ["commission_min_amount", "negative", -1],
    ["commission_min_amount", "string", "5"],
  ];
  it.each(cases)("%s rejects %s", (key, _label, value) => {
    expect(() => loadSettings({ [key]: value })).toThrow(SettingsValidationError);
    try {
      loadSettings({ [key]: value });
    } catch (e) {
      const err = e as SettingsValidationError;
      expect(err.issues.map((i) => i.key)).toEqual([key]);
      expect(err.message).toContain(key);
      expect(err.issues[0]?.receivedType).toBeTruthy();
    }
  });

  it("rejects unknown keys", () => {
    expect(() => loadSettings({ bogus: 1 })).toThrow(/bogus/);
  });

  it("reports all offending keys at once", () => {
    try {
      loadSettings({ inquiry_window_minutes: 0, weight_price: "x", commission_rate: 2, bogus: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsValidationError);
      expect((e as SettingsValidationError).issues.map((i) => i.key).sort()).toEqual(
        ["bogus", "commission_rate", "inquiry_window_minutes", "weight_price"],
      );
    }
  });

  it("accepts boundary values", () => {
    const s = loadSettings({ commission_rate: 0, commission_min_amount: 0, weight_price: 0 });
    expect(s.commission_rate).toBe(0);
    expect(loadSettings({ commission_rate: 1 }).commission_rate).toBe(1);
  });
});

describe("overrides, immutability", () => {
  // covers AC3 overrides/frozen
  it("applies valid overrides, does not mutate input, and freezes the result", () => {
    const input = { inquiry_window_minutes: 3, commission_rate: 0.25 };
    const snapshot = { ...input };
    const s = loadSettings(input);
    expect(s.inquiry_window_minutes).toBe(3);
    expect(s.commission_rate).toBe(0.25);
    expect(s.missing).not.toContain("commission_rate");
    expect(input).toEqual(snapshot);
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.missing)).toBe(true);
  });
});
