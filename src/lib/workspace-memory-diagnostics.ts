export const PROJECT_MEMORY_SECTIONS = [
  "Overview",
  "Members And Roles",
  "Roadmap And Milestones",
] as const;

export type ProjectMemorySection = typeof PROJECT_MEMORY_SECTIONS[number];

export interface WorkspaceMemoryProjectCoverage {
  projectName: string;
  presentSections: ProjectMemorySection[];
  missingSections: ProjectMemorySection[];
  bulletCounts: Record<ProjectMemorySection, number>;
}

export interface WorkspaceMemoryCurrentStateWarning {
  lineNumber: number;
  line: string;
  reason: "issue-reference" | "workflow-state";
}

export interface WorkspaceMemoryCoverageDiagnostics {
  headings: string[];
  projectNames: string[];
  totalProjects: number;
  completeProjects: string[];
  incompleteProjects: string[];
  projects: WorkspaceMemoryProjectCoverage[];
  currentStateWarnings: WorkspaceMemoryCurrentStateWarning[];
  notes: {
    projectCoverage: string;
    currentStateBoundary: string;
  };
}

const PROJECT_MEMORY_SECTION_SET = new Set<string>(PROJECT_MEMORY_SECTIONS);

function emptyBulletCounts(): Record<ProjectMemorySection, number> {
  return {
    Overview: 0,
    "Members And Roles": 0,
    "Roadmap And Milestones": 0,
  };
}

function looksLikeIssueReference(value: string): boolean {
  return /\b[A-Z]{2,}-\d+\b/.test(value);
}

function looksLikeWorkflowState(value: string): boolean {
  return /\b(?:Backlog|In Progress|In Review|Done|Blocked|Canceled|Cancelled)\b/i.test(value)
    || /(?:現在の進捗|現在は|今日やる|今日の|今週|今月|未着手|進行中|レビュー待ち|完了済み)/.test(value);
}

export function extractWorkspaceMemoryHeadings(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(##|###|####)\s+/.test(line));
}

export function analyzeWorkspaceMemory(value: string | undefined): WorkspaceMemoryCoverageDiagnostics {
  const lines = value?.split("\n") ?? [];
  const projectSections = new Map<string, Set<ProjectMemorySection>>();
  const bulletCounts = new Map<string, Record<ProjectMemorySection, number>>();
  const currentStateWarnings: WorkspaceMemoryCurrentStateWarning[] = [];
  let currentProject: string | undefined;
  let currentSection: ProjectMemorySection | undefined;

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (/^###\s+/.test(trimmed)) {
      currentProject = trimmed.replace(/^###\s+/, "");
      currentSection = undefined;
      if (!projectSections.has(currentProject)) {
        projectSections.set(currentProject, new Set<ProjectMemorySection>());
        bulletCounts.set(currentProject, emptyBulletCounts());
      }
      return;
    }

    if (/^####\s+/.test(trimmed)) {
      const sectionHeading = trimmed.replace(/^####\s+/, "");
      currentSection = currentProject && PROJECT_MEMORY_SECTION_SET.has(sectionHeading)
        ? sectionHeading as ProjectMemorySection
        : undefined;
      if (currentProject && currentSection) {
        projectSections.get(currentProject)?.add(currentSection);
      }
      return;
    }

    if (/^##\s+/.test(trimmed)) {
      currentProject = undefined;
      currentSection = undefined;
      return;
    }

    if (!trimmed.startsWith("- ")) {
      return;
    }

    if (currentProject && currentSection) {
      const projectBulletCounts = bulletCounts.get(currentProject);
      if (projectBulletCounts) {
        projectBulletCounts[currentSection] += 1;
      }
    }

    if (looksLikeIssueReference(trimmed)) {
      currentStateWarnings.push({
        lineNumber: index + 1,
        line: trimmed,
        reason: "issue-reference",
      });
      return;
    }

    if (looksLikeWorkflowState(trimmed)) {
      currentStateWarnings.push({
        lineNumber: index + 1,
        line: trimmed,
        reason: "workflow-state",
      });
    }
  });

  const projects = Array.from(projectSections.entries())
    .map(([projectName, sections]) => {
      const presentSections = PROJECT_MEMORY_SECTIONS.filter((section) => sections.has(section));
      const missingSections = PROJECT_MEMORY_SECTIONS.filter((section) => !sections.has(section));

      return {
        projectName,
        presentSections,
        missingSections,
        bulletCounts: bulletCounts.get(projectName) ?? emptyBulletCounts(),
      };
    })
    .sort((left, right) => left.projectName.localeCompare(right.projectName, "ja"));

  return {
    headings: extractWorkspaceMemoryHeadings(value),
    projectNames: projects.map((project) => project.projectName),
    totalProjects: projects.length,
    completeProjects: projects
      .filter((project) => project.missingSections.length === 0)
      .map((project) => project.projectName),
    incompleteProjects: projects
      .filter((project) => project.missingSections.length > 0)
      .map((project) => project.projectName),
    projects,
    currentStateWarnings,
    notes: {
      projectCoverage: "Each project should ideally cover Overview, Members And Roles, and Roadmap And Milestones.",
      currentStateBoundary: "Warnings flag issue IDs or workflow-state wording inside MEMORY. Milestone dates alone are allowed.",
    },
  };
}
