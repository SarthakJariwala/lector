use tauri_plugin_sql::{Migration, MigrationKind};

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_tables",
            sql: "CREATE TABLE IF NOT EXISTS feeds (
                url TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                added_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS articles (
                id TEXT PRIMARY KEY,
                feed_url TEXT NOT NULL REFERENCES feeds(url) ON DELETE CASCADE,
                feed_name TEXT,
                title TEXT NOT NULL,
                link TEXT,
                published TEXT,
                published_ts INTEGER,
                content TEXT,
                author TEXT,
                is_read INTEGER NOT NULL DEFAULT 0,
                is_starred INTEGER NOT NULL DEFAULT 0,
                fetched_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_articles_feed_url ON articles(feed_url);
            CREATE INDEX IF NOT EXISTS idx_articles_published_ts ON articles(published_ts);
            CREATE INDEX IF NOT EXISTS idx_articles_starred ON articles(is_starred);

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_sync_foundation_tables",
            sql: "ALTER TABLE feeds ADD COLUMN subscribed INTEGER NOT NULL DEFAULT 1;
            ALTER TABLE feeds ADD COLUMN subscription_changed_at INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE feeds ADD COLUMN subscription_changed_by TEXT NOT NULL DEFAULT '';
            ALTER TABLE feeds ADD COLUMN name_changed_at INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE feeds ADD COLUMN name_changed_by TEXT NOT NULL DEFAULT '';

            CREATE TABLE IF NOT EXISTS article_state (
                article_id TEXT PRIMARY KEY,
                feed_url TEXT NOT NULL,
                read_value INTEGER NOT NULL DEFAULT 0,
                read_changed_at INTEGER NOT NULL DEFAULT 0,
                read_changed_by TEXT NOT NULL DEFAULT '',
                starred_value INTEGER NOT NULL DEFAULT 0,
                starred_changed_at INTEGER NOT NULL DEFAULT 0,
                starred_changed_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_article_state_feed_url ON article_state(feed_url);

            CREATE TABLE IF NOT EXISTS sync_outbox (
                device_id TEXT NOT NULL,
                mutation_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (device_id, mutation_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_outbox_created_at ON sync_outbox(created_at);",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lector.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
