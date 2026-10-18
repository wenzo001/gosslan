import { api } from "@/api";
import { t } from "@/i18n";
import { urlToBase64 } from "@/utils/imageBytes";
import { saveImageWith, type ImageSource, type SaveImageOutcome } from "@/utils/saveImageCore";

/** 把系统对话框、i18n、Tauri 依赖接到纯核心上；组件只调这一处。 */
export async function saveImageAs(url: string, source?: ImageSource): Promise<SaveImageOutcome> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  return saveImageWith(url, {
    defaultName: () => `${t("common.image")}-${Date.now()}.png`,
    pickDestination: (defaultPath) => save({ defaultPath }),
    toBase64: urlToBase64,
    saveDataFile: (base64Data, destination) => api.saveDataFile(base64Data, destination),
    saveMedia: (src, destination) => api.saveMediaAs(src, destination),
  }, source);
}
