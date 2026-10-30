// 职责边界：`commands/favorites.rs` 里「清除数据」那张**表清单**的覆盖判据。
// 由 `favorites.rs` 末尾 `include!` 拼进 `commands` 模块 ⇒ 本文件的 mod 落在
// `commands::clear_data_gate_tests`（与同形的 `commands/files.rs` + `files_tests.rs` 一致）。
//
// 为什么必须有这一格（审计 B3-F2）：清单是**手写**的，而 schema 在 `db.rs` 里单独长 ——
// 新表一进来就会静默漏清。`group_file_acks` 与 `group_recalled_messages` 就是这么漏的，
// 后者还是一张**只增不减**的 G-Set（`db.rs` 的建表注释原话）⇒ 用户点完「清除数据」，
// 那两个群的账本还跟着这台设备走。
// 判据把两边都从源码现解析；只留一张**有产品口径**的保留名单（对话框里明说那两类不受影响）。
#[cfg(test)]
mod clear_data_gate_tests {
    /// schema 里所有 `CREATE TABLE IF NOT EXISTS <name>`（`db.rs` 是唯一建表处）。
    fn schema_tables(src: &str) -> Vec<String> {
        const NEEDLE: &str = "CREATE TABLE IF NOT EXISTS ";
        src.match_indices(NEEDLE)
            .map(|(i, _)| {
                src[i + NEEDLE.len()..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect::<String>()
            })
            .filter(|t| !t.is_empty())
            .collect()
    }

    /// 实现里那张清单：`for table in [ … ]` 之间带引号的表名（注释行跳过）。
    fn cleared_tables(src: &str) -> Vec<String> {
        const HEAD: &str = "for table in [";
        let start = src.find(HEAD).expect("清除清单的锚点不见了") + HEAD.len();
        let rest = &src[start..];
        let end = rest.find("] {").expect("清除清单没有收尾");
        rest[..end]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .filter_map(|l| {
                let t = l.trim().strip_prefix('"')?;
                let name = t.split('"').next()?;
                let ok = !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_');
                ok.then(|| name.to_string())
            })
            .collect()
    }

    /// 按行清除的表（不整表删）：表名 + 那句 SQL 的锚点。少一句就等于整张表没清。
    const PARTIAL: [(&str, &str); 1] = [(
        "conversation_clocks",
        "DELETE FROM conversation_clocks WHERE conv_id LIKE 'group:%'",
    )];

    /// 既没被清除、也不在保留名单里的表（= 清完会残留的表）。
    fn residue(schema: &[String], cleared: &[String], keep: &[&str]) -> Vec<String> {
        let mut left: Vec<String> = schema
            .iter()
            .filter(|t| !keep.contains(&t.as_str()) && !cleared.contains(t))
            .filter(|t| !PARTIAL.iter().any(|(name, _)| name == t))
            .cloned()
            .collect();
        left.sort();
        left
    }

    /// 清除数据必须覆盖 schema 里每一张「聊天数据」表；只有明确保留的才算例外。
    #[test]
    fn clearing_chat_data_covers_every_table_in_the_schema() {
        // 分母是**两处建表点**：`db.rs` 的基础 schema + `content/store.rs` 的内容层
        // （后者与基础 schema 同事务建，但按 `db.rs` 数表时看不见 —— 发版前 review 抓到的
        // `content_transfers` 就是这么漏出清单的）。
        let cleared = cleared_tables(include_str!("favorites.rs"));
        let mut schema = schema_tables(include_str!("../db.rs"));
        let content_tables = schema_tables(include_str!("../content/store.rs"));
        assert!(
            !content_tables.is_empty(),
            "内容层 schema 里一张表都没解析到 ⇒ 提取器或建表形状变了"
        );
        schema.extend(content_tables);
        assert!(
            schema.len() >= 21,
            "只解析到 {} 张表 ⇒ 量具或 schema 形状变了：{schema:?}",
            schema.len()
        );
        // 下限只证明**量具没坏**（没有在空集上恒绿），刻意不卡在实测值上 ——
        // 卡到实测值的话，"清单里漏了一张表"会先报成"锚点变了"，把归因指错。
        assert!(
            cleared.len() >= 15,
            "清单只解析到 {} 张表 ⇒ 锚点变了：{cleared:?}",
            cleared.len()
        );

        // 保留名单是**产品口径**，不是"忘了清"：对话框写着「好友列表 / 设备身份与加密密钥」不受影响。
        const KEEP: [&str; 2] = ["friends", "settings"];
        let left = residue(&schema, &cleared, &KEEP);
        assert_eq!(
            left,
            Vec::<String>::new(),
            "schema 里这些表既没被清除、也没登记为保留（点完「清除数据」它们还留在库里）：{left:?}"
        );

        // 清单里不许出现 schema 没有的表名：拼错的名字永远删不到行，而上面的覆盖会被假满足。
        let unknown: Vec<&String> = cleared.iter().filter(|t| !schema.contains(t)).collect();
        assert_eq!(
            unknown,
            Vec::<&String>::new(),
            "清单里有 schema 不存在的表名（拼错了？）：{unknown:?}"
        );

        // 正控：覆盖检测器必须会说「缺」—— 合成一张新表，必须被报出来（否则上面那条在空集上恒绿）。
        let mut with_new = schema.clone();
        with_new.push("some_new_table".to_string());
        assert_eq!(
            residue(&with_new, &cleared, &KEEP),
            vec!["some_new_table".to_string()],
            "新加一张表却没进清单时必须被这条判据抓住"
        );
        // 反控：保留名单真的在起作用（把它缩小一格，`settings` 必须变成缺口，而不是被默认放过）。
        assert_eq!(
            residue(&schema, &cleared, &["friends"]),
            vec!["settings".to_string()]
        );

        // 按行清除的那几张：它的 SQL 必须真在（`PARTIAL` 只是声明，不在这句里就什么都没清）。
        let src = include_str!("favorites.rs");
        for (table, sql) in PARTIAL {
            assert!(
                src.contains(sql),
                "`{table}` 登记成按行清除，但源码里找不到那句 SQL ⇒ 群删了、它还在"
            );
        }
    }
}
