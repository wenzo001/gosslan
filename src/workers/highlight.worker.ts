/// <reference lib="webworker" />
import { highlightCode } from "@/utils/codeHighlightCore";

interface Request {
  id: number;
  code: string;
  language?: string;
}

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, code, language } = event.data;
  const result = highlightCode(code, language);
  (self as unknown as Worker).postMessage({ id, ...result });
};
