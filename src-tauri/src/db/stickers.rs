#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerEntry {
    pub id: String,
    pub sha256: String,
    pub path: String,
    pub thumb_path: String,
    pub name: String,
    pub mime: String,
    pub width: i64,
    pub height: i64,
    pub frame_count: i64,
    pub size: i64,
    pub sort_at: i64,
    pub source_msg_id: Option<String>,
}

fn row_to_sticker(r: &rusqlite::Row<'_>) -> rusqlite::Result<StickerEntry> {
    Ok(StickerEntry {
        id: r.get(0)?,
        sha256: r.get(1)?,
        path: r.get(2)?,
        thumb_path: r.get(3)?,
        name: r.get(4)?,
        mime: r.get(5)?,
        width: r.get(6)?,
        height: r.get(7)?,
        frame_count: r.get(8)?,
        size: r.get(9)?,
        sort_at: r.get(10)?,
        source_msg_id: r.get(11)?,
    })
}

pub fn list_stickers(conn: &Connection) -> rusqlite::Result<Vec<StickerEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, sha256, path, thumb_path, name, mime, width, height, frame_count, size, sort_at, source_msg_id
         FROM custom_stickers ORDER BY sort_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], row_to_sticker)?;
    rows.collect()
}

pub fn get_sticker(conn: &Connection, id: &str) -> rusqlite::Result<Option<StickerEntry>> {
    conn.query_row(
        "SELECT id, sha256, path, thumb_path, name, mime, width, height, frame_count, size, sort_at, source_msg_id
         FROM custom_stickers WHERE id = ?1",
        params![id],
        row_to_sticker,
    )
    .optional()
}

pub fn get_sticker_by_sha(conn: &Connection, sha256: &str) -> rusqlite::Result<Option<StickerEntry>> {
    conn.query_row(
        "SELECT id, sha256, path, thumb_path, name, mime, width, height, frame_count, size, sort_at, source_msg_id
         FROM custom_stickers WHERE sha256 = ?1",
        params![sha256],
        row_to_sticker,
    )
    .optional()
}

pub fn next_sticker_sort_at(conn: &Connection) -> rusqlite::Result<i64> {
    let current: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_at), 0) FROM custom_stickers",
        [],
        |r| r.get(0),
    )?;
    Ok(now_ms().max(current.saturating_add(1)))
}

pub fn insert_sticker(conn: &Connection, sticker: &StickerEntry) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO custom_stickers
         (id, sha256, path, thumb_path, name, mime, width, height, frame_count, size, sort_at, source_msg_id)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            sticker.id,
            sticker.sha256,
            sticker.path,
            sticker.thumb_path,
            sticker.name,
            sticker.mime,
            sticker.width,
            sticker.height,
            sticker.frame_count,
            sticker.size,
            sticker.sort_at,
            sticker.source_msg_id
        ],
    )?;
    Ok(changed > 0)
}

pub fn delete_sticker(conn: &Connection, id: &str) -> rusqlite::Result<Option<StickerEntry>> {
    let tx = conn.unchecked_transaction()?;
    let found = get_sticker(&tx, id)?;
    if found.is_some() {
        tx.execute("DELETE FROM custom_stickers WHERE id = ?1", params![id])?;
    }
    tx.commit()?;
    Ok(found)
}

pub fn move_sticker_to_front(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let sort_at = next_sticker_sort_at(conn)?;
    let changed = conn.execute(
        "UPDATE custom_stickers SET sort_at = ?2 WHERE id = ?1",
        params![id, sort_at],
    )?;
    Ok(changed > 0)
}

pub fn set_transfer_sticker(conn: &Connection, id: &str, sticker: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE file_transfers SET sticker = ?2 WHERE id = ?1",
        params![id, if sticker { 1i64 } else { 0i64 }],
    )?;
    Ok(())
}

pub fn transfer_is_sticker(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let value: Option<i64> = conn
        .query_row(
            "SELECT sticker FROM file_transfers WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or(0) != 0)
}

pub fn set_group_file_sticker(conn: &Connection, id: &str, sticker: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE group_files SET sticker = ?2 WHERE transfer_id = ?1",
        params![id, if sticker { 1i64 } else { 0i64 }],
    )?;
    Ok(())
}

pub fn group_file_is_sticker(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    let value: Option<i64> = conn
        .query_row(
            "SELECT sticker FROM group_files WHERE transfer_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or(0) != 0)
}

pub fn group_file_is_sticker_by_sha(
    conn: &Connection,
    group_id: &str,
    sha256: &str,
) -> rusqlite::Result<bool> {
    let value: Option<i64> = conn
        .query_row(
            "SELECT sticker FROM group_files WHERE group_id = ?1 AND sha256 = ?2
             ORDER BY created_at DESC LIMIT 1",
            params![group_id, sha256],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value.unwrap_or(0) != 0)
}

#[cfg(test)]
mod sticker_db_tests {
    use super::*;

    fn sticker(id: &str, sort_at: i64) -> StickerEntry {
        StickerEntry {
            id: id.into(),
            sha256: id.into(),
            path: format!("/stickers/{id}.png"),
            thumb_path: format!("/stickers/thumbs/{id}.png"),
            name: id.into(),
            mime: "image/png".into(),
            width: 32,
            height: 32,
            frame_count: 1,
            size: 10,
            sort_at,
            source_msg_id: None,
        }
    }

    #[test]
    fn stickers_sort_by_latest_action_and_move_to_front_is_monotonic() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        insert_sticker(&conn, &sticker("a", 10)).unwrap();
        insert_sticker(&conn, &sticker("b", 20)).unwrap();
        assert_eq!(list_stickers(&conn).unwrap()[0].id, "b");
        assert!(move_sticker_to_front(&conn, "a").unwrap());
        let rows = list_stickers(&conn).unwrap();
        assert_eq!(rows[0].id, "a");
        assert!(rows[0].sort_at > rows[1].sort_at);
        assert!(!move_sticker_to_front(&conn, "missing").unwrap());
    }

    #[test]
    fn duplicate_sticker_sha_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        assert!(insert_sticker(&conn, &sticker("same", 1)).unwrap());
        assert!(!insert_sticker(&conn, &sticker("same", 2)).unwrap());
        assert_eq!(list_stickers(&conn).unwrap().len(), 1);
    }

    #[test]
    fn transfer_and_group_file_sticker_flags_roundtrip() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        upsert_transfer(&conn, "t", "p", "a.png", 1, "receive", "active", None, 0.0).unwrap();
        set_transfer_sticker(&conn, "t", true).unwrap();
        assert!(transfer_is_sticker(&conn, "t").unwrap());
        conn.execute(
            "INSERT INTO group_files(transfer_id,group_id,sender_id,name,size,sha256,status,created_at,scope,todo_id,sticker)
             VALUES('g','group','p','a.png',1,'h','pending',0,'chat','',1)",
            [],
        )
        .unwrap();
        assert!(group_file_is_sticker(&conn, "g").unwrap());
        assert!(group_file_is_sticker_by_sha(&conn, "group", "h").unwrap());
        assert!(!group_file_is_sticker_by_sha(&conn, "other", "h").unwrap());
    }
}
