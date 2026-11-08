import {
  useEffect,
  useState,
  type FormEvent
} from 'react';

import type {
  Task,
  TaskDetailValues,
  TaskDetailWrite
} from './index.js';

type Props = Readonly<{
  task: Task | null;
  write: TaskDetailWrite | undefined;
  loadError?: string;
  onBack: () => void;
  onRetryLoad?: () => void | Promise<unknown>;
  onSave: (values: TaskDetailValues) => void | Promise<unknown>;
}>;

export function TaskDetail({
  task,
  write,
  loadError,
  onBack,
  onRetryLoad,
  onSave
}: Props) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(task?.title ?? '');
    setDescription(task?.description ?? '');
  }, [task?.id, task?.title, task?.description]);

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setActionError(null);
    void Promise.resolve(onSave({ title, description })).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  function retryLoad(): void {
    setActionError(null);

    if (!onRetryLoad)
      return;

    void Promise.resolve(onRetryLoad()).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : String(error));
    });
  }

  return (
    <div className="notebook">
      <header className="notebook-header">
        <button className="wordmark" type="button" onClick={onBack} aria-label="Back to tasks">
          <span className="brand-mark" aria-hidden="true">F</span>fieldwork<span className="wordmark-dot">.</span>
        </button>
        <span className="implementation"><span className="connection-dot" /> TASK DETAILS</span>
      </header>
      <main className="main-panel task-detail-panel">
        <button className="back-to-tasks" type="button" onClick={onBack}>← Back to tasks</button>
        {loadError ? (
          <section className="task-not-found" aria-labelledby="task-load-error-heading">
            <p className="eyebrow">PROJECT NOTEBOOK / TASK DETAIL</p>
            <h1 id="task-load-error-heading">Could not load task details</h1>
            <p role="alert">{loadError}</p>
            {actionError && <p role="alert">{actionError}</p>}
            {onRetryLoad &&
              <button className="primary-button" type="button" onClick={retryLoad}>Retry details</button>}
          </section>
        ) : task ? (
          <>
            <p className="eyebrow">PROJECT NOTEBOOK / TASK DETAIL</p>
            <h1>{task.title}</h1>
            <p className="task-detail-id">{task.id}</p>
            <form className="task-detail-form" onSubmit={submit}>
              <label>
                Task title
                <input name="title" value={title} maxLength={200} required disabled={write?.status === 'saving'}
                  onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label>
                Description
                <textarea name="description" value={description} maxLength={5000} rows={8} disabled={write?.status === 'saving'}
                  onChange={(event) => setDescription(event.target.value)} />
              </label>
              <div className="task-detail-actions">
                <button className="primary-button" type="submit" disabled={write?.status === 'saving'}>
                  {write?.status === 'saving' ? 'Saving details…' : 'Save details'}
                </button>
                {write?.status === 'error' && <p role="alert">{write.error}</p>}
                {actionError && <p role="alert">{actionError}</p>}
              </div>
            </form>
          </>
        ) : (
          <section className="task-not-found" aria-labelledby="task-not-found-heading">
            <p className="eyebrow">PROJECT NOTEBOOK / TASK DETAIL</p>
            <h1 id="task-not-found-heading">Task not found</h1>
            <p className="intro-copy">This task may have been removed or its link may be out of date.</p>
          </section>
        )}
      </main>
    </div>
  );
}
