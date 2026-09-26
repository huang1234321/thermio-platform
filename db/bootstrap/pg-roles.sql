-- db/bootstrap/pg-roles.sql
-- 运行：psql -U postgres -d thermio \
--        -v api_password="$THERMIO_API_PASSWORD" \
--        -v ingest_password="$THERMIO_INGEST_PASSWORD" \
--        -v auth_password="$THERMIO_AUTH_PASSWORD" -f db/bootstrap/pg-roles.sql
\set ON_ERROR_STOP on
CREATE ROLE thermio_owner NOLOGIN;
CREATE ROLE thermio_api LOGIN PASSWORD :'api_password';
CREATE ROLE thermio_ingest LOGIN PASSWORD :'ingest_password';
CREATE ROLE thermio_auth LOGIN PASSWORD :'auth_password';
GRANT CONNECT ON DATABASE thermio TO thermio_api, thermio_ingest, thermio_auth;
GRANT CREATE, USAGE ON SCHEMA public TO thermio_owner;   -- goose 以 owner 建对象
GRANT CREATE ON DATABASE thermio TO thermio_owner;        -- 供创建 trusted extension（btree_gist）
