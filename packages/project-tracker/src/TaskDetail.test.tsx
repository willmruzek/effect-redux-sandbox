// @vitest-environment happy-dom

import { act } from 'react';
import {
  createRoot,
  type Root
} from 'react-dom/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi
} from 'vitest';

import { TaskDetail } from './TaskDetail.js';
import type { Task } from './index.js';

describe('task detail form', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('submits the edited title and description', async () => {
    // Arrange: a loaded detail entity and a save boundary.
    const task: Task = {
      id: 'TASK-1',
      projectId: 'atlas',
      assigneeId: null,
      title: 'Original title',
      status: 'todo',
      priority: 'medium',
      description: 'Original description',
    };
    const onSave = vi.fn(async () => { });

    await act(async () => root.render(
      <TaskDetail task={task} write={undefined} onBack={() => { }} onSave={onSave} />,
    ));

    // Act: edit both fields and submit.
    const title = container.querySelector<HTMLInputElement>('[name="title"]');
    const description = container.querySelector<HTMLTextAreaElement>('[name="description"]');

    if (!title || !description)
      throw new Error('Missing task detail fields.');

    const setTitle = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const setDescription = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;

    if (!setTitle || !setDescription)
      throw new Error('Missing native value setters.');

    await act(async () => {
      setTitle.call(title, 'Revised title');
      title.dispatchEvent(new Event('input', { bubbles: true }));
      setDescription.call(description, 'Useful detail');
      description.dispatchEvent(new Event('input', { bubbles: true }));
      container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Assert: the form emits one app-owned write with both current values.
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ title: 'Revised title', description: 'Useful detail' });
  });

  test('shows an explicit not-found state when the route has no task', async () => {
    // Arrange / Act: render the route's null task result.
    await act(async () => root.render(
      <TaskDetail task={null} write={undefined} onBack={() => { }} onSave={async () => { }} />,
    ));
    // Assert: absence is visible and offers a way back.
    expect(container.textContent).toContain('Task not found');
    expect(container.querySelector('.back-to-tasks')?.textContent).toContain('Back to tasks');
  });

  test('shows a load error with an explicit retry action', async () => {
    // Arrange: the route loader reports a visible failure.
    const onRetryLoad = vi.fn(async () => { });

    await act(async () => root.render(
      <TaskDetail task={null} write={undefined} loadError="Task details are unavailable."
        onBack={() => { }} onRetryLoad={onRetryLoad} onSave={async () => { }} />,
    ));

    // Act: retry the loader.
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Retry details');

    if (!retry)
      throw new Error('Missing retry button.');

    await act(async () => retry.click());
    // Assert: both the error and retry intent remain explicit.
    expect(container.textContent).toContain('Task details are unavailable.');
    expect(onRetryLoad).toHaveBeenCalledExactlyOnceWith();
  });
});
