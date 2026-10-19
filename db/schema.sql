-- PCB Studio: lo schema del database.
--
-- Fino alla v0.18 queste tabelle esistevano solo sul database di produzione,
-- create a mano: quando quel database e' stato eliminato (29/09/2026) non c'era
-- modo di ricrearle, perche' nel repo non erano scritte da nessuna parte. Qui
-- ci sono tutte quelle che il codice usa e non crea da solo, ricostruite dalle
-- query di src/lib. Le tabelle di cache (project_compiles, route_variants,
-- parts_cache, mouser_cache, ...) restano create dal codice al primo uso.
--
-- Idempotente: si puo' rilanciare su un database gia' allineato
-- (`pnpm db:migrate`). Ogni cambio di schema si aggiunge qui in fondo, sempre
-- con IF NOT EXISTS, mai riscrivendo una CREATE gia' applicata.

-- ---------------------------------------------------------------------------
-- Auth.js (adapter Neon). Gli id sono UUID: l'app li valida come uuid.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text UNIQUE,
  "emailVerified" timestamptz,
  image text
);

CREATE TABLE IF NOT EXISTS accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  provider text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token text,
  access_token text,
  expires_at bigint,
  id_token text,
  scope text,
  session_state text,
  token_type text,
  UNIQUE (provider, "providerAccountId")
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires timestamptz NOT NULL,
  "sessionToken" text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS verification_token (
  identifier text NOT NULL,
  expires timestamptz NOT NULL,
  token text NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- ---------------------------------------------------------------------------
-- Organizzazioni
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS organization_members_user_idx ON organization_members (user_id);

-- l'email si salva minuscola: e' la chiave con cui l'invito si consuma al primo accesso
CREATE TABLE IF NOT EXISTS organization_invites (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  PRIMARY KEY (org_id, email)
);

-- ---------------------------------------------------------------------------
-- Progetti: il codice tscircuit e' il progetto, tutto il resto ne deriva
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY CHECK (id ~* '^[a-z0-9][a-z0-9_-]{0,59}$'),
  name text,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org', 'link')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);
CREATE INDEX IF NOT EXISTS projects_created_by_idx ON projects (created_by);

-- `version` cresce a ogni scrittura: e' il confronto con cui due salvataggi
-- concorrenti dello stesso file non si cancellano a vicenda
CREATE TABLE IF NOT EXISTS project_files (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path text NOT NULL,
  content text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, path)
);

CREATE TABLE IF NOT EXISTS project_shares (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_shares_user_idx ON project_shares (user_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_messages_project_idx ON chat_messages (project_id, id);

CREATE TABLE IF NOT EXISTS project_revisions (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  files jsonb NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  chat_message_id bigint REFERENCES chat_messages(id) ON DELETE SET NULL,
  compile_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_revisions_project_idx ON project_revisions (project_id, id DESC);

-- una riga per ogni chiamata a un modello: si scrive all'INIZIO del lavoro
-- (finished_at NULL = in corso), cosi' il limite conta anche le esecuzioni in
-- volo e non solo quelle finite. `kind` distingue l'agente dalle descrizioni.
CREATE TABLE IF NOT EXISTS agent_runs (
  id bigserial PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'agent',
  ip text,
  steps integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0,
  tokens_out integer NOT NULL DEFAULT 0,
  stop_reason text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_ip_idx ON agent_runs (ip, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_user_idx ON agent_runs (user_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_active_idx ON agent_runs (project_id) WHERE finished_at IS NULL;

-- ---------------------------------------------------------------------------
-- Accesso da agenti esterni (MCP): del token si tiene solo l'hash
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_tokens_user_idx ON api_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Libreria componenti e datasheet
-- ---------------------------------------------------------------------------

-- org_id NULL = libreria condivisa dell'istanza. L'indice unico usa COALESCE
-- perche' in Postgres NULL non collide con NULL: senza, ogni salvataggio di un
-- componente condiviso inseriva una riga nuova invece di aggiornarla.
CREATE TABLE IF NOT EXISTS library_components (
  id bigserial PRIMARY KEY,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  code text NOT NULL,
  source text NOT NULL
    CONSTRAINT library_components_source_check
    CHECK (source IN ('lcsc', 'datasheet', 'llm', 'manual', 'kicad', 'altium')),
  source_ref text,
  version integer NOT NULL DEFAULT 1,
  datasheet_url text,
  schematic_notes text,
  layout_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS library_components_scope_name_idx
  ON library_components ((COALESCE(org_id::text, '')), name);

CREATE TABLE IF NOT EXISTS library_component_versions (
  component_id bigint NOT NULL REFERENCES library_components(id) ON DELETE CASCADE,
  version integer NOT NULL,
  code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (component_id, version)
);

CREATE TABLE IF NOT EXISTS datasheets (
  id bigserial PRIMARY KEY,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  title text NOT NULL,
  source_url text,
  text_content text NOT NULL,
  pages integer,
  mpn text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS datasheets_project_idx ON datasheets (project_id);
CREATE INDEX IF NOT EXISTS datasheets_mpn_idx ON datasheets (mpn);
