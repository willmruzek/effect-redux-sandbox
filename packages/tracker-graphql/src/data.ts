import {
  createInitialState,
  type TrackerData,
  type Task,
  type Person,
  type Project
} from '@repo/project-tracker';

/** Deterministic fake backend dataset; no browser imports this module. */
export function createBackendData(): TrackerData {
  const seed = createInitialState();
  const projects: Project[] = [...Object.values(seed.projects), ...Array.from({ length: 8 }, (_, index) => ({
    id: `project-${index + 1}`,
    name: `Initiative ${index + 1}`,
    code: `P${String(index + 1).padStart(2, '0')}`,
    description: `Shared initiative ${index + 1}.`,
  }))];
  const people: Person[] = [...Object.values(seed.people), ...Array.from({ length: 16 }, (_, index) => ({
    id: `person-${index + 1}`,
    name: `Teammate ${String(index + 1).padStart(2, '0')}`,
    initials: `T${index + 1}`,
    role: index % 2 === 0 ? 'Engineering' : 'Design',
  }))];
  const activeProjects = projects.filter((project) => project.id !== 'ideas');
  const tasks: Task[] = [...Object.values(seed.tasks), ...Array.from({ length: 194 }, (_, index): Task => {
    const project = activeProjects[index % activeProjects.length];
    const person = people[index % people.length];

    if (!project || !person)
      throw new Error('Invalid backend seed relationship.');

    return {
      id: `${project.code}-${String(index + 100).padStart(3, '0')}`,
      projectId: project.id,
      assigneeId: index % 7 === 0 ? null : person.id,
      title: `${['Review accessibility', 'Plan research', 'Build components', 'Document decisions'][index % 4]} ${String(index % 17).padStart(2, '0')}`,
      status: index % 3 === 0 ? 'todo' : index % 3 === 1 ? 'in-progress' : 'done',
      priority: index % 3 === 0 ? 'high' : index % 3 === 1 ? 'medium' : 'low',
    };
  })];

  return {
    projects,
    people,
    tasks
  };
}
