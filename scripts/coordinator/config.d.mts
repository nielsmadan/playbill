export interface CoordinatorConfig {
  root: string;
  runId: string;
  runtime: string;
  configHash: string;
  configPath: string;
}
export function configuration(path: string): CoordinatorConfig;
