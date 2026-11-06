export interface GosslanPulseTokens {
  accent: string;
  spark: string;
  mint: string;
  lemon: string;
  radiusControl: string;
  radiusBubble: string;
}

export interface GosslanPulse {
  version: string;
  name: string;
  tokens: GosslanPulseTokens;
}

declare global {
  interface Window {
    GosslanPulse: GosslanPulse;
  }
}

export {};
