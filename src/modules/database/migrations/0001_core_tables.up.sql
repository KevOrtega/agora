CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  whatsapp_phone text NOT NULL,
  display_name text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_whatsapp_phone_key UNIQUE (whatsapp_phone)
);

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text,
  whatsapp_phone text NOT NULL,
  contact_email text,
  source text,
  status text NOT NULL DEFAULT 'proposed',
  accepts_pay_on_delivery text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT businesses_whatsapp_phone_key UNIQUE (whatsapp_phone),
  CONSTRAINT businesses_status_check
    CHECK (status IN ('proposed', 'new', 'active', 'blocklisted')),
  CONSTRAINT businesses_accepts_pay_on_delivery_check
    CHECK (accepts_pay_on_delivery IN ('unknown', 'yes', 'no'))
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses (id),
  name text NOT NULL,
  reported_price_minor bigint,
  price_confirmed_at timestamptz,
  out_of_stock_reported_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_reported_price_minor_check
    CHECK (reported_price_minor IS NULL OR reported_price_minor >= 0)
);
CREATE INDEX products_business_id_idx ON products (business_id);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers (id),
  business_id uuid REFERENCES businesses (id),
  payment_mode text NOT NULL,
  status text NOT NULL,
  total_amount_minor bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_payment_mode_check
    CHECK (payment_mode IN ('prepaid', 'pay_on_delivery')),
  CONSTRAINT orders_status_check CHECK (status IN (
    'pending_quote', 'awaiting_customer', 'awaiting_topup', 'sent_to_business',
    'price_change_pending', 'confirmed', 'cancellation_pending', 'shipped',
    'delivered', 'under_review', 'not_delivered', 'cancelled'
  )),
  CONSTRAINT orders_total_amount_minor_check
    CHECK (total_amount_minor IS NULL OR total_amount_minor >= 0)
);
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_business_id_idx ON orders (business_id);
