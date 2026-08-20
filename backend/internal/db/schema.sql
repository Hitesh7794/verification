-- Verification Portal — Postgres schema.
--
-- Single source of truth for the schema. Applied by Migrate() once on
-- a fresh database, guarded by the schema_migrations table so it is
-- idempotent.
--
-- Translated from the SQLite migrations 001–023 (Jan 2025 – Aug 2026).
-- Design notes:
--   * IDs are BIGINT via GENERATED ALWAYS AS IDENTITY. SQLite INTEGER
--     was 64-bit, so BIGINT preserves range parity for the data load.
--   * DATETIME columns become TIMESTAMPTZ (server timezone is UTC on
--     both dev + prod). DATE stays DATE.
--   * 0/1 flag columns stay SMALLINT with CHECK — the Go code compares
--     to int, so keeping the same width avoids a large touch to the
--     application layer. A future refactor can switch these to BOOLEAN.
--   * All defaults use NOW()/CURRENT_TIMESTAMP where the SQLite version
--     did CURRENT_TIMESTAMP.

-- schema_migrations is created by Migrate() before applying this file
-- (that's how the runner detects whether the schema has been applied
-- at all — bootstrap first, then this file). So it is intentionally
-- absent from this DDL.

-- ─────────────────────────────────────────────────────────────
--  Core tenant + user + auth
-- ─────────────────────────────────────────────────────────────

CREATE TABLE organizations (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
    id                       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username                 TEXT NOT NULL UNIQUE,
    password_hash            TEXT NOT NULL,
    role                     TEXT NOT NULL CHECK (role IN ('client','admin','superadmin','ops_admin')),
    org_id                   BIGINT REFERENCES organizations(id),
    display_name             TEXT NOT NULL,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    email                    TEXT,
    disabled_at              TIMESTAMPTZ,
    activated_at             TIMESTAMPTZ,
    password_plaintext       TEXT,
    password_change_required SMALLINT NOT NULL DEFAULT 0 CHECK (password_change_required IN (0,1)),
    spending_cap_paise       INTEGER,
    spent_paise              INTEGER NOT NULL DEFAULT 0,
    valid_from               DATE,
    valid_to                 DATE
);
CREATE INDEX idx_users_org_role ON users(org_id, role);
-- Email uniqueness scoped per organisation (V6, 2026-08-20) — same
-- physical person can operate under multiple orgs with the same email;
-- collisions inside one org are still prevented.
CREATE UNIQUE INDEX ux_users_org_email_ci
    ON users(org_id, LOWER(email))
    WHERE email IS NOT NULL AND email != '';

CREATE TABLE magic_links (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    purpose      TEXT NOT NULL CHECK (purpose IN ('set_password','reset_password')),
    expires_at   TIMESTAMPTZ NOT NULL,
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_magic_links_user    ON magic_links(user_id);
CREATE INDEX idx_magic_links_expires ON magic_links(expires_at) WHERE used_at IS NULL;

CREATE TABLE audit_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    actor_username  TEXT,
    actor_role      TEXT,
    org_id          BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       BIGINT,
    metadata        TEXT,
    ip              TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_org_created    ON audit_log(org_id,        created_at DESC);
CREATE INDEX idx_audit_action_created ON audit_log(action,        created_at DESC);
CREATE INDEX idx_audit_actor_created  ON audit_log(actor_user_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
--  Exam catalog (clients → exams → candidates + centres)
-- ─────────────────────────────────────────────────────────────

CREATE TABLE clients (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT NOT NULL,
    notes        TEXT,
    visible      SMALLINT NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
    closed       SMALLINT NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
    closed_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_clients_visible ON clients(visible, closed, created_at DESC);

CREATE TABLE exams (
    id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id          BIGINT NOT NULL REFERENCES clients(id),
    name               TEXT NOT NULL,
    exam_code          TEXT NOT NULL,
    trustview_ref      TEXT,
    verification_from  DATE NOT NULL,
    verification_to    DATE NOT NULL,
    visible            SMALLINT NOT NULL DEFAULT 1 CHECK (visible IN (0,1)),
    closed             SMALLINT NOT NULL DEFAULT 0 CHECK (closed IN (0,1)),
    closed_at          TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requires_face      SMALLINT NOT NULL DEFAULT 1 CHECK (requires_face IN (0,1)),
    requires_fp        SMALLINT NOT NULL DEFAULT 1 CHECK (requires_fp   IN (0,1)),
    requires_iris      SMALLINT NOT NULL DEFAULT 0 CHECK (requires_iris IN (0,1)),
    CHECK (verification_from <= verification_to)
);
CREATE UNIQUE INDEX idx_exams_code   ON exams(exam_code);
CREATE INDEX idx_exams_client        ON exams(client_id, created_at DESC);

CREATE TABLE exam_candidates (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exam_id           BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    roll_no           TEXT NOT NULL,
    name              TEXT NOT NULL,
    verification_date DATE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registration_id   TEXT,
    father_name       TEXT,
    dob               DATE,
    gender            TEXT,
    shift_name        TEXT,
    centre_code       TEXT,
    UNIQUE (exam_id, roll_no)
);
CREATE INDEX idx_exam_candidates_exam   ON exam_candidates(exam_id);
CREATE INDEX idx_exam_candidates_roll   ON exam_candidates(roll_no);
CREATE INDEX idx_exam_candidates_centre ON exam_candidates(centre_code);
CREATE INDEX idx_exam_candidates_regid  ON exam_candidates(registration_id);

CREATE TABLE exam_centres (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exam_id      BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    centre_code  TEXT NOT NULL,
    centre_name  TEXT NOT NULL,
    address      TEXT,
    city         TEXT,
    state        TEXT,
    pincode      TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (exam_id, centre_code)
);
CREATE INDEX idx_exam_centres_exam ON exam_centres(exam_id);

CREATE TABLE exam_csv_uploads (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    exam_id        BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,
    storage_path   TEXT NOT NULL,
    size_bytes     BIGINT NOT NULL,
    sha256         TEXT NOT NULL,
    uploaded_by    BIGINT NOT NULL REFERENCES users(id),
    uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rows_seeded    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_exam_csv_uploads_exam ON exam_csv_uploads(exam_id, uploaded_at DESC);

CREATE TABLE organization_exam_subscriptions (
    org_id         BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    exam_id        BIGINT NOT NULL REFERENCES exams(id)         ON DELETE CASCADE,
    subscribed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    subscribed_by  BIGINT REFERENCES users(id),
    PRIMARY KEY (org_id, exam_id)
);
CREATE INDEX idx_org_exam_subs_exam ON organization_exam_subscriptions(exam_id);

CREATE TABLE operator_exams (
    user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id  BIGINT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, exam_id)
);
CREATE INDEX idx_operator_exams_exam ON operator_exams(exam_id);
CREATE UNIQUE INDEX ux_operator_exams_user ON operator_exams(user_id);

-- ─────────────────────────────────────────────────────────────
--  Verifications + artifacts
-- ─────────────────────────────────────────────────────────────

CREATE TABLE verifications (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    roll_no             TEXT NOT NULL,
    org_id              BIGINT NOT NULL,
    operator_id         BIGINT NOT NULL,
    face_match          SMALLINT NOT NULL DEFAULT 0 CHECK (face_match IN (0,1)),
    fp_match            SMALLINT NOT NULL DEFAULT 0 CHECK (fp_match   IN (0,1)),
    status              TEXT NOT NULL CHECK (status IN ('verified','denied')),
    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    device_serial       TEXT,
    device_model        TEXT,
    fp_template_format  TEXT,
    fp_quality          INTEGER,
    fp_nfiq             INTEGER,
    fp_match_score      INTEGER,
    fp_liveness         INTEGER,
    iris_left_score     DOUBLE PRECISION,
    iris_right_score    DOUBLE PRECISION,
    iris_left_quality   INTEGER,
    iris_right_quality  INTEGER,
    face_match_score    DOUBLE PRECISION,
    via                 TEXT,
    match_threshold     INTEGER,
    decision_ms         INTEGER,
    client_app_version  TEXT,
    idempotency_key     TEXT,
    fp_vendor           TEXT,
    probe_photo_path    TEXT
);
CREATE INDEX idx_verifications_org_created ON verifications(org_id, created_at);
CREATE INDEX idx_verifications_roll        ON verifications(roll_no);
CREATE INDEX idx_verifications_status      ON verifications(status);
CREATE UNIQUE INDEX idx_verifications_idempotency
    ON verifications(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────
--  Wallet + Razorpay
-- ─────────────────────────────────────────────────────────────

CREATE TABLE wallets (
    org_id        BIGINT PRIMARY KEY REFERENCES organizations(id),
    balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wallet_transactions (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org_id               BIGINT NOT NULL REFERENCES organizations(id),
    actor_user_id        BIGINT REFERENCES users(id),
    kind                 TEXT NOT NULL CHECK (kind IN ('deposit','charge','admin_credit','refund')),
    amount_paise         BIGINT NOT NULL,
    balance_after_paise  BIGINT NOT NULL,
    related_roll         TEXT,
    razorpay_order_id    TEXT,
    razorpay_payment_id  TEXT,
    description          TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wallet_tx_org_created      ON wallet_transactions(org_id, created_at);
CREATE INDEX idx_wallet_tx_org_roll_created ON wallet_transactions(org_id, related_roll, created_at)
    WHERE related_roll IS NOT NULL;
CREATE UNIQUE INDEX idx_wallet_tx_razorpay_payment
    ON wallet_transactions(razorpay_payment_id)
    WHERE razorpay_payment_id IS NOT NULL;

CREATE TABLE razorpay_orders (
    razorpay_order_id   TEXT PRIMARY KEY,
    org_id              BIGINT NOT NULL REFERENCES organizations(id),
    actor_user_id       BIGINT NOT NULL REFERENCES users(id),
    amount_paise        BIGINT NOT NULL CHECK (amount_paise > 0),
    receipt             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created','verified','expired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    verified_at         TIMESTAMPTZ
);
CREATE INDEX idx_razorpay_orders_org_created ON razorpay_orders(org_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────
--  Institution onboarding
-- ─────────────────────────────────────────────────────────────

CREATE TABLE institution_applications (
    id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status                TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('draft','pending','approved','rejected')),
    institution_name      TEXT NOT NULL,
    institution_type      TEXT NOT NULL,
    tier                  TEXT
        CHECK (tier IS NULL OR tier IN ('tier_1','tier_2','tier_3')),
    aishe_code            TEXT,
    pan                   TEXT,
    year_established      INTEGER,
    affiliation_body      TEXT,
    address_line1         TEXT NOT NULL,
    address_line2         TEXT,
    city                  TEXT NOT NULL,
    district              TEXT,
    state                 TEXT NOT NULL,
    pin_code              TEXT NOT NULL,
    approx_student_count  INTEGER,
    expected_centres      INTEGER NOT NULL DEFAULT 1,
    head_name             TEXT NOT NULL,
    head_designation      TEXT NOT NULL,
    head_email            TEXT NOT NULL,
    head_mobile           TEXT NOT NULL,
    reviewed_by_user_id   BIGINT REFERENCES users(id),
    reviewed_at           TIMESTAMPTZ,
    review_note           TEXT,
    submitter_ip          TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_inst_apps_status     ON institution_applications(status, created_at DESC);
CREATE INDEX idx_inst_apps_created    ON institution_applications(created_at DESC);
CREATE INDEX idx_inst_apps_head_email ON institution_applications(head_email);
CREATE INDEX idx_inst_apps_head_mobile ON institution_applications(head_mobile);
CREATE UNIQUE INDEX idx_inst_apps_aishe
    ON institution_applications(aishe_code) WHERE aishe_code IS NOT NULL;
CREATE UNIQUE INDEX idx_inst_apps_pan_active
    ON institution_applications(pan)
    WHERE pan IS NOT NULL AND status IN ('approved','pending');
CREATE UNIQUE INDEX idx_inst_apps_head_email_active
    ON institution_applications(head_email) WHERE status IN ('approved','pending');
CREATE UNIQUE INDEX idx_inst_apps_head_mobile_active
    ON institution_applications(head_mobile) WHERE status IN ('approved','pending');

CREATE TABLE institution_application_documents (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    application_id  BIGINT NOT NULL REFERENCES institution_applications(id) ON DELETE CASCADE,
    doc_kind        TEXT NOT NULL
        CHECK (doc_kind IN (
            'recognition_letter',
            'pan_card',
            'authorization_letter',
            'naac_certificate',
            'other'
        )),
    original_name   TEXT NOT NULL,
    storage_path    TEXT NOT NULL,
    mime            TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL,
    sha256          TEXT NOT NULL,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_inst_app_docs_app ON institution_application_documents(application_id);
