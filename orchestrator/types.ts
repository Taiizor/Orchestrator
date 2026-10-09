export type TaskStatus =
  | "PENDING" // Waiting for dependencies to complete
  | "IN_PROGRESS" // Subagent currently executing
  | "IN_REVIEW" // Subagent finished; awaiting Orchestrator review
  | "COMPLETED" // Reviewed and approved; merged into integration branch
  | "FAILED"; // Subagent failed or review rejected max attempts

export type AgentRole =
  "architect" | "backend" | "frontend" | "mobile" | "qa" | "reviewer" | "security" | "tracker" | "fullstack";

export interface TaskItem {
  id: string; // Unique ID e.g. "TASK-001"
  title: string; // Short task description
  description: string; // Detailed instructions for the subagent
  role: AgentRole; // Assigned subagent role
  dependencies: string[]; // IDs of tasks that must be COMPLETED first
  targetFiles: string[]; // Files/directories allocated to this task to prevent conflicts
  status: TaskStatus; // Current lifecycle status
  branch: string; // Dedicated branch for this task
  runId?: number; // GitHub Actions workflow run ID if triggered
  dispatchedAt?: string; // ISO timestamp of last dispatch (watchdog staleness)
  issueNumber?: number; // Linked GitHub Issue number
  issueUrl?: string; // Linked GitHub Issue URL
  milestone?: string; // Assigned GitHub Milestone
  projectItemId?: string; // GitHub Project item ID
  reviewNotes?: string; // Feedback from orchestrator review if changes requested
  attempts: number; // Number of execution attempts
  maxAttempts: number; // Maximum allowed retry attempts
  failedAt?: string; // ISO timestamp of last FAILED transition (auto-resurrect cooldown)
  resurrections?: number; // Auto-resurrect count (bounded; human /retry resets to 0)
  lastReviewSha?: string; // Branch tip SHA of last completed review (skip re-review when unchanged)
  createdAt: string;
  updatedAt: string;
}

export interface ServiceDefinition {
  name: string; // lowercase-hyphen service name
  image: string; // Docker image (Docker Hub or ghcr.io)
  env?: Record<string, string>; // extra env exported to jobs
  ports?: string[]; // e.g. ["5432:5432"]
  command?: string; // container command override
  healthcheck?: string[]; // CMD array for readiness probe
}

export interface Roadmap {
  projectName: string;
  version: number;
  summary: string;
  projectNumber?: number; // Linked GitHub Project v2 number
  projectUrl?: string; // Linked GitHub Project v2 URL
  milestones?: { title: string; description?: string }[];
  services?: (string | ServiceDefinition)[]; // preset names or full custom defs
  globalStatus: "PLANNING" | "IN_PROGRESS" | "COMPLETED" | "PAUSED" | "FAILED";
  tasks: TaskItem[];
  updatedAt: string;
  lastBoardSyncAt?: string; // Last successful board drift-heal (skip idle snapshots)
}

export interface TaskProgressReport {
  taskId: string;
  subagentRole: AgentRole;
  done: string[]; // Completed items and created files
  doing: string[]; // Current execution state
  todo: string[]; // Remaining or downstream integration items
  verification: string; // Test/verification results (proof of working code)
  notes?: string; // General notes or caveats
}

export interface ReviewResult {
  approved: boolean;
  notes: string;
  suggestedFixes?: string[];
}
