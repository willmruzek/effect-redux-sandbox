import { useState } from 'react';

import type {
  Person,
  Project,
  Task,
  TaskCreation,
  TaskCreateInput,
  TaskPreference
} from './index.js';

export type TaskCreationPanelProps = {
  readonly projects: readonly Project[];
  readonly people: readonly Person[];
  readonly tasks: Readonly<Record<string, Task>>;
  readonly creations: Readonly<Record<string, TaskCreation>>;
  readonly preferences: Readonly<Record<string, TaskPreference>>;
  readonly onCreate: (input: TaskCreateInput, fail: boolean) => Promise<unknown>;
  readonly onRetry: (operationId: string, fail: boolean) => Promise<unknown>;
  readonly onDiscard: (operationId: string) => void;
  readonly onSetStarred: (input: Readonly<{ taskId: string; starred: boolean }>) => void;
};

export function TaskCreationPanel({
  projects,
  people,
  tasks,
  creations,
  preferences,
  onCreate,
  onRetry,
  onDiscard,
  onSetStarred
}: TaskCreationPanelProps) {
  const [draft, setDraft] = useState<TaskCreateInput>({
    title: '',
    projectId: projects[0]?.id ?? '',
    assigneeId: null,
    status: 'todo',
    priority: 'low',
  });
  const [fail, setFail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setError(null);
    setSubmitting(true);

    try {
      await onCreate(draft, fail);
      setDraft((current) => ({ ...current, title: '' }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  function retry(operationId: string): void {
    setError(null);
    void onRetry(operationId, fail).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <section className="creation-panel" aria-labelledby="creation-heading">
      <p className="eyebrow">A NEW DETAIL / SERVER-VALIDATED</p>
      <h2 id="creation-heading">Add to the notebook.</h2>
      <p className="creation-intro">Drafts stay outside the server-ranked ledger. Saved tasks join its next refreshed window only when the server query includes them.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}>
        <fieldset disabled={submitting}>
          <label className="creation-title">Title<input aria-label="New task title" required value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label>Project<select aria-label="New task project" required value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
            <option value="" disabled>Choose a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <label>Assignee<select aria-label="New task assignee" value={draft.assigneeId ?? ''} onChange={(event) => setDraft({ ...draft, assigneeId: event.target.value || null })}>
            <option value="">Unassigned</option>
            {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select></label>
          <label>Status<select aria-label="New task status" value={draft.status} onChange={(event) => {
            const value = event.target.value;

            if (value !== 'todo' && value !== 'in-progress' && value !== 'done')
              throw new Error(`Unknown task status: ${value}`);

            setDraft({ ...draft, status: value });
          }}><option value="todo">To do</option><option value="in-progress">In progress</option><option value="done">Done</option></select></label>
          <label>Priority<select aria-label="New task priority" value={draft.priority} onChange={(event) => {
            const value = event.target.value;

            if (value !== 'high' && value !== 'medium' && value !== 'low')
              throw new Error(`Unknown task priority: ${value}`);

            setDraft({ ...draft, priority: value });
          }}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          <button className="creation-submit" type="submit" disabled={!projects.length}>{submitting ? 'Creating task...' : 'Create task'}</button>
          <label className="creation-failure"><input type="checkbox" aria-label="Fail task creations" checked={fail} onChange={(event) => setFail(event.target.checked)} />Fail task creations</label>
        </fieldset>
      </form>
      {error ? <p role="alert" className="error-message">{error}</p> : null}
      {Object.keys(creations).length > 0 ? (
        <div className="creation-drafts" aria-label="Pending creations">
          <h3>Pending creations <span>/ recent confirmations</span></h3>
          <p>Not part of server-ranked results. An uncertain retry may create a duplicate; check the task list before retrying. Discard removes the local draft only.</p>
          {Object.entries(creations).map(([operationId, creation]) => {
            const task = tasks[creation.taskId];

            if (!task)
              return <p key={operationId} role="alert" className="error-message">Missing creation entity: {creation.taskId}</p>;

            return (
              <article key={operationId} data-operation-id={operationId}>
                <button type="button" className="local-star"
                  aria-label={`${preferences[task.id]?.starred ? 'Unstar' : 'Star'} task ${task.id}`}
                  aria-pressed={preferences[task.id]?.starred ?? false}
                  onClick={() => onSetStarred({ taskId: task.id, starred: !preferences[task.id]?.starred })}>
                  {preferences[task.id]?.starred ? '★' : '☆'}
                </button>
                <div><strong>{task.title || '(Untitled draft)'}</strong><small>{task.id}</small>
                  <span role="status">{creation.status === 'saving' ? 'Creating...' : creation.status === 'created' ? 'Saved. Server query determines ledger placement.' : 'Creation failed'}</span>
                </div>
                {creation.status === 'error' ? <div className="creation-actions">
                  <button type="button" onClick={() => retry(operationId)}>Retry creation</button>
                  <button type="button" onClick={() => onDiscard(operationId)}>Discard draft</button>
                  <p role="alert" className="error-message">{creation.error}</p>
                </div> : creation.status === 'created' ? <button type="button" onClick={() => onDiscard(operationId)}>Dismiss notice</button> : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
