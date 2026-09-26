# db/ — PostgreSQL 迁移链与租户开通（IMPL-3）

业务真相源（PG 侧）迁移资产。蓝本：伞仓 `docs/design/ddl.md` v1.1（§3/§4/§9.4 原样落盘）。

## 目录

| 路径                        | 内容                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap/pg-roles.sql`    | 角色 bootstrap（ddl.md §3 原样；psql 执行，**不入** goose 版本链）                                                                                                                                                                                                                                                                                                 |
| `migrations/pg/`            | goose 迁移链（`0001_init.sql` = ddl.md §4 原样，19 表 + RLS + 角色授权；`0002_alarm_event_tenant_uidx.sql` = §9.4，CONCURRENTLY 单文件补 `alarm_event` 复合唯一索引；`0003_import_fdd_fuse.sql` = §9.4，import/FDD/熔断六表 + RLS + 授权，19→25 表；`0004_control_fuse_touch.sql` = DAT-92 评审建议 3 / DAT-102，`control_fuse` 补 touch 触发器 + 时间戳口径成文） |
| `scripts/create-tenant.sh`  | 租户开通运维脚本（ddl.md §5.3 superuser 通道，幂等可重跑）                                                                                                                                                                                                                                                                                                         |
| `scripts/verify-rls.sh`     | ddl.md §8 用例 2–6 脚本化复跑（RLS 隔离 / fail-closed / 角色矩阵）                                                                                                                                                                                                                                                                                                 |
| `scripts/verify-v11.sh`     | ddl.md §9.6 用例 2–9 脚本化复跑（0002/0003 六新表：DML 状态机 / CHECK 封闭集 / 活跃唯一 / FK RESTRICT / RLS 隔离 / 最小权 / 索引 / touch 触发器）                                                                                                                                                                                                                  |
| `scripts/verify-exclude.sh` | ddl.md §9.6 用例 11 脚本化复跑（0001 §4 `mv_baseline_no_active_overlap` EXCLUDE 拒绝语义，DAT-106 补录：同租户重叠 active 拒；首条 / 相邻 / 重叠 draft / 跨租户 / retired 换代放行，6 断言）                                                                                                                                                                       |

CI：`.github/workflows/db-migration-smoke.yml`（compose 外的一次性干净 PG 容器上跑 goose up/down 往返（25 表断言）+ RLS 验证 + §9.6 增量用例 + EXCLUDE 拒绝语义（§9.6 用例 11）+ 租户幂等）。

## 执行顺序契约（ddl.md §1）

**先 bootstrap 角色后迁移，先迁移后起服务。**

1. **bootstrap 角色**（部署管线一次性执行；密码只来自环境变量，SEC-KEY-01）：

   ```bash
   psql -U postgres -d thermio \
     -v api_password="$THERMIO_API_PASSWORD" \
     -v ingest_password="$THERMIO_INGEST_PASSWORD" \
     -v auth_password="$THERMIO_AUTH_PASSWORD" \
     -f db/bootstrap/pg-roles.sql
   ```

   幂等性由部署侧保证：角色已存在时本文件会报错退出，凭据轮换走 `ALTER ROLE ... PASSWORD`（SEC-KEY-04 双读窗口后续设计，见 ddl.md §3）。注意 PG 角色是**集群级**对象——DROP DATABASE 后重建库时角色仍在但库级/模式级 GRANT 已随库消失，需重放本文件的 GRANT 部分（干净集群/新容器一次通过，CI 即此形态）。

2. **goose 迁移**（执行角色 `thermio_owner` NOLOGIN，经连接参数 `SET ROLE`，见 ddl.md §1/§5.1）：

   ```bash
   goose -dir db/migrations/pg postgres \
     "postgres://<superuser>:<pw>@<host>:<port>/thermio?sslmode=disable&options=-c role=thermio_owner" up
   ```

   `options=-c role=thermio_owner` 让会话建立即 `SET ROLE`：对象 OWNER 归 `thermio_owner`，FORCE RLS 对 owner 生效（ddl.md §8 用例 6）。

3. **起服务**：应用连接角色（`thermio_api` / `thermio_ingest` / `thermio_auth`）只在迁移完成后启动；api 每事务 `SET LOCAL app.tenant_id`（ddl.md §5.2）。

## 与蓝本的唯一差异

`0001_init.sql` 与 `0003_import_fdd_fuse.sql` 的 RLS `DO $$ … $$;` 块（ddl.md §4 第 8 节 / §9.4 第 13 节）外层各包了一对 `-- +goose StatementBegin` / `-- +goose StatementEnd` 注解：goose 逐行按分号切分语句，多行 dollar-quoted 块会在块内分号处被截断（0001 实跑验证发现，蓝本当时用 psql 验证未暴露；0003 为同一 DO 块结构，同因同解）。注解是 goose 文件格式的语句包裹指令，SQL 文本零改动，psql 直跑不受影响。除此之外与 ddl.md §4/§9.4 逐字一致。

## 本地冒烟（一次性容器，环境隔离纪律）

```bash
docker run -d --name thermio-smoke-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=thermio \
  -p 127.0.0.1:55432:5432 postgres:16.4-alpine
docker exec thermio-smoke-pg pg_isready -U postgres   # 等就绪

# 1) bootstrap（密码现场生成，勿入库勿入码）
docker exec -i thermio-smoke-pg psql -U postgres -d thermio \
  -v api_password="$(openssl rand -hex 16)" \
  -v ingest_password="$(openssl rand -hex 16)" \
  -v auth_password="$(openssl rand -hex 16)" \
  -f - < db/bootstrap/pg-roles.sql

# 2) goose 往返
goose -dir db/migrations/pg postgres \
  "postgres://postgres:postgres@127.0.0.1:55432/thermio?sslmode=disable&options=-c%20role%3Dthermio_owner" up
goose -dir db/migrations/pg postgres \
  "postgres://postgres:postgres@127.0.0.1:55432/thermio?sslmode=disable&options=-c%20role%3Dthermio_owner" down-to 0
goose -dir db/migrations/pg postgres \
  "postgres://postgres:postgres@127.0.0.1:55432/thermio?sslmode=disable&options=-c%20role%3Dthermio_owner" up

# 3) RLS 验证 + §9.6 增量用例 + EXCLUDE 拒绝语义 + 租户开通幂等（容器内 psql，socket trust 通道）
docker exec -i -e PGUSER=postgres -e PGDATABASE=thermio thermio-smoke-pg bash -s < db/scripts/verify-rls.sh
docker exec -i -e PGUSER=postgres -e PGDATABASE=thermio thermio-smoke-pg bash -s < db/scripts/verify-v11.sh
docker exec -i -e PGUSER=postgres -e PGDATABASE=thermio thermio-smoke-pg bash -s < db/scripts/verify-exclude.sh
docker exec -i -e PGUSER=postgres -e PGDATABASE=thermio thermio-smoke-pg bash -s < db/scripts/create-tenant.sh -- \
  --slug demo --name "演示租户" --admin-email admin@demo.local --admin-password-hash '(argon2id/bcrypt 串)'
docker exec -i -e PGUSER=postgres -e PGDATABASE=thermio thermio-smoke-pg bash -s < db/scripts/create-tenant.sh -- \
  --slug demo --name "演示租户" --admin-email admin@demo.local --admin-password-hash '(同上)'   # 第二次应幂等

docker rm -f thermio-smoke-pg   # 跑完即清
```
