export interface GosslanStillTokens {
  accent: string;
  radiusControl: string;
  radiusBubble: string;
}

export interface GosslanStill {
  version: string;
  name: string;
  tokens: GosslanStillTokens;
}

declare global {
  interface Window {
    GosslanStill: GosslanStill;
  }
}

export {};
