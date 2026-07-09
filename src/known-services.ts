/**
 * Ecosystem-wide known services — seeded into PolarPort on startup.
 * Includes external tools whose ports may not end in 0/5 (lm-studio, ollama, etc.).
 */
export interface KnownService {
  service_name: string;
  project: string;
  port: number;
}

/** Preferred-port reservations (must end in 0 or 5). */
export const KNOWN_RESERVATIONS: KnownService[] = [
  { service_name: "polarclaw-web", project: "PolarClaw", port: 3910 },
  { service_name: "autooffice", project: "AutoOffice", port: 3900 },
  { service_name: "polar-port", project: "PolarPort", port: 11050 },
  { service_name: "polar-process", project: "PolarProcess", port: 11055 },
  { service_name: "sotagent", project: "SOTAgent", port: 4800 },
  { service_name: "polarpilot", project: "PolarPilot", port: 4900 },
  { service_name: "polarprivate", project: "PolarPrivate", port: 12790 },
  { service_name: "polarprivate-frontend", project: "PolarPrivate", port: 12795 },
  { service_name: "polarclock-backend", project: "Clock", port: 15550 },
  { service_name: "polarclock-frontend", project: "Clock", port: 4555 },
  { service_name: "polarui-dev", project: "PolarUI", port: 5170 },
  { service_name: "dify-reference", project: "PolarUI", port: 8090 },
  { service_name: "dify-reference-https", project: "PolarUI", port: 8450 },
  { service_name: "polarcop-web-dev", project: "PolarCopilot", port: 5180 },
  { service_name: "polarcop-hub", project: "PolarCopilot", port: 8040 },
  { service_name: "knowlever-rag", project: "KnowLever", port: 18080 },
  { service_name: "knowlever-wiki", project: "KnowLever", port: 18085 },
  { service_name: "digist-api", project: "digist", port: 3800 },
  { service_name: "polarmemory-api", project: "PolarMemory", port: 3100 },
  { service_name: "infoforge-api", project: "InfoForge", port: 3901 },
  { service_name: "infoforge-sse", project: "InfoForge", port: 3902 },
  { service_name: "tqsdk-collector", project: "tqsdk", port: 18900 },
  { service_name: "tqsdk-gateway", project: "tqsdk", port: 12890 },
];

/** Active port registrations — all ecosystem services including external tools. */
export const KNOWN_SERVICES: KnownService[] = [
  ...KNOWN_RESERVATIONS,
  { service_name: "digist-preview", project: "digist", port: 4880 },
  { service_name: "sotagent-console", project: "SOTAgent", port: 4880 },
  { service_name: "polar-process", project: "PolarProcess", port: 11055 },
  { service_name: "polarops", project: "PolarOps", port: 11065 },
  // External / third-party / on-demand
  { service_name: "lm-studio", project: "—", port: 1234 },
  { service_name: "vocab-app", project: "English", port: 3000 },
  { service_name: "llama-server", project: "—", port: 8080 },
  { service_name: "polarcop-stepflow", project: "PolarCopilot", port: 8765 },
  { service_name: "ai-daily-digest", project: "clawd", port: 8785 },
  { service_name: "knowlever-embedding", project: "KnowLever", port: 8801 },
  { service_name: "ollama", project: "—", port: 11434 },
  { service_name: "claude-code-viz", project: "—", port: 19120 },
];
