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
  "topup_wait_minutes",
  "quiet_hours",
  "rating_reminder_after_minutes",
  "dispute_24h_reminder_max_count",
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
  it("empty input yields exactly the ten defaults and lists the admin keys as missing", () => {
    const s = loadSettings({});
    expect(s).toEqual({
      inquiry_window_minutes: 15,
      price_change_timeout_minutes: 120,
      delivery_reminder_interval_minutes: 20,
      delivery_reminder_max_count: 6,
      cancellation_followup_retry_minutes: 30,
      cancellation_followup_max_attempts: 8,
      topup_wait_minutes: 120,
      quiet_hours: false,
      rating_reminder_after_minutes: 1440,
      dispute_24h_reminder_max_count: 1,
      missing: ADMIN,
    });
    for (const k of ADMIN) expect(k in s).toBe(false);
    expect(s.quiet_hours).toBe(false);
    expect(SETTING_KEYS).toHaveLength(16);
  });
});

describe("provisional marking", () => {
  // covers AC2
  it("marks exactly the four provisional defaults and the decided ones with decisions", () => {
    const provisional = SETTING_KEYS.filter((k) => SETTING_DEFINITIONS[k].status === "provisional_pending_owner");
    expect(provisional.sort()).toEqual(
      [
        "cancellation_followup_max_attempts",
        "cancellation_followup_retry_minutes",
        "delivery_reminder_max_count",
        "rating_reminder_after_minutes",
      ].sort(),
    );
    const decided = SETTING_DEFINITIONS;
    expect(decided.inquiry_window_minutes).toMatchObject({ status: "decided", decision: "D29" });
    expect(decided.price_change_timeout_minutes).toMatchObject({ status: "decided", decision: "D33" });
    expect(decided.delivery_reminder_interval_minutes).toMatchObject({ status: "decided", decision: "D34" });
  });

  // covers AG-TOP-07, AG-TMR-12, AG-RANK-08, AG-BL-05
  it("marks the new keys with status and decision", () => {
    expect(SETTING_DEFINITIONS.topup_wait_minutes).toMatchObject({ status: "decided", decision: "D65", default: 120 });
    expect(SETTING_DEFINITIONS.quiet_hours).toMatchObject({ status: "decided", decision: "D63", default: false });
    expect(SETTING_DEFINITIONS.rating_reminder_after_minutes).toMatchObject({
      status: "provisional_pending_owner",
      decision: "D68",
      default: 1440,
    });
    expect(SETTING_DEFINITIONS.dispute_24h_reminder_max_count).toMatchObject({
      status: "decided",
      decision: "D62/Q17",
      default: 1,
    });
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
    // AG-TOP-07
    ["topup_wait_minutes", "zero", 0],
    ["topup_wait_minutes", "negative", -1],
    ["topup_wait_minutes", "non-integer", 1.5],
    ["topup_wait_minutes", "unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["topup_wait_minutes", "string", "120"],
    ["topup_wait_minutes", "null", null],
    // AG-TMR-12
    ["quiet_hours", "string true", "true"],
    ["quiet_hours", "string false", "false"],
    ["quiet_hours", "number 1", 1],
    ["quiet_hours", "number 0", 0],
    ["quiet_hours", "null", null],
    // AG-RANK-08
    ["rating_reminder_after_minutes", "zero", 0],
    ["rating_reminder_after_minutes", "negative", -1],
    ["rating_reminder_after_minutes", "non-integer", 1.5],
    ["rating_reminder_after_minutes", "unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["rating_reminder_after_minutes", "1e21", 1e21],
    ["rating_reminder_after_minutes", "string", "1440"],
    ["rating_reminder_after_minutes", "null", null],
    // AG-BL-05
    ["dispute_24h_reminder_max_count", "zero", 0],
    ["dispute_24h_reminder_max_count", "negative", -1],
    ["dispute_24h_reminder_max_count", "non-integer", 1.5],
    ["dispute_24h_reminder_max_count", "unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["dispute_24h_reminder_max_count", "string", "1"],
    ["dispute_24h_reminder_max_count", "null", null],
    // PR #6 m2
    ["commission_min_amount", "1e21", 1e21],
    ["commission_min_amount", "MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["inquiry_window_minutes", "1e21", 1e21],
    ["inquiry_window_minutes", "MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
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

describe("new parameters accept valid overrides", () => {
  // covers AG-TOP-07, AG-TMR-12, AG-RANK-08, AG-BL-05
  it("accepts valid values, including quiet_hours booleans", () => {
    const s = loadSettings({
      topup_wait_minutes: 5,
      quiet_hours: true,
      rating_reminder_after_minutes: 60,
      dispute_24h_reminder_max_count: 2,
    });
    expect(s.topup_wait_minutes).toBe(5);
    expect(s.quiet_hours).toBe(true);
    expect(s.rating_reminder_after_minutes).toBe(60);
    expect(s.dispute_24h_reminder_max_count).toBe(2);
    expect(loadSettings({ quiet_hours: false }).quiet_hours).toBe(false);
  });
});

describe("ranking weights rule", () => {
  const zeros = {
    weight_price: 0,
    weight_reputation: 0,
    weight_availability: 0,
    weight_response_time: 0,
  };

  // covers AG-RANK-05
  it("AG-RANK-05 rejects all-zero weights with an issue naming the weights and the rule", () => {
    try {
      loadSettings(zeros);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsValidationError);
      const err = e as SettingsValidationError;
      expect(err.issues).toHaveLength(1);
      for (const k of RANKING_WEIGHT_KEYS) expect(err.issues[0]?.key).toContain(k);
      expect(err.message).toContain("at least one ranking weight must be > 0");
    }
  });

  it("AG-RANK-05 accepts a single positive weight and no sum-to-1 rule", () => {
    expect(loadSettings({ ...zeros, weight_availability: 0.1 }).weight_availability).toBe(0.1);
    expect(requireRankingWeights(loadSettings(ADMIN_TEST_VALUES)).weight_response_time).toBe(4);
  });

  it("AG-RANK-05 does not apply when some weights are missing", () => {
    const s = loadSettings({ weight_price: 0, weight_reputation: 0 });
    expect(s.missing).toEqual(expect.arrayContaining(["weight_availability", "weight_response_time"]));
    expect(() => requireRankingWeights(s)).toThrow(MissingSettingsError);
  });
});

describe("explicit undefined (PR #6 m1)", () => {
  it("PR #6 m1: a key passed as undefined counts as not provided", () => {
    const s = loadSettings({ inquiry_window_minutes: undefined, weight_price: undefined, quiet_hours: undefined });
    expect(s.inquiry_window_minutes).toBe(15);
    expect(s.quiet_hours).toBe(false);
    expect("weight_price" in s).toBe(false);
    expect(s.missing).toContain("weight_price");
  });
});

describe("safe integers (PR #6 m2)", () => {
  it("PR #6 m2: accepts Number.MAX_SAFE_INTEGER for commission_min_amount", () => {
    expect(loadSettings({ commission_min_amount: Number.MAX_SAFE_INTEGER }).commission_min_amount).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
