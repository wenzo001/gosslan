// 16/16 补拉回程路由：群维度 cid **只能**走群文件帧。
//
// 回归对象：群任务图片冒到单聊（1:1 FileDone 会写一条 conv_id=服务成员 的消息）。
// 三条边界钉住纯决策；最后一条钉住结构 —— 群分支存在且 1:1 调用点在它之后。

#[test]
fn content_pull_route_group_cid_only_group_file() {
    assert_eq!(
        content_pull_route(Some("group-1"), true),
        ContentPullRoute::GroupFile
    );
}

#[test]
fn content_pull_route_group_cid_non_member_is_refused() {
    // 群内容不许因为"是好友"就落到单聊；不在名册的一律不服务。
    assert_eq!(
        content_pull_route(Some("group-1"), false),
        ContentPullRoute::Refuse
    );
}

#[test]
fn content_pull_route_single_chat_cid_keeps_one_to_one() {
    assert_eq!(
        content_pull_route(None, false),
        ContentPullRoute::SingleChatFile
    );
    assert_eq!(
        content_pull_route(None, true),
        ContentPullRoute::SingleChatFile
    );
}

#[test]
fn group_pull_never_falls_back_to_single_chat_call_site() {
    // 源码锚点：ContentRequest 臂必须先过纯路由，worker 里群分支必须在 1:1 调用点之前。
    // 反例自证：把 `else if let Some(group_id) = job.group_id.clone()` 改回无条件 `else`，
    // 下面 `group_branch` 的断言立刻红；同时三条纯决策测试也会红（GroupFile 变 SingleChatFile）。
    let src = include_str!("handle_share.rs");
    assert!(
        src.contains("content_pull_route(group_id.as_deref(), requester_in_group)"),
        "ContentRequest 臂必须用纯路由决定回程通道"
    );
    let group_branch = "} else if let Some(group_id) = job.group_id.clone() {";
    let pos = src
        .find(group_branch)
        .expect("worker 必须有群维度回程分支（群 cid 不得落 1:1）");
    let after = &src[pos..];
    let group_call = after
        .find("send_group_file_pull_at")
        .expect("群分支必须调用群文件回程");
    let one_to_one_else = after
        .find("} else {")
        .expect("群分支之后必须还有单聊 legacy 分支");
    let one_to_one_call = after
        .find("send_file_from_path_at")
        .expect("单聊 legacy 分支必须保留");
    assert!(
        group_call < one_to_one_else && one_to_one_else < one_to_one_call,
        "1:1 回程必须排在群分支之后，group_id.is_some() 时不得可达"
    );
}
