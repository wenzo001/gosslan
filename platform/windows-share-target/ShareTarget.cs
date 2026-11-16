// 小院儿（`Gosslan`）的 Windows 分享目标处理端。
//
// ## 职责只有一件
//
// 把系统分享过来的内容**写成一份落地区文件**（协议见
// `docs/notes/system-share-target-design-2026-11-15.md` §3），然后交还给系统。
//
// Windows 的分享目标**不是独立进程**，而是主应用被唤起后由
// `DataTransferManager.DataRequested` 事件接住 ⇒ 这段代码要跑在主应用进程里
// （本仓是 Rust + Tauri ⇒ 需要一个很薄的 C#/WinRT 壳，或用 Tauri 插件承载）。
//
// ## 与 macOS 侧同一口径
//
// · 文件名：`incoming-<32 位小写十六进制>.json`（**文件名是唯一真源**）；
// · 正文：`{ "v": 1, "id": "<同一个 id>", "receivedAtMs": <毫秒>, "payload": { "url":…, "title":…, "text":… } }`；
// · 目录：`%LOCALAPPDATA%\<包标识>\incoming-shares\`；
// · 三个字段至少一个非空；主应用会逐项校验（大小、数量、TTL、内容限额）。
//
// ## 四条红线（与深链同一条）
//
// ① 不静默发消息（内容只进面板，用户自己选会话并点发送）；
// ② 不联网（不请求任何 URL）；
// ③ 不信任自称来源（落地区文件不带来源字段）；
// ④ 写失败就放弃（不落到别处）。

using System;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Windows.ApplicationModel.DataTransfer;

namespace Gosslan.ShareTarget;

/// <summary>分享目标的接线：注册 <see cref="DataRequested"/> 并把内容写成落地区文件。</summary>
public static class ShareTarget
{
    /// <summary>落地区目录名（与读取端一致）。</summary>
    private const string DropFolderName = "incoming-shares";

    /// <summary>
    /// 挂上分享处理。调用点：主应用启动时（以及每次窗口重新获得焦点后，Windows 可能再次唤起）。
    /// </summary>
    public static void Register(DataTransferManager manager)
    {
        manager.DataRequested += OnDataRequested;
    }

    private static void OnDataRequested(DataTransferManager sender, DataRequestedEventArgs args)
    {
        var request = args.Request;
        var payload = new Payload();

        // 链接（URI）
        if (request.Data.Contains(StandardDataFormats.Uri))
        {
            var uri = request.Data.GetUri();
            if (uri != null)
            {
                payload.Url = uri.AbsoluteUri;
            }
        }

        // 纯文本（Text）
        if (request.Data.Contains(StandardDataFormats.Text))
        {
            var text = request.Data.GetText();
            if (!string.IsNullOrEmpty(text))
            {
                payload.Text = text;
            }
        }

        // 三个字段至少一个非空，否则不是一次分享（主应用会按同一条规则拒收）。
        if (payload.Url == null && payload.Text == null && payload.Title == null)
        {
            args.Request.Fail(DataTransferError.OperationCanceled);
            return;
        }

        if (!TryWriteDroppedFile(payload, out var error))
        {
            args.Request.Fail(DataTransferError.Unknown);
            return;
        }

        // 交还给系统：数据留在落地区，由主应用自己捡（**不由分享目标直接投递**）。
        args.Request.Complete();
    }

    /// <summary>把载荷写成一份落地区文件。</summary>
    private static bool TryWriteDroppedFile(Payload payload, out string error)
    {
        error = string.Empty;
        try
        {
            var directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                PackageIdentityName(),
                DropFolderName);
            Directory.CreateDirectory(directory);

            var id = Guid.NewGuid().ToString("N").ToLowerInvariant();
            var body = new
            {
                v = 1,
                id,
                receivedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                payload,
            };
            var json = JsonSerializer.Serialize(body);
            var path = Path.Combine(directory, $"incoming-{id}.json");
            File.WriteAllText(path, json, new UTF8Encoding(false));
            return true;
        }
        catch (Exception e)
        {
            error = e.Message;
            return false;
        }
    }

    /// <summary>
    /// 包标识（MSIX 的 Package Family Name 去掉下划线后缀那一段）。
    /// ⚠️ 必须与主应用实际使用的目录名一致 —— 读取端按
    /// `app_local_data_dir()/incoming-shares` 读（见 `src-tauri/src/incoming_share.rs`）。
    /// </summary>
    private static string PackageIdentityName() => "Gosslan";

    /// <summary>
    /// 落地区载荷。**字段名必须小写开头**：`JsonSerializer.Serialize` 默认输出
    /// PascalCase（`Url/Title/Text`），而读取端（Rust `incoming_share.rs` 的
    /// `IncomingPayload` 带 `#[serde(rename_all = "camelCase")]`）只认
    /// `url/title/text` —— 两边不一致的话，文件会被当成「三个字段都缺」直接拒收。
    /// 用 `JsonPropertyName` 显式钉住，不依赖序列化器的默认命名策略。
    /// </summary>
    private sealed class Payload
    {
        [JsonPropertyName("url")]
        public string? Url { get; set; }

        [JsonPropertyName("title")]
        public string? Title { get; set; }

        [JsonPropertyName("text")]
        public string? Text { get; set; }
    }
}
