-- =============================================================================
-- SPAWN Database Schema — scws_daemon
-- =============================================================================
-- Standalone DDL for initializing the SPAWN daemon database.
-- Usage: sudo -u postgres psql scws_daemon < scripts/schema.sql
--
-- Tables: projects, claude_runs, activity_log, daemon_config,
--         spawn_memories, channels, connections, notifications
-- =============================================================================

-- ── projects ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    name text NOT NULL UNIQUE,
    display_name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    port integer NOT NULL UNIQUE,
    status text DEFAULT 'stopped'::text NOT NULL,
    framework text DEFAULT 'express'::text NOT NULL,
    git_repo text,
    git_branch text DEFAULT 'main'::text NOT NULL,
    db_name text,
    entry_file text DEFAULT 'dist/index.js'::text NOT NULL,
    build_command text,
    start_command text,
    env_vars text DEFAULT '{}'::text NOT NULL,
    deploy_targets text DEFAULT '[]'::text NOT NULL,
    last_build_at timestamp without time zone,
    last_deploy_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── claude_runs ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS claude_runs (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    project_id character varying NOT NULL,
    project_name text,
    prompt text NOT NULL,
    output text,
    status text DEFAULT 'running'::text NOT NULL,
    mode text DEFAULT 'build'::text NOT NULL,
    session_id text,
    turn_number integer DEFAULT 1 NOT NULL,
    parent_run_id character varying,
    duration integer,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── activity_log ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS activity_log (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    project_id character varying,
    action text NOT NULL,
    details text DEFAULT ''::text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── daemon_config ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS daemon_config (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    key text NOT NULL UNIQUE,
    value text NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── spawn_memories ──────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS spawn_memories_id_seq
    AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

CREATE TABLE IF NOT EXISTS spawn_memories (
    id integer DEFAULT nextval('spawn_memories_id_seq'::regclass) NOT NULL PRIMARY KEY,
    key text NOT NULL UNIQUE,
    value text NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER SEQUENCE spawn_memories_id_seq OWNED BY spawn_memories.id;

-- ── channels ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channels (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    type text NOT NULL,
    name text NOT NULL,
    config text DEFAULT '{}'::text NOT NULL,
    enabled integer DEFAULT 1 NOT NULL,
    verified integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    status_message text,
    last_tested_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── connections ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS connections (
    id text DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    name text NOT NULL UNIQUE,
    type text NOT NULL,
    config text DEFAULT '{}'::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    tags text DEFAULT '[]'::text NOT NULL,
    last_used_at timestamp without time zone,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── notifications ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
    id character varying DEFAULT (gen_random_uuid())::text NOT NULL PRIMARY KEY,
    channel_id character varying NOT NULL,
    event text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    error text,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);

-- ── indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_notifications_channel ON notifications USING btree (channel_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications USING btree (created_at DESC);
