CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), google_id text UNIQUE NOT NULL,
 email text NOT NULL, name text NOT NULL, phone text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admins (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text UNIQUE NOT NULL CHECK (email = lower(email)),
 name text NOT NULL DEFAULT '', google_id text UNIQUE, role text NOT NULL CHECK (role IN ('staff','super_admin')),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sports (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE NOT NULL,
 price numeric(12,2) NOT NULL CHECK (price >= 0), description text NOT NULL DEFAULT '', active boolean NOT NULL DEFAULT true
);
CREATE TABLE events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, description text NOT NULL DEFAULT '',
 start_date timestamptz NOT NULL, end_date timestamptz NOT NULL, venue text NOT NULL,
 active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now(), CHECK (end_date >= start_date)
);
CREATE UNIQUE INDEX one_active_event ON events ((active)) WHERE active;
CREATE TABLE orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','phone_captured','invoiced','payment_pending','receipt_submitted','under_review','confirmed','rejected','contacted','completed','cancelled','expired')),
 phone_number text, total_amount numeric(14,2), invoiced_at timestamptz, confirmed_at timestamptz,
 cancellation_reason text CHECK (cancellation_reason IN ('revised','expired','admin_rejected')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((invoiced_at IS NULL AND total_amount IS NULL) OR (invoiced_at IS NOT NULL AND total_amount IS NOT NULL AND total_amount >= 0))
);
CREATE UNIQUE INDEX one_open_order_per_user ON orders(user_id) WHERE status NOT IN ('completed','cancelled','expired','rejected');
CREATE INDEX orders_queue ON orders(status, created_at DESC);
CREATE TABLE order_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 sport_id uuid NOT NULL REFERENCES sports(id), price_at_purchase numeric(12,2) NOT NULL CHECK (price_at_purchase >= 0),
 team_name text NOT NULL CHECK (length(trim(team_name)) > 0), logo_url text, profile_completed_at timestamptz,
 UNIQUE(order_id, sport_id)
);
CREATE INDEX items_sport ON order_items(sport_id);
CREATE TABLE team_players (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
 player_name text NOT NULL CHECK(length(trim(player_name)) > 0), position integer NOT NULL DEFAULT 0 CHECK(position >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX players_item ON team_players(order_item_id);
CREATE TABLE payment_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid UNIQUE NOT NULL REFERENCES orders(id),
 unique_code text UNIQUE NOT NULL, qr_payload text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE receipts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 file_url text NOT NULL CHECK (file_url LIKE 'receipts/%'), uploaded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipts_order ON receipts(order_id);
CREATE TABLE payment_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), admin_id uuid NOT NULL REFERENCES admins(id),
 decision text NOT NULL CHECK(decision IN ('confirmed','rejected')), notes text NOT NULL DEFAULT '', verified_at timestamptz NOT NULL DEFAULT now(),
 CHECK(decision <> 'rejected' OR length(trim(notes)) > 0)
);
CREATE TABLE order_status_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), from_status text, to_status text NOT NULL,
 changed_by uuid REFERENCES admins(id), changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_order ON order_status_history(order_id, changed_at);
CREATE TABLE audit_logs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), admin_id uuid NOT NULL REFERENCES admins(id), action text NOT NULL,
 entity_type text NOT NULL, entity_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE email_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id), user_id uuid NOT NULL REFERENCES users(id),
 sent_to text NOT NULL, status text NOT NULL CHECK(status IN ('sent','failed')), provider_message_id text,
 error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_log_order ON email_log(order_id);
-- Transactional outbox: queue creation and final profile completion commit together.
CREATE TABLE email_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid NOT NULL REFERENCES orders(id),
 kind text NOT NULL CHECK(kind IN ('confirmation','manual')), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','sent','failed')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), locked_at timestamptz,
 lease_token uuid, first_attempt_at timestamptz, last_error text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX one_confirmation_per_order ON email_jobs(order_id) WHERE kind = 'confirmation';
CREATE INDEX email_jobs_queue ON email_jobs(status, available_at);
CREATE TABLE sessions (
 token_hash text PRIMARY KEY, user_id uuid REFERENCES users(id), admin_id uuid REFERENCES admins(id),
 expires_at timestamptz NOT NULL, CHECK ((user_id IS NULL) <> (admin_id IS NULL))
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE oauth_states (
 state_hash text PRIMARY KEY, verifier text NOT NULL, audience text NOT NULL CHECK(audience IN ('user','admin')),
 expires_at timestamptz NOT NULL
);
CREATE FUNCTION freeze_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.invoiced_at IS NOT NULL AND (NEW.total_amount IS DISTINCT FROM OLD.total_amount OR NEW.invoiced_at IS DISTINCT FROM OLD.invoiced_at) THEN
  RAISE EXCEPTION 'Invoiced amount and timestamp are immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER freeze_invoice BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION freeze_invoice();
CREATE FUNCTION freeze_items() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid;
BEGIN
 IF TG_OP = 'INSERT' THEN parent_id := NEW.order_id; ELSE parent_id := OLD.order_id; END IF;
 IF TG_OP = 'UPDATE' AND NEW.order_id IS DISTINCT FROM OLD.order_id THEN
  RAISE EXCEPTION 'Cannot move order items' USING ERRCODE = '23514';
 END IF;
 PERFORM id FROM orders WHERE id = parent_id FOR UPDATE;
 IF EXISTS (SELECT 1 FROM orders WHERE id = parent_id AND invoiced_at IS NOT NULL) THEN
  IF TG_OP <> 'UPDATE' THEN
   RAISE EXCEPTION 'Invoiced items are immutable' USING ERRCODE = '23514';
  ELSIF NEW.sport_id IS DISTINCT FROM OLD.sport_id OR NEW.team_name IS DISTINCT FROM OLD.team_name OR NEW.price_at_purchase IS DISTINCT FROM OLD.price_at_purchase THEN
   RAISE EXCEPTION 'Invoiced items are immutable' USING ERRCODE = '23514';
  END IF;
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER freeze_items BEFORE INSERT OR UPDATE OR DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION freeze_items();
