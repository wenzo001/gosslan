/// <reference lib="webworker" />
import { detectCodeLanguage, highlightCode } from "@/utils/codeHighlightCore";

interface Request {
  id: number;
  code: string;
  language?: string;
  /** 只要识别结果，不做高亮（发送前标签用）。 */
  detect?: boolean;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, code, language, detect } = event.data;
  if (detect) {
    const result = detectCodeLanguage(code);
    (self as unknown as Worker).postMessage({ id, detect: true, ...result });
    return;
  }
  const result = highlightCode(code, language);
  (self as unknown as Worker).postMessage({ id, ...result });
};
