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
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:lector.db", migrations)
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
