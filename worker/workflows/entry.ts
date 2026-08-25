import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { AppEnv, GroupSummarizerParams } from "../env";
import { runGroupSummarizerSteps, type WorkflowStepRunner } from "./group-summarizer";

export class GroupSummarizer extends WorkflowEntrypoint<AppEnv, GroupSummarizerParams> {
  async run(event: Readonly<WorkflowEvent<GroupSummarizerParams>>, step: WorkflowStep): Promise<unknown> {
    return runGroupSummarizerSteps(this.env, event.payload, step as unknown as WorkflowStepRunner);
  }
}
