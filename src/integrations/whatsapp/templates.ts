import type { TemplateCategory } from "./types.js";

/**
 * PROVISIONAL template catalog.
 *
 * The real templates are NOT approved by Meta yet and the opt-in question is still open,
 * so every entry here is a placeholder shape (name, category, language, named parameters),
 * not final copy. Replace the entries and flip the status once the templates are approved.
 */
export const TEMPLATE_CATALOG_STATUS = "provisional" as const;

export interface TemplateDefinition {
  name: string;
  category: TemplateCategory;
  languageCode: string;
  /** Named parameters, English snake_case. Values are strings at send time. */
  parameters: readonly string[];
  provisional: true;
  /** Optional placeholder body (Spanish, NOT final copy). */
  exampleBody?: string;
}

export const TEMPLATE_LANGUAGE = "es_AR";

export const TEMPLATE_CATALOG: readonly TemplateDefinition[] = [
  {
    name: "order_update",
    category: "utility",
    languageCode: TEMPLATE_LANGUAGE,
    parameters: ["order_reference", "status"],
    provisional: true,
    exampleBody: "[placeholder] Pedido {{order_reference}}: {{status}}",
  },
  {
    name: "credit_topup_confirmation",
    category: "utility",
    languageCode: TEMPLATE_LANGUAGE,
    parameters: ["amount", "balance"],
    provisional: true,
    exampleBody: "[placeholder] Carga de {{amount}} confirmada. Saldo: {{balance}}",
  },
  {
    name: "payout_update",
    category: "utility",
    languageCode: TEMPLATE_LANGUAGE,
    parameters: ["payout_reference", "status", "amount"],
    provisional: true,
    exampleBody: "[placeholder] Pago {{payout_reference}}: {{status}} ({{amount}})",
  },
  {
    name: "business_order_request",
    category: "utility",
    languageCode: TEMPLATE_LANGUAGE,
    parameters: ["order_reference", "items_summary"],
    provisional: true,
    exampleBody: "[placeholder] Pedido {{order_reference}}: {{items_summary}}",
  },
];
