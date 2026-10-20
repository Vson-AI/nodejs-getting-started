-- =====================================================================
-- IP-PMS : Multi-tenant SaaS IP Portfolio Management System
-- Schema, row-level security, audit triggers, reference counters.
--
-- The SRS targets SQL Server 2019+. This deployment runs PostgreSQL, so
-- the T-SQL constructs are translated as follows:
--   SESSION_CONTEXT(N'key')        -> current_setting('app.key', true)
--   CREATE SECURITY POLICY ... RLS -> CREATE POLICY + FORCE ROW LEVEL SECURITY
--   UPDLOCK, HOLDLOCK              -> SELECT ... FOR UPDATE
--   FORMAT(@v, 'D6')               -> lpad(v::text, 6, '0')
--   Always Encrypted (CMK)         -> AES-256-GCM envelope, key held outside
--                                     the database (see src/lib/crypto.js)
-- This script is idempotent: it may be run on every boot.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Session helpers (the RLS "session context" of SRS section 9.1)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS BIGINT
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
$$;

CREATE OR REPLACE FUNCTION app_client_id() RETURNS BIGINT
  LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.client_id', true), '')::BIGINT
$$;

CREATE OR REPLACE FUNCTION app_user_type() RETURNS TEXT
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.user_type', true), ''), 'NONE')
$$;

CREATE OR REPLACE FUNCTION app_username() RETURNS TEXT
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.username', true), ''), 'system')
$$;

-- Maintenance escape hatch. Only migrations, the seeder and the audit
-- archive job set this; no HTTP request path ever does.
CREATE OR REPLACE FUNCTION app_bypass() RETURNS BOOLEAN
  LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.bypass', true), 'off') = 'on'
$$;

-- ---------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (            -- Phase 3 stub (decision #9)
  id              BIGSERIAL PRIMARY KEY,
  code            VARCHAR(30)  NOT NULL UNIQUE,
  name            VARCHAR(100) NOT NULL,
  max_users       INT,
  max_clients     INT,
  max_ip_records  INT,
  max_storage_mb  INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id            BIGSERIAL PRIMARY KEY,
  legal_name    VARCHAR(255) NOT NULL,
  initials      VARCHAR(8)   NOT NULL,
  contact_email VARCHAR(255),
  contact_phone VARCHAR(50),
  plan_id       BIGINT REFERENCES plans(id),
  status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_tenants_status CHECK (status IN ('ACTIVE','SUSPENDED')),
  CONSTRAINT ck_tenants_initials CHECK (initials ~ '^[A-Z0-9]{2,8}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_initials   ON tenants (initials);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenants_legal_name ON tenants (lower(legal_name));

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id               BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  smtp_host               VARCHAR(255),
  smtp_port               INT,
  smtp_user               VARCHAR(255),
  smtp_password_encrypted BYTEA,
  smtp_from               VARCHAR(255),
  smtp_use_tls            BOOLEAN NOT NULL DEFAULT TRUE,
  smtp_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  file_base_dir           VARCHAR(500),
  file_cloud_prefix       VARCHAR(500),
  brand_logo_url          VARCHAR(500),
  docket_lookahead_days   INT NOT NULL DEFAULT 30,
  expiry_lookahead_days   INT NOT NULL DEFAULT 90,
  import_max_rows         INT NOT NULL DEFAULT 50000,
  import_max_bytes        BIGINT NOT NULL DEFAULT 20971520,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           VARCHAR(30)  NOT NULL,
  name           VARCHAR(255) NOT NULL,
  contact_person VARCHAR(255),
  email          VARCHAR(255),
  phone          VARCHAR(50),
  address        VARCHAR(500),
  tax_number     VARCHAR(50),
  notes          TEXT,
  status         VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_clients_status CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  CONSTRAINT ux_clients_code UNIQUE (tenant_id, code)
);
CREATE INDEX IF NOT EXISTS ix_clients_status ON clients (tenant_id, status);

-- ---------------------------------------------------------------------
-- Users, roles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     BIGINT REFERENCES tenants(id) ON DELETE CASCADE, -- NULL for platform staff
  client_id     BIGINT REFERENCES clients(id) ON DELETE CASCADE,
  username      VARCHAR(100) NOT NULL,
  full_name     VARCHAR(255),
  email         VARCHAR(255),
  password_hash VARCHAR(255) NOT NULL,
  user_type     VARCHAR(20)  NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_users_type   CHECK (user_type IN ('PLATFORM_ADMIN','STAFF','CLIENT')),
  CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE','INACTIVE')),
  CONSTRAINT ck_users_client CHECK (
    (user_type = 'CLIENT' AND client_id IS NOT NULL AND tenant_id IS NOT NULL)
    OR (user_type = 'STAFF' AND client_id IS NULL AND tenant_id IS NOT NULL)
    OR (user_type = 'PLATFORM_ADMIN' AND client_id IS NULL AND tenant_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_tenant_username
  ON users (tenant_id, lower(username)) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_platform_username
  ON users (lower(username)) WHERE tenant_id IS NULL;
CREATE INDEX IF NOT EXISTS ix_users_client ON users (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS ix_users_type   ON users (user_type);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role    VARCHAR(20) NOT NULL,
  PRIMARY KEY (user_id, role),
  CONSTRAINT ck_user_roles CHECK (role IN ('PLATFORM_ADMIN','ADMIN','EXAMINER','VIEWER','CLIENT','AUDITOR'))
);

CREATE TABLE IF NOT EXISTS login_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT,
  username   VARCHAR(100),
  succeeded  BOOLEAN NOT NULL,
  reason     VARCHAR(200),
  ip_address VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_login_events ON login_events (created_at DESC);

-- ---------------------------------------------------------------------
-- Reference counters (SRS section 5)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ref_counters (
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type_code  CHAR(1) NOT NULL,
  last_value BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, type_code),
  CONSTRAINT ck_ref_counters_type CHECK (type_code IN ('P','U','M','C','D'))
);

-- ---------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS countries (
  id        BIGSERIAL PRIMARY KEY,
  code      VARCHAR(3)   NOT NULL,
  name      VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  tenant_id BIGINT REFERENCES tenants(id) ON DELETE CASCADE  -- NULL = global
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_countries_code
  ON countries (code, COALESCE(tenant_id, 0));
CREATE INDEX IF NOT EXISTS ix_countries_name ON countries (lower(name));

CREATE TABLE IF NOT EXISTS status_options (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = global
  ip_type    VARCHAR(20) NOT NULL,
  value      VARCHAR(50) NOT NULL,
  sort_order INT NOT NULL DEFAULT 100
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_status_options
  ON status_options (ip_type, lower(value), COALESCE(tenant_id, 0));

-- ---------------------------------------------------------------------
-- IP modules
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patents (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id        BIGINT REFERENCES clients(id),
  three_eyes_ref   VARCHAR(60)  NOT NULL,
  title            VARCHAR(500) NOT NULL,
  status           VARCHAR(50)  NOT NULL,
  filing_date      DATE NOT NULL,
  publication_date DATE,
  grant_date       DATE,
  expiry_date      DATE,
  owner            VARCHAR(255),
  inventors        VARCHAR(1000),
  applicant        VARCHAR(255),
  ipc_class        VARCHAR(100),
  abstract         TEXT,
  created_by       VARCHAR(100),
  updated_by       VARCHAR(100),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_patents_ref UNIQUE (tenant_id, three_eyes_ref),
  CONSTRAINT ck_patents_dates CHECK (expiry_date IS NULL OR expiry_date > filing_date)
);

CREATE TABLE IF NOT EXISTS utility_models (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id      BIGINT REFERENCES clients(id),
  three_eyes_ref VARCHAR(60)  NOT NULL,
  title          VARCHAR(500) NOT NULL,
  status         VARCHAR(50)  NOT NULL,
  filing_date    DATE NOT NULL,
  grant_date     DATE,
  expiry_date    DATE,
  owner          VARCHAR(255),
  inventors      VARCHAR(1000),
  applicant      VARCHAR(255),
  ipc_class      VARCHAR(100),
  abstract       TEXT,
  created_by     VARCHAR(100),
  updated_by     VARCHAR(100),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_utility_models_ref UNIQUE (tenant_id, three_eyes_ref),
  CONSTRAINT ck_utility_models_dates CHECK (expiry_date IS NULL OR expiry_date > filing_date)
);

CREATE TABLE IF NOT EXISTS trademarks (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           BIGINT REFERENCES clients(id),
  three_eyes_ref      VARCHAR(60)  NOT NULL,
  title               VARCHAR(500) NOT NULL,
  ipo_ref             VARCHAR(100),
  classes             INT[] NOT NULL DEFAULT '{}',
  class_description   TEXT,
  registration_number VARCHAR(100),
  applicant           VARCHAR(255),
  territory           VARCHAR(100),
  designated_states   VARCHAR(3)[] NOT NULL DEFAULT '{}',
  filing_date         DATE NOT NULL,
  expiry_date         DATE,
  status              VARCHAR(50) NOT NULL,
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_trademarks_ref UNIQUE (tenant_id, three_eyes_ref),
  CONSTRAINT ck_trademarks_dates CHECK (expiry_date IS NULL OR expiry_date > filing_date)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_trademarks_regno
  ON trademarks (tenant_id, upper(registration_number))
  WHERE registration_number IS NOT NULL AND registration_number <> '';

CREATE TABLE IF NOT EXISTS copyrights (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           BIGINT REFERENCES clients(id),
  three_eyes_ref      VARCHAR(60)  NOT NULL,
  title               VARCHAR(500) NOT NULL,
  work_type           VARCHAR(100),
  author              VARCHAR(255),
  registration_number VARCHAR(100),
  filing_date         DATE NOT NULL,
  expiry_date         DATE,
  status              VARCHAR(50) NOT NULL,
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_copyrights_ref UNIQUE (tenant_id, three_eyes_ref),
  CONSTRAINT ck_copyrights_dates CHECK (expiry_date IS NULL OR expiry_date > filing_date)
);

CREATE TABLE IF NOT EXISTS industrial_designs (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           BIGINT REFERENCES clients(id),
  three_eyes_ref      VARCHAR(60)  NOT NULL,
  title               VARCHAR(500) NOT NULL,
  locarno_class       VARCHAR(100),
  registration_number VARCHAR(100),
  applicant           VARCHAR(255),
  filing_date         DATE NOT NULL,
  expiry_date         DATE,
  status              VARCHAR(50) NOT NULL,
  created_by          VARCHAR(100),
  updated_by          VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ux_industrial_designs_ref UNIQUE (tenant_id, three_eyes_ref),
  CONSTRAINT ck_industrial_designs_dates CHECK (expiry_date IS NULL OR expiry_date > filing_date)
);

-- ---------------------------------------------------------------------
-- Docketing
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docket_entries (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id       BIGINT REFERENCES clients(id),
  ip_type         VARCHAR(20),
  ip_record_id    BIGINT,
  ip_record_ref   VARCHAR(60),
  title           VARCHAR(500) NOT NULL,
  description     TEXT,
  due_date        DATE NOT NULL,
  completed       BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_to     VARCHAR(100),
  status          VARCHAR(50),
  status_date     DATE,
  action_due      VARCHAR(255),
  action_due_date DATE,
  priority        VARCHAR(10) NOT NULL DEFAULT 'Medium',
  comments        TEXT,
  documents       TEXT,
  reproduction    VARCHAR(1000),
  certificate     VARCHAR(1000),
  created_by      VARCHAR(100),
  updated_by      VARCHAR(100),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_docket_priority CHECK (priority IN ('Low','Medium','High')),
  CONSTRAINT ck_docket_iptype CHECK (
    ip_type IS NULL OR ip_type IN ('patent','utility_model','trademark','copyright','design'))
);

-- ---------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL,
  client_id  BIGINT,
  username   VARCHAR(100) NOT NULL,
  action     VARCHAR(20)  NOT NULL,
  module     VARCHAR(30)  NOT NULL,
  record_id  BIGINT,
  record_ref VARCHAR(60),
  old_value  JSONB,
  new_value  JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id          BIGINT PRIMARY KEY,
  tenant_id   BIGINT NOT NULL,
  client_id   BIGINT,
  username    VARCHAR(100) NOT NULL,
  action      VARCHAR(20)  NOT NULL,
  module      VARCHAR(30)  NOT NULL,
  record_id   BIGINT,
  record_ref  VARCHAR(60),
  old_value   JSONB,
  new_value   JSONB,
  created_at  TIMESTAMPTZ NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Bulk import
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_jobs (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL REFERENCES users(id),
  username          VARCHAR(100),
  module            VARCHAR(30) NOT NULL,
  file_name         VARCHAR(255),
  file_hash         CHAR(64),
  file_path         VARCHAR(500),
  mode              VARCHAR(20) NOT NULL,
  skip_invalid      BOOLEAN NOT NULL DEFAULT FALSE,
  status            VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  rows_total        INT NOT NULL DEFAULT 0,
  rows_inserted     INT NOT NULL DEFAULT 0,
  rows_updated      INT NOT NULL DEFAULT 0,
  rows_skipped      INT NOT NULL DEFAULT 0,
  rows_failed       INT NOT NULL DEFAULT 0,
  message           TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT ck_import_mode   CHECK (mode IN ('DRY_RUN','COMMIT')),
  CONSTRAINT ck_import_status CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED'))
);
CREATE INDEX IF NOT EXISTS ix_import_jobs_tenant ON import_jobs (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_import_jobs_hash   ON import_jobs (file_hash);

CREATE TABLE IF NOT EXISTS import_job_errors (
  id             BIGSERIAL PRIMARY KEY,
  import_job_id  BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_number     INT,
  column_name    VARCHAR(100),
  error_message  VARCHAR(500),
  raw_row        TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_job_errors ON import_job_errors (import_job_id, row_number);

-- Rows successfully committed, keyed by content hash: makes a re-upload of
-- the same file idempotent (FR-IMP-018).
CREATE TABLE IF NOT EXISTS import_job_rows (
  id            BIGSERIAL PRIMARY KEY,
  import_job_id BIGINT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  tenant_id     BIGINT NOT NULL,
  module        VARCHAR(30) NOT NULL,
  row_hash      CHAR(64) NOT NULL,
  row_number    INT,
  operation     VARCHAR(10),
  record_id     BIGINT,
  record_ref    VARCHAR(60),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_import_job_rows_hash
  ON import_job_rows (tenant_id, module, row_hash);

CREATE TABLE IF NOT EXISTS user_sessions (
  sid    VARCHAR NOT NULL COLLATE "default" PRIMARY KEY,
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_user_sessions_expire ON user_sessions (expire);

-- ---------------------------------------------------------------------
-- Indexes required by SRS section 8.3
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['patents','utility_models','trademarks','copyrights','industrial_designs'] LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%1$s_status ON %1$s (tenant_id, status)', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%1$s_expiry ON %1$s (tenant_id, expiry_date)', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%1$s_filing ON %1$s (tenant_id, filing_date)', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%1$s_client ON %1$s (tenant_id, client_id)', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS ix_%1$s_title  ON %1$s (tenant_id, lower(title))', t);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS ix_docket_link      ON docket_entries (tenant_id, ip_type, ip_record_id);
CREATE INDEX IF NOT EXISTS ix_docket_due       ON docket_entries (tenant_id, client_id, due_date);
CREATE INDEX IF NOT EXISTS ix_docket_completed ON docket_entries (tenant_id, completed);
CREATE INDEX IF NOT EXISTS ix_docket_priority  ON docket_entries (tenant_id, priority);

CREATE INDEX IF NOT EXISTS ix_audit_record  ON audit_logs (tenant_id, module, record_id);
CREATE INDEX IF NOT EXISTS ix_audit_time    ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_user    ON audit_logs (tenant_id, username);
CREATE INDEX IF NOT EXISTS ix_audit_client  ON audit_logs (tenant_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_arch_record   ON audit_logs_archive (tenant_id, module, record_id);
CREATE INDEX IF NOT EXISTS ix_arch_time     ON audit_logs_archive (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_arch_user     ON audit_logs_archive (tenant_id, username);
CREATE INDEX IF NOT EXISTS ix_arch_client   ON audit_logs_archive (tenant_id, client_id, created_at DESC);

-- ---------------------------------------------------------------------
-- Audit triggers (FR-AUD-005). Every INSERT/UPDATE/DELETE on the business
-- tables writes an immutable audit row carrying the session's user.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_audit_row() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_old JSONB; v_new JSONB; v_doc JSONB;
  v_action TEXT; v_module TEXT;
  v_tenant BIGINT; v_client BIGINT; v_record BIGINT; v_ref TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW); v_action := 'CREATE';
  ELSIF TG_OP = 'UPDATE' THEN
    v_new := to_jsonb(NEW); v_old := to_jsonb(OLD); v_action := 'UPDATE';
  ELSE
    v_old := to_jsonb(OLD); v_action := 'DELETE';
  END IF;

  v_doc := COALESCE(v_new, v_old);

  v_module := CASE TG_TABLE_NAME
    WHEN 'patents'            THEN 'PATENT'
    WHEN 'utility_models'     THEN 'UTILITY_MODEL'
    WHEN 'trademarks'         THEN 'TRADEMARK'
    WHEN 'copyrights'         THEN 'COPYRIGHT'
    WHEN 'industrial_designs' THEN 'DESIGN'
    WHEN 'docket_entries'     THEN 'DOCKET'
    WHEN 'clients'            THEN 'CLIENT'
    WHEN 'users'              THEN 'USER'
    WHEN 'tenant_settings'    THEN 'SETTINGS'
    WHEN 'tenants'            THEN 'TENANT'
    ELSE upper(TG_TABLE_NAME)
  END;

  IF TG_TABLE_NAME = 'tenants' THEN
    v_tenant := (v_doc->>'id')::BIGINT;
  ELSE
    v_tenant := COALESCE((v_doc->>'tenant_id')::BIGINT, app_tenant_id(), 0);
  END IF;
  v_client := (v_doc->>'client_id')::BIGINT;
  v_record := (v_doc->>'id')::BIGINT;
  v_ref    := COALESCE(v_doc->>'three_eyes_ref', v_doc->>'code', v_doc->>'username');

  -- Never persist a password hash or an encrypted secret in the trail.
  v_old := v_old - 'password_hash' - 'smtp_password_encrypted';
  v_new := v_new - 'password_hash' - 'smtp_password_encrypted';

  INSERT INTO audit_logs (tenant_id, client_id, username, action, module,
                          record_id, record_ref, old_value, new_value)
  VALUES (v_tenant, v_client, app_username(), v_action, v_module,
          v_record, v_ref, v_old, v_new);

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE OR REPLACE FUNCTION app_touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Reference immutability (BR-03 / FR-PAT-003)
CREATE OR REPLACE FUNCTION app_guard_reference() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.three_eyes_ref IS DISTINCT FROM OLD.three_eyes_ref THEN
    RAISE EXCEPTION 'three_eyes_ref is immutable once assigned (BR-03)';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id cannot be changed';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['patents','utility_models','trademarks','copyrights',
                           'industrial_designs','docket_entries','clients','users',
                           'tenants','tenant_settings'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION app_audit_row()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_touch_%1$s ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['patents','utility_models','trademarks','copyrights','industrial_designs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_ref_%1$s ON %1$s', t);
    EXECUTE format('CREATE TRIGGER trg_ref_%1$s BEFORE UPDATE ON %1$s
                    FOR EACH ROW EXECUTE FUNCTION app_guard_reference()', t);
  END LOOP;
END $$;

-- Audit rows are append-only for the application (BR-07 / FR-AUD-004).
CREATE OR REPLACE FUNCTION app_audit_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF app_bypass() THEN
    RETURN COALESCE(NEW, OLD);   -- archive job only
  END IF;
  RAISE EXCEPTION 'audit_logs is append-only (BR-07)';
END $$;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs;
CREATE TRIGGER trg_audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app_audit_immutable();

DROP TRIGGER IF EXISTS trg_archive_immutable ON audit_logs_archive;
CREATE TRIGGER trg_archive_immutable BEFORE UPDATE OR DELETE ON audit_logs_archive
  FOR EACH ROW EXECUTE FUNCTION app_audit_immutable();

-- ---------------------------------------------------------------------
-- Reference generation (SRS section 5.5 / UC-21)
-- Atomic per tenant, per type. Never resets, never reuses, min width 6.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_next_reference(p_tenant BIGINT, p_type CHAR(1), p_year INT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_initials TEXT;
  v_next     BIGINT;
BEGIN
  SELECT initials INTO v_initials FROM tenants WHERE id = p_tenant;
  IF v_initials IS NULL THEN
    RAISE EXCEPTION 'Unknown tenant %', p_tenant;
  END IF;

  INSERT INTO ref_counters (tenant_id, type_code, last_value)
  VALUES (p_tenant, p_type, 0)
  ON CONFLICT (tenant_id, type_code) DO NOTHING;

  -- SELECT ... FOR UPDATE is the PostgreSQL equivalent of UPDLOCK, HOLDLOCK
  PERFORM 1 FROM ref_counters
   WHERE tenant_id = p_tenant AND type_code = p_type FOR UPDATE;

  UPDATE ref_counters SET last_value = last_value + 1
   WHERE tenant_id = p_tenant AND type_code = p_type
  RETURNING last_value INTO v_next;

  -- Minimum width 6, growing on its own past 999999 (R-04).
  -- lpad truncates when the value is longer than the width, so the width is
  -- taken as the larger of 6 and the value's own length.
  RETURN v_initials || '/' || p_type || '/' || p_year::TEXT || '/' ||
         lpad(v_next::TEXT, GREATEST(6, length(v_next::TEXT)), '0');
END $$;

-- ---------------------------------------------------------------------
-- Audit archive job (FR-AUD-006 .. 008)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_archive_audit_logs(p_years INT DEFAULT 5)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_moved INT;
BEGIN
  PERFORM set_config('app.bypass', 'on', true);

  WITH moved AS (
    DELETE FROM audit_logs
     WHERE created_at < now() - make_interval(years => p_years)
    RETURNING *
  )
  INSERT INTO audit_logs_archive (id, tenant_id, client_id, username, action, module,
                                  record_id, record_ref, old_value, new_value, created_at)
  SELECT id, tenant_id, client_id, username, action, module,
         record_id, record_ref, old_value, new_value, created_at
    FROM moved;

  GET DIAGNOSTICS v_moved = ROW_COUNT;

  -- The job audits itself (FR-AUD-008)
  INSERT INTO audit_logs (tenant_id, username, action, module, new_value)
  VALUES (0, 'system', 'ARCHIVE', 'AUDIT',
          jsonb_build_object('rows_moved', v_moved, 'retention_years', p_years));

  PERFORM set_config('app.bypass', 'off', true);
  RETURN v_moved;
END $$;

-- ---------------------------------------------------------------------
-- Row-level security (SRS section 9)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_row_visible(p_tenant BIGINT, p_client BIGINT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT app_bypass()
      OR (
        p_tenant = app_tenant_id()
        AND (
          app_user_type() IN ('STAFF','PLATFORM_ADMIN')
          OR p_client = app_client_id()
        )
      )
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['patents','utility_models','trademarks','copyrights',
                           'industrial_designs','docket_entries','audit_logs',
                           'audit_logs_archive'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS sec_tenant_client ON %I', t);
    EXECUTE format($f$CREATE POLICY sec_tenant_client ON %I
                      FOR ALL
                      USING (app_row_visible(tenant_id, client_id))
                      WITH CHECK (app_row_visible(tenant_id, client_id))$f$, t);
  END LOOP;
END $$;
