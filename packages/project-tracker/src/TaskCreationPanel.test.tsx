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

import {
  TaskCreationPanel,
  type TaskCreationPanelProps
} from './TaskCreationPanel.js';

describe('task creation panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: TaskCreationPanelProps;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    props = {
      projects: [{
        id: 'p',
        name: 'Project',
        code: 'P',
        description: ''
      }],
      people: [],
      tasks: {
        'temp:op': {
          id: 'temp:op',
          title: 'Retained draft',
          projectId: 'p',
          assigneeId: null,
          status: 'todo',
          priority: 'low',

        }
      },
      creations: {},

      onCreate: vi.fn(async () => { }),

      onRetry: vi.fn(async () => { }),

      onDiscard: vi.fn(() => { }),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  test('submits form values to the app-owned creation callback', async () => {
    // Arrange: render a new-task form with one valid project.
    await act(async () => root.render(<TaskCreationPanel {...props} />));

    const input = container.querySelector<HTMLInputElement>('[aria-label="New task title"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    const form = container.querySelector('form');

    if (!input || !setter || !form)
      throw new Error('Missing creation form.');

    // Act: type a title and submit without creating a local entity cache.
    await act(async () => {
      setter.call(input, 'New title');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));

    // Assert: the owning app receives the complete draft and failure control.
    expect(props.onCreate).toHaveBeenCalledWith({
      title: 'New title',
      projectId: 'p',
      assigneeId: null,
      status: 'todo',
      priority: 'low',
    }, false);
  });

  test('labels pending rows as outside server-ranked results', async () => {
    // Arrange: the store has an in-flight temporary entity.
    props = {
      ...props,
      creations: {
        op: {
          status: 'saving',
          taskId: 'temp:op',
          requestId: 'r'
        }
      }
    };

    // Act: project store-owned creation metadata into the UI.
    await act(async () => root.render(<TaskCreationPanel {...props} />));

    // Assert: draft rows have no pretend backend membership or editable fields.
    expect(container.textContent).toContain('Pending creations');
    expect(container.textContent).toContain('Not part of server-ranked results');
    expect(container.textContent).toContain('Retained draft');
    expect(container.textContent).toContain('Creating');
    expect(container.querySelector('[data-operation-id="op"] button')).toBeNull();
  });

  test('offers explicit retry and discard for a failed draft', async () => {
    // Arrange: the stored draft survived its failed request.
    props = {
      ...props,
      creations: {
        op: {
          status: 'error',
          taskId: 'temp:op',
          requestId: 'r',
          error: 'Title must contain 1-200 characters.',
        }
      }
    };
    await act(async () => root.render(<TaskCreationPanel {...props} />));

    const buttons = container.querySelectorAll<HTMLButtonElement>('[data-operation-id="op"] button');
    const retry = buttons[0];
    const discard = buttons[1];

    if (!retry || !discard)
      throw new Error('Missing draft actions.');

    // Act: send retry/discard intent to the app.
    await act(async () => retry.click());
    await act(async () => discard.click());

    // Assert: original operation identity remains available for safe retry.
    expect(props.onRetry).toHaveBeenCalledWith('op', false);
    expect(props.onDiscard).toHaveBeenCalledWith('op');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Title must contain');
  });

  test(
    'shows the authoritative ID for a saved task outside the current window',
    async () => {
      // Arrange: success replaced the temporary entity.
      const task = props.tasks['temp:op'];

      if (!task)
        throw new Error('Missing fixture.');

      props = {
        ...props,
        tasks: { server: { ...task, id: 'server' } },
        creations: { op: { status: 'created', taskId: 'server' } }
      };

      // Act: render the confirmation.
      await act(async () => root.render(<TaskCreationPanel {...props} />));

      // Assert: a saved task is not falsely inserted into the current ranked window.
      expect(container.textContent).toContain('Saved');
      expect(container.textContent).toContain('server');
      expect(container.textContent).toContain('Dismiss notice');
      expect(container.textContent).not.toContain('temp:op');
    }
  );
});
