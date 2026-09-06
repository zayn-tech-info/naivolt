use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{Executor, PgPool};
use std::str::FromStr;
use uuid::Uuid;

pub(crate) struct IsolatedDatabase {
    pub(crate) pool: PgPool,
    admin: PgPool,
    database_url: String,
    schema: String,
    cleaned: bool,
}

struct SetupSchemaGuard {
    database_url: String,
    schema: String,
    armed: bool,
}

impl IsolatedDatabase {
    pub(crate) async fn new(prefix: &str) -> Self {
        let database_url = std::env::var("DATABASE_URL")
            .expect("DATABASE_URL is required for PostgreSQL integration tests");
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("PostgreSQL integration test database must be reachable");
        let schema = format!("{prefix}_{}", Uuid::new_v4().simple());
        admin
            .execute(format!("CREATE SCHEMA {schema}").as_str())
            .await
            .expect("temporary PostgreSQL test schema must be created");
        let mut setup_guard = SetupSchemaGuard {
            database_url: database_url.clone(),
            schema: schema.clone(),
            armed: true,
        };

        let options = PgConnectOptions::from_str(&database_url)
            .expect("DATABASE_URL must be a valid PostgreSQL URL");
        let search_path = schema.clone();
        let pool = PgPoolOptions::new()
            .max_connections(6)
            .after_connect(move |connection, _| {
                let sql = format!("SET search_path TO {search_path}, public");
                Box::pin(async move {
                    connection.execute(sql.as_str()).await?;
                    Ok(())
                })
            })
            .connect_with(options)
            .await
            .expect("temporary PostgreSQL test pool must connect");
        sqlx::migrate!("../../migrations")
            .run(&pool)
            .await
            .expect("all migrations must apply in the temporary test schema");
        setup_guard.armed = false;

        Self {
            pool,
            admin,
            database_url,
            schema,
            cleaned: false,
        }
    }

    pub(crate) async fn cleanup(mut self) {
        self.pool.close().await;
        self.admin
            .execute(format!("DROP SCHEMA {} CASCADE", self.schema).as_str())
            .await
            .expect("temporary PostgreSQL test schema must be removed");
        self.cleaned = true;
    }
}

impl Drop for IsolatedDatabase {
    fn drop(&mut self) {
        if self.cleaned {
            return;
        }

        cleanup_blocking(self.database_url.clone(), self.schema.clone());
    }
}

impl Drop for SetupSchemaGuard {
    fn drop(&mut self) {
        if self.armed {
            cleanup_blocking(self.database_url.clone(), self.schema.clone());
        }
    }
}

fn cleanup_blocking(database_url: String, schema: String) {
    let _ = std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            if let Ok(runtime) = runtime {
                runtime.block_on(async move {
                    if let Ok(admin) = PgPoolOptions::new()
                        .max_connections(1)
                        .connect(&database_url)
                        .await
                    {
                        let _ = admin
                            .execute(format!("DROP SCHEMA {schema} CASCADE").as_str())
                            .await;
                    }
                });
            }
        })
        .join();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn panic_still_removes_the_temporary_schema() {
        let database = IsolatedDatabase::new("number_cleanup_test").await;
        let database_url = database.database_url.clone();
        let schema = database.schema.clone();
        let task = tokio::spawn(async move {
            let _database = database;
            panic!("intentional cleanup regression test");
        });
        assert!(task.await.is_err());

        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                 SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
             )",
        )
        .bind(schema)
        .fetch_one(&admin)
        .await
        .unwrap();
        assert!(!exists);
    }

    #[tokio::test]
    async fn ordinary_drop_still_removes_the_temporary_schema() {
        let database = IsolatedDatabase::new("number_drop_cleanup_test").await;
        let database_url = database.database_url.clone();
        let schema = database.schema.clone();
        drop(database);

        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (
                 SELECT 1 FROM information_schema.schemata WHERE schema_name = $1
             )",
        )
        .bind(schema)
        .fetch_one(&admin)
        .await
        .unwrap();
        assert!(!exists);
    }
}
