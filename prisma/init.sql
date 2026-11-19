-- Current database structure for an empty schema. Apply with bun run db:init.

CREATE FUNCTION auth_last_passkey_removed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=OLD."userId") THEN
    DELETE FROM auth_verification WHERE value=OLD."userId" AND identifier LIKE '2fa-%';
    DELETE FROM auth_session WHERE "userId"=OLD."userId";
  END IF;
  RETURN OLD;
END $$;

CREATE FUNCTION auth_passkey_enable_mfa() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE users SET two_factor_enabled=true WHERE id=NEW."userId";
  RETURN NEW;
END $$;

CREATE FUNCTION auth_passkey_owner_lock() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM id FROM users WHERE id=COALESCE(NEW."userId",OLD."userId") FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION auth_passkey_requires_mfa() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM auth_passkey WHERE "userId"=NEW.id) THEN
    NEW.two_factor_enabled=true;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION enqueue_order_email() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.contact_email IS NOT NULL AND (TG_OP='INSERT' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    INSERT INTO email_outbox(id,order_id,status) VALUES(NEW.id||':'||NEW.status,NEW.id,NEW.status) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION record_funnel_order() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE q record;
BEGIN
  IF NEW.kind <> 'purchase' THEN RETURN NEW; END IF;
  SELECT analytics_visitor, attribution_source INTO q FROM quotes WHERE id=NEW.quote_id;
  IF q.analytics_visitor IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':created','order_created',q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.status IN ('processing','completed') THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':paid','payment_succeeded',q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.status IN ('completed','refunded') THEN
    INSERT INTO funnel_events(id,event,visitor_key,product_id,source)
    VALUES(NEW.id||':'||NEW.status,CASE NEW.status WHEN 'completed' THEN 'delivery_completed' ELSE 'order_refunded' END,
      q.analytics_visitor,NEW.product_id,q.attribution_source)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE audit (
    id text NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    target text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE auth_account (
    id text NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "registrationRecord" text
);

CREATE TABLE auth_passkey (
    id text NOT NULL,
    name text,
    "publicKey" text NOT NULL,
    "userId" text NOT NULL,
    "credentialID" text NOT NULL,
    counter integer NOT NULL,
    "deviceType" text NOT NULL,
    "backedUp" boolean NOT NULL,
    transports text,
    "createdAt" timestamp with time zone,
    aaguid text
);

CREATE TABLE auth_rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    "lastRequest" bigint NOT NULL
);

CREATE TABLE auth_session (
    id text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL,
    method text
);

CREATE TABLE auth_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE commissions (
    id text NOT NULL,
    user_id text NOT NULL,
    order_id text NOT NULL,
    amount integer NOT NULL,
    status text NOT NULL,
    available_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commissions_amount_check CHECK ((amount > 0)),
    CONSTRAINT commissions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'available'::text, 'reversed'::text])))
);

CREATE TABLE coupon_redemptions (
    id text NOT NULL,
    coupon_id text NOT NULL,
    order_id text NOT NULL,
    status text DEFAULT 'reserved'::text NOT NULL,
    user_id text,
    buyer_key text NOT NULL,
    contact_key text NOT NULL,
    discount_amount integer NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupon_redemptions_discount_amount_check CHECK ((discount_amount > 0)),
    CONSTRAINT coupon_redemptions_expires_check CHECK (((status = 'reserved'::text) OR (expires_at IS NULL))),
    CONSTRAINT coupon_redemptions_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'redeemed'::text, 'released'::text])))
);

CREATE TABLE coupons (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    discount_kind text NOT NULL,
    discount_value integer NOT NULL,
    max_discount_amount integer,
    min_amount integer DEFAULT 0 NOT NULL,
    scope_mode text DEFAULT 'all'::text NOT NULL,
    product_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
    upgrade_protection text DEFAULT 'cost'::text NOT NULL,
    first_order_only boolean DEFAULT false NOT NULL,
    require_login boolean DEFAULT false NOT NULL,
    max_redemptions integer,
    per_buyer_limit integer DEFAULT 1,
    starts_at timestamp with time zone,
    expires_at timestamp with time zone,
    allow_referral boolean DEFAULT true NOT NULL,
    affiliate_user_id text,
    affiliate_rate_bps integer,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT coupons_affiliate_rate_check CHECK (((affiliate_rate_bps IS NULL) OR ((affiliate_user_id IS NOT NULL) AND (affiliate_rate_bps >= 0) AND (affiliate_rate_bps <= 900)))),
    CONSTRAINT coupons_code_check CHECK ((code ~ '^[A-Z0-9_-]{3,32}$'::text)),
    CONSTRAINT coupons_discount_check CHECK ((((discount_kind = 'fixed'::text) AND (discount_value > 0) AND (discount_value <= 100000000) AND (max_discount_amount IS NULL)) OR ((discount_kind = 'percent'::text) AND (discount_value >= 1) AND (discount_value <= 9900) AND ((max_discount_amount IS NULL) OR ((max_discount_amount > 0) AND (max_discount_amount <= 100000000)))))),
    CONSTRAINT coupons_limits_check CHECK (((min_amount >= 0) AND (min_amount <= 100000000) AND ((max_redemptions IS NULL) OR (max_redemptions > 0)) AND ((per_buyer_limit IS NULL) OR (per_buyer_limit > 0)))),
    CONSTRAINT coupons_scope_mode_check CHECK ((scope_mode = ANY (ARRAY['all'::text, 'recharge_only'::text, 'upgrade_only'::text, 'products'::text]))),
    CONSTRAINT coupons_upgrade_protection_check CHECK ((upgrade_protection = ANY (ARRAY['cost'::text, 'min_profit'::text, 'none'::text]))),
    CONSTRAINT coupons_window_check CHECK (((starts_at IS NULL) OR (expires_at IS NULL) OR (starts_at < expires_at)))
);

CREATE TABLE demo_mailbox (
    browser_digest text NOT NULL,
    email text NOT NULL,
    code text NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE email_outbox (
    id text NOT NULL,
    order_id text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone
);

CREATE TABLE exchange_rates (
    id text NOT NULL,
    rate_e8 bigint,
    source_date text,
    fetched_at timestamp with time zone,
    expires_at timestamp with time zone,
    refresh_after timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease text,
    last_error text,
    source text,
    CONSTRAINT exchange_rates_id_check CHECK ((id ~ '^([A-Z]{3}|USDT)_CNY$'::text)),
    CONSTRAINT exchange_rates_rate_e8_check CHECK (((rate_e8 > 0) AND (rate_e8 <= '10000000000'::bigint)))
);

CREATE TABLE funnel_events (
    id text NOT NULL,
    event text NOT NULL,
    visitor_key text NOT NULL,
    product_id text NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT funnel_events_event_check CHECK ((event = ANY (ARRAY['plan_view'::text, 'checkout_view'::text, 'verify_started'::text, 'quote_ready'::text, 'order_created'::text, 'payment_succeeded'::text, 'delivery_completed'::text, 'order_refunded'::text]))),
    CONSTRAINT funnel_events_source_check CHECK ((source = ANY (ARRAY['direct'::text, 'google'::text, 'bing'::text, 'baidu'::text, 'referral'::text, 'coupon'::text, 'other'::text])))
);

CREATE TABLE integrations (
    id text NOT NULL,
    provider text NOT NULL,
    public jsonb NOT NULL,
    secret text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE inventory (
    id text NOT NULL,
    product_id text NOT NULL,
    code text NOT NULL,
    fingerprint text NOT NULL,
    status text DEFAULT 'available'::text NOT NULL,
    reserved_until timestamp with time zone,
    enabled boolean DEFAULT true NOT NULL,
    batch_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    discount_country text,
    CONSTRAINT inventory_discount_country_check CHECK (((discount_country IS NULL) OR (discount_country ~ '^[a-z]{2}$'::text))),
    CONSTRAINT inventory_status_check CHECK ((status = ANY (ARRAY['available'::text, 'reserved'::text, 'consumed'::text])))
);

CREATE TABLE inventory_batches (
    id text NOT NULL,
    name text NOT NULL,
    product_id text NOT NULL,
    imported_by text NOT NULL,
    imported integer NOT NULL,
    duplicates integer DEFAULT 0 NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    discount_country text,
    CONSTRAINT inventory_batches_discount_country_check CHECK (((discount_country IS NULL) OR (discount_country ~ '^[a-z]{2}$'::text))),
    CONSTRAINT inventory_batches_duplicates_check CHECK ((duplicates >= 0)),
    CONSTRAINT inventory_batches_imported_check CHECK ((imported >= 0))
);

CREATE TABLE inventory_replacements (
    id text NOT NULL,
    inventory_id text NOT NULL,
    integration_id text NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    preview jsonb NOT NULL,
    restore_enabled boolean NOT NULL,
    replacement_inventory_id text,
    upstream_replacement_id text,
    upstream_code_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inventory_replacements_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'review'::text, 'completed'::text])))
);

CREATE TABLE jobs (
    id text NOT NULL,
    order_id text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    locked_until timestamp with time zone,
    lease text,
    last_error text,
    done boolean DEFAULT false NOT NULL
);

CREATE TABLE orders (
    id text NOT NULL,
    user_id text,
    quote_id text,
    kind text DEFAULT 'purchase'::text NOT NULL,
    request_hash text DEFAULT ''::text NOT NULL,
    product_id text,
    product_name text NOT NULL,
    email text NOT NULL,
    list_amount integer NOT NULL,
    discount_amount integer DEFAULT 0 NOT NULL,
    amount integer NOT NULL,
    coupon_id text,
    coupon_code text,
    coupon_snapshot jsonb,
    status text NOT NULL,
    channel text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    rate_bps integer NOT NULL,
    settlement_days integer NOT NULL,
    first_order_only boolean NOT NULL,
    provider text NOT NULL,
    integration_id text,
    payment_id text,
    payment_url text,
    payment_attempted boolean DEFAULT false NOT NULL,
    redemption_id text,
    fulfillment_attempt integer DEFAULT 0 NOT NULL,
    failure_reason text,
    contact_email text,
    guest_browser_digest text,
    ip_address text,
    aicdk_integration_id text,
    balance_amount integer DEFAULT 0 NOT NULL,
    external_amount integer NOT NULL,
    inviter_id text,
    buyer_key text,
    fulfillment_status text,
    redemption_version integer DEFAULT 0 NOT NULL,
    submission_attempted boolean DEFAULT false NOT NULL,
    fulfillment_resolution jsonb,
    refill_history jsonb DEFAULT '[]'::jsonb NOT NULL,
    refund_destination text,
    refund_status text,
    refund_automatic boolean DEFAULT false NOT NULL,
    refund_note text DEFAULT ''::text NOT NULL,
    refund_actor text,
    refund_requested_at timestamp with time zone,
    refund_completed_at timestamp with time zone,
    refund_resolution_note text DEFAULT ''::text NOT NULL,
    refund_resolved_by text,
    CONSTRAINT orders_amount_check CHECK ((amount > 0)),
    CONSTRAINT orders_channel_check CHECK ((channel = ANY (ARRAY['alipay'::text, 'wechat'::text, 'crypto'::text, 'balance'::text]))),
    CONSTRAINT orders_discount_check CHECK (((list_amount > 0) AND (discount_amount >= 0) AND ((list_amount - discount_amount) = amount) AND (((discount_amount = 0) AND (coupon_id IS NULL) AND (coupon_code IS NULL) AND (coupon_snapshot IS NULL)) OR ((kind = 'purchase'::text) AND (discount_amount > 0) AND (coupon_id IS NOT NULL) AND (coupon_code IS NOT NULL) AND (coupon_snapshot IS NOT NULL))))),
    CONSTRAINT orders_kind_check CHECK ((kind = ANY (ARRAY['purchase'::text, 'topup'::text]))),
    CONSTRAINT orders_refund_destination_check CHECK ((refund_destination = ANY (ARRAY['wallet'::text, 'original'::text]))),
    CONSTRAINT orders_refund_record_check CHECK ((((refund_status IS NULL) AND (refund_destination IS NULL) AND (NOT refund_automatic) AND (refund_requested_at IS NULL) AND (refund_completed_at IS NULL)) OR ((refund_status IS NOT NULL) AND (refund_destination IS NOT NULL) AND (refund_requested_at IS NOT NULL) AND (refund_actor IS NOT NULL) AND (kind = 'purchase'::text) AND ((NOT refund_automatic) OR ((refund_destination = 'original'::text) AND (provider = 'xorpay'::text) AND (external_amount > 0))) AND ((refund_destination <> 'original'::text) OR refund_automatic OR (length(TRIM(BOTH FROM refund_note)) > 0)) AND (((refund_status = ANY (ARRAY['processing'::text, 'review'::text])) AND (status = 'failed'::text) AND (refund_automatic OR ((refund_status = 'review'::text) AND (refund_destination = 'original'::text) AND (external_amount > 0))) AND (refund_completed_at IS NULL)) OR ((refund_status = 'completed'::text) AND (status = 'refunded'::text) AND (refund_completed_at IS NOT NULL)))))),
    CONSTRAINT orders_refund_status_check CHECK ((refund_status = ANY (ARRAY['processing'::text, 'review'::text, 'completed'::text]))),
    CONSTRAINT orders_split_check CHECK (((balance_amount >= 0) AND (external_amount >= 0) AND ((balance_amount + external_amount) = amount) AND ((balance_amount = 0) OR (user_id IS NOT NULL)))),
    CONSTRAINT orders_status_check CHECK ((status = ANY (ARRAY['unpaid'::text, 'processing'::text, 'completed'::text, 'needs_session'::text, 'failed'::text, 'refunded'::text, 'cancelled'::text])))
);

CREATE TABLE payment_events (
    provider text NOT NULL,
    transaction_id text NOT NULL,
    order_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE products (
    id text NOT NULL,
    name text NOT NULL,
    subtitle text NOT NULL,
    description text NOT NULL,
    price integer NOT NULL,
    features jsonb NOT NULL,
    plan text NOT NULL,
    enabled boolean DEFAULT true NOT NULL,
    featured boolean DEFAULT false NOT NULL,
    upgrade boolean DEFAULT false NOT NULL,
    pricing_mode text DEFAULT 'fixed'::text NOT NULL,
    pricing jsonb,
    price_currency text DEFAULT 'CNY'::text NOT NULL,
    rounding_step integer DEFAULT 100 NOT NULL,
    CONSTRAINT products_plan_check CHECK ((plan = ANY (ARRAY['go'::text, 'plus'::text, 'pro5'::text, 'pro20'::text, 'promax'::text]))),
    CONSTRAINT products_price_check CHECK (((price > 0) AND (price <= 100000000))),
    CONSTRAINT products_price_currency_check CHECK ((price_currency = ANY (ARRAY['CNY'::text, 'USD'::text]))),
    CONSTRAINT products_pricing_mode_check CHECK (((upgrade AND (pricing_mode = 'markup'::text)) OR ((NOT upgrade) AND (pricing_mode = 'fixed'::text)))),
    CONSTRAINT products_rounding_step_check CHECK ((rounding_step = ANY (ARRAY[1, 10, 100, 1000])))
);

CREATE TABLE quotes (
    id text NOT NULL,
    browser_digest text NOT NULL,
    product_id text NOT NULL,
    email text NOT NULL,
    amount integer NOT NULL,
    inventory_id text,
    preflight_token text,
    status text DEFAULT 'ready'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    aicdk_integration_id text,
    pricing_snapshot jsonb,
    current_plan text,
    target_plan text,
    analytics_visitor text,
    attribution_source text DEFAULT 'direct'::text NOT NULL,
    preflight_expires_at timestamp with time zone,
    CONSTRAINT quotes_amount_check CHECK ((amount > 0))
);

CREATE TABLE rate_limits (
    key text NOT NULL,
    count integer DEFAULT 1 NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE TABLE risk_events (
    id text NOT NULL,
    scene text NOT NULL,
    action text NOT NULL,
    effective_action text NOT NULL,
    mode text NOT NULL,
    rule_version text NOT NULL,
    reason_codes jsonb NOT NULL,
    subjects jsonb NOT NULL,
    facts jsonb NOT NULL,
    reference_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT risk_events_action_check CHECK ((action = ANY (ARRAY['allow'::text, 'deny'::text, 'challenge'::text, 'review'::text]))),
    CONSTRAINT risk_events_effective_action_check CHECK ((effective_action = ANY (ARRAY['allow'::text, 'deny'::text, 'challenge'::text, 'review'::text]))),
    CONSTRAINT risk_events_mode_check CHECK ((mode = ANY (ARRAY['enforce'::text, 'observe'::text])))
);

CREATE TABLE roles (
    id text NOT NULL,
    name text NOT NULL,
    permissions jsonb NOT NULL,
    protected boolean DEFAULT false NOT NULL
);

CREATE TABLE settings (
    id integer NOT NULL,
    body jsonb NOT NULL,
    CONSTRAINT settings_id_check CHECK ((id = 1))
);

CREATE TABLE "twoFactor" (
    id text NOT NULL,
    secret text NOT NULL,
    "backupCodes" text NOT NULL,
    "userId" text NOT NULL,
    verified boolean,
    "failedVerificationCount" integer,
    "lockedUntil" timestamp with time zone
);

CREATE TABLE user_roles (
    user_id text NOT NULL,
    role_id text NOT NULL
);

CREATE TABLE users (
    id text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'user'::text NOT NULL,
    referral_code text NOT NULL,
    invited_by text,
    disabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    image text,
    two_factor_enabled boolean DEFAULT false,
    referral_tier_id text,
    CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text])))
);

CREATE TABLE wallet_ledger (
    id text NOT NULL,
    user_id text NOT NULL,
    amount integer NOT NULL,
    balance_after integer NOT NULL,
    kind text NOT NULL,
    order_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT wallet_ledger_amount_check CHECK ((amount <> 0)),
    CONSTRAINT wallet_ledger_balance_after_check CHECK ((balance_after >= 0)),
    CONSTRAINT wallet_ledger_kind_check CHECK ((kind = ANY (ARRAY['topup'::text, 'purchase'::text, 'refund'::text])))
);

CREATE TABLE wallets (
    user_id text NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    CONSTRAINT wallets_balance_check CHECK ((balance >= 0))
);

CREATE TABLE withdrawals (
    id text NOT NULL,
    user_id text NOT NULL,
    amount integer NOT NULL,
    method text NOT NULL,
    account text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    note text DEFAULT ''::text NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    recipient_name text DEFAULT ''::text NOT NULL,
    network text,
    request_hash text DEFAULT ''::text NOT NULL,
    fee_amount integer DEFAULT 0 NOT NULL,
    fee_rate_bps integer DEFAULT 0 NOT NULL,
    fixed_fee integer DEFAULT 0 NOT NULL,
    payout_reference text DEFAULT ''::text NOT NULL,
    payout_amount numeric(20,6),
    reviewer_id text,
    reviewed_at timestamp with time zone,
    payout_fingerprint text,
    CONSTRAINT withdrawals_amount_check CHECK ((amount > 0)),
    CONSTRAINT withdrawals_check CHECK (((fee_amount >= 0) AND (fee_amount < amount))),
    CONSTRAINT withdrawals_fee_rate_bps_check CHECK (((fee_rate_bps >= 0) AND (fee_rate_bps < 10000))),
    CONSTRAINT withdrawals_fixed_fee_check CHECK ((fixed_fee >= 0)),
    CONSTRAINT withdrawals_network_check CHECK ((network = ANY (ARRAY['TRC20'::text, 'ERC20'::text, 'BSC'::text, 'Polygon'::text]))),
    CONSTRAINT withdrawals_payout_amount_check CHECK ((payout_amount > (0)::numeric)),
    CONSTRAINT withdrawals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'paid'::text, 'rejected'::text])))
);

ALTER TABLE ONLY audit
    ADD CONSTRAINT audit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT auth_account_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT "auth_account_registrationRecord_key" UNIQUE ("registrationRecord");

ALTER TABLE ONLY auth_passkey
    ADD CONSTRAINT auth_passkey_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_key_key UNIQUE (key);

ALTER TABLE ONLY auth_rate_limit
    ADD CONSTRAINT auth_rate_limit_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_pkey PRIMARY KEY (id);

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT auth_session_token_key UNIQUE (token);

ALTER TABLE ONLY auth_verification
    ADD CONSTRAINT auth_verification_pkey PRIMARY KEY (id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY coupons
    ADD CONSTRAINT coupons_code_key UNIQUE (code);

ALTER TABLE ONLY coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);

ALTER TABLE ONLY demo_mailbox
    ADD CONSTRAINT demo_mailbox_pkey PRIMARY KEY (browser_digest, email);

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_order_id_status_key UNIQUE (order_id, status);

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY exchange_rates
    ADD CONSTRAINT exchange_rates_pkey PRIMARY KEY (id);

ALTER TABLE ONLY funnel_events
    ADD CONSTRAINT funnel_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inventory_batches
    ADD CONSTRAINT inventory_batches_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_fingerprint_key UNIQUE (fingerprint);

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_pkey PRIMARY KEY (id);

ALTER TABLE ONLY inventory_replacements
    ADD CONSTRAINT inventory_replacements_inventory_id_key UNIQUE (inventory_id);

ALTER TABLE ONLY inventory_replacements
    ADD CONSTRAINT inventory_replacements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_order_id_key UNIQUE (order_id);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_quote_id_key UNIQUE (quote_id);

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_pkey PRIMARY KEY (provider, transaction_id);

ALTER TABLE ONLY products
    ADD CONSTRAINT products_pkey PRIMARY KEY (id);

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY rate_limits
    ADD CONSTRAINT rate_limits_pkey PRIMARY KEY (key);

ALTER TABLE ONLY risk_events
    ADD CONSTRAINT risk_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);

ALTER TABLE ONLY settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY "twoFactor"
    ADD CONSTRAINT "twoFactor_pkey" PRIMARY KEY (id);

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_email_key UNIQUE (email);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_order_id_kind_key UNIQUE (order_id, kind);

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_pkey PRIMARY KEY (id);

ALTER TABLE ONLY wallets
    ADD CONSTRAINT wallets_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_request_key_key UNIQUE (request_key);

CREATE INDEX "auth_account_userId_idx" ON auth_account USING btree ("userId");

CREATE UNIQUE INDEX auth_one_opaque_account ON auth_account USING btree ("userId") WHERE ("providerId" = 'opaque'::text);

CREATE INDEX "auth_passkey_credentialID_idx" ON auth_passkey USING btree ("credentialID");

CREATE INDEX "auth_passkey_userId_idx" ON auth_passkey USING btree ("userId");

CREATE INDEX "auth_session_userId_idx" ON auth_session USING btree ("userId");

CREATE INDEX auth_verification_identifier_idx ON auth_verification USING btree (identifier);

CREATE INDEX commissions_user ON commissions USING btree (user_id);

CREATE INDEX coupon_redemptions_buyer_idx ON coupon_redemptions USING btree (coupon_id, buyer_key) WHERE (status <> 'released'::text);

CREATE INDEX coupon_redemptions_contact_idx ON coupon_redemptions USING btree (coupon_id, contact_key) WHERE (status <> 'released'::text);

CREATE INDEX coupon_redemptions_coupon_status_idx ON coupon_redemptions USING btree (coupon_id, status);

CREATE INDEX coupon_redemptions_expiring_idx ON coupon_redemptions USING btree (expires_at) WHERE ((status = 'reserved'::text) AND (expires_at IS NOT NULL));

CREATE INDEX coupon_redemptions_user_idx ON coupon_redemptions USING btree (coupon_id, user_id) WHERE ((user_id IS NOT NULL) AND (status <> 'released'::text));

CREATE INDEX coupons_affiliate_idx ON coupons USING btree (affiliate_user_id) WHERE (affiliate_user_id IS NOT NULL);

CREATE INDEX coupons_created_idx ON coupons USING btree (created_at DESC, id DESC);

CREATE INDEX funnel_events_date ON funnel_events USING btree (created_at);

CREATE UNIQUE INDEX integrations_active ON integrations USING btree (provider) WHERE (active = true);

CREATE INDEX inventory_batch ON inventory USING btree (batch_id);

CREATE INDEX inventory_batches_created ON inventory_batches USING btree (created_at, id);

CREATE INDEX inventory_discount_availability ON inventory USING btree (product_id, discount_country, enabled, status);

CREATE INDEX inventory_product_availability ON inventory USING btree (product_id, enabled, status);

CREATE INDEX jobs_ready ON jobs USING btree (run_at) WHERE (done = false);

CREATE INDEX orders_buyer ON orders USING btree (buyer_key) WHERE (kind = 'purchase'::text);

CREATE INDEX orders_coupon_idx ON orders USING btree (coupon_id) WHERE (coupon_id IS NOT NULL);

CREATE INDEX orders_unclaimed_email ON orders USING btree (contact_email) WHERE (user_id IS NULL);

CREATE INDEX orders_user ON orders USING btree (user_id, created_at DESC);

CREATE INDEX risk_events_created ON risk_events USING btree (created_at DESC);

CREATE INDEX risk_events_reference ON risk_events USING btree (reference_id);

CREATE INDEX "twoFactor_secret_idx" ON "twoFactor" USING btree (secret);

CREATE INDEX "twoFactor_userId_idx" ON "twoFactor" USING btree ("userId");

CREATE INDEX wallet_ledger_user ON wallet_ledger USING btree (user_id, created_at DESC);

CREATE INDEX withdrawals_payout_identity ON withdrawals USING btree (payout_fingerprint, user_id);

CREATE UNIQUE INDEX withdrawals_payout_reference ON withdrawals USING btree (method, COALESCE(network, ''::text), payout_reference) WHERE (payout_reference <> ''::text);

CREATE INDEX withdrawals_user ON withdrawals USING btree (user_id, created_at DESC);

CREATE TRIGGER auth_last_passkey_removed AFTER DELETE ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_last_passkey_removed();

CREATE TRIGGER auth_passkey_enable_mfa AFTER INSERT ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_passkey_enable_mfa();

CREATE TRIGGER auth_passkey_owner_lock BEFORE INSERT OR DELETE ON auth_passkey FOR EACH ROW EXECUTE FUNCTION auth_passkey_owner_lock();

CREATE TRIGGER auth_passkey_requires_mfa BEFORE UPDATE OF two_factor_enabled ON users FOR EACH ROW EXECUTE FUNCTION auth_passkey_requires_mfa();

CREATE TRIGGER order_email_outbox AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION enqueue_order_email();

CREATE TRIGGER order_funnel AFTER INSERT OR UPDATE OF status ON orders FOR EACH ROW EXECUTE FUNCTION record_funnel_order();

ALTER TABLE ONLY auth_account
    ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_passkey
    ADD CONSTRAINT "auth_passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY auth_session
    ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY commissions
    ADD CONSTRAINT commissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY coupons
    ADD CONSTRAINT coupons_affiliate_user_id_fkey FOREIGN KEY (affiliate_user_id) REFERENCES users(id);

ALTER TABLE ONLY email_outbox
    ADD CONSTRAINT email_outbox_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES inventory_batches(id);

ALTER TABLE ONLY inventory_batches
    ADD CONSTRAINT inventory_batches_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);

ALTER TABLE ONLY inventory
    ADD CONSTRAINT inventory_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);

ALTER TABLE ONLY inventory_replacements
    ADD CONSTRAINT inventory_replacements_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id);

ALTER TABLE ONLY inventory_replacements
    ADD CONSTRAINT inventory_replacements_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES inventory(id);

ALTER TABLE ONLY inventory_replacements
    ADD CONSTRAINT inventory_replacements_replacement_inventory_id_fkey FOREIGN KEY (replacement_inventory_id) REFERENCES inventory(id);

ALTER TABLE ONLY jobs
    ADD CONSTRAINT jobs_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_aicdk_integration_id_fkey FOREIGN KEY (aicdk_integration_id) REFERENCES integrations(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES coupons(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES integrations(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES users(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_quote_id_fkey FOREIGN KEY (quote_id) REFERENCES quotes(id);

ALTER TABLE ONLY orders
    ADD CONSTRAINT orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY payment_events
    ADD CONSTRAINT payment_events_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_aicdk_integration_id_fkey FOREIGN KEY (aicdk_integration_id) REFERENCES integrations(id);

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_inventory_id_fkey FOREIGN KEY (inventory_id) REFERENCES inventory(id);

ALTER TABLE ONLY quotes
    ADD CONSTRAINT quotes_product_id_fkey FOREIGN KEY (product_id) REFERENCES products(id);

ALTER TABLE ONLY "twoFactor"
    ADD CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id);

ALTER TABLE ONLY user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY users
    ADD CONSTRAINT users_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES users(id);

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

ALTER TABLE ONLY wallet_ledger
    ADD CONSTRAINT wallet_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY wallets
    ADD CONSTRAINT wallets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES users(id);

ALTER TABLE ONLY withdrawals
    ADD CONSTRAINT withdrawals_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);

CREATE TABLE stock_mappings (
    product_id text PRIMARY KEY REFERENCES products(id),
    integration_id text NOT NULL REFERENCES integrations(id),
    upstream_product_id integer NOT NULL CHECK (upstream_product_id > 0),
    sku_id integer NOT NULL CHECK (sku_id > 0),
    UNIQUE (integration_id, sku_id)
);

CREATE TABLE stock_purchases (
    id text PRIMARY KEY,
    product_id text NOT NULL REFERENCES products(id),
    integration_id text NOT NULL REFERENCES integrations(id),
    upstream_product_id integer NOT NULL CHECK (upstream_product_id > 0),
    sku_id integer NOT NULL CHECK (sku_id > 0),
    quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 500),
    actor text NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','polling','received','rejected','review')),
    upstream_order_id integer,
    batch_id text UNIQUE REFERENCES inventory_batches(id),
    last_error text,
    attempts integer NOT NULL DEFAULT 0,
    next_run_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_purchases_state_next_run_at_idx ON stock_purchases(state, next_run_at);

-- Migration ledger (appended 2026-11-19). Records which numbered SQL file under
-- prisma/migrations has been applied. Written only by `bun run db:migrate`;
-- never edited by hand. Kept out of prisma/database-contract.json on purpose:
-- see the follow-up task that adds it to managedTables.
CREATE TABLE schema_version (
    version integer PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now(),
    applied_by text NOT NULL
);
