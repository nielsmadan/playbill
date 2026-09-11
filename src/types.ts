export type ModelTier = 'fast' | 'balanced' | 'capable';

export interface AgentProperties {
  fresh: boolean;
  read_only: boolean;
  model: ModelTier;
}

export type AgentRequirements = Partial<AgentProperties>;

export interface Triggers {
  keywords?: string[];
  file_patterns?: string[];
  repo_conditions?: ('git' | 'clean' | 'dirty')[];
}

export interface CoordinationPolicy {
  report_artifact?: string;
  redirect_threshold?: number;
  ask_on_redirect?: boolean;
  enabled?: boolean;
  artifact_scope?: 'project' | 'run';
}

export interface WorkflowPolicy {
  coordination?: CoordinationPolicy;
  entry?: 'auto' | 'explicit' | 'disabled';
  priority?: number;
  triggers?: Triggers;
}

export interface Config {
  version: 1;
  slots: Record<string, string>;
  workflows: Record<string, WorkflowPolicy>;
}

export interface Artifact {
  id: string;
  path: string;
  kind: 'file' | 'collection';
}

export interface Step {
  type: 'step';
  id: string;
  title: string;
  skill: string;
  consumes: string[];
  produces: string[];
  requires: AgentRequirements;
  agent: AgentProperties;
  instruction?: string;
}

export interface IfNode {
  type: 'if';
  condition: string;
  then: PipelineNode[];
  else?: PipelineNode[];
}

export interface SwitchNode {
  type: 'switch';
  select: string;
  cases: { when: string; steps: PipelineNode[] }[];
  default?: PipelineNode[];
}

export interface WhileNode {
  type: 'while';
  condition: string;
  max_iterations: number;
  steps: PipelineNode[];
}

export interface ForEachNode {
  type: 'for_each';
  collection: string;
  as: string;
  max_items: number;
  steps: PipelineNode[];
}

export type PipelineNode = Step | IfNode | SwitchNode | WhileNode | ForEachNode;

export interface Pipeline {
  version: 1;
  id: string;
  title: string;
  introduction?: string;
  artifacts: Artifact[];
  inputs: string[];
  outputs: string[];
  steps: PipelineNode[];
}

export interface InstalledSkill {
  id: string;
  path: string;
  model_invocable: boolean;
  requires: AgentRequirements;
}

export interface Diagnostic {
  code: string;
  path: string;
  message: string;
}

export interface ValidatedPipeline {
  pipeline: Pipeline;
  skills: ReadonlyMap<string, InstalledSkill>;
}
